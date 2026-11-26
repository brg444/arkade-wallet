import { useContext, useEffect, useState } from 'react'
import Button from '../../../components/Button'
import ButtonsOnBottom from '../../../components/ButtonsOnBottom'
import ChainLogo from '../../../components/ChainLogo'
import Content from '../../../components/Content'
import ErrorMessage from '../../../components/Error'
import FlexCol from '../../../components/FlexCol'
import FlexRow from '../../../components/FlexRow'
import Header from '../../../components/Header'
import Input from '../../../components/Input'
import InputAddress from '../../../components/InputAddress'
import InputContainer from '../../../components/InputContainer'
import Padded from '../../../components/Padded'
import Scanner from '../../../components/Scanner'
import Select from '../../../components/Select'
import SheetModal from '../../../components/SheetModal'
import Table, { type TableData } from '../../../components/Table'
import Text from '../../../components/Text'
import { toast } from '../../../components/Toast'
import ChevronDownIcon from '../../../icons/ChevronDown'
import { hapticLight, hapticSubtle } from '../../../lib/haptics'
import { consoleError } from '../../../lib/logs'
import { formatUsd, formatUsdc, parseUsdc } from '../../../lib/usdc/amount'
import {
  USDC_SEND_NETWORKS,
  isCrossChainNetwork,
  usdcSendNetwork,
  type UsdcSendNetworkId,
} from '../../../lib/usdc/cctp'
import { PAYMASTER_ALLOWANCE, usdcConfig } from '../../../lib/usdc/config'
import { isSendableRecipient, parseScannedRecipient } from '../../../lib/usdc/recipient'
import type { UsdcSendFeeQuote } from '../../../lib/usdc/send'
import { useTranslation } from '../../../providers/language'
import { UsdcContext } from '../../../providers/usdc'

/** Held back from "max" until the paymaster has quoted the real Arbitrum gas fee. */
const FEE_BUFFER = BigInt(50_000) // 0.05 USDC
/** Room left on top of the quoted Arbitrum gas fee, for gas moving before the send lands. */
const feeWithMargin = (fee: bigint): bigint => {
  const quarter = fee / BigInt(4)
  return fee + (quarter > BigInt(10_000) ? quarter : BigInt(10_000))
}

type FeeState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; quote: UsdcSendFeeQuote }
  | { status: 'error' }

const NETWORK_IDS = USDC_SEND_NETWORKS.map((net) => net.id)
const NETWORK_LABELS = USDC_SEND_NETWORKS.map((net) => net.name)

