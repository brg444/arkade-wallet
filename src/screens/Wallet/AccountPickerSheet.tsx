import { useContext } from 'react'
import AssetCard from '../../components/AssetCard'
import SheetModal from '../../components/SheetModal'
import { type PortfolioRow } from '../../hooks/usePortfolioFiat'
import { hapticLight } from '../../lib/haptics'
import { USD_ACCOUNT_ID } from '../../lib/usdc/config'
import { FlowContext, emptyRecvInfo, emptySendInfo } from '../../providers/flow'
import { useTranslation } from '../../providers/language'
import { NavigationContext, Pages } from '../../providers/navigation'
import { UsdcContext } from '../../providers/usdc'
import { hasSpendable, sendInfoForRow } from './accountSend'

export type AccountAction = 'receive' | 'send'

/**
 * Receive or Send from Home: the person picks the account first, then gets
 * that account's own flow, the same one its screen opens.
 * - Bitcoin: the usual Arkade / on-chain / Lightning screens.
 * - USD: the USD account's own address or send screen. Sending, when its
 *   USDC is empty and the dollars sit on Arkade, sends those instead.
 * - Any other account: the Arkade flow for the asset behind it.
 */
export function useAccountAction() {
  const { setRecvInfo, setSendInfo, setUsdcEntry } = useContext(FlowContext)
  const { navigate } = useContext(NavigationContext)
  const usdc = useContext(UsdcContext)

  return (action: AccountAction, row: PortfolioRow, portfolioRows: PortfolioRow[]) => {
    if (row.assetId === USD_ACCOUNT_ID) {
      const arkadeDollars = portfolioRows.filter((candidate) => candidate.mergedInto === USD_ACCOUNT_ID)
      const usdcEmpty = !usdc.balance
      const fundedArkade = arkadeDollars.find(
        (candidate) => hasSpendable(candidate) && sendInfoForRow(candidate).account,
      )
      if (action === 'send' && usdcEmpty && fundedArkade) {
        setSendInfo(sendInfoForRow(fundedArkade))
        navigate(Pages.SendForm)
        return
      }
      setUsdcEntry(action)
      navigate(Pages.Usdc)
      return
    }
    if (action === 'send') {
      setSendInfo(row.assetId === 'btc' ? emptySendInfo : sendInfoForRow(row))
      navigate(Pages.SendForm)
      return
    }
    const assetId = row.assetId === 'btc' ? undefined : (row.sourceAsset?.assetId ?? row.assetId)
    setRecvInfo(assetId ? { ...emptyRecvInfo, assetId, assetAmount: BigInt(0) } : emptyRecvInfo)
    navigate(Pages.ReceiveQRCode)
  }
}

export default function AccountPickerSheet({
  action,
  rows,
  portfolioRows,
  onClose,
}: {
  /** Closed when undefined. */
  action: AccountAction | undefined
  rows: PortfolioRow[]
  portfolioRows: PortfolioRow[]
  onClose: () => void
}) {
  const open = useAccountAction()
  const { t } = useTranslation()

  const choose = (row: PortfolioRow) => {
    if (!action) return
    hapticLight()
    onClose()
    open(action, row, portfolioRows)
  }

  return (
    <SheetModal isOpen={Boolean(action)} onClose={onClose} labelledBy='account-picker-title'>
      <div className='flex flex-col gap-3' data-testid='account-picker-sheet'>
        <h2 id='account-picker-title' className='home-section-label'>
          {action === 'send' ? t('wallet.sendWhat') : t('wallet.receiveWhat')}
        </h2>
        <div className='home-section__content'>
          {rows.map((row) => (
            <AssetCard
              key={row.assetId}
              assetId={row.assetId === 'btc' ? '' : row.assetId}
              name={row.name}
              ticker={row.ticker}
              icon={row.icon}
              decimals={row.decimals}
              balance={row.balance}
              trusted={row.assetId === USD_ACCOUNT_ID}
              onClick={() => choose(row)}
            />
          ))}
        </div>
      </div>
    </SheetModal>
  )
}
