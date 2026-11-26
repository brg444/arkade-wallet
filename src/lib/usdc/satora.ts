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
import {
  CONTINUATION_WINDOW_MS,
  blindRefundDue,
  isRefundedStatus,
  isUnfundedStatus,
  needsClaim,
  needsContinuation,
  needsRefund,
  registerSatoraLifecycle,
  type UsdcSwapDirection,
  type UsdcSwapRecord,
} from './swaps'

// Keyed by the account address, never by the root key: the only copy of the
// xprv outside the session is the one inside the client, and it is dropped
// with the client on lock and reset.
let cached:
  | {
      address: string
      arkServerUrl: string
      client: Promise<Client>
      signerStorage: IdbWalletStorage
      swapStorage: IdbSwapStorage
    }
  | undefined

export const satoraClient = (session: UsdcSession, arkServerUrl: string): Promise<Client> => {
  if (cached && cached.address === session.address && cached.arkServerUrl === arkServerUrl) return cached.client
  const signerStorage = new IdbWalletStorage()
  const swapStorage = new IdbSwapStorage()
  let builder = Client.builder()
    .withSignerStorage(signerStorage)
    .withSwapStorage(swapStorage)
    .withXprv(session.rootXprv)
    .withArkadeServerUrl(arkServerUrl)
  const { satoraApiUrl } = usdcConfig()
  if (satoraApiUrl) builder = builder.withBaseUrl(satoraApiUrl)
  const client = builder.build()
  cached = { address: session.address, arkServerUrl, client, signerStorage, swapStorage }
  client.catch(() => {
    if (cached?.client === client) cached = undefined
  })
  return client
}

export const forgetSatoraClient = (): void => {
  cached = undefined
}

/** Empties Satora's stores through the handles this client opened. */
const wipeSatoraStores = async (): Promise<void> => {
  const stores = cached
  if (!stores) return
  await Promise.allSettled([stores.swapStorage.clear(), stores.signerStorage.clear()])
}

registerSatoraLifecycle({ forget: forgetSatoraClient, wipe: wipeSatoraStores })

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

/**
 * `requested` is the amount the person typed, in source units. It is what the
 * swap is created for, so it is carried through as given, never read back
 * from a field Satora might populate differently.
 */
