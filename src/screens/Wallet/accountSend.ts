import { accountTickerForAssetTicker } from '../../components/TokenLogo'
import { type PortfolioRow } from '../../hooks/usePortfolioFiat'
import { normalizeAssetMinorUnits } from '../../lib/accountAssets'
import { fiatDecimalsFor } from '../../lib/fiat'
import { Currencies } from '../../lib/types'
import { emptySendInfo, type SendInfo } from '../../providers/flow'

const units = (value: number | bigint): bigint =>
  typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.floor(value)))

/**
 * What Send opens with for one account. Bitcoin starts empty; a fiat account
 * backed by an Arkade asset sends as that account, capped at its spendable
 * balance in the account's own minor units; any other asset sends as itself.
 */
export const sendInfoForRow = (row: PortfolioRow): SendInfo => {
  if (row.assetId === 'btc') return emptySendInfo
  const accountTicker = accountTickerForAssetTicker(row.ticker)
  if (accountTicker && accountTicker !== 'BTC' && row.sourceAsset) {
    const decimals = fiatDecimalsFor(accountTicker as Currencies)
    return {
      ...emptySendInfo,
      account: {
        assetId: row.assetId,
        ticker: accountTicker,
        // the composer caps at this; the account screen keeps the full-precision total
        balance: normalizeAssetMinorUnits(units(row.spendableBalance), row.decimals, decimals),
        decimals,
        amount: BigInt(0),
        source: row.sourceAsset,
      },
    }
  }
  return { ...emptySendInfo, assets: [{ assetId: row.sourceAsset?.assetId ?? row.assetId, amount: BigInt(0) }] }
}

/** Whether an account holds anything it could send right now. */
export const hasSpendable = (row: PortfolioRow): boolean => units(row.spendableBalance) > BigInt(0)
