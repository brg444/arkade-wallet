import { useContext } from 'react'
import { prettyFiatAmount } from '../lib/format'
import { Currencies } from '../lib/types'
import { usdcToNumber } from '../lib/usdc/amount'
import { ConfigContext } from '../providers/config'
import { FiatContext } from '../providers/fiat'

/**
 * A USDC balance in the wallet's display currency, counting USDC as 1:1 with
 * USD. Any other currency goes through the Bitcoin price the wallet already
 * tracks, so it moves with the same rates as every other row on Home.
 */
export function useUsdcFiatText(): (units: bigint) => string | undefined {
  const { config } = useContext(ConfigContext)
  const { fiatDecimals, fromFiatAmount, toFiat } = useContext(FiatContext)

  return (units: bigint) => {
    const usd = usdcToNumber(units)
    const value = config.currency === Currencies.USD ? usd : toFiat(fromFiatAmount(usd, Currencies.USD))
    if (!Number.isFinite(value) || (usd > 0 && value === 0)) return undefined
    const decimals = fiatDecimals()
    return prettyFiatAmount(value, config.currency, {
      bitcoinUnit: config.unit,
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals,
    })
  }
}