export const toUsdcSwapQuote = (quote: QuoteResponse, requested: bigint): UsdcSwapQuote => ({
  sourceAmount: requested,
  targetAmount: toBigInt(quote.net_target_amount || quote.target_amount),
  minSats: toBigInt(quote.min_amount),
  maxSats: toBigInt(quote.max_amount),
  feeSats: (quote.protocol_fee ?? 0) + (quote.network_fee ?? 0) + (quote.gasless_network_fee ?? 0),
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
  return toUsdcSwapQuote(quote, sats)
}

export const quoteToArkade = async (client: Client, usdc: bigint): Promise<UsdcSwapQuote> => {
  const quote = await client.getQuote({
    sourceChain: ARBITRUM_CHAIN,
    sourceToken: USDC_ARBITRUM_ADDRESS,
    targetChain: ARKADE_CHAIN,
    targetToken: Asset.BTC_ARKADE.tokenId,
    sourceAmount: usdc,
  })
  return toUsdcSwapQuote(quote, usdc)
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

/** What Satora created, for checking against the quote before funding. */
export interface CreatedSwapTerms {
  sourceAmount: bigint
  targetAmount: bigint
}

export const createdTerms = (record: Pick<UsdcSwapRecord, 'sourceAmount' | 'targetAmount'>): CreatedSwapTerms => ({
  sourceAmount: toBigInt(record.sourceAmount),
  targetAmount: toBigInt(record.targetAmount),
})

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

type AnySwap = Awaited<ReturnType<Client['getSwap']>>

/** Satora's own record of this wallet's funding transaction, if it has one. */
const hasFundingTx = (direction: UsdcSwapDirection, swap: AnySwap): boolean => {
  const fields = swap as { btc_fund_txid?: string | null; evm_fund_txid?: string | null }
  return Boolean(direction === 'toUsdc' ? fields.btc_fund_txid : fields.evm_fund_txid)
}

const recordFromSwap = (swap: AnySwap, arkAddress: string): UsdcSwapRecord | undefined => {
  if (swap.direction !== 'arkade_to_evm' && swap.direction !== 'evm_to_arkade') return undefined
  const direction: UsdcSwapDirection = swap.direction === 'arkade_to_evm' ? 'toUsdc' : 'toArkade'
  const created = Date.parse(swap.created_at) || Date.now()
  return {
    id: swap.id,
    direction,
    createdAt: created,
    updatedAt: Date.now(),
    sourceAmount: swap.source_amount,
    targetAmount: swap.target_amount,
    status: swap.status,
    arkAddress: swap.direction === 'evm_to_arkade' ? swap.target_arkade_address : arkAddress,
    funded: hasFundingTx(direction, swap) || !isUnfundedStatus(swap.status),
    counterparties: swapContracts(swap),
  }
}

/**
 * Swaps Satora's store knows that the wallet's own index does not: a swap
 * created (or a refund continued) right before a crash or a dropped response.
 * They are adopted so the resume loop drives them like any other.
 */
export const reconcileStoredSwaps = async (
  client: Client,
  known: UsdcSwapRecord[],
  arkAddress: string,
): Promise<UsdcSwapRecord[]> => {
  const knownIds = new Set(known.flatMap((record) => [record.id, record.continuedTo ?? record.id]))
  const adopted: UsdcSwapRecord[] = []
  for (const stored of await client.listAllSwaps()) {
    if (knownIds.has(stored.swapId)) continue
    const record = recordFromSwap(stored.response, arkAddress)
    if (record) adopted.push(record)
  }
  return adopted
}

export interface AdvanceOptions {
  /** Saves a record at once: called before any step that cannot be repeated. */
  persist: (record: UsdcSwapRecord) => void
  /** Where a refund goes when the record carries no address of its own. */
  arkAddress: string
}

/**
 * Swaps a refunded USD → Bitcoin swap's lock token on to Arkade. The record
 * stays `needed` (and so pending) through every failure here, so the next
 * pass tries again; it only gives up once Satora has said for a full day that
 * there is nothing left to continue.
 */
const continueRefund = async (
  client: Client,
  record: UsdcSwapRecord,
  { persist, arkAddress }: AdvanceOptions,
): Promise<{ record: UsdcSwapRecord; continued?: UsdcSwapRecord }> => {
  const info = await client.getRefundedEvmSwapContinuation(record.id)
  if (!info.eligible) {
    const since = record.continuationSince ?? record.updatedAt
    const gaveUp = Date.now() - since > CONTINUATION_WINDOW_MS
    return {
      record: {
        ...record,
        continuation: gaveUp ? 'unavailable' : 'needed',
        error: info.reason ?? 'refund cannot be continued yet',
        updatedAt: Date.now(),
      },
    }
  }
  const destination = record.arkAddress || arkAddress
  const continuation = await client.continueRefundedEvmSwap(record.id, { targetAddress: destination, target: 'arkade' })
  // saved before anything else can fail: the refund is spent from here on
  const done: UsdcSwapRecord = {
    ...record,
    continuation: 'done',
    continuedTo: continuation.newSwapId,
    error: undefined,
    updatedAt: Date.now(),
  }
  persist(done)
  // the new swap's own terms, not the ones the refunded swap was quoted at
  const created = recordFromSwap(await client.getSwap(continuation.newSwapId, { updateStorage: true }), destination)
  return { record: done, continued: created ? { ...created, funded: true } : undefined }
}

/**
 * Moves one swap forward: refreshes its status, claims once Satora has locked
 * its side, refunds when the swap can no longer complete, and continues a
 * refunded USD → Bitcoin swap on to Arkade. Returns the updated record plus
 * any follow-up swap. Safe to call repeatedly: each step that cannot be
 * repeated is recorded before it runs.
 */
export const advanceUsdcSwap = async (
  client: Client,
  record: UsdcSwapRecord,
  options: AdvanceOptions,
): Promise<{ record: UsdcSwapRecord; continued?: UsdcSwapRecord }> => {
  const { persist, arkAddress } = options
  const swap = await client.getSwap(record.id, { updateStorage: true })
  let next: UsdcSwapRecord = { ...record, status: swap.status, updatedAt: Date.now(), error: undefined }
  // Satora can know about the funding when the wallet does not (a reload
  // mid-send): trust its status, and its record of the funding transaction
  // even on a swap it has since expired
  if (!next.funded && (hasFundingTx(next.direction, swap) || !isUnfundedStatus(swap.status))) {
    next = { ...next, funded: true }
  }

  if (needsContinuation(next) && isRefundedStatus(next.status)) return continueRefund(client, next, options)

  if (needsClaim(next)) {
    if (next.direction === 'toUsdc') await client.claim(next.id)
    else await client.claimArkade(next.id, { destinationAddress: next.arkAddress || arkAddress })
    const after = await client.getSwap(next.id, { updateStorage: true })
    return { record: { ...next, status: after.status, updatedAt: Date.now() } }
  }

  if (needsRefund(next)) {
    // a swap only known to have attempted funding gets a bounded number of
    // tries, spaced out over more than a day
    if (!next.funded) {
      if (!blindRefundDue(next)) return { record: next }
      next = { ...next, refundAttempts: (next.refundAttempts ?? 0) + 1, refundAttemptAt: Date.now() }
      persist(next)
    }
    if (next.direction === 'toUsdc') {
      await client.refundSwap(next.id, { destinationAddress: next.arkAddress || arkAddress })
      const after = await client.getSwap(next.id, { updateStorage: true })
      return { record: { ...next, status: after.status, funded: true, updatedAt: Date.now() } }
    }
    // An EVM-sourced refund returns the HTLC's lock token, not USDC. The need
    // to swap it on is recorded before the refund goes out, so a crash or a
    // failed continuation after it never leaves the token stranded unseen.
    next = { ...next, continuation: 'needed', continuationSince: next.continuationSince ?? Date.now() }
    persist(next)
    await client.collabRefundEvmSwap(next.id)
    const after = await client.getSwap(next.id, { updateStorage: true })
    next = { ...next, status: after.status, funded: true, updatedAt: Date.now() }
    persist(next)
    return isRefundedStatus(next.status) ? continueRefund(client, next, options) : { record: next }
  }

  return { record: next }
}
