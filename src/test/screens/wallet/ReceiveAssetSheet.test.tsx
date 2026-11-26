import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ReceiveAssetSheet from '../../../screens/Wallet/ReceiveAssetSheet'
import type { PortfolioRow } from '../../../hooks/usePortfolioFiat'
import { USD_ACCOUNT_ID } from '../../../lib/usdc/config'
import { FlowContext, emptyRecvInfo } from '../../../providers/flow'
import { NavigationContext, Pages } from '../../../providers/navigation'
import { UsdcContext } from '../../../providers/usdc'
import { mockFlowContextValue, mockNavigationContextValue } from '../mocks'

vi.mock('../../../lib/haptics', () => ({ hapticLight: vi.fn() }))
vi.mock('../../../components/SheetModal', () => ({
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => (isOpen ? children : null),
}))
vi.mock('../../../components/AssetCard', () => ({
  default: ({ name, onClick }: { name: string; onClick: () => void }) => (
    <button type='button' onClick={onClick}>
      {name}
    </button>
  ),
}))

const row = (assetId: string, name: string, extra: Partial<PortfolioRow> = {}): PortfolioRow => ({
  assetId,
  name,
  ticker: name,
  decimals: 2,
  balance: BigInt(0),
  spendableBalance: BigInt(0),
  fiatAmount: 0,
  satsEquivalent: 0,
  hasFiatPrice: false,
  ...extra,
})

const rows = [
  row('btc', 'Bitcoin'),
  row(USD_ACCOUNT_ID, 'USD', {
    sources: [{ rail: 'arkade', assetId: 'arkade-usd', balance: BigInt(0), fiatAmount: 0 }],
  }),
  row('euro-account', 'EUR', { sourceAsset: { assetId: 'arkade-eur', balance: BigInt(0), decimals: 2 } }),
]

const renderSheet = (usdcSession: boolean) => {
  const navigate = vi.fn()
  const setRecvInfo = vi.fn()
  const setUsdcEntry = vi.fn()
  const onClose = vi.fn()
  render(
    <UsdcContext.Provider value={{ session: usdcSession ? { address: '0xme' } : undefined } as any}>
      <NavigationContext.Provider value={{ ...mockNavigationContextValue, navigate }}>
        <FlowContext.Provider value={{ ...mockFlowContextValue, setRecvInfo, setUsdcEntry }}>
          <ReceiveAssetSheet isOpen rows={rows} onClose={onClose} />
        </FlowContext.Provider>
      </NavigationContext.Provider>
    </UsdcContext.Provider>,
  )
  return { navigate, setRecvInfo, setUsdcEntry, onClose }
}

describe('ReceiveAssetSheet', () => {
  it('asks what is coming in, listing what Home lists', () => {
    renderSheet(true)
    expect(screen.getByText('What do you want to receive?')).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Bitcoin', 'USD', 'EUR'])
  })

  it('opens the usual Bitcoin receive screen for Bitcoin', () => {
    const { navigate, setRecvInfo, onClose } = renderSheet(true)
    fireEvent.click(screen.getByText('Bitcoin'))
    expect(onClose).toHaveBeenCalled()
    expect(setRecvInfo).toHaveBeenCalledWith(emptyRecvInfo)
    expect(navigate).toHaveBeenCalledWith(Pages.ReceiveQRCode)
  })

  it('opens the USD account straight on its address for USD', () => {
    const { navigate, setUsdcEntry, setRecvInfo } = renderSheet(true)
    fireEvent.click(screen.getByText('USD'))
    expect(setUsdcEntry).toHaveBeenCalledWith('receive')
    expect(navigate).toHaveBeenCalledWith(Pages.Usdc)
    expect(setRecvInfo).not.toHaveBeenCalled()
  })

  it('receives USD as the Arkade dollars it holds where the USD account is not set up', () => {
    const { navigate, setUsdcEntry, setRecvInfo } = renderSheet(false)
    fireEvent.click(screen.getByText('USD'))
    expect(setUsdcEntry).not.toHaveBeenCalled()
    expect(setRecvInfo).toHaveBeenCalledWith({ ...emptyRecvInfo, assetId: 'arkade-usd', assetAmount: BigInt(0) })
    expect(navigate).toHaveBeenCalledWith(Pages.ReceiveQRCode)
  })

  it('receives any other account as the Arkade asset behind it', () => {
    const { navigate, setRecvInfo } = renderSheet(true)
    fireEvent.click(screen.getByText('EUR'))
    expect(setRecvInfo).toHaveBeenCalledWith({ ...emptyRecvInfo, assetId: 'arkade-eur', assetAmount: BigInt(0) })
    expect(navigate).toHaveBeenCalledWith(Pages.ReceiveQRCode)
  })
})
