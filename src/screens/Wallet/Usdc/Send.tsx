import { useContext, useEffect, useState } from 'react'
import Button from '../../../components/Button'
import ButtonsOnBottom from '../../../components/ButtonsOnBottom'
import Content from '../../../components/Content'
import ErrorMessage from '../../../components/Error'
import FlexCol from '../../../components/FlexCol'
import Header from '../../../components/Header'
import Input from '../../../components/Input'
import InputAddress from '../../../components/InputAddress'
import Padded from '../../../components/Padded'
import Scanner from '../../../components/Scanner'
import Table from '../../../components/Table'
import Text from '../../../components/Text'
import { toast } from '../../../components/Toast'
import { hapticSubtle } from '../../../lib/haptics'
import { consoleError } from '../../../lib/logs'
import { formatUsd, formatUsdc, parseUsdc } from '../../../lib/usdc/amount'
import { PAYMASTER_ALLOWANCE, usdcConfig } from '../../../lib/usdc/config'
import { isSendableRecipient, parseScannedRecipient } from '../../../lib/usdc/recipient'
import { useTranslation } from '../../../providers/language'
import { UsdcContext } from '../../../providers/usdc'

/** Held back from "max" until the paymaster has quoted the real fee. */
const FEE_BUFFER = BigInt(50_000) // 0.05 USDC
/** Room left on top of the quoted fee, for gas moving before the send lands. */
const feeWithMargin = (fee: bigint): bigint => {
  const quarter = fee / BigInt(4)
  return fee + (quarter > BigInt(10_000) ? quarter : BigInt(10_000))
}

type FeeState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; fee: bigint } | { status: 'error' }

export default function UsdcSend({ back }: { back: () => void }) {
  const { session, balance, refresh } = useContext(UsdcContext)
  const { t } = useTranslation()

  const [to, setTo] = useState('')
  const [amountText, setAmountText] = useState('')
  const [fee, setFee] = useState<FeeState>({ status: 'idle' })
  const [scan, setScan] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const configured = Boolean(usdcConfig().zerodevRpcUrl)
  const available = balance ?? BigInt(0)
  const amount = parseUsdc(amountText)
  const addressValid = isSendableRecipient(to)
  const selfSend = addressValid && session !== undefined && to.toLowerCase() === session.address.toLowerCase()
  const feeUnits = fee.status === 'ready' ? fee.fee : undefined
  // the paymaster may only pull what this send approves it for
  const feeOverAllowance = feeUnits !== undefined && feeUnits > PAYMASTER_ALLOWANCE
  // before the fee is known, the whole balance already leaves nothing to pay it with
  const overBalance = amount !== undefined && amount + (feeUnits ?? BigInt(1)) > available
  // only with a fee the person can see and the balance can cover: a send that
  // could not be priced is not offered
  const canSend =
    configured &&
    !sending &&
    addressValid &&
    !selfSend &&
    !!amount &&
    amount > BigInt(0) &&
    fee.status === 'ready' &&
    !feeOverAllowance &&
    !overBalance

  const addressError = to && (!addressValid || selfSend) ? t('usdc.invalidAddress') : ''
  const amountError =
    amountText && (amount === undefined || amount === BigInt(0))
      ? t('usdc.invalidAmount')
      : overBalance
        ? t('send.insufficientFunds')
        : ''

  useEffect(() => {
    if (!configured || !session || !addressValid || selfSend || !amount || amount <= BigInt(0)) {
      setFee({ status: 'idle' })
      return
    }
    let cancelled = false
    setFee({ status: 'loading' })
    const timer = setTimeout(async () => {
      try {
        const { estimateUsdcSendFee } = await import('../../../lib/usdc/send')
        const estimate = await estimateUsdcSendFee(session, to, amount)
        if (!cancelled) setFee({ status: 'ready', fee: estimate })
      } catch (err) {
        consoleError(err, 'failed to estimate USDC send fee')
        if (!cancelled) setFee({ status: 'error' })
      }
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [configured, session, to, addressValid, selfSend, amount])

  const handleMax = () => {
    hapticSubtle()
    const max = available - (feeUnits !== undefined ? feeWithMargin(feeUnits) : FEE_BUFFER)
    setAmountText(max > BigInt(0) ? formatUsdc(max, 0).replace(/,/g, '') : '0')
  }

  const handleSend = async () => {
    if (!session || !amount || !canSend) return
    setError('')
    setSending(true)
    try {
      const { sendUsdc } = await import('../../../lib/usdc/send')
      await sendUsdc(session, to, amount)
      toast(t('usdc.sent', { amount: formatUsd(amount) }))
      refresh()
      back()
    } catch (err) {
      consoleError(err, 'USDC send failed')
      setError(t('usdc.sendFailed'))
    } finally {
      setSending(false)
    }
  }

  if (scan)
    return (
      <Scanner
        close={() => setScan(false)}
        label={t('usdc.recipient')}
        onData={(data) => {
          const scanned = parseScannedRecipient(data)
          if ('address' in scanned) {
            setError('')
            setTo(scanned.address)
          } else {
            setError(t('usdc.scanUnsupported'))
          }
          setScan(false)
        }}
        onError={setError}
      />
    )

  const feeText =
    fee.status === 'loading'
      ? t('usdc.estimating')
      : fee.status === 'ready'
        ? formatUsd(fee.fee)
        : fee.status === 'error'
          ? t('usdc.feeUnavailable')
          : '—'

  return (
    <>
      <Header text={t('usdc.sendTitle')} back={back} />
      <Content>
        <Padded>
          <FlexCol gap='1.5rem'>
            <ErrorMessage error={!configured} text={t('usdc.sendUnavailable')} />
            <ErrorMessage error={Boolean(error)} text={error} />
            <InputAddress
              focus
              label={t('usdc.recipient')}
              name='usdc-recipient'
              onChange={setTo}
              openScan={() => setScan(true)}
              placeholder='0x…'
              value={to}
              error={addressError}
            />
            <Input
              label={`${t('usdc.amount')} (USD)`}
              testId='usdc-amount'
              onChange={setAmountText}
              placeholder='0.00'
              value={amountText}
              error={amountError}
              right={
                <button type='button' className='home-section-action' onClick={handleMax}>
                  {t('usdc.max')}
                </button>
              }
            />
            <FlexCol gap='0.5rem'>
              <Table data={[[t('usdc.networkFee'), feeText]]} />
              <Text small color='neutral-500' wrap>
                {t('usdc.networkFeeHint')}
              </Text>
            </FlexCol>
          </FlexCol>
        </Padded>
      </Content>
      <ButtonsOnBottom>
        <Button
          onClick={handleSend}
          disabled={!canSend}
          loading={sending}
          label={
            sending ? t('usdc.sending') : amount ? t('usdc.confirmSend', { amount: formatUsd(amount) }) : t('usdc.send')
          }
          testId='usdc-send'
        />
      </ButtonsOnBottom>
    </>
  )
}