export default function UsdcSend({ back }: { back: () => void }) {
  const { session, balance, refresh } = useContext(UsdcContext)
  const { t } = useTranslation()

  const [network, setNetwork] = useState<UsdcSendNetworkId>('arbitrum')
  const [networkPickerOpen, setNetworkPickerOpen] = useState(false)
  const [to, setTo] = useState('')
  const [amountText, setAmountText] = useState('')
  const [fee, setFee] = useState<FeeState>({ status: 'idle' })
  const [scan, setScan] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const selectedNetwork = usdcSendNetwork(network)
  const crossChain = isCrossChainNetwork(network)
  const configured = Boolean(usdcConfig().bundlerUrl)
  const available = balance ?? BigInt(0)
  const amount = parseUsdc(amountText)
  const addressValid = isSendableRecipient(to)
  const selfSend =
    !crossChain && addressValid && session !== undefined && to.toLowerCase() === session.address.toLowerCase()
  const quote = fee.status === 'ready' ? fee.quote : undefined
  // the Arbitrum paymaster may only pull what this send permits it for (bridge fees come out of the burn itself)
  const feeOverAllowance = quote !== undefined && quote.gasFee > PAYMASTER_ALLOWANCE
  // before the fee is known, the whole balance already leaves nothing to pay gas with
  const overBalance = amount !== undefined && amount + (quote !== undefined ? quote.totalFee : BigInt(1)) > available
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
        const estimated = await estimateUsdcSendFee(session, to, amount, network)
        if (!cancelled) setFee({ status: 'ready', quote: estimated })
      } catch (err) {
        consoleError(err, 'failed to estimate USDC send fee')
        if (!cancelled) setFee({ status: 'error' })
      }
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [configured, session, to, addressValid, selfSend, amount, network])

  const handleSelectNetwork = (next: string) => {
    setNetwork(next as UsdcSendNetworkId)
    setNetworkPickerOpen(false)
    setError('')
    setFee({ status: 'idle' })
  }

  const handleMax = () => {
    hapticSubtle()
    const reserve =
      (quote !== undefined ? feeWithMargin(quote.gasFee) : FEE_BUFFER) +
      (quote !== undefined ? quote.bridgeFee : selectedNetwork.defaultForwardingFee)
    const max = available - reserve
    setAmountText(max > BigInt(0) ? formatUsdc(max, 0).replace(/,/g, '') : '0')
  }

  const handleSend = async () => {
    if (!session || !amount || !canSend || !quote) return
    setError('')
    setSending(true)
    try {
      const { sendUsdc } = await import('../../../lib/usdc/send')
      await sendUsdc(session, to, amount, { network, bridgeFee: quote.bridgeFee })
      toast(
        crossChain
          ? t('usdc.sentOnNetwork', { amount: formatUsd(amount), network: selectedNetwork.name })
          : t('usdc.sent', { amount: formatUsd(amount) }),
      )
      refresh()
      back()
    } catch (err) {
      if (err instanceof Error && err.name === 'UsdcSendUncertain') {
        // Already accepted by the bundler: leave Send and point at activity so
        // a second tap cannot send the same transfer twice.
        consoleError('cause' in err ? err.cause : err, 'USDC send did not confirm')
        toast.error(t('usdc.sendUncertain'), { duration: 8000 })
        refresh()
        back()
        return
      }
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
            if (scanned.network) setNetwork(scanned.network)
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
        ? formatUsd(fee.quote.totalFee)
        : fee.status === 'error'
          ? t('usdc.feeUnavailable')
          : '—'

  const summaryRows: TableData = crossChain
    ? [
        [t('usdc.networkFee'), feeText],
        [t('usdc.arrival'), t('usdc.arrivalFast')],
      ]
    : [[t('usdc.networkFee'), feeText]]

  return (
    <>
      <Header text={t('usdc.sendTitle')} back={back} />
      <Content>
        <Padded>
          <FlexCol gap='1.5rem'>
            <ErrorMessage error={!configured} text={t('usdc.sendUnavailable')} />
            <ErrorMessage error={feeOverAllowance} text={t('usdc.feeTooHigh')} />
            <ErrorMessage error={Boolean(error)} text={error} />
            <InputContainer label={t('usdc.network')}>
              <button
                type='button'
                className='input flex w-full items-center justify-between text-left'
                data-testid='usdc-network'
                onClick={() => {
                  hapticLight()
                  setNetworkPickerOpen(true)
                }}
              >
                <FlexRow gap='0.625rem'>
                  <span className='inline-flex size-5 shrink-0 overflow-hidden rounded-full' aria-hidden='true'>
                    <ChainLogo chainId={selectedNetwork.caip2} />
                  </span>
                  <span>{selectedNetwork.name}</span>
                </FlexRow>
                <span className='text-[var(--ink-3)]' aria-hidden='true'>
                  <ChevronDownIcon />
                </span>
              </button>
            </InputContainer>
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
            {crossChain ? (
              <FlexCol gap='0.5rem'>
                <Table data={summaryRows} />
                <Text small color='neutral-500' wrap>
                  {t('usdc.crossChainHint', { network: selectedNetwork.name })}
                </Text>
              </FlexCol>
            ) : (
              <Table data={summaryRows} />
            )}
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
      <SheetModal
        isOpen={networkPickerOpen}
        onClose={() => setNetworkPickerOpen(false)}
        labelledBy='usdc-network-title'
      >
        <div className='flex flex-col gap-3' data-testid='usdc-network-sheet'>
          <h2 id='usdc-network-title' className='home-section-label'>
            {t('usdc.selectNetwork')}
          </h2>
          <Select
            options={NETWORK_IDS}
            labels={NETWORK_LABELS}
            selected={network}
            onChange={handleSelectNetwork}
            renderStart={(id) => {
              const item = usdcSendNetwork(id as UsdcSendNetworkId)
              return (
                <span className='inline-flex size-6 shrink-0 overflow-hidden rounded-full' aria-hidden='true'>
                  <ChainLogo chainId={item.caip2} />
                </span>
              )
            }}
          />
        </div>
      </SheetModal>
    </>
  )
}
