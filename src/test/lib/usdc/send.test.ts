import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsdcSendUncertain, computeCirclePaymasterMaxFee, estimateUsdcSendFee, sendUsdc } from '../../../lib/usdc/send'
import { CIRCLE_PAYMASTER_V07, PAYMASTER_ALLOWANCE, USDC_ARBITRUM_ADDRESS } from '../../../lib/usdc/config'
import type { UsdcSession } from '../../../lib/usdc/keys'

const mocks = vi.hoisted(() => ({
  prepareUserOperation: vi.fn(),
  sendUserOperation: vi.fn(),
  waitForUserOperationReceipt: vi.fn(),
  readContract: vi.fn(),
  signTypedData: vi.fn(),
  encodeCalls: vi.fn(),
  lastClientConfig: undefined as
    | { paymaster?: { getPaymasterData?: () => Promise<{ paymaster: string; paymasterData: string }> } }
    | undefined,
}))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: mocks.readContract,
      estimateFeesPerGas: vi.fn(async () => ({ maxFeePerGas: BigInt(100_000_000), maxPriorityFeePerGas: BigInt(0) })),
    })),
  }
})

vi.mock('@zerodev/sdk', () => ({
  createKernelAccount: vi.fn(async () => ({
    address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
    encodeCalls: mocks.encodeCalls,
    signTypedData: mocks.signTypedData,
  })),
  createKernelAccountClient: vi.fn((config: unknown) => {
    mocks.lastClientConfig = config as typeof mocks.lastClientConfig
    return {
      prepareUserOperation: mocks.prepareUserOperation,
      sendUserOperation: mocks.sendUserOperation,
      waitForUserOperationReceipt: mocks.waitForUserOperationReceipt,
    }
  }),
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

describe('USDC gasless sends (Circle Paymaster v0.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.encodeCalls.mockResolvedValue('0xdead')
    mocks.signTypedData.mockResolvedValue(`0x00${'ab'.repeat(65)}`)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('computes max USDC gas fee with Circle 10% surcharge rounded up', () => {
    const fee = computeCirclePaymasterMaxFee({
      preVerificationGas: BigInt(79_900),
      verificationGasLimit: BigInt(61_585),
      callGasLimit: BigInt(35_910),
      paymasterVerificationGasLimit: BigInt(422_502),
      paymasterPostOpGasLimit: BigInt(12_370),
      additionalGasCharge: BigInt(35_000),
      maxFeePerGas: BigInt(29_185_200),
      ethUsdPrice: BigInt(169_799_358_155), // $1,697.99358155 (8 decimals)
      oracleDecimals: 8,
    })
    expect(fee).toBe(BigInt(35_284)) // ~$0.035284
  })

  it('estimates fee from prepared UserOperation and Circle Paymaster oracle without needing ZeroDev env vars', async () => {
    mocks.prepareUserOperation.mockResolvedValue({
      preVerificationGas: BigInt(80_000),
      verificationGasLimit: BigInt(60_000),
      callGasLimit: BigInt(36_000),
      paymasterVerificationGasLimit: BigInt(420_000),
      paymasterPostOpGasLimit: BigInt(15_000),
      maxFeePerGas: BigInt(30_000_000),
    })
    mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'nonces') return BigInt(2)
      if (functionName === 'additionalGasCharge') return BigInt(35_000)
      if (functionName === 'oracle') return '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612'
      if (functionName === 'latestRoundData')
        return [BigInt(1), BigInt(200_000_000_000), BigInt(0), BigInt(0), BigInt(1)]
      if (functionName === 'decimals') return 8
      throw new Error(`unexpected readContract: ${functionName}`)
    })

    const fee = await estimateUsdcSendFee(session, recipient, BigInt(1_000_000))
    expect(fee).toBe(BigInt(42_636))

    // Verify paymaster callback packs Circle Paymaster v0.7 permit with live nonce and 66-byte ERC-1271 sig
    const pm = await mocks.lastClientConfig?.paymaster?.getPaymasterData?.()
    expect(pm?.paymaster).toBe(CIRCLE_PAYMASTER_V07)
    expect(pm?.paymasterData.toLowerCase()).toContain(USDC_ARBITRUM_ADDRESS.slice(2).toLowerCase())
    expect(mocks.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryType: 'Permit',
        message: expect.objectContaining({
          spender: CIRCLE_PAYMASTER_V07,
          value: PAYMASTER_ALLOWANCE,
          nonce: BigInt(2),
        }),
      }),
    )
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
