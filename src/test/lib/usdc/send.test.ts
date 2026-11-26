import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsdcSendUncertain, sendUsdc } from '../../../lib/usdc/send'
import type { UsdcSession } from '../../../lib/usdc/keys'

const mocks = vi.hoisted(() => ({
  sendUserOperation: vi.fn(),
  waitForUserOperationReceipt: vi.fn(),
}))

vi.mock('@zerodev/sdk', () => ({
  createKernelAccount: vi.fn(async () => ({ encodeCalls: vi.fn(async () => '0xdead') })),
  createKernelAccountClient: vi.fn(() => ({
    sendUserOperation: mocks.sendUserOperation,
    waitForUserOperationReceipt: mocks.waitForUserOperationReceipt,
  })),
  createZeroDevPaymasterClient: vi.fn(() => ({ sponsorUserOperation: vi.fn() })),
  getERC20PaymasterApproveCall: vi.fn(async () => ({ to: '0x0', value: BigInt(0), data: '0x' })),
}))

vi.mock('@zerodev/sdk/constants', () => ({
  KERNEL_7702_DELEGATION_ADDRESS: '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28',
  KERNEL_V3_3: '0.3.3',
  getEntryPoint: () => ({ address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', version: '0.7' }),
}))

const session: UsdcSession = {
  address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  privateKey: new Uint8Array(32).fill(7),
  rootXprv: 'xprv-test',
}
const recipient = '0x1111111111111111111111111111111111111111'

describe('USDC gasless sends', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('VITE_ZERODEV_PROJECT_ID', 'test-project')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws UsdcSendUncertain when waiting for the receipt fails after the bundler accepted the UserOp', async () => {
    mocks.sendUserOperation.mockResolvedValue('0xop123')
    mocks.waitForUserOperationReceipt.mockRejectedValue(new Error('timed out'))

    const err = await sendUsdc(session, recipient, BigInt(1_000_000)).catch((caught) => caught)
    expect(err).toBeInstanceOf(UsdcSendUncertain)
    expect((err as UsdcSendUncertain).userOpHash).toBe('0xop123')
  })

  it('does not classify pre-submission rejection or an on-chain revert as uncertain', async () => {
    mocks.sendUserOperation.mockRejectedValueOnce(new Error('AA21 didnt pay prefund'))
    const preSubmitErr = await sendUsdc(session, recipient, BigInt(1_000_000)).catch((caught) => caught)
    expect(preSubmitErr).not.toBeInstanceOf(UsdcSendUncertain)

    mocks.sendUserOperation.mockResolvedValueOnce('0xop456')
    mocks.waitForUserOperationReceipt.mockResolvedValueOnce({ success: false, receipt: { transactionHash: '0xtx' } })
    const revertErr = await sendUsdc(session, recipient, BigInt(1_000_000)).catch((caught) => caught)
    expect(revertErr).not.toBeInstanceOf(UsdcSendUncertain)
    expect(revertErr).toBeInstanceOf(Error)
  })
})
