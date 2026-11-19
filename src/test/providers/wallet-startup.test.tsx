import { act, render, waitFor } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletContext, WalletProvider } from '../../providers/wallet'
import { AspContext } from '../../providers/asp'
import { ConfigContext } from '../../providers/config'
import { mockAspContextValue, mockConfigContextValue } from '../screens/mocks'

// A fresh service per test: a provider outlives its test (its status ping keeps running), and must
// not count toward the next test's reloads.
const makeService = () => {
  const sync: { state: { lastSyncedAt?: number } } = { state: {} }
  return {
    sync,
    activity: { use: vi.fn() },
    getVtxoManager: vi.fn().mockResolvedValue({ renewVtxos: async () => {} }),
    getStatus: vi.fn().mockResolvedValue({ walletInitialized: true }),
    getVtxos: vi.fn().mockResolvedValue([]),
    getActivityHistory: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn().mockResolvedValue({ total: 0, available: 0, unrolled: 0, assets: [], availableAssets: [] }),
    assetManager: { getAssetDetails: vi.fn() },
    getContractManager: vi.fn(async () => ({ getSyncState: () => sync.state })),
  }
}

const mocks = vi.hoisted(() => {
  const current = { service: undefined as unknown as ReturnType<typeof makeService> }
  return { current, setup: vi.fn(async () => current.service) }
})

vi.mock('@arkade-os/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arkade-os/sdk')>()),
  ServiceWorkerWallet: { setup: mocks.setup },
  IndexedDBWalletRepository: class {
    async getWalletState() {
      return null
    }
  },
  IndexedDBContractRepository: class {},
}))

let wallet: React.ContextType<typeof WalletContext>
function Capture() {
  wallet = useContext(WalletContext)
  return null
}

const startWallet = async () => {
  render(
    <AspContext.Provider value={mockAspContextValue}>
      <ConfigContext.Provider value={mockConfigContextValue}>
        <WalletProvider>
          <Capture />
        </WalletProvider>
      </ConfigContext.Provider>
    </AspContext.Provider>,
  )
  await act(() => wallet.initWallet({ privateKey: new Uint8Array(32).fill(1) }))
}

// reloadWallet is the only caller of an unfiltered getVtxos()
const reloads = () => mocks.current.service.getVtxos.mock.calls.filter((args) => args.length === 0).length

beforeEach(() => {
  vi.clearAllMocks()
  mocks.current.service = makeService()
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: async () => undefined, addEventListener: vi.fn(), removeEventListener: vi.fn() },
  })
})
afterEach(() => vi.unstubAllGlobals())

it('starts the worker without holding the boot on contract sync', async () => {
  await startWallet()

  expect(mocks.setup).toHaveBeenCalledWith(expect.objectContaining({ lazyInitialization: true }))
})

const load = () => act(() => wallet.reloadWallet(mocks.current.service as never))
const syncLands = () => {
  mocks.current.service.sync.state = { lastSyncedAt: Date.now() }
}
/** Wait until the provider has looked at the sync state since `since` looks. */
const looked = async (since: number) =>
  vi.waitFor(() => expect(mocks.current.service.getContractManager.mock.calls.length).toBeGreaterThan(since), {
    timeout: 3000,
  })

describe('the syncing line', () => {
  it('stays until a load that started after the first sync has landed', async () => {
    await startWallet()
    await load()
    expect(wallet.syncing).toBe(true)
    const before = reloads()

    syncLands()

    // Nothing was reading when the sync landed, so a load is started for it.
    await vi.waitFor(() => expect(wallet.syncing).toBe(false), { timeout: 3000 })
    expect(reloads()).toBe(before + 1)
  })

  it('goes with the first load when the sync lands before it, without another', async () => {
    syncLands()
    await startWallet()
    await looked(0)
    expect(wallet.syncing).toBe(true)
    const before = reloads()

    await load()

    expect(wallet.syncing).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(reloads()).toBe(before + 1)
  })

  it('loads once more when the sync lands while a load is reading', async () => {
    await startWallet()
    await load()
    let answer: (coins: never[]) => void = () => {}
    mocks.current.service.getVtxos.mockReturnValueOnce(new Promise<never[]>((resolve) => (answer = resolve)))
    const before = reloads()
    let reading = Promise.resolve()
    act(() => {
      reading = wallet.reloadWallet(mocks.current.service as never)
    })

    const looks = mocks.current.service.getContractManager.mock.calls.length
    syncLands()
    await looked(looks)
    expect(wallet.syncing).toBe(true)
    answer([])
    await act(() => reading)

    expect(wallet.syncing).toBe(false)
    expect(reloads()).toBe(before + 2)
  })

  it('is looked for straight away, not only on the one-second ping', async () => {
    await startWallet()
    await load()
    const started = performance.now()

    syncLands()

    await vi.waitFor(() => expect(wallet.syncing).toBe(false), { timeout: 3000 })
    expect(performance.now() - started).toBeLessThan(900)
  })
})

it.each(['vtxo_received', 'vtxo_spent'])('reloads when a contract event reports %s', async (eventType) => {
  await startWallet()
  const before = reloads()
  const onMessage = vi
    .mocked(navigator.serviceWorker.addEventListener)
    .mock.calls.filter(([type]) => type === 'message')
    .at(-1)![1] as (event: MessageEvent) => void

  onMessage({ data: { type: 'CONTRACT_EVENT', payload: { event: { type: eventType } } } } as MessageEvent)

  await vi.waitFor(() => expect(reloads()).toBe(before + 1), { timeout: 3000 })
})

it('prefetches newly referenced assets after overlapping wallet reloads', async () => {
  localStorage.clear()
  await startWallet()

  const first = 'a'.repeat(68)
  const second = 'b'.repeat(68)
  const third = 'c'.repeat(68)
  let releaseFirst: () => void = () => {}
  const firstRequest = new Promise<void>((resolve) => (releaseFirst = resolve))
  const getAssetDetails = vi.fn(async (assetId: string) => {
    if (assetId === first) await firstRequest
    return { assetId, metadata: { name: `Asset ${assetId[0]}`, ticker: assetId[0].toUpperCase(), decimals: 0 } }
  })
  let assets = [{ assetId: first, amount: 1n }]
  const service = {
    ...mocks.current.service,
    getActivityHistory: vi.fn().mockResolvedValue([]),
    getBalance: vi.fn(async () => ({ total: 0, available: 0, unrolled: 0, assets, availableAssets: assets })),
    assetManager: { getAssetDetails },
  }

  await act(() => wallet.reloadWallet(service as never))
  await waitFor(() => expect(getAssetDetails).toHaveBeenCalledWith(first))

  assets = [{ assetId: second, amount: 1n }]
  await act(() => wallet.reloadWallet(service as never))
  assets = [
    { assetId: second, amount: 1n },
    { assetId: third, amount: 1n },
  ]
  await act(() => wallet.reloadWallet(service as never))
  expect(getAssetDetails).toHaveBeenCalledTimes(1)

  await act(async () => releaseFirst())
  await waitFor(() => expect(wallet.assetMetadataCache.get(second)?.metadata?.name).toBe('Asset b'))
  await waitFor(() => expect(wallet.assetMetadataCache.get(third)?.metadata?.name).toBe('Asset c'))
  expect(getAssetDetails).toHaveBeenCalledTimes(3)
})
