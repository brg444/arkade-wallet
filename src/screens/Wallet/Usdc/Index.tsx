import { useContext, useEffect, useState } from 'react'
import Content from '../../../components/Content'
import Figure from '../../../components/Figure'
import Header from '../../../components/Header'
import Padded from '../../../components/Padded'
import { PrivacyAmount } from '../../../components/PrivacyAmount'
import TokenLogo from '../../../components/TokenLogo'
import { usePortfolioFiat, type PortfolioSource } from '../../../hooks/usePortfolioFiat'
import { prettyFiatAmount } from '../../../lib/format'
import { ConfigContext } from '../../../providers/config'
import { FiatContext } from '../../../providers/fiat'
import Glyph from '../../../icons/Glyph'
import { hapticLight } from '../../../lib/haptics'
import { formatUsdBalance } from '../../../lib/usdc/amount'
import { Currencies } from '../../../lib/types'
import { NavigationContext, Pages, holdBackLayer } from '../../../providers/navigation'
import { FlowContext } from '../../../providers/flow'
import { USD_ACCOUNT_ID } from '../../../lib/usdc/config'
import { useTranslation } from '../../../providers/language'
import { UsdcContext } from '../../../providers/usdc'
import HomeQuickActions from '../HomeQuickActions'
import UsdcActivity from './Activity'
import UsdcReceive from './Receive'
import UsdcSend from './Send'

export type UsdcView = 'overview' | 'receive' | 'send'

export default function Usdc() {
  const { session, balance, refresh } = useContext(UsdcContext)
  const { config } = useContext(ConfigContext)
  const { fiatDecimals } = useContext(FiatContext)
  const { setAssetInfo, setSwapFromAssetId } = useContext(FlowContext)
  const { navigate } = useContext(NavigationContext)
  const { rows } = usePortfolioFiat()
  // the merged row: every dollar the person holds, on whichever rail
  const row = rows.find((candidate) => candidate.assetId === USD_ACCOUNT_ID)
  const { t } = useTranslation()
  const [view, setView] = useState<UsdcView>('overview')

  const back = () => setView('overview')

  // the hardware back button closes a sub-view before it leaves the account
  useEffect(() => (view === 'overview' ? undefined : holdBackLayer(back)), [view])

  useEffect(() => {
    refresh()
  }, [refresh])

  if (!session) {
    return (
      <>
        <Header text={Currencies.USD} back />
        <Content>
          <Padded>
            <div className='asset-detail-page'>{t('usdc.locked')}</div>
          </Padded>
        </Content>
      </>
    )
  }

  if (view === 'receive') return <UsdcReceive address={session.address} back={back} />
  if (view === 'send') return <UsdcSend back={back} />

  // sends go out from the account's own USDC; dollars held on Arkade send
  // from their own screen, one tap away in the breakdown
  const units = balance ?? BigInt(0)
  const total = typeof row?.balance === 'bigint' ? row.balance : units
  const formattedBalance = formatUsdBalance(total)
  const decimals = fiatDecimals()
  const fiatText = (amount: number) =>
    prettyFiatAmount(amount, config.currency, {
      bitcoinUnit: config.unit,
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals,
    })
  const value = row?.hasFiatPrice ? fiatText(row.fiatAmount) : undefined
  const sources = row?.sources ?? []
  const openSource = (source: PortfolioSource) => {
    if (source.rail !== 'arkade' || !source.assetId) return
    hapticLight()
    setAssetInfo({ assetId: source.assetId, supply: BigInt(0) })
    navigate(Pages.AccountDetail)
  }

  return (
    <>
      <Header text='' back />
      <Content>
        <Padded>
          <div className='asset-detail-page'>
            <section className='asset-detail-hero'>
              <div className='asset-detail-identity'>
                <span className='asset-detail-logo' aria-hidden='true'>
                  <TokenLogo ticker='USD' />
                </span>
                <div>
                  <h1 className='asset-detail-name'>{Currencies.USD}</h1>
                </div>
              </div>
              <div className='asset-detail-price-row'>
                <div className='asset-detail-price'>
                  <PrivacyAmount masked='•••• USD'>
                    <Figure value={formattedBalance} />
                  </PrivacyAmount>
                </div>
                {/* the balance is already in dollars: a value is only news in another currency */}
                {value !== undefined && config.currency !== Currencies.USD ? (
                  <span className='text-[length:var(--asset-detail-control-size)] text-[var(--ink-3)] tabular-nums'>
                    <PrivacyAmount masked='••••'>{value}</PrivacyAmount>
                  </span>
                ) : null}
              </div>
            </section>

            <div className='asset-detail-actions'>
              <HomeQuickActions
                onReceive={() => setView('receive')}
                onSend={() => setView('send')}
                sendDisabled={units === BigInt(0)}
              />
              <button
                type='button'
                onClick={() => {
                  hapticLight()
                  // the one Swap screen, opened on USD; it routes the pair itself
                  setSwapFromAssetId(USD_ACCOUNT_ID)
                  navigate(Pages.WalletSwap)
                }}
                className='home-section-action asset-detail-swap'
                data-testid='usdc-action-swap'
              >
                <Glyph name='swap' size={17} strokeWidth={2} />
                {t('wallet.swap')}
              </button>
            </div>

            {sources.length > 1 ? <UsdBreakdown sources={sources} total={total} onOpen={openSource} /> : null}

            <section className='asset-detail-activity'>
              <div className='asset-detail-section-header'>
                <strong>{t('usdc.activity')}</strong>
              </div>
              <UsdcActivity />
            </section>
          </div>
        </Padded>
      </Content>
    </>
  )
}

