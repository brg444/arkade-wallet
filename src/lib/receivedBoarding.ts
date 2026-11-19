import type { Coin } from '@arkade-os/sdk'

const outpoint = (coin: Pick<Coin, 'txid' | 'vout'>) => `${coin.txid}:${coin.vout}`

/**
 * The boarding coins in an update that were not there before.
 *
 * The worker's `UTXO_UPDATE` carries every boarding coin the wallet holds, not the ones that just
 * arrived, so a coin already held when the Receive screen opened is not a payment to it. With no
 * starting set (the first read failed), the first update becomes it and counts as no payment: a
 * missed "received" screen is better than announcing money that was already there.
 */
export const newBoardingCoins = <T extends Pick<Coin, 'txid' | 'vout'>>(
  seen: ReadonlySet<string> | undefined,
  coins: T[],
): { fresh: T[]; seen: Set<string> } => {
  const fresh = seen ? coins.filter((coin) => !seen.has(outpoint(coin))) : []
  return { fresh, seen: new Set([...(seen ?? []), ...coins.map(outpoint)]) }
}

/** The outpoints of `coins`, for {@link newBoardingCoins}. */
export const boardingOutpoints = (coins: Pick<Coin, 'txid' | 'vout'>[]): Set<string> => new Set(coins.map(outpoint))
