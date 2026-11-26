import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import DismissibleBanner from '../../components/DismissibleBanner'
import ErrorMessage from '../../components/Error'
import { AspContext } from '../../providers/asp'
import { aspErrorText } from '../../lib/asp'
import { ConfigContext } from '../../providers/config'
import HomeIcon from '../../icons/Home'
import Padded from '../../components/Padded'
import Content from '../../components/Content'
import FlexCol from '../../components/FlexCol'
import { NavigationContext } from '../../providers/navigation'
import { NudgeContext } from '../../providers/nudge'
import { AnnouncementContext } from '../../providers/announcements'
import { WalletStaggerContainer, WalletStaggerChild } from '../../components/WalletLoadIn'
import { pwaCanInstall, usePwaInstalled, canPromptInstall, promptPwaInstall } from '../../lib/pwa'
import { isIOS, isAndroid } from '../../lib/browser'
import { getBootAnimActive, subscribeBootAnim } from '../../lib/bootCover'
import { getPredictConfig } from '../../lib/predict/constants'
import HomeHeader from './HomeHeader'
import PortfolioHero from './PortfolioHero'
import HomeQuickActions from './HomeQuickActions'
import AssetsSection, { useHomeAccountRows } from './AssetsSection'
import AccountPickerSheet, { type AccountAction, useAccountAction } from './AccountPickerSheet'
import { hasSpendable } from './accountSend'
import PredictSection from './PredictSection'
import RecentActivitySection from './RecentActivitySection'
import ContactsSection from './ContactsSection'
import { readContacts } from '../../lib/contacts'
import { usePortfolioBalanceDisplay } from '../../hooks/usePortfolioBalanceDisplay'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { BackupContext } from '@/providers/backup'
import { useTranslation } from '../../providers/language'

