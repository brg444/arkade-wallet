/**
 * The Satora rail of the Swap screen: Bitcoin on Arkade to and from the USD
 * account, behind the same {@link RouteQuote} an Arkade market quote produces.
 * The SDK itself still loads lazily, on the first quote.
 */
import type { IWallet } from '@arkade-os/sdk'
import { getReceivingAddresses, sendOffChain } from '../asp'
import type { RouteQuote } from '../swapRoute'
import type { UsdcSession } from './keys'
import type { UsdcSwapQuote, ToUsdcSwap } from './satora'
import {
  beginCreatingSwap,
  beginFunding,
  endCreatingSwap,
  endFunding,
  type UsdcSwapDirection,
  type UsdcSwapRecord,
} from './swaps'

const SATS_PER_BTC = 100_000_000
const USDC_PER_USD = 1_000_000

/**
 * The composer hands quotes a give amount in whole units: whole BTC for
 * Bitcoin, dollars for USD. Satora wants sats and USDC base units.
 */
export const satoraSourceUnits = (direction: UsdcSwapDirection, giveWholeUnits: string): bigint | undefined => {
  const [whole = '', fraction = ''] = giveWholeUnits.trim().split('.')
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || (!whole && !fraction)) return undefined
  const decimals = direction === 'toUsdc' ? 8 : 6
  if (fraction.length > decimals) return undefined
  return BigInt(whole || '0') * BigInt(10) ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
}

export const routeQuoteFromSatora = (direction: UsdcSwapDirection, quote: UsdcSwapQuote): RouteQuote => {
  const fee = quote.feeSats
  if (direction === 'toUsdc') {
    const depositSats = Number(quote.sourceAmount)
    const deposit = depositSats / SATS_PER_BTC
    const receive = Number(quote.targetAmount) / USDC_PER_USD
    const feeFraction = depositSats > 0 ? Math.min(fee / depositSats, 1) : 0
    return { rail: 'satora', deposit, receive, feeFraction, rate: grossRate(deposit, receive, feeFraction) }
  }
  const deposit = Number(quote.sourceAmount) / USDC_PER_USD
  const receiveSats = Number(quote.targetAmount)
  const receive = receiveSats / SATS_PER_BTC
  const feeFraction = receiveSats + fee > 0 ? fee / (receiveSats + fee) : 0
  return { rail: 'satora', deposit, receive, feeFraction, rate: grossRate(deposit, receive, feeFraction) }
}

const grossRate = (deposit: number, receive: number, feeFraction: number): number =>
  deposit > 0 && feeFraction < 1 ? receive / (1 - feeFraction) / deposit : 0

/**
 * Satora bounds a swap by its Bitcoin side in sats. Returns that bound on the
 * give side, in whole units, so the composer can quote it against what the
 * person is typing; 0 when the quote gives no price to convert it with.
 * Selling USD, the bound is on the sats received after fees while `rate` is
 * the pre-fee price, so the fees are added back first: the flat ones as they
 * are, the protocol fee in proportion to the bound, since it scales with the
 * swap. Giving exactly this much clears the bound.
 */
export const satoraGiveLimit = (
  direction: UsdcSwapDirection,
  limitSats: bigint,
  route: RouteQuote,
  quote?: Pick<UsdcSwapQuote, 'targetAmount' | 'feeSats' | 'protocolFeeSats'>,
): number => {
  if (direction === 'toUsdc') return Number(limitSats) / SATS_PER_BTC
  if (!(route.rate > 0)) return 0
  const fee = quote?.feeSats ?? 0
  const protocol = Math.min(quote?.protocolFeeSats ?? 0, fee)
  const grossNow = Number(quote?.targetAmount ?? 0) + fee
  const protocolFraction = grossNow > 0 ? protocol / grossNow : 0
  if (protocolFraction >= 1) return 0
  const grossSats = (Number(limitSats) + fee - protocol) / (1 - protocolFraction)
  return grossSats / SATS_PER_BTC / route.rate
}

export const fetchSatoraQuote = async (
  session: UsdcSession,
  arkServerUrl: string,
  direction: UsdcSwapDirection,
  sourceUnits: bigint,
): Promise<UsdcSwapQuote> => {
  const satora = await import('./satora')
  const client = await satora.satoraClient(session, arkServerUrl)
  return direction === 'toUsdc' ? satora.quoteToUsdc(client, sourceUnits) : satora.quoteToArkade(client, sourceUnits)
}

