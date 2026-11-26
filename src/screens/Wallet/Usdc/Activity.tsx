import { useContext } from 'react'
import { PrivacyAmount } from '../../../components/PrivacyAmount'
import SwapRouteIcon from '../../../components/SwapRouteIcon'
import ReceivedIcon from '../../../icons/Received'
import SentIcon from '../../../icons/Sent'
import { prettyBitcoinAmount, prettyDate } from '../../../lib/format'
import { formatUsd } from '../../../lib/usdc/amount'
import type { UsdcTransfer } from '../../../lib/usdc/chain'
import { CIRCLE_PAYMASTER_V07, explorerTxUrl } from '../../../lib/usdc/config'
import { swapPhase, type UsdcSwapRecord } from '../../../lib/usdc/swaps'
import { ConfigContext } from '../../../providers/config'
import { useTranslation } from '../../../providers/language'
import { UsdcContext } from '../../../providers/usdc'

const LIMIT = 20

type Entry =
  | { kind: 'transfer'; at: number; transfer: UsdcTransfer }
  | { kind: 'swap'; at: number; swap: UsdcSwapRecord }

/**
 * Transfers from the indexer and swaps from the wallet's own records, newest
 * first. A transfer to or from one of a swap's Satora contracts is that swap's
 * USDC leg, already shown on the swap row, so it is left out.
 */
export const usdcActivityEntries = (transfers: UsdcTransfer[], swaps: UsdcSwapRecord[]): Entry[] => {
  const swapContracts = new Set(swaps.flatMap((swap) => swap.counterparties ?? []))
  const paymaster = CIRCLE_PAYMASTER_V07.toLowerCase()
  const nonSwap = transfers.filter(
    (transfer) => !swapContracts.has(transfer.direction === 'in' ? transfer.from : transfer.to),
  )
  const outHashes = new Set(nonSwap.filter((transfer) => transfer.direction === 'out').map((transfer) => transfer.hash))
  // One send moves USDC in up to three transfers in one transaction: the
  // payment, the paymaster's gas prefund, and any unused-gas refund the
  // paymaster returns in `postOp`. Combine them into one outgoing row showing
  // the net amount spent.
  const byTx = new Map<string, UsdcTransfer>()
  const paymasterRefunds = new Map<string, bigint>()
  for (const transfer of nonSwap) {
    if (transfer.direction === 'in' && transfer.from === paymaster && outHashes.has(transfer.hash)) {
      paymasterRefunds.set(transfer.hash, (paymasterRefunds.get(transfer.hash) ?? BigInt(0)) + transfer.amount)
      continue
    }
    const key = `${transfer.hash}-${transfer.direction}`
    const seen = byTx.get(key)
    byTx.set(key, seen ? { ...seen, amount: seen.amount + transfer.amount } : transfer)
  }
  for (const [hash, refund] of paymasterRefunds) {
    const key = `${hash}-out`
    const out = byTx.get(key)
    if (out) byTx.set(key, { ...out, amount: out.amount > refund ? out.amount - refund : BigInt(0) })
  }
  const entries: Entry[] = [
    ...[...byTx.values()].map((transfer) => ({ kind: 'transfer' as const, at: transfer.timestamp, transfer })),
    ...swaps.map((swap) => ({ kind: 'swap' as const, at: swap.createdAt, swap })),
  ]
  return entries.sort((a, b) => b.at - a.at).slice(0, LIMIT)
}

export default function UsdcActivity() {
  const { config } = useContext(ConfigContext)
  const { transfers, swaps } = useContext(UsdcContext)
  const { language, t } = useTranslation()

  const entries = usdcActivityEntries(transfers, swaps)
  if (entries.length === 0) return <p className='activity-row__meta'>{t('usdc.noActivity')}</p>

  const openTransfer = (hash: string) => window.open(explorerTxUrl(hash), '_blank', 'noreferrer')
  const date = (ms: number) => prettyDate(Math.floor(ms / 1000), language)

  return (
    <div className='activity-list activity-list--compact'>
      {entries.map((entry, index) => {
        const first = index === 0 ? ' activity-row--first' : ''
        if (entry.kind === 'transfer') {
          const { transfer } = entry
          const incoming = transfer.direction === 'in'
          const amount = `${incoming ? '+' : '-'} ${formatUsd(transfer.amount)}`
          return (
            <div
              key={`${transfer.hash}-${transfer.direction}`}
              role='link'
              tabIndex={0}
              className={`activity-row activity-row--static${first}`}
              aria-label={t('usdc.viewOnExplorer')}
              onClick={() => openTransfer(transfer.hash)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                openTransfer(transfer.hash)
              }}
            >
              <div className='activity-row__left'>
                <span className='activity-row__icon'>{incoming ? <ReceivedIcon /> : <SentIcon />}</span>
                <div className='activity-row__copy'>
                  <span className='activity-row__kind'>
                    {incoming ? t('transaction.received') : t('transaction.sent')}
                  </span>
                  <span className='activity-row__meta'>{date(transfer.timestamp)}</span>
                </div>
              </div>
              <div className='activity-row__right'>
                <span className={`activity-row__amount${incoming ? ' activity-row__amount--in' : ''}`}>
                  <PrivacyAmount masked={`${incoming ? '+' : '-'} •••• USD`}>{amount}</PrivacyAmount>
                </span>
              </div>
            </div>
          )
        }
        const { swap } = entry
        const phase = swapPhase(swap)
        const toUsdc = swap.direction === 'toUsdc'
        const label =
          phase === 'complete'
            ? t('usdc.swapComplete')
            : phase === 'refunded'
              ? t('usdc.swapRefunded')
              : phase === 'failed'
                ? t('usdc.swapFailedStatus')
                : t('usdc.swapPending')
        const received = toUsdc
          ? `+ ${formatUsd(BigInt(swap.targetAmount || '0'))}`
          : `+ ${prettyBitcoinAmount(Number(swap.targetAmount || '0'), config.unit)}`
        const amountClass =
          phase === 'pending'
            ? ' activity-row__amount--pending'
            : phase === 'failed'
              ? ' activity-row__amount--failed'
              : phase === 'complete'
                ? ' activity-row__amount--in'
                : ''
        return (
          <div key={swap.id} className={`activity-row activity-row--static${first}`}>
            <div className='activity-row__left'>
              <span className='activity-row__icon'>
                <SwapRouteIcon
                  from={toUsdc ? { assetId: 'btc', ticker: 'BTC' } : { ticker: 'USD' }}
                  to={toUsdc ? { ticker: 'USD' } : { assetId: 'btc', ticker: 'BTC' }}
                />
              </span>
              <div className='activity-row__copy'>
                <span className='activity-row__kind'>{label}</span>
                <span className='activity-row__meta'>
                  {`${toUsdc ? t('usdc.toUsdc') : t('usdc.toArkade')} · ${date(swap.createdAt)}`}
                </span>
              </div>
            </div>
            <div className='activity-row__right'>
              <span className={`activity-row__amount${amountClass}`}>
                <PrivacyAmount masked='+ ••••'>{received}</PrivacyAmount>
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
