import { act, render } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AspContext } from '../../providers/asp'
import { UsdcContext, UsdcProvider } from '../../providers/usdc'
import { WalletContext } from '../../providers/wallet'
import { clearUsdcSession, setUsdcSessionFromMnemonic } from '../../lib/usdc/keys'
import {
  beginCreatingSwap,
  endCreatingSwap,
  loadUsdcSwaps,
  saveUsdcSwap,
  type UsdcSwapRecord,
} from '../../lib/usdc/swaps'
import { mockAspContextValue, mockWalletContextValue } from '../screens/mocks'

const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const mocks = vi.hoisted(() => ({
  readUsdcBalance: vi.fn(),
  fetchUsdcTransfers: vi.fn(),
  satoraClient: vi.fn(),
  advanceUsdcSwap: vi.fn(),
  reconcileStoredSwaps: vi.fn(),
  getReceivingAddresses: vi.fn(async () => ({ offchainAddr: 'ark1me', boardingAddr: '' })),
}))

vi.mock('../../lib/mnemonic', () => ({ hasMnemonic: () => true }))
vi.mock('../../lib/asp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/asp')>()),
  getReceivingAddresses: () => mocks.getReceivingAddresses(),
}))
vi.mock('../../lib/usdc/chain', () => ({
  readUsdcBalance: (...args: unknown[]) => mocks.readUsdcBalance(...args),
  fetchUsdcTransfers: (...args: unknown[]) => mocks.fetchUsdcTransfers(...args),
}))
vi.mock('../../lib/usdc/satora', () => ({
  satoraClient: (...args: unknown[]) => mocks.satoraClient(...args),
  advanceUsdcSwap: (...args: unknown[]) => mocks.advanceUsdcSwap(...args),
  reconcileStoredSwaps: (...args: unknown[]) => mocks.reconcileStoredSwaps(...args),
}))

let usdc: React.ContextType<typeof UsdcContext>
function Capture() {
  usdc = useContext(UsdcContext)
  return null
}

const renderProvider = () =>
  render(
    <AspContext.Provider
      value={{
        ...mockAspContextValue,
        aspInfo: { ...mockAspContextValue.aspInfo, network: 'bitcoin', url: 'https://ark.example' },
      }}
    >
      <WalletContext.Provider value={{ ...mockWalletContextValue, svcWallet: {} as any }}>
        <UsdcProvider>
          <Capture />
        </UsdcProvider>
      </WalletContext.Provider>
    </AspContext.Provider>,
  )

const record = (overrides: Partial<UsdcSwapRecord> = {}): UsdcSwapRecord => ({
  id: 'swap-1',
  direction: 'toArkade',
  createdAt: 1,
  updatedAt: 1,
  sourceAmount: '10000000',
  targetAmount: '10000',
  status: 'pending',
  arkAddress: 'ark1me',
  funded: true,
  ...overrides,
})

describe('UsdcProvider lifecycle and concurrency', () => {
  beforeEach(() => {
    localStorage.clear()
    clearUsdcSession()
    vi.clearAllMocks()
    vi.stubEnv('VITE_USDC_ENABLED', 'true')
    mocks.readUsdcBalance.mockResolvedValue(BigInt(0))
    mocks.fetchUsdcTransfers.mockResolvedValue([])
    mocks.satoraClient.mockResolvedValue({})
    mocks.advanceUsdcSwap.mockResolvedValue({ record: record({ status: 'clientredeemed' }) })
    mocks.reconcileStoredSwaps.mockResolvedValue([])
    vi.stubGlobal('indexedDB', { databases: vi.fn(async () => []) })
  })

  afterEach(() => {
    clearUsdcSession()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('drops stale balance and transfer reads that resolve after lock', async () => {
    let resolveBalance!: (v: bigint) => void
    let resolveTransfers!: (v: unknown[]) => void
    mocks.readUsdcBalance.mockImplementation(
      () =>
        new Promise<bigint>((resolve) => {
          resolveBalance = resolve
        }),
    )
    mocks.fetchUsdcTransfers.mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          resolveTransfers = resolve
        }),
    )

    setUsdcSessionFromMnemonic(testMnemonic)
    renderProvider()

    await act(async () => {
      clearUsdcSession()
    })

    await act(async () => {
      resolveBalance(BigInt(99_000_000))
      resolveTransfers([{ hash: '0x1', from: '0xa', to: '0xb', amount: BigInt(1), timestamp: 1, direction: 'in' }])
      await Promise.resolve()
    })

    expect(usdc.balance).toBeUndefined()
    expect(usdc.transfers).toEqual([])
  })

  it('defers unlock reconcile while a swap is being created so a moved-quote swap cannot be adopted', async () => {
    // Force reconcile to fall back to Satora (as when a gap exists or databases() is absent)
    vi.stubGlobal('indexedDB', {})
    mocks.reconcileStoredSwaps.mockResolvedValue([record({ id: 'swap-transient', funded: false })])

    beginCreatingSwap()
    try {
      setUsdcSessionFromMnemonic(testMnemonic)
      renderProvider()

      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(mocks.reconcileStoredSwaps).not.toHaveBeenCalled()
      expect(loadUsdcSwaps()).toEqual([])
    } finally {
      endCreatingSwap()
    }
  })

  it('never lets unlock reconcile overwrite a swap already present in the index', async () => {
    vi.stubGlobal('indexedDB', {})
    saveUsdcSwap(record({ id: 'swap-existing', status: 'clientredeemed', funded: true }))
    mocks.reconcileStoredSwaps.mockResolvedValue([
      record({ id: 'swap-existing', status: 'pending', funded: false }),
      record({ id: 'swap-new', status: 'clientfunded', funded: true }),
    ])

    setUsdcSessionFromMnemonic(testMnemonic)
    renderProvider()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    const stored = loadUsdcSwaps()
    expect(stored.find((swap) => swap.id === 'swap-existing')?.status).toBe('clientredeemed')
    expect(stored.find((swap) => swap.id === 'swap-new')?.status).toBe('clientfunded')
  })

  it('does not build a Satora client when locked before drive finishes loading the chunk', async () => {
    saveUsdcSwap(record({ id: 'swap-pending', status: 'clientfunded', funded: true }))
    setUsdcSessionFromMnemonic(testMnemonic)
    renderProvider()

    // Lock synchronously on the same tick while drive()'s dynamic import is still pending
    await act(async () => {
      clearUsdcSession()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(mocks.satoraClient).not.toHaveBeenCalled()
  })
})