const RAIL_COLOR: Record<PortfolioSource['rail'], string> = {
  arkade: 'var(--brand)',
  arbitrum: 'var(--purple-200)',
}

/**
 * Where the USD balance sits, when it sits in more than one place. The bar and
 * the rows share one order and one colour per rail; a rail held on Arkade
 * opens its own account screen, where it sends, receives and swaps natively.
 */
function UsdBreakdown({
  sources,
  total,
  onOpen,
}: {
  sources: PortfolioSource[]
  total: bigint
  onOpen: (source: PortfolioSource) => void
}) {
  const { t } = useTranslation()
  const share = (balance: bigint) => (total > BigInt(0) ? Number((balance * BigInt(10_000)) / total) / 100 : 0)
  const label = (source: PortfolioSource) => (source.rail === 'arkade' ? t('usdc.railArkade') : t('usdc.railArbitrum'))

  return (
    <section className='asset-detail-activity' aria-label={t('usdc.breakdown')}>
      <div className='asset-detail-section-header'>
        <strong>{t('usdc.breakdown')}</strong>
      </div>
      <div className='flex h-2 w-full overflow-hidden rounded-full' aria-hidden='true'>
        {sources.map((source) => (
          <span
            key={`${source.rail}-${source.assetId ?? ''}`}
            style={{ width: `${share(source.balance)}%`, background: RAIL_COLOR[source.rail] }}
          />
        ))}
      </div>
      <div className='activity-list activity-list--compact'>
        {sources.map((source, index) => {
          const content = (
            <>
              <div className='activity-row__left'>
                <span
                  className='inline-block size-2.5 shrink-0 rounded-full'
                  style={{ background: RAIL_COLOR[source.rail] }}
                  aria-hidden='true'
                />
                <div className='activity-row__copy'>
                  <span className='activity-row__kind'>{label(source)}</span>
                  <span className='activity-row__meta'>{`${Math.round(share(source.balance))}%`}</span>
                </div>
              </div>
              <div className='activity-row__right'>
                <span className='activity-row__amount'>
                  <PrivacyAmount masked='•••• USD'>{formatUsdBalance(source.balance)}</PrivacyAmount>
                </span>
              </div>
            </>
          )
          const className = `activity-row activity-row--static${index === 0 ? ' activity-row--first' : ''}`
          return source.rail === 'arkade' ? (
            <div
              key={`${source.rail}-${source.assetId ?? ''}`}
              role='button'
              tabIndex={0}
              className={className}
              onClick={() => onOpen(source)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onOpen(source)
              }}
            >
              {content}
            </div>
          ) : (
            <div key={source.rail} className={className}>
              {content}
            </div>
          )
        })}
      </div>
    </section>
  )
}
