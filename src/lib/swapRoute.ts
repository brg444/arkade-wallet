import type { OfferPlan } from '@arkade-os/solver-discovery'
import { preFeeDisplayRate } from './swapMarkets'

/**
 * Which rail fills a swap. The Swap screen composes, reviews and confirms every
 * pair the same way; only quoting and execution differ underneath.
 *
 * - `arkade`: an intent filled by a solver on an Arkade market (`@arkade-os/swap`).
 * - `satora`: a Satora HTLC swap between Bitcoin on Arkade and the USD account.
 */
export type SwapRail = 'arkade' | 'satora'

/**
 * The part of a quote the composer reads, whichever rail produced it. Amounts
 * are in whole protocol units (whole BTC, whole dollars), the same scale as an
 * Arkade plan's `display` figures.
 */
export interface RouteQuote {
  rail: SwapRail
  /** What leaves the wallet. */
  deposit: number
  /** What arrives, net of every fee. */
  receive: number
  /** Share of the gross payout the rail keeps, 0 to 1. */
  feeFraction: number
  /** Pre-fee price: receive units per one deposit unit. */
  rate: number
}

export const routeQuoteFromPlan = (plan: OfferPlan): RouteQuote => ({
  rail: 'arkade',
  deposit: Number(plan.deposit.display),
  receive: Number(plan.receive.display),
  feeFraction: plan.market.fee_bps / 10_000,
  rate: preFeeDisplayRate(plan),
})

/** A pair resolved to the rail that fills it and the concrete assets it trades. */
export type ResolvedSwapRoute =
  | { rail: 'arkade'; fromId: string; toId: string }
  | { rail: 'satora'; direction: 'toUsdc' | 'toArkade' }

/**
 * Picks the rail for a pair. The USD account is one asset to the person but
 * can hold dollars on Arkade (a USD-designated asset) and on Arbitrum (USDC),
 * so a pair touching it resolves to a concrete asset on one rail:
 *
 * - Selling USD spends Arkade dollars first, through an Arkade market, when
 *   they cover the amount; otherwise the USDC goes through Satora (Bitcoin
 *   only). A swap is never split across the two.
 * - Buying USD with Bitcoin lands as USDC through Satora: Arbitrum is the
 *   default home of new dollars. Buying it with any other Arkade asset uses
 *   that asset's market to the Arkade dollar.
 * - Every other pair is an Arkade market, as before.
 */
export function resolveSwapRoute({
  fromId,
  toId,
  btcId,
  usdId,
  arkadeUsdId,
  hasMarket,
  giveUsd = 0,
  arkadeUsdBalance = 0,
}: {
  fromId: string
  toId: string
  btcId: string
  usdId: string
  /** The USD-designated Arkade asset folded into the USD account, if any. */
  arkadeUsdId?: string
  hasMarket: (fromId: string, toId: string) => boolean
  /** The amount being sold, in dollars, when the give side is USD. */
  giveUsd?: number
  /** Spendable Arkade dollars. */
  arkadeUsdBalance?: number
}): ResolvedSwapRoute | undefined {
  if (fromId === toId) return undefined
  if (fromId === usdId) {
    const arkadeCovers = !!arkadeUsdId && hasMarket(arkadeUsdId, toId) && giveUsd > 0 && giveUsd <= arkadeUsdBalance
    if (arkadeCovers && arkadeUsdId) return { rail: 'arkade', fromId: arkadeUsdId, toId }
    if (toId === btcId) return { rail: 'satora', direction: 'toArkade' }
    if (arkadeUsdId && hasMarket(arkadeUsdId, toId)) return { rail: 'arkade', fromId: arkadeUsdId, toId }
    return undefined
  }
  if (toId === usdId) {
    if (fromId === btcId) return { rail: 'satora', direction: 'toUsdc' }
    if (arkadeUsdId && hasMarket(fromId, arkadeUsdId)) return { rail: 'arkade', fromId, toId: arkadeUsdId }
    return undefined
  }
  return hasMarket(fromId, toId) ? { rail: 'arkade', fromId, toId } : undefined
}
