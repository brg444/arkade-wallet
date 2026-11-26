/**
 * Plain USDC sends, gas paid in USDC.
 *
 * The account is the wallet's own EOA upgraded in place with EIP-7702 to
 * Kernel V3.3, which is the one delegation Satora's gasless funding also
 * accepts, so sending from here never locks the account out of swaps. Each
 * send is a single EntryPoint v0.7 UserOperation paid through Circle's
 * permissionless USDC Paymaster v0.7 via an EIP-2612 permit (ERC-1271 wrapped
 * by Kernel V3.3) bounded to `PAYMASTER_ALLOWANCE`; Circle fronts the ETH gas
 * and refunds any unused USDC in `postOp`. The first send carries the 7702
 * authorization too.
 *
 * This module pulls in viem and the Kernel SDK, so it is only ever imported
 * dynamically, from the USDC screens.
 */
import { createKernelAccount, createKernelAccountClient } from '@zerodev/sdk'
import { KERNEL_7702_DELEGATION_ADDRESS, KERNEL_V3_3, getEntryPoint } from '@zerodev/sdk/constants'
import {
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  getAddress,
  http,
  maxUint256,
  parseAbi,
  toHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import {
  CCTP_FINALITY_FAST,
  CCTP_FORWARDING_HOOK_DATA,
  CCTP_TOKEN_MESSENGER_V2,
  CCTP_ZERO_BYTES32,
  evmAddressToBytes32,
  isCrossChainNetwork,
  quoteCctpBridgeFee,
  usdcSendNetwork,
  type UsdcSendNetworkId,
} from './cctp'
import {
  ARBITRUM_CHAIN_ID,
  CIRCLE_PAYMASTER_V07,
  KERNEL_V3_3_DELEGATE,
  PAYMASTER_ALLOWANCE,
  USDC_ARBITRUM_ADDRESS,
  USDC_DECIMALS,
  usdcConfig,
} from './config'
import type { UsdcSession } from './keys'
import { isSendableRecipient } from './recipient'

const entryPoint = getEntryPoint('0.7')

if (KERNEL_7702_DELEGATION_ADDRESS.toLowerCase() !== KERNEL_V3_3_DELEGATE.toLowerCase()) {
  // Satora signs ERC-1271 envelopes only for this delegate; an SDK upgrade
  // that moved it would silently break gasless swap funding.
  throw new Error('Kernel 7702 delegate no longer matches the one Satora supports')
}

/** Circle Paymaster v0.7 operational surcharge on Arbitrum One (10%). */
const CIRCLE_PAYMASTER_SURCHARGE_NUM = BigInt(110)
const CIRCLE_PAYMASTER_SURCHARGE_DEN = BigInt(100)
/**
 * Headroom added on top of Circle Paymaster's `additionalGasCharge` (35,000)
 * for `paymasterPostOpGasLimit`. Circle reverts in `_validatePaymasterUserOp`
 * (`0x5ff4afc1`) whenever `paymasterPostOpGasLimit < additionalGasCharge`,
 * while bundler simulations often estimate raw `_postOp` gas below 35,000.
 */
const CIRCLE_POST_OP_GAS_BUFFER = BigInt(15_000)
const ETH_DECIMALS = 18

const CIRCLE_PAYMASTER_ABI = parseAbi([
  'function additionalGasCharge() view returns (uint256)',
  'function oracle() view returns (address)',
])
const CHAINLINK_ORACLE_ABI = parseAbi([
  'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function decimals() view returns (uint8)',
])
const USDC_NONCES_ABI = parseAbi(['function nonces(address owner) view returns (uint256)'])
const TOKEN_MESSENGER_V2_ABI = parseAbi([
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) external',
])

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const USDC_PERMIT_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: ARBITRUM_CHAIN_ID,
  verifyingContract: USDC_ARBITRUM_ADDRESS as `0x${string}`,
} as const

export class UsdcSendUnavailable extends Error {
  constructor() {
    super('USDC sends are not configured on this deployment')
    this.name = 'UsdcSendUnavailable'
  }
}

