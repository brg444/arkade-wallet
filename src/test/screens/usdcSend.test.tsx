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

describe('UsdcSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.stubEnv('VITE_ZERODEV_PROJECT_ID', 'test-project')
    mocks.estimateUsdcSendFee.mockResolvedValue(BigInt(10_000))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('closes Send and warns instead of claiming funds stayed put when confirmation is uncertain', async () => {
    mocks.sendUsdc.mockRejectedValue(new UsdcSendUncertain('0xop123', new Error('timeout')))
    const back = vi.fn()
    const refresh = vi.fn(async () => {})

    render(
      <LanguageProvider>
        <UsdcContext.Provider
          value={{
            available: true,
            session,
            address: session.address,
            balance: BigInt(50_000_000),
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
})
