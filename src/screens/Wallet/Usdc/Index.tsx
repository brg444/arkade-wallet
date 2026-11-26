import { useContext, useEffect, useState } from 'react'
import Content from '../../../components/Content'
import Figure from '../../../components/Figure'
import Header from '../../../components/Header'
import Padded from '../../../components/Padded'
import { PrivacyAmount } from '../../../components/PrivacyAmount'
import TokenLogo from '../../../components/TokenLogo'
import { useUsdcFiatText } from '../../../hooks/useUsdcFiatText'
import Glyph from '../../../icons/Glyph'
import { hapticLight } from '../../../lib/haptics'
import { formatUsd } from '../../../lib/usdc/amount'
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
  const { setSwapFromAssetId } = useContext(FlowContext)
  const { navigate } = useContext(NavigationContext)
  const fiatText = useUsdcFiatText()
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

  const units = balance ?? BigInt(0)
  const formattedBalance = formatUsd(units)
  const value = balance === undefined ? undefined : fiatText(balance)

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

            <section className='asset-detail-holdings'>
              <div className='asset-detail-holding'>
                <span>{t('common.balance')}</span>
                <strong>
                  <PrivacyAmount masked='•••• USD'>
                    <span className='asset-detail-holding-amount'>{formattedBalance}</span>
                  </PrivacyAmount>
                </strong>
              </div>
              <div className='asset-detail-holding'>
                <span>{t('common.value')}</span>
                <strong>
                  {value === undefined ? (
                    t('accounts.valueUnavailable')
                  ) : (
                    <PrivacyAmount masked='••••'>{value}</PrivacyAmount>
                  )}
                </strong>
              </div>
            </section>

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
