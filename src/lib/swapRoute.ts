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
