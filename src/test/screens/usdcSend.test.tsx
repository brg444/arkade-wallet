import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UsdcSend from '../../screens/Wallet/Usdc/Send'
import { UsdcContext } from '../../providers/usdc'
import { LanguageProvider } from '../../providers/language'
import { UsdcSendUncertain } from '../../lib/usdc/send'
import type { UsdcSession } from '../../lib/usdc/keys'

const mocks = vi.hoisted(() => ({
  estimateUsdcSendFee: vi.fn(),
  sendUsdc: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('../../lib/usdc/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/usdc/send')>()
  return {
    ...actual,
    estimateUsdcSendFee: (...args: unknown[]) => mocks.estimateUsdcSendFee(...args),
    sendUsdc: (...args: unknown[]) => mocks.sendUsdc(...args),
  }
})

vi.mock('../../components/SheetModal', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => (isOpen ? children : null),
}))

vi.mock('../../components/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/Toast')>()),
  toast: Object.assign((...args: unknown[]) => mocks.toastSuccess(...args), {
    error: (...args: unknown[]) => mocks.toastError(...args),
  }),
}))

const session: UsdcSession = {
  address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  privateKey: new Uint8Array(32).fill(7),
  rootXprv: 'xprv-test',
}
const recipient = '0x1111111111111111111111111111111111111111'

const renderSend = (balance = BigInt(50_000_000)) => {
  const back = vi.fn()
  const refresh = vi.fn(async () => {})
  render(
    <LanguageProvider>
      <UsdcContext.Provider
        value={{
          available: true,
          session,
          address: session.address,
          balance,
          transfers: [],
          swaps: [],
          refresh,
          recordSwap: vi.fn(),
        }}
      >
        <UsdcSend back={back} />
      </UsdcContext.Provider>
    </LanguageProvider>,
  )
  return { back, refresh }
}

describe('UsdcSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.estimateUsdcSendFee.mockResolvedValue({
      gasFee: BigInt(10_000),
      bridgeFee: BigInt(0),
      totalFee: BigInt(10_000),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('closes Send and warns instead of claiming funds stayed put when confirmation is uncertain', async () => {
    mocks.sendUsdc.mockRejectedValue(new UsdcSendUncertain('0xop123', new Error('timeout')))
    const { back, refresh } = renderSend()

    fireEvent.change(screen.getByPlaceholderText('0x…'), { target: { value: recipient } })
    fireEvent.change(screen.getByTestId('usdc-amount'), { target: { value: '10' } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })

    const sendButton = screen.getByTestId('usdc-send')
    expect(sendButton).not.toBeDisabled()

    await act(async () => {
      fireEvent.click(sendButton)
    })

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining('Check your USD activity'),
      expect.objectContaining({ duration: 8000 }),
    )
    expect(refresh).toHaveBeenCalled()
    expect(back).toHaveBeenCalled()
    expect(screen.queryByText(/money is still in your account/i)).toBeNull()
  })

  it('routes cross-chain Ethereum sends through CCTP V2 without tripping the Arbitrum paymaster allowance cap', async () => {
    mocks.estimateUsdcSendFee.mockResolvedValue({
      gasFee: BigInt(40_000), // $0.04 Arbitrum paymaster gas (under $1 allowance)
      bridgeFee: BigInt(1_500_000), // $1.50 Ethereum forwarding fee (paid from burn, NOT paymaster)
      totalFee: BigInt(1_540_000),
      bridgeFeeSource: 'iris',
    })
    mocks.sendUsdc.mockResolvedValue({
      userOpHash: '0xop-eth',
      txHash: '0xtx-eth',
      network: 'ethereum',
      bridgeFee: BigInt(1_500_000),
    })
    const { back, refresh } = renderSend(BigInt(50_000_000))

    fireEvent.click(screen.getByTestId('usdc-network'))
    fireEvent.click(screen.getByText('Ethereum'))
    fireEvent.change(screen.getByPlaceholderText('0x…'), { target: { value: recipient } })
    fireEvent.change(screen.getByTestId('usdc-amount'), { target: { value: '10' } })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })

    expect(mocks.estimateUsdcSendFee).toHaveBeenLastCalledWith(session, recipient, BigInt(10_000_000), 'ethereum')
    expect(screen.getByText('1.54 USD')).toBeInTheDocument()
    expect(screen.getByText(/Circle CCTP/)).toBeInTheDocument()

    const sendButton = screen.getByTestId('usdc-send')
    expect(sendButton).not.toBeDisabled()

    await act(async () => {
      fireEvent.click(sendButton)
    })

    expect(mocks.sendUsdc).toHaveBeenCalledWith(session, recipient, BigInt(10_000_000), {
      network: 'ethereum',
      bridgeFee: BigInt(1_500_000),
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sent 10.00 USD to Ethereum')
    expect(refresh).toHaveBeenCalled()
    expect(back).toHaveBeenCalled()
  })

  it('reserves the selected network baseline bridge fee when tapping Max', () => {
    renderSend(BigInt(10_000_000))
    fireEvent.click(screen.getByTestId('usdc-network'))
    fireEvent.click(screen.getByText('Ethereum'))
    fireEvent.click(screen.getByText('Max'))
    // 10.00 - 0.05 gas buffer - 1.50 Ethereum forwarding baseline = 8.45
    expect((screen.getByTestId('usdc-amount') as HTMLInputElement).value).toBe('8.45')
  })
})
