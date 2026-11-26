import Decimal from 'decimal.js'
import { useContext } from 'react'
import { reportingSatsForFiatAmount } from '../lib/fiat'
import { Currencies } from '../lib/types'
import { AspContext } from '../providers/asp'
import { FiatContext } from '../providers/fiat'
import { WalletContext } from '../providers/wallet'
import { designatedAccountCurrency, normalizeAssetMinorUnits, type FiatAccountSourceAsset } from '../lib/accountAssets'
import { USD_ACCOUNT_ID, USDC_DECIMALS } from '../lib/usdc/config'
import { usdcToNumber } from '../lib/usdc/amount'
import { UsdcContext } from '../providers/usdc'

export interface PortfolioRow {
  /** 'btc' for the native bitcoin row, otherwise the asset's on-chain id. */
  assetId: string
  name: string
  ticker: string
  icon?: string
  decimals: number
  /** Raw balance in the asset's smallest unit (sats for BTC, atomic units otherwise).
   * Everything the wallet owns, escrow and awaiting-recovery included — this is
   * the reporting figure, not a spending limit. */
  balance: number | bigint
  /** The spendable subset of {@link balance}, same denomination. Funds locked in
   * a swap covenant, intent-locked or awaiting recovery are excluded, so this is
   * what any selectable amount must be capped at. */
  spendableBalance: number | bigint
  /** Fiat value in the user's selected currency (0 if no price feed). */
  fiatAmount: number
  /** Equivalent value in satoshis, computed via the live BTC price feed. */
  satsEquivalent: number
  /** True if this asset has a price feed and fiatAmount is meaningful. */
  hasFiatPrice: boolean
  /** Fiat currency represented by this product-level account. */
  fiatCurrency?: Currencies
  /** Backing wallet asset used internally to fulfill account actions. */
  sourceAsset?: FiatAccountSourceAsset
  /** Set on a row whose balance is shown inside another row (the USD
   * account): it stays here for its own detail screen and the swap screen,
   * but Home lists only the row it was merged into. */
  mergedInto?: string
  /** For a row that merges several holdings: where the balance sits. */
  sources?: PortfolioSource[]
}

export interface PortfolioSource {
  /** `arkade`: an asset on Arkade (its id in `assetId`). `arbitrum`: the
   * USD account's USDC. */
  rail: 'arkade' | 'arbitrum'
  assetId?: string
  /** In the merged row's minor units. */
  balance: bigint
  fiatAmount: number
}

export interface PortfolioFiat {
  totalFiat: number
  totalSats: number
  rows: PortfolioRow[]
}

/**
 * Aggregates BTC + all asset balances into a single fiat total using the
 * user's configured currency. Recognized fiat-pegged assets use the same
 * price feed as the rest of the wallet.
 */
