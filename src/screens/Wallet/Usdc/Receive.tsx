import Button from '../../../components/Button'
import ButtonsOnBottom from '../../../components/ButtonsOnBottom'
import Content from '../../../components/Content'
import FlexCol from '../../../components/FlexCol'
import Header from '../../../components/Header'
import Padded from '../../../components/Padded'
import QrCode from '../../../components/QrCode'
import Text from '../../../components/Text'
import TokenLogo from '../../../components/TokenLogo'
import Warning from '../../../components/Warning'
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard'
import { useTranslation } from '../../../providers/language'

export default function UsdcReceive({ address, back }: { address: string; back: () => void }) {
  const copy = useCopyToClipboard()
  const { t } = useTranslation()

  return (
    <>
      <Header text={t('usdc.receiveTitle')} back={back} />
      <Content>
        <Padded>
          <FlexCol gap='1.5rem' centered>
            <QrCode value={address} logo={<TokenLogo ticker='USD' />} />
            <FlexCol gap='0.25rem' centered>
              <Text small color='neutral-500'>
                {t('usdc.address')}
              </Text>
              <Text wrap centered copy={address} testId='usdc-address'>
                {address}
              </Text>
            </FlexCol>
            <Warning text={t('usdc.receiveHint')} />
          </FlexCol>
        </Padded>
      </Content>
      <ButtonsOnBottom>
        <Button onClick={() => copy(address)} label={t('usdc.copyAddress')} testId='usdc-copy-address' />
      </ButtonsOnBottom>
    </>
  )
}
