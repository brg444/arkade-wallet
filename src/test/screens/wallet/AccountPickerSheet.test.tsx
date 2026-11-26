import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import AccountPickerSheet, { type AccountAction } from '../../../screens/Wallet/AccountPickerSheet'
import { sendInfoForRow } from '../../../screens/Wallet/accountSend'
import type { PortfolioRow } from '../../../hooks/usePortfolioFiat'
import { USD_ACCOUNT_ID } from '../../../lib/usdc/config'
import { Currencies } from '../../../lib/types'
import { FlowContext, emptyRecvInfo, emptySendInfo } from '../../../providers/flow'
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
  balance: BigInt(500),
  spendableBalance: BigInt(500),
  fiatAmount: 0,
  satsEquivalent: 0,
  hasFiatPrice: false,
  ...extra,
})

const arkadeUsd = row('usd-account', 'USD', {
  fiatCurrency: Currencies.USD,
  mergedInto: USD_ACCOUNT_ID,
  sourceAsset: { assetId: 'arkade-usd', balance: BigInt(500), decimals: 2 },
})
const euro = row('euro-account', 'EUR', {
  fiatCurrency: Currencies.EUR,
  sourceAsset: { assetId: 'arkade-eur', balance: BigInt(500), decimals: 2 },
})
const homeRows = [row('btc', 'Bitcoin'), row(USD_ACCOUNT_ID, 'USD'), euro]
const portfolioRows = [...homeRows, arkadeUsd]

const renderSheet = (action: AccountAction, usdcBalance = BigInt(1_000_000)) => {
  const navigate = vi.fn()
  const setRecvInfo = vi.fn()
  const setSendInfo = vi.fn()
  const setUsdcEntry = vi.fn()
  const onClose = vi.fn()
  render(
    <UsdcContext.Provider value={{ session: { address: '0xme' }, balance: usdcBalance } as any}>
      <NavigationContext.Provider value={{ ...mockNavigationContextValue, navigate }}>
        <FlowContext.Provider value={{ ...mockFlowContextValue, setRecvInfo, setSendInfo, setUsdcEntry }}>
          <AccountPickerSheet action={action} rows={homeRows} portfolioRows={portfolioRows} onClose={onClose} />
        </FlowContext.Provider>
      </NavigationContext.Provider>
    </UsdcContext.Provider>,
  )
  return { navigate, setRecvInfo, setSendInfo, setUsdcEntry, onClose }
}

describe('AccountPickerSheet, receiving', () => {
  it('asks what is coming in, listing the accounts it is given', () => {
    renderSheet('receive')
    expect(screen.getByText('What do you want to receive?')).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Bitcoin', 'USD', 'EUR'])
  })

  it('opens the usual Bitcoin receive screen for Bitcoin', () => {
    const { navigate, setRecvInfo, onClose } = renderSheet('receive')
    fireEvent.click(screen.getByText('Bitcoin'))
    expect(onClose).toHaveBeenCalled()
    expect(setRecvInfo).toHaveBeenCalledWith(emptyRecvInfo)
    expect(navigate).toHaveBeenCalledWith(Pages.ReceiveQRCode)
  })

  it('opens the USD account straight on its address for USD', () => {
    const { navigate, setUsdcEntry, setRecvInfo } = renderSheet('receive')
    fireEvent.click(screen.getByText('USD'))
    expect(setUsdcEntry).toHaveBeenCalledWith('receive')
    expect(navigate).toHaveBeenCalledWith(Pages.Usdc)
    expect(setRecvInfo).not.toHaveBeenCalled()
  })

  it('receives any other account as the Arkade asset behind it', () => {
    const { navigate, setRecvInfo } = renderSheet('receive')
    fireEvent.click(screen.getByText('EUR'))
    expect(setRecvInfo).toHaveBeenCalledWith({ ...emptyRecvInfo, assetId: 'arkade-eur', assetAmount: BigInt(0) })
    expect(navigate).toHaveBeenCalledWith(Pages.ReceiveQRCode)
  })
})

describe('AccountPickerSheet, sending', () => {
  it('asks what is going out', () => {
    renderSheet('send')
    expect(screen.getByText('What do you want to send?')).toBeInTheDocument()
  })

  it('opens the usual Send form for Bitcoin', () => {
    const { navigate, setSendInfo } = renderSheet('send')
    fireEvent.click(screen.getByText('Bitcoin'))
    expect(setSendInfo).toHaveBeenCalledWith(emptySendInfo)
    expect(navigate).toHaveBeenCalledWith(Pages.SendForm)
  })

  it('opens the USD account straight on its send screen while it holds USDC', () => {
    const { navigate, setUsdcEntry, setSendInfo } = renderSheet('send')
    fireEvent.click(screen.getByText('USD'))
    expect(setUsdcEntry).toHaveBeenCalledWith('send')
    expect(navigate).toHaveBeenCalledWith(Pages.Usdc)
    expect(setSendInfo).not.toHaveBeenCalled()
  })

  it('sends the Arkade dollars when the USD account holds no USDC', () => {
    const { navigate, setUsdcEntry, setSendInfo } = renderSheet('send', BigInt(0))
    fireEvent.click(screen.getByText('USD'))
    expect(setUsdcEntry).not.toHaveBeenCalled()
    expect(setSendInfo).toHaveBeenCalledWith(sendInfoForRow(arkadeUsd))
    expect(navigate).toHaveBeenCalledWith(Pages.SendForm)
  })

  it('sends any other account the way its own screen does', () => {
    const { navigate, setSendInfo } = renderSheet('send')
    fireEvent.click(screen.getByText('EUR'))
    expect(setSendInfo).toHaveBeenCalledWith(sendInfoForRow(euro))
    expect(setSendInfo.mock.calls[0][0].account).toMatchObject({ assetId: 'euro-account', ticker: 'EUR' })
    expect(navigate).toHaveBeenCalledWith(Pages.SendForm)
  })
})
