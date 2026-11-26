/**
 * Plain USDC sends, gas paid in USDC.
 *
 * The account is the wallet's own EOA upgraded in place with EIP-7702 to
 * Kernel V3.3, which is the one delegation Satora's gasless funding also
 * accepts, so sending from here never locks the account out of swaps. Each
 * send is a single UserOperation that approves ZeroDev's ERC-20 paymaster for a
 * bounded amount and makes the transfer; the paymaster fronts the ETH and takes
 * its cost back in USDC. The first send carries the 7702 authorization too.
 *
 * This module pulls in viem and the ZeroDev SDK, so it is only ever imported
 * dynamically, from the USDC screens.
 */
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
  getERC20PaymasterApproveCall,
} from '@zerodev/sdk'
import { KERNEL_7702_DELEGATION_ADDRESS, KERNEL_V3_3, getEntryPoint } from '@zerodev/sdk/constants'
import { createPublicClient, encodeFunctionData, erc20Abi, getAddress, http, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { KERNEL_V3_3_DELEGATE, PAYMASTER_ALLOWANCE, USDC_ARBITRUM_ADDRESS, usdcConfig } from './config'
import type { UsdcSession } from './keys'
import { isSendableRecipient } from './recipient'

const entryPoint = getEntryPoint('0.7')

if (KERNEL_7702_DELEGATION_ADDRESS.toLowerCase() !== KERNEL_V3_3_DELEGATE.toLowerCase()) {
  // Satora signs ERC-1271 envelopes only for this delegate; a ZeroDev upgrade
  // that moved it would silently break gasless swap funding.
  throw new Error('ZeroDev Kernel 7702 delegate no longer matches the one Satora supports')
}

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

const buildClients = async (session: UsdcSession) => {
  const { rpcUrl, zerodevRpcUrl } = usdcConfig()
  if (!zerodevRpcUrl) throw new UsdcSendUnavailable()
  const publicClient = createPublicClient({ chain: arbitrum, transport: http(rpcUrl) })
  const signer = privateKeyToAccount(toHex(session.privateKey))
  const account = await createKernelAccount(publicClient, {
    eip7702Account: signer,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  })
  const paymasterClient = createZeroDevPaymasterClient({ chain: arbitrum, transport: http(zerodevRpcUrl) })
  const kernelClient = createKernelAccountClient({
    account,
    chain: arbitrum,
    client: publicClient,
    bundlerTransport: http(zerodevRpcUrl),
    paymaster: {
      getPaymasterData: (userOperation) =>
        paymasterClient.sponsorUserOperation({ userOperation, gasToken: USDC_ARBITRUM_ADDRESS }),
    },
  })
  return { account, kernelClient, paymasterClient }
}

const transferCalls = async (
  paymasterClient: Awaited<ReturnType<typeof buildClients>>['paymasterClient'],
  to: string,
  amount: bigint,
) => [
  await getERC20PaymasterApproveCall(paymasterClient, {
    gasToken: USDC_ARBITRUM_ADDRESS,
    approveAmount: PAYMASTER_ALLOWANCE,
    entryPoint,
  }),
  {
    to: USDC_ARBITRUM_ADDRESS as `0x${string}`,
    value: BigInt(0),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(to), amount] }),
  },
]

/**
 * What the paymaster will take for this send at most, in USDC base units.
 * Prepares the full UserOperation (authorization included) without sending it.
 */
export const estimateUsdcSendFee = async (session: UsdcSession, to: string, amount: bigint): Promise<bigint> => {
  const { account, kernelClient, paymasterClient } = await buildClients(session)
  const userOperation = await kernelClient.prepareUserOperation({
    callData: await account.encodeCalls(await transferCalls(paymasterClient, to, amount)),
  })
  const { amount: fee } = await paymasterClient.estimateGasInERC20({
    userOperation,
    gasTokenAddress: USDC_ARBITRUM_ADDRESS,
    entryPoint: entryPoint.address,
  })
  // `amount` is a float in whole USDC; round up to the next base unit
  return BigInt(Math.ceil(fee * 1_000_000))
}

export interface UsdcSendResult {
  userOpHash: string
  txHash: string
}

export const sendUsdc = async (session: UsdcSession, to: string, amount: bigint): Promise<UsdcSendResult> => {
  if (amount <= BigInt(0)) throw new Error('Amount must be positive')
  if (!isSendableRecipient(to)) throw new Error('Not an address USDC can be sent to')
  const { account, kernelClient, paymasterClient } = await buildClients(session)
  const userOpHash = await kernelClient.sendUserOperation({
    callData: await account.encodeCalls(await transferCalls(paymasterClient, to, amount)),
  })
  let receipt: Awaited<ReturnType<typeof kernelClient.waitForUserOperationReceipt>>
  try {
    receipt = await kernelClient.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 })
  } catch (err) {
    throw new UsdcSendUncertain(userOpHash, err)
  }
  if (!receipt.success) throw new Error('The transfer was included but reverted')
  return { userOpHash, txHash: receipt.receipt.transactionHash }
}
