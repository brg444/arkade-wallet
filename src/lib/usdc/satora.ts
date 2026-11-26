/**
 * Swaps between Bitcoin on Arkade and USDC on Arbitrum, through Satora.
 *
 * Both directions are gasless. Bitcoin → USDC: the wallet funds Satora's VHTLC
 * on Arkade, Satora locks the EVM side, and a gasless claim swaps it into USDC
 * paid to the account. USDC → Bitcoin: the account signs a Permit2 witness
 * (plus a one-time EIP-2612 permit), Satora's relayer pulls the USDC into the
 * HTLC, and the wallet claims the Bitcoin on Arkade.
 *
 * The client is built from the BIP-32 root as an xprv, which Satora never
 * persists; it derives the same `m/44'/60'/0'/0/0` key the account uses, so
 * swaps fund from and pay into the address that shows the balance. Only its
 * per-swap key index and swap secrets are stored, in its own IndexedDB.
 *
 * Imported dynamically only: the SDK is large.
 */
import { Asset, Client, IdbSwapStorage, IdbWalletStorage } from '@lendasat/lendaswap-sdk-pure'
import { ARBITRUM_CHAIN_ID, USDC_ARBITRUM_ADDRESS, usdcConfig } from './config'
import type { UsdcSession } from './keys'
import { needsClaim, needsRefund, type UsdcSwapRecord } from './swaps'

let cached: { xprv: string; arkServerUrl: string; client: Promise<Client> } | undefined

export const satoraClient = (session: UsdcSession, arkServerUrl: string): Promise<Client> => {
  if (cached && cached.xprv === session.rootXprv && cached.arkServerUrl === arkServerUrl) return cached.client
  let builder = Client.builder()
    .withSignerStorage(new IdbWalletStorage())
    .withSwapStorage(new IdbSwapStorage())
    .withXprv(session.rootXprv)
    .withArkadeServerUrl(arkServerUrl)
  const { satoraApiUrl } = usdcConfig()
  if (satoraApiUrl) builder = builder.withBaseUrl(satoraApiUrl)
  const client = builder.build()
  cached = { xprv: session.rootXprv, arkServerUrl, client }
  client.catch(() => {
    if (cached?.client === client) cached = undefined
  })
  return client
}

export const forgetSatoraClient = (): void => {
  cached = undefined
}

export interface UsdcSwapQuote {
  /** What the person sends and gets after every fee, in sats or USDC base
   * units according to the direction. */
  sourceAmount: bigint
  targetAmount: bigint
  /** Satora bounds a swap by its Bitcoin side, in sats, in both directions. */
  minSats: bigint
  maxSats: bigint
  /** Protocol and network fees, in sats. */
  feeSats: number
}

type QuoteResponse = Awaited<ReturnType<Client['getQuote']>>

export const toUsdcSwapQuote = (quote: QuoteResponse): UsdcSwapQuote => ({
  sourceAmount: toBigInt(quote.net_source_amount || quote.source_amount),
  targetAmount: toBigInt(quote.net_target_amount || quote.target_amount),
  minSats: toBigInt(quote.min_amount),
  maxSats: toBigInt(quote.max_amount),
  feeSats: quote.protocol_fee + quote.network_fee + quote.gasless_network_fee,
})

type QuoteChain = Parameters<Client['getQuote']>[0]['sourceChain']
const ARKADE_CHAIN = 'Arkade' as QuoteChain
const ARBITRUM_CHAIN = String(ARBITRUM_CHAIN_ID) as QuoteChain

const toBigInt = (value: string | number | undefined): bigint => {
  if (value === undefined || value === '') return BigInt(0)
  return BigInt(typeof value === 'number' ? Math.round(value) : value.split('.')[0])
}

export const quoteToUsdc = async (client: Client, sats: bigint): Promise<UsdcSwapQuote> => {
  const quote = await client.getQuote({
    sourceChain: ARKADE_CHAIN,
    sourceToken: Asset.BTC_ARKADE.tokenId,
    targetChain: ARBITRUM_CHAIN,
    targetToken: USDC_ARBITRUM_ADDRESS,
    sourceAmount: sats,
  })
  return toUsdcSwapQuote(quote)
}

export const quoteToArkade = async (client: Client, usdc: bigint): Promise<UsdcSwapQuote> => {
  const quote = await client.getQuote({
    sourceChain: ARBITRUM_CHAIN,
    sourceToken: USDC_ARBITRUM_ADDRESS,
    targetChain: ARKADE_CHAIN,
    targetToken: Asset.BTC_ARKADE.tokenId,
    sourceAmount: usdc,
  })
  return toUsdcSwapQuote(quote)
}

const swapContracts = (response: { evm_coordinator_address?: string; evm_htlc_address?: string }): string[] =>
  [response.evm_coordinator_address, response.evm_htlc_address]
    .filter((address): address is string => !!address)
    .map((address) => address.toLowerCase())