/**
 * The UserOperation was accepted by the bundler, then waiting for its receipt
 * failed or timed out. The transfer may still land on Arbitrum, so the caller
 * must not claim funds stayed put or offer a second Send tap.
 */
export class UsdcSendUncertain extends Error {
  readonly userOpHash: string
  constructor(userOpHash: string, cause: unknown) {
    super('the send was submitted but did not confirm in time')
    this.name = 'UsdcSendUncertain'
    this.userOpHash = userOpHash
    this.cause = cause
  }
}

interface PimlicoGasPriceResponse {
  fast?: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` }
}

/**
 * Computes the maximum USDC base units Circle Paymaster v0.7 can charge for a
 * prepared UserOperation, including `additionalGasCharge` and Circle's 10%
 * surcharge, rounded up to the next base unit.
 */
export const computeCirclePaymasterMaxFee = ({
  preVerificationGas,
  verificationGasLimit,
  callGasLimit,
  paymasterVerificationGasLimit,
  paymasterPostOpGasLimit,
  additionalGasCharge,
  maxFeePerGas,
  ethUsdPrice,
  oracleDecimals,
}: {
  preVerificationGas: bigint
  verificationGasLimit: bigint
  callGasLimit: bigint
  paymasterVerificationGasLimit: bigint
  paymasterPostOpGasLimit: bigint
  additionalGasCharge: bigint
  maxFeePerGas: bigint
  ethUsdPrice: bigint
  oracleDecimals: number
}): bigint => {
  if (ethUsdPrice <= BigInt(0)) throw new Error('ETH/USD oracle returned a non-positive price')
  const totalGas =
    preVerificationGas +
    verificationGasLimit +
    callGasLimit +
    paymasterVerificationGasLimit +
    paymasterPostOpGasLimit +
    additionalGasCharge
  const maxEthWei = totalGas * maxFeePerGas
  const scale = BigInt(10) ** BigInt(ETH_DECIMALS + oracleDecimals - USDC_DECIMALS) * CIRCLE_PAYMASTER_SURCHARGE_DEN
  return (maxEthWei * ethUsdPrice * CIRCLE_PAYMASTER_SURCHARGE_NUM + scale - BigInt(1)) / scale
}

const buildClients = async (session: UsdcSession) => {
  const { rpcUrl, bundlerUrl } = usdcConfig()
  if (!bundlerUrl) throw new UsdcSendUnavailable()
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) })
  const signer = privateKeyToAccount(toHex(session.privateKey))
  const account = await createKernelAccount(publicClient, {
    eip7702Account: signer,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  })
  const signCirclePaymasterData = async () => {
    const nonce = await publicClient.readContract({
      address: USDC_ARBITRUM_ADDRESS as `0x${string}`,
      abi: USDC_NONCES_ABI,
      functionName: 'nonces',
      args: [account.address],
    })
    // Under EIP-7702 Kernel V3.3, Arbitrum USDC v2.2 verifies permits via
    // ERC-1271 `isValidSignature`; `account.signTypedData` produces Kernel's
    // 66-byte `0x00 || sig` envelope that succeeds on both first and later sends.
    const signature = await account.signTypedData({
      domain: USDC_PERMIT_DOMAIN,
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: {
        owner: account.address,
        spender: CIRCLE_PAYMASTER_V07 as `0x${string}`,
        value: PAYMASTER_ALLOWANCE,
        nonce,
        deadline: maxUint256,
      },
    })
    return encodePacked(
      ['uint8', 'address', 'uint256', 'bytes'],
      [0, USDC_ARBITRUM_ADDRESS as `0x${string}`, PAYMASTER_ALLOWANCE, signature],
    )
  }
  const kernelClient = createKernelAccountClient({
    account,
    chain: arbitrum,
    client: publicClient,
    bundlerTransport: http(bundlerUrl),
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        try {
          const request = bundlerClient.request as (args: {
            method: string
            params: unknown[]
          }) => Promise<PimlicoGasPriceResponse>
          const prices = await request({ method: 'pimlico_getUserOperationGasPrice', params: [] })
          if (prices.fast?.maxFeePerGas && prices.fast?.maxPriorityFeePerGas) {
            return {
              maxFeePerGas: BigInt(prices.fast.maxFeePerGas),
              maxPriorityFeePerGas: BigInt(prices.fast.maxPriorityFeePerGas),
            }
          }
        } catch {
          // Non-Pimlico bundlers fall back to standard EIP-1559 fee estimation.
        }
        const fees = await publicClient.estimateFeesPerGas()
        return {
          maxFeePerGas: (fees.maxFeePerGas * BigInt(150)) / BigInt(100),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      },
    },
    paymaster: {
      // Omit `paymasterVerificationGasLimit` so `prepareUserOperation` keeps
      // the bundler's live estimate (~422k gas for ERC-1271 permit + oracle),
      // while setting `paymasterPostOpGasLimit` above `additionalGasCharge` so
      // Circle Paymaster's minimum-postOp check never reverts on submission.
      getPaymasterData: async () => {
        const [paymasterData, additionalGasCharge] = await Promise.all([
          signCirclePaymasterData(),
          publicClient.readContract({
            address: CIRCLE_PAYMASTER_V07 as `0x${string}`,
            abi: CIRCLE_PAYMASTER_ABI,
            functionName: 'additionalGasCharge',
          }),
        ])
        return {
          paymaster: CIRCLE_PAYMASTER_V07 as `0x${string}`,
          paymasterData,
          paymasterPostOpGasLimit: additionalGasCharge + CIRCLE_POST_OP_GAS_BUFFER,
        }
      },
    },
  })
  return { account, kernelClient, publicClient }
}

const buildSendCalls = (to: string, amount: bigint, network: UsdcSendNetworkId, bridgeFee: bigint) => {
  if (!isCrossChainNetwork(network)) {
    return [
      {
        to: USDC_ARBITRUM_ADDRESS as `0x${string}`,
        value: BigInt(0),
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] }),
      },
    ]
  }
  // Cross-chain sends via Circle CCTP V2 + Forwarding Service: Circle deducts
  // the actual fast-transfer + forwarding fee (<= `bridgeFee`) from the burned
  // amount on destination mint, so burning `amount + bridgeFee` guarantees the
  // recipient receives at least `amount` with zero gas needed on destination.
  const dest = usdcSendNetwork(network)
  const burnAmount = amount + bridgeFee
  return [
    {
      to: USDC_ARBITRUM_ADDRESS as `0x${string}`,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [CCTP_TOKEN_MESSENGER_V2 as `0x${string}`, burnAmount],
      }),
    },
    {
      to: CCTP_TOKEN_MESSENGER_V2 as `0x${string}`,
      value: BigInt(0),
      data: encodeFunctionData({
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: 'depositForBurnWithHook',
        args: [
          burnAmount,
          dest.cctpDomain,
          evmAddressToBytes32(getAddress(to)),
          USDC_ARBITRUM_ADDRESS as `0x${string}`,
          CCTP_ZERO_BYTES32 as `0x${string}`,
          bridgeFee,
          CCTP_FINALITY_FAST,
          CCTP_FORWARDING_HOOK_DATA as `0x${string}`,
        ],
      }),
    },
  ]
}

export interface UsdcSendFeeQuote {
  /** Maximum USDC base units Circle Paymaster v0.7 may pull for Arbitrum gas. */
  gasFee: bigint
  /** Maximum USDC base units Circle CCTP V2 + Forwarding Service may take (0 on Arbitrum). */
  bridgeFee: bigint
  /** Combined maximum fee (`gasFee + bridgeFee`). */
  totalFee: bigint
  /** Present on cross-chain sends: whether `bridgeFee` came from live Circle IRIS or baseline fallback. */
  bridgeFeeSource?: 'iris' | 'fallback'
}

/**
 * Quotes the maximum USDC fee for this send. On Arbitrum that is Circle
 * Paymaster v0.7 gas alone; on other supported networks it adds Circle CCTP V2
 * fast-transfer + Forwarding Service delivery fees. Prepares the full
 * UserOperation (authorization and permit included) without sending it.
 */
export const estimateUsdcSendFee = async (
  session: UsdcSession,
  to: string,
  amount: bigint,
  network: UsdcSendNetworkId = 'arbitrum',
): Promise<UsdcSendFeeQuote> => {
  const [{ account, kernelClient, publicClient }, bridgeQuote] = await Promise.all([
    buildClients(session),
    quoteCctpBridgeFee(network, amount),
  ])
  const calls = buildSendCalls(to, amount, network, bridgeQuote.maxFee)
  const [userOperation, additionalGasCharge, oracleAddress] = await Promise.all([
    kernelClient.prepareUserOperation({
      callData: await account.encodeCalls(calls),
    }),
    publicClient.readContract({
      address: CIRCLE_PAYMASTER_V07 as `0x${string}`,
      abi: CIRCLE_PAYMASTER_ABI,
      functionName: 'additionalGasCharge',
    }),
    publicClient.readContract({
      address: CIRCLE_PAYMASTER_V07 as `0x${string}`,
      abi: CIRCLE_PAYMASTER_ABI,
      functionName: 'oracle',
    }),
  ])
  const [roundData, oracleDecimals] = await Promise.all([
    publicClient.readContract({
      address: oracleAddress,
      abi: CHAINLINK_ORACLE_ABI,
      functionName: 'latestRoundData',
    }),
    publicClient.readContract({
      address: oracleAddress,
      abi: CHAINLINK_ORACLE_ABI,
      functionName: 'decimals',
    }),
  ])
  const gasFee = computeCirclePaymasterMaxFee({
    preVerificationGas: userOperation.preVerificationGas ?? BigInt(0),
    verificationGasLimit: userOperation.verificationGasLimit ?? BigInt(0),
    callGasLimit: userOperation.callGasLimit ?? BigInt(0),
    paymasterVerificationGasLimit: userOperation.paymasterVerificationGasLimit ?? BigInt(0),
    paymasterPostOpGasLimit: userOperation.paymasterPostOpGasLimit ?? BigInt(0),
    additionalGasCharge,
    maxFeePerGas: userOperation.maxFeePerGas ?? BigInt(0),
    ethUsdPrice: roundData[1],
    oracleDecimals: Number(oracleDecimals),
  })
  return {
    gasFee,
    bridgeFee: bridgeQuote.maxFee,
    totalFee: gasFee + bridgeQuote.maxFee,
    ...(isCrossChainNetwork(network) ? { bridgeFeeSource: bridgeQuote.source } : {}),
  }
}

export interface UsdcSendOptions {
  network?: UsdcSendNetworkId
  /** Explicit CCTP V2 `maxFee` ceiling from the shown quote (used as-is on cross-chain sends). */
  bridgeFee?: bigint
}

export interface UsdcSendResult {
  userOpHash: string
  txHash: string
  network: UsdcSendNetworkId
  bridgeFee: bigint
}

export const sendUsdc = async (
  session: UsdcSession,
  to: string,
  amount: bigint,
  options?: UsdcSendOptions,
): Promise<UsdcSendResult> => {
  if (amount <= BigInt(0)) throw new Error('Amount must be positive')
  if (!isSendableRecipient(to)) throw new Error('Not an address USDC can be sent to')
  const network = options?.network ?? 'arbitrum'
  const bridgeFee = isCrossChainNetwork(network)
    ? options?.bridgeFee !== undefined && options.bridgeFee > BigInt(0)
      ? options.bridgeFee
      : (await quoteCctpBridgeFee(network, amount)).maxFee
    : BigInt(0)
  const { account, kernelClient } = await buildClients(session)
  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls(buildSendCalls(to, amount, network, bridgeFee)),
  })
  let receipt: Awaited<ReturnType<typeof kernelClient.waitForUserOperationReceipt>>
  try {
    receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 })
  } catch (err) {
    throw new UsdcSendUncertain(userOpHash, err)
  }
  if (!receipt.success) throw new Error('The transfer was included but reverted')
  return { userOpHash, txHash: receipt.receipt.transactionHash, network, bridgeFee }
}