export function usePortfolioFiat(): PortfolioFiat {
  const { aspInfo } = useContext(AspContext)
  const { balance, availableBalance, assetBalances, availableAssetBalances, assetMetadataCache, isVerifiedAsset } =
    useContext(WalletContext)
  const { toFiat, toFiatAmount } = useContext(FiatContext)
  const usdc = useContext(UsdcContext)

  const rows: PortfolioRow[] = []
  let totalSats = 0

  // bitcoin row first, always present.
  totalSats += balance
  rows.push({
    assetId: 'btc',
    name: 'Bitcoin',
    ticker: 'BTC',
    decimals: 8,
    balance,
    spendableBalance: availableBalance,
    fiatAmount: toFiat(balance),
    satsEquivalent: balance,
    hasFiatPrice: true,
  })

  // Non-bitcoin asset rows from real SDK data.
  for (const ab of assetBalances) {
    const meta = assetMetadataCache.get(ab.assetId)?.metadata
    const assetDecimals = meta?.decimals ?? 0
    // absent from availableAssets means every unit of it is escrowed, locked or
    // awaiting recovery — owned, but nothing of it is selectable
    const spendableAmount = availableAssetBalances.find((a) => a.assetId === ab.assetId)?.amount ?? BigInt(0)
    // only verified asset IDs may claim currency-account treatment
    const sourceFiat = isVerifiedAsset(ab.assetId) ? designatedAccountCurrency(aspInfo.network, ab.assetId) : undefined

    if (sourceFiat) {
      // the backing asset fulfills sends, so it carries the spendable amount;
      // the row's own `balance` stays owned for display and the fiat total
      const sourceAsset: FiatAccountSourceAsset = {
        assetId: ab.assetId,
        balance: BigInt(spendableAmount),
        decimals: assetDecimals,
      }
      const amount = Decimal.div(ab.amount.toString(), Decimal.pow(10, assetDecimals)).toNumber()
      // Spending conversions floor to whole sats; retain fractional sats for reporting.
      const satsEquivalent = reportingSatsForFiatAmount(amount, sourceFiat, toFiatAmount)
      const fiatAmount = toFiat(satsEquivalent)
      totalSats += satsEquivalent
      rows.push({
        assetId: ab.assetId,
        name: sourceFiat,
        ticker: sourceFiat,
        decimals: assetDecimals,
        balance: BigInt(ab.amount),
        spendableBalance: BigInt(spendableAmount),
        fiatAmount,
        satsEquivalent,
        hasFiatPrice: true,
        fiatCurrency: sourceFiat,
        sourceAsset,
      })
      continue
    }

    rows.push({
      assetId: ab.assetId,
      name: meta?.name ?? `Asset ${ab.assetId.slice(0, 8)}...`,
      ticker: meta?.ticker?.trim().toUpperCase() ?? 'TKN',
      icon: meta?.icon,
      decimals: assetDecimals,
      balance: ab.amount,
      spendableBalance: spendableAmount,
      fiatAmount: 0,
      satsEquivalent: 0,
      hasFiatPrice: false,
    })
  }

  // The USD account: one row for every dollar the person holds, wherever it
  // sits. Its own USDC counts toward the total here; a USD-designated asset on
  // Arkade was counted above, so it is folded into the row's balance and
  // breakdown and marked merged rather than counted twice.
  if (usdc.available) {
    const units = usdc.balance ?? BigInt(0)
    const satsEquivalent = reportingSatsForFiatAmount(usdcToNumber(units), Currencies.USD, toFiatAmount)
    totalSats += satsEquivalent
    const sources: PortfolioSource[] = []
    let balance = BigInt(0)
    let spendableBalance = BigInt(0)
    let fiatAmount = 0
    let rowSats = 0
    // undefined: no Arkade dollars folded in; false: one of them has no price
    let mergedHavePrice: boolean | undefined
    for (const row of rows) {
      if (row.fiatCurrency !== Currencies.USD) continue
      mergedHavePrice =
        (mergedHavePrice ?? true) && row.hasFiatPrice && (row.balance === BigInt(0) || row.satsEquivalent > 0)
      row.mergedInto = USD_ACCOUNT_ID
      const owned = normalizeAssetMinorUnits(row.balance, row.decimals, USDC_DECIMALS)
      balance += owned
      spendableBalance += normalizeAssetMinorUnits(row.spendableBalance, row.decimals, USDC_DECIMALS)
      fiatAmount += row.fiatAmount
      rowSats += row.satsEquivalent
      sources.push({ rail: 'arkade', assetId: row.assetId, balance: owned, fiatAmount: row.fiatAmount })
    }
    sources.push({ rail: 'arbitrum', balance: units, fiatAmount: toFiat(satsEquivalent) })
    rows.push({
      assetId: USD_ACCOUNT_ID,
      name: Currencies.USD,
      ticker: Currencies.USD,
      decimals: USDC_DECIMALS,
      balance: balance + units,
      spendableBalance: spendableBalance + units,
      fiatAmount: fiatAmount + toFiat(satsEquivalent),
      satsEquivalent: rowSats + satsEquivalent,
      // a balance with no rate to value it is "unavailable", not zero
      hasFiatPrice:
        (usdc.balance !== undefined || mergedHavePrice === true) &&
        (units === BigInt(0) || satsEquivalent > 0) &&
        mergedHavePrice !== false,
      fiatCurrency: Currencies.USD,
      sources,
    })
  }

  return {
    totalFiat: toFiat(totalSats),
    totalSats,
    rows,
  }
}