/** How far a created swap's payout may fall short of the reviewed quote. */
export const QUOTE_TOLERANCE_BPS = BigInt(100) // 1%

/** The swap Satora created no longer matches what was reviewed. Nothing was funded. */
export class SatoraQuoteMoved extends Error {
  constructor() {
    super('the swap terms changed since the quote was reviewed')
    this.name = 'SatoraQuoteMoved'
  }
}

/**
 * Funding went out, or may have: the call failed or timed out at a point where
 * this wallet cannot tell. The swap is on record and the resume loop will
 * finish or refund it, so the one thing that must not happen is a second try.
 */
export class SatoraFundingUncertain extends Error {
  readonly swapId: string
  constructor(swapId: string, cause: unknown) {
    super('the swap may already be funded')
    this.name = 'SatoraFundingUncertain'
    this.swapId = swapId
    this.cause = cause
  }
}

/**
 * A Satora quote carries no expiry, and creating the swap prices it afresh.
 * Before anything is funded, the created swap must ask for exactly the amount
 * that was reviewed and pay out no less than the reviewed figure, within
 * {@link QUOTE_TOLERANCE_BPS}.
 */
export const assertSwapMatchesQuote = (
  quote: Pick<UsdcSwapQuote, 'sourceAmount' | 'targetAmount'>,
  created: { sourceAmount: bigint; targetAmount: bigint },
): void => {
  if (created.sourceAmount !== quote.sourceAmount) throw new SatoraQuoteMoved()
  const floor = (quote.targetAmount * (BigInt(10_000) - QUOTE_TOLERANCE_BPS)) / BigInt(10_000)
  if (created.targetAmount < floor) throw new SatoraQuoteMoved()
}

const bigMin = (a: bigint, b: bigint): bigint => (a < b ? a : b)

/**
 * Starts a Satora swap and funds this wallet's side.
 *
 * The created swap is checked against the reviewed quote first; a mismatch
 * throws {@link SatoraQuoteMoved} with nothing sent. From there the record is
 * saved, marked as attempting funding, before the funding call goes out, and
 * the resume loop is held off it until that call returns. Any failure after
 * that point throws {@link SatoraFundingUncertain}: the caller must not offer
 * a retry, because the USD account's resume loop already owns the swap and
 * will claim it or refund it.
 */
export const executeSatoraSwap = async ({
  session,
  arkServerUrl,
  wallet,
  direction,
  quote,
  recordSwap,
}: {
  session: UsdcSession
  arkServerUrl: string
  wallet: IWallet
  direction: UsdcSwapDirection
  quote: UsdcSwapQuote
  recordSwap: (record: UsdcSwapRecord) => void
}): Promise<UsdcSwapRecord> => {
  const satora = await import('./satora')
  const client = await satora.satoraClient(session, arkServerUrl)
  const { offchainAddr } = await getReceivingAddresses(wallet)

  let created: ToUsdcSwap | { record: UsdcSwapRecord }
  let record: UsdcSwapRecord
  // Hold off unlock reconcile until the created swap is either deleted on
  // moved terms or recorded in the wallet index, so it cannot be adopted mid-flight.
  beginCreatingSwap()
  try {
    created =
      direction === 'toUsdc'
        ? await satora.createToUsdcSwap(client, session, quote.sourceAmount, offchainAddr)
        : { record: await satora.createToArkadeSwap(client, session, quote.sourceAmount, offchainAddr) }
    const terms = satora.createdTerms(created.record)
    try {
      assertSwapMatchesQuote(quote, terms)
    } catch (err) {
      // never funded: keep it out of Satora's store, or reconcile adopts it
      await satora.forgetUnfundedSwap(client, created.record.id)
      throw err
    }

    // never more than either the reviewed net figure or what Satora created
    record = {
      ...created.record,
      targetAmount: bigMin(quote.targetAmount, terms.targetAmount).toString(),
      fundingAttempted: true,
    }
    beginFunding(record.id)
    recordSwap(record)
  } finally {
    endCreatingSwap()
  }
  try {
    if ('vhtlcAddress' in created) await sendOffChain(wallet, created.fundSats, created.vhtlcAddress)
    else await satora.fundToArkadeSwap(client, record.id)
  } catch (err) {
    throw new SatoraFundingUncertain(record.id, err)
  } finally {
    endFunding(record.id)
  }
  const funded = { ...record, funded: true, updatedAt: Date.now() }
  recordSwap(funded)
  return funded
}
