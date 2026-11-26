import { useContext } from 'react'
import AssetCard from '../../components/AssetCard'
import SheetModal from '../../components/SheetModal'
import { type PortfolioRow } from '../../hooks/usePortfolioFiat'
import { hapticLight } from '../../lib/haptics'
import { USD_ACCOUNT_ID } from '../../lib/usdc/config'
import { FlowContext, emptyRecvInfo } from '../../providers/flow'
import { useTranslation } from '../../providers/language'
import { NavigationContext, Pages } from '../../providers/navigation'
import { UsdcContext } from '../../providers/usdc'

/**
 * Receive from Home: the person picks what they are receiving, then gets that
 * asset's own way in. Bitcoin opens the usual Arkade / on-chain / Lightning
 * screen, USD opens the USD account's address, any other asset opens the
 * Arkade receive screen for that asset.
 */
export default function ReceiveAssetSheet({
  isOpen,
  rows,
  onClose,
}: {
  isOpen: boolean
  rows: PortfolioRow[]
  onClose: () => void
}) {
  const { setRecvInfo, setUsdcEntry } = useContext(FlowContext)
  const { navigate } = useContext(NavigationContext)
  const { session } = useContext(UsdcContext)
  const { t } = useTranslation()

  const receiveAsset = (assetId: string) => {
    setRecvInfo({ ...emptyRecvInfo, assetId, assetAmount: BigInt(0) })
    navigate(Pages.ReceiveQRCode)
  }

  const choose = (row: PortfolioRow) => {
    hapticLight()
    onClose()
    if (row.assetId === 'btc') {
      setRecvInfo(emptyRecvInfo)
      navigate(Pages.ReceiveQRCode)
      return
    }
    if (row.assetId === USD_ACCOUNT_ID) {
      // dollars arrive at the USD account's own address; without it (not
      // configured here), they arrive as the Arkade dollars it already holds
      const arkadeDollars = row.sources?.find((source) => source.rail === 'arkade')?.assetId
      if (session || !arkadeDollars) {
        setUsdcEntry('receive')
        navigate(Pages.Usdc)
      } else {
        receiveAsset(arkadeDollars)
      }
      return
    }
    receiveAsset(row.sourceAsset?.assetId ?? row.assetId)
  }

  return (
    <SheetModal isOpen={isOpen} onClose={onClose} labelledBy='receive-asset-title'>
      <div className='flex flex-col gap-3' data-testid='receive-asset-sheet'>
        <h2 id='receive-asset-title' className='home-section-label'>
          {t('wallet.receiveWhat')}
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