export default function Wallet() {
  const { aspInfo } = useContext(AspContext)
  const { announcement } = useContext(AnnouncementContext)
  const { config } = useContext(ConfigContext)
  const { backupAndUpdateConfig } = useContext(BackupContext)
  const { isInitialLoad } = useContext(NavigationContext)
  const { nudge, nudgeCheckComplete } = useContext(NudgeContext)
  const { t } = useTranslation()
  const predictEnabled = getPredictConfig(aspInfo.network, aspInfo.url || undefined).enabled

  const [error, setError] = useState(false)
  const [homeScrolled, setHomeScrolled] = useState(false)
  const [balanceCollapseProgress, setBalanceCollapseProgress] = useState(0)
  const bootAnimActive = useSyncExternalStore(subscribeBootAnim, getBootAnimActive)
  const {
    balance: portfolioBalance,
    maskedBalance: maskedPortfolioBalance,
    unit: portfolioBalanceUnit,
  } = usePortfolioBalanceDisplay()
  const prefersReducedMotion = useReducedMotion()
  // Capture isInitialLoad at mount — it goes false before boot animation ends,
  // which would switch the stagger container from motion.div to plain div
  const shouldStagger = useRef(isInitialLoad).current

  const balanceRef = useRef<HTMLDivElement | null>(null)

  const pwaInstalled = usePwaInstalled()
  const dismissed = (config?.dismissedBanners ?? []).includes('pwa-install')
  const showPwaBanner = pwaCanInstall() && (isIOS() || isAndroid()) && !pwaInstalled && !dismissed
  const pwaBannerVisible = Boolean(nudgeCheckComplete && showPwaBanner)
  const hasHomeNotices = Boolean(nudge || pwaBannerVisible)

  const pwaDescription = isIOS() ? t('wallet.installIosDescription') : t('wallet.installAndroidDescription')

  const dismissPwaBanner = () => {
    if (!config) return
    const dismissedBanners = [...(config.dismissedBanners ?? []), 'pwa-install']
    backupAndUpdateConfig({ ...config, dismissedBanners })
  }

  useEffect(() => {
    setError(aspInfo.unreachable)
  }, [aspInfo.unreachable])

  useEffect(() => {
    const scrollEl = document.querySelector<HTMLElement>('.wallet-home-content')
    if (!scrollEl) return

    let frame = 0
    const updateScrolled = () => {
      frame = 0
      setHomeScrolled(scrollEl.scrollTop > 2)

      const balanceEl = balanceRef.current
      if (!balanceEl) {
        setBalanceCollapseProgress(0)
        return
      }

      // Measure relative to the scroller so cover scale transforms don't skew it.
      const origin = scrollEl.getBoundingClientRect().top
      const balanceTop = balanceEl.getBoundingClientRect().top - origin
      const headerBottom = (document.querySelector('.home-header')?.getBoundingClientRect().bottom ?? 56) - origin
      const collapseStart = headerBottom + 12
      const collapseEnd = headerBottom - 28
      const progress = prefersReducedMotion
        ? Number(balanceTop <= headerBottom)
        : (collapseStart - balanceTop) / (collapseStart - collapseEnd)
      setBalanceCollapseProgress(Math.max(0, Math.min(1, progress)))
    }

    const handleScroll = () => {
      if (frame) return
      frame = window.requestAnimationFrame(updateScrolled)
    }

    updateScrolled()
    scrollEl.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      scrollEl.removeEventListener('scroll', handleScroll)
    }
  }, [prefersReducedMotion])

  const contacts = useMemo(readContacts, [])

  // Receive and Send ask which account first, once there is a choice to make:
  // any account can receive, only one holding something can send
  const { accountRows, portfolioRows } = useHomeAccountRows()
  const sendableRows = accountRows.filter(hasSpendable)
  const [picking, setPicking] = useState<AccountAction>()
  const openAccount = useAccountAction()
  const bitcoinRow = accountRows.find((row) => row.assetId === 'btc') ?? accountRows[0]
  const handleReceive = () => {
    if (accountRows.length > 1) return setPicking('receive')
    if (bitcoinRow) openAccount('receive', bitcoinRow, portfolioRows)
  }
  const handleSend = () => {
    if (sendableRows.length > 1) return setPicking('send')
    // one account to send from opens it; none still opens Send to scan or paste
    const only = sendableRows[0] ?? bitcoinRow
    if (only) openAccount('send', only, portfolioRows)
  }

  return (
    <Content className={homeScrolled ? 'wallet-home-content wallet-home-content--scrolled' : 'wallet-home-content'}>
      <Padded>
        {announcement}
        <HomeHeader
          balance={portfolioBalance}
          balanceProgress={balanceCollapseProgress}
          balanceUnit={portfolioBalanceUnit}
          maskedBalance={maskedPortfolioBalance}
        />
        <WalletStaggerContainer animate={shouldStagger} className='home-stack' hold={bootAnimActive}>
          <WalletStaggerChild animate={shouldStagger} className='home-stack__hero'>
            <PortfolioHero ref={balanceRef} collapseProgress={balanceCollapseProgress} />
          </WalletStaggerChild>
          <WalletStaggerChild animate={shouldStagger} className='home-stack__actions'>
            <HomeQuickActions onReceive={handleReceive} onSend={handleSend} />
          </WalletStaggerChild>
          {hasHomeNotices ? (
            <WalletStaggerChild animate={shouldStagger}>
              <FlexCol gap='0.75rem'>
                {nudge}
                <DismissibleBanner
                  id='pwa-install'
                  icon={<HomeIcon />}
                  title={t('wallet.addArkadeToHome')}
                  description={pwaDescription}
                  action={
                    canPromptInstall()
                      ? {
                          label: t('wallet.install'),
                          onClick: async () => {
                            const outcome = await promptPwaInstall().catch(() => null)
                            if (outcome) dismissPwaBanner()
                          },
                        }
                      : undefined
                  }
                  onDismiss={dismissPwaBanner}
                  visible={pwaBannerVisible}
                />
              </FlexCol>
            </WalletStaggerChild>
          ) : null}
          {error ? (
            <WalletStaggerChild animate={shouldStagger}>
              <ErrorMessage
                error={error}
                text={aspErrorText(aspInfo, t('init.arkadeServerUnreachable'), t('errors.outdatedWallet'))}
              />
            </WalletStaggerChild>
          ) : null}
          {contacts.length ? (
            <WalletStaggerChild animate={shouldStagger} className='home-stack__section'>
              <ContactsSection contacts={contacts} />
            </WalletStaggerChild>
          ) : null}
          <WalletStaggerChild animate={shouldStagger} className='home-stack__section'>
            <AssetsSection />
          </WalletStaggerChild>
          {predictEnabled ? (
            <WalletStaggerChild animate={shouldStagger} className='home-stack__section'>
              <PredictSection />
            </WalletStaggerChild>
          ) : null}
          <WalletStaggerChild animate={shouldStagger} className='home-stack__section'>
            <RecentActivitySection />
          </WalletStaggerChild>
        </WalletStaggerContainer>
      </Padded>
      <AccountPickerSheet
        action={picking}
        rows={picking === 'send' ? sendableRows : accountRows}
        portfolioRows={portfolioRows}
        onClose={() => setPicking(undefined)}
      />
    </Content>
  )
}
