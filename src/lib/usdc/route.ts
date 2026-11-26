/**
 * The Satora rail of the Swap screen: Bitcoin on Arkade to and from the USD
 * account, behind the same {@link RouteQuote} an Arkade market quote produces.
 * The SDK itself still loads lazily, on the first quote.
 */
import type { IWallet } from '@arkade-os/sdk'
import { getReceivingAddresses, sendOffChain } from '../asp'
import type { RouteQuote } from '../swapRoute'
import type { UsdcSession } from './keys'
import type { UsdcSwapQuote } from './satora'
import type { UsdcSwapDirection, UsdcSwapRecord } from './swaps'

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
 * person is typing.
 */
export const satoraGiveLimit = (direction: UsdcSwapDirection, limitSats: bigint, route: RouteQuote): number => {
  const btc = Number(limitSats) / SATS_PER_BTC
  if (direction === 'toUsdc') return btc
  return route.rate > 0 ? btc / route.rate : 0
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

/**
 * Starts a Satora swap and funds this wallet's side. Each record is saved
 * before its funding step, so a funding call that lands but never answers still
 * leaves a swap the USD account's resume loop drives to a claim or a refund.
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
  // the net figure the person was quoted, rather than Satora's pre-fee one
  const targetAmount = quote.targetAmount.toString()

  if (direction === 'toUsdc') {
    const created = await satora.createToUsdcSwap(client, session, quote.sourceAmount, offchainAddr)
    const record = { ...created.record, targetAmount }
    recordSwap(record)
    await sendOffChain(wallet, created.fundSats, created.vhtlcAddress)
    const funded = { ...record, funded: true, updatedAt: Date.now() }
    recordSwap(funded)
    return funded
  }

  const created = await satora.createToArkadeSwap(client, session, quote.sourceAmount, offchainAddr)
  const record = { ...created, targetAmount }
  recordSwap(record)
  await satora.fundToArkadeSwap(client, record.id)
  const funded = { ...record, funded: true, updatedAt: Date.now() }
  recordSwap(funded)
  return funded
}