export interface ToUsdcSwap {
  record: UsdcSwapRecord
  /** The Arkade address the wallet must send `fundSats` to. */
  vhtlcAddress: string
  fundSats: number
}

/** Creates a Bitcoin → USDC swap. The caller funds it from the Arkade wallet. */
export const createToUsdcSwap = async (
  client: Client,
  session: UsdcSession,
  sats: bigint,
  refundArkAddress: string,
): Promise<ToUsdcSwap> => {
  const { response } = await client.createArkadeToEvmSwapGeneric({
    targetAddress: session.address,
    tokenAddress: USDC_ARBITRUM_ADDRESS,
    evmChainId: ARBITRUM_CHAIN_ID,
    sourceAmount: sats,
    gasless: true,
  })
  const now = Date.now()
  return {
    vhtlcAddress: response.btc_vhtlc_address,
    fundSats: Number(response.source_amount),
    record: {
      id: response.id,
      direction: 'toUsdc',
      createdAt: now,
      updatedAt: now,
      sourceAmount: response.source_amount,
      targetAmount: response.target_amount,
      status: response.status,
      arkAddress: refundArkAddress,
      funded: false,
      counterparties: swapContracts(response),
    },
  }
}

/**
 * Creates a USDC → Bitcoin swap. Fund it with {@link fundToArkadeSwap} once the
 * record is saved, so a funding call that lands but never answers still leaves
 * a swap the resume loop can see through.
 */
export const createToArkadeSwap = async (
  client: Client,
  session: UsdcSession,
  usdc: bigint,
  arkAddress: string,
): Promise<UsdcSwapRecord> => {
  const { response } = await client.createEvmToArkadeSwapGeneric({
    targetAddress: arkAddress,
    tokenAddress: USDC_ARBITRUM_ADDRESS,
    evmChainId: ARBITRUM_CHAIN_ID,
    userAddress: session.address,
    sourceAmount: usdc,
    gasless: true,
  })
  const now = Date.now()
  const record: UsdcSwapRecord = {
    id: response.id,
    direction: 'toArkade',
    createdAt: now,
    updatedAt: now,
    sourceAmount: response.source_amount,
    targetAmount: response.target_amount,
    status: response.status,
    arkAddress,
    funded: false,
    counterparties: swapContracts(response),
  }
  return record
}

/** Funds a USDC → Bitcoin swap through Satora's gasless Permit2 relay. */
export const fundToArkadeSwap = async (client: Client, swapId: string): Promise<void> => {
  await client.fundSwapGasless(swapId)
}

/**
 * Moves one swap forward: refreshes its status, claims once Satora has locked
 * its side, and refunds when the swap can no longer complete. Returns the
 * updated record plus any follow-up swap a refund continued into. Safe to call
 * repeatedly; every step is idempotent on Satora's side.
 */
export const advanceUsdcSwap = async (
  client: Client,
  record: UsdcSwapRecord,
): Promise<{ record: UsdcSwapRecord; continued?: UsdcSwapRecord }> => {
  const swap = await client.getSwap(record.id, { updateStorage: true })
  let next: UsdcSwapRecord = { ...record, status: swap.status, updatedAt: Date.now(), error: undefined }
  // Satora sees the Arkade funding before the wallet records it on a reload
  if (!next.funded && !['pending', 'expired'].includes(swap.status)) next = { ...next, funded: true }

  if (needsClaim(next)) {
    if (next.direction === 'toUsdc') await client.claim(next.id)
    else await client.claimArkade(next.id, { destinationAddress: next.arkAddress })
    const after = await client.getSwap(next.id, { updateStorage: true })
    return { record: { ...next, status: after.status, updatedAt: Date.now() } }
  }

  if (needsRefund(next)) {
    if (next.direction === 'toUsdc') {
      await client.refundSwap(next.id, { destinationAddress: next.arkAddress })
      const after = await client.getSwap(next.id, { updateStorage: true })
      return { record: { ...next, status: after.status, updatedAt: Date.now() } }
    }
    // An EVM-sourced refund returns the HTLC's lock token, not USDC, so rather
    // than strand it, swap the refund on to the Arkade address it was meant for.
    await client.collabRefundEvmSwap(next.id)
    const after = await client.getSwap(next.id, { updateStorage: true })
    const refunded = { ...next, status: after.status, updatedAt: Date.now() }
    const continuation = await client.continueRefundedEvmSwap(next.id, {
      targetAddress: next.arkAddress,
      target: 'arkade',
    })
    const now = Date.now()
    return {
      record: refunded,
      continued: {
        id: continuation.newSwapId,
        direction: 'toArkade',
        createdAt: now,
        updatedAt: now,
        sourceAmount: next.sourceAmount,
        targetAmount: next.targetAmount,
        status: 'clientfundingseen',
        arkAddress: next.arkAddress,
        funded: true,
        counterparties: next.counterparties,
      },
    }
  }

  return { record: next }
}
