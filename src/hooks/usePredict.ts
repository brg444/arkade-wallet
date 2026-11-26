import { ArkAddress, toXOnlySignerHex } from '@arkade-os/sdk'
import type { LivelinePoint } from 'liveline'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AspContext } from '../providers/asp'
import { WalletContext } from '../providers/wallet'
import { getPredictConfig, type PredictConfig, type PredictKind } from '../lib/predict/constants'
import { bytesToHex } from '../lib/predict/hex'
import {
  createDemoPredictEngine,
  createLivePredictEngine,
  type PredictEngine,
  type PredictQuote,
} from '../lib/predict/engine'
import { fetchPredictMarket, type PredictMarketSnapshot } from '../lib/predict/marketFeed'
import { watchNostrPredictPositions } from '../lib/predict/nostrRfq'
import { payoutMultiplier, predictMultiplier, upcomingWindows } from '../lib/predict/pricing'
import {
  isActivePosition,
  readPredictPositions,
  upsertPredictPosition,
  writePredictPositions,
  type PredictPosition,
} from '../lib/predict/storage'

export interface UsePredictResult {
  config: PredictConfig
  engine: PredictEngine
  holderAddress: string
  holderPubkey: string
  market: PredictMarketSnapshot | null
  chartPoints: LivelinePoint[]
  windows: number[]
  selectedExpiry: number
  setSelectedExpiry: (expiry: number) => void
  lineCents: number | null
  secondsToClose: number
  higherMultiplier: number | null
  lowerMultiplier: number | null
  positions: PredictPosition[]
  activeCount: number
  savePosition: (pos: PredictPosition) => void
  refreshPositions: () => Promise<void>
  requestQuote: (kind: PredictKind, stakeSats: bigint) => Promise<{ quotes: PredictQuote[]; note: string }>
  fundQuote: (quote: PredictQuote) => Promise<PredictPosition>
  cancelPosition: (pos: PredictPosition) => Promise<PredictPosition>
  settlePosition: (pos: PredictPosition) => Promise<{ position: PredictPosition; result: string }>
  refundVoidPosition: (pos: PredictPosition) => Promise<{ position: PredictPosition; result: string }>
  reboardPosition: (pos: PredictPosition) => Promise<{ result: 'reboarded' | 'missing'; commitmentTxid?: string }>
}

export function usePredict(): UsePredictResult {
  const { aspInfo } = useContext(AspContext)
  const { svcWallet, wallet } = useContext(WalletContext)

  const config = useMemo(
    () => getPredictConfig(aspInfo.network, aspInfo.url || undefined),
    [aspInfo.network, aspInfo.url],
  )

  const engine = useMemo(
    () => (config.demoMode ? createDemoPredictEngine(config) : createLivePredictEngine(config, svcWallet)),
    [config, svcWallet],
  )

  const [holderAddress, setHolderAddress] = useState('')
  const [holderPubkey, setHolderPubkey] = useState('')
  const [market, setMarket] = useState<PredictMarketSnapshot | null>(null)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  const [positions, setPositions] = useState<PredictPosition[]>([])
  const marketRef = useRef<PredictMarketSnapshot | null>(null)
  marketRef.current = market

  // Resolve wallet Arkade address & x-only signer pubkey.
  useEffect(() => {
    if (!svcWallet) return
    let cancelled = false
    Promise.resolve(svcWallet.getAddress())
      .then((addr) => {
        if (cancelled || !addr) return
        setHolderAddress(addr)
        if (wallet.pubkey) {
          try {
            setHolderPubkey(toXOnlySignerHex(wallet.pubkey))
          } catch {
            setHolderPubkey('')
          }
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [svcWallet, wallet.pubkey])

  // Load persisted positions for the active wallet & network.
  useEffect(() => {
    const key = holderPubkey || holderAddress
    if (!key) return
    setPositions(readPredictPositions(config.profile.id, key))
  }, [config.profile.id, holderPubkey, holderAddress])

  // Persist positions on update.
  const storageKeyId = holderPubkey || holderAddress
  const savePosition = useCallback(
    (next: PredictPosition) => {
      setPositions((prev) => {
        const updated = upsertPredictPosition(prev, next)
        if (storageKeyId) writePredictPositions(config.profile.id, storageKeyId, updated)
        return updated
      })
    },
    [config.profile.id, storageKeyId],
  )

  // Replay filled positions from Nostr (live mode).
  useEffect(() => {
    if (config.demoMode || !holderAddress) return
    let holderScript = ''
    try {
      holderScript = bytesToHex(ArkAddress.decode(holderAddress).pkScript)
    } catch {
      return
    }
    const sub = watchNostrPredictPositions({
      relays: config.relays,
      holderPkScript: holderScript,
      onPosition: (raw) => {
        const stake = BigInt(raw.stake)
        const payout = BigInt(raw.collateral)
        savePosition({
          id: raw.rfq_id,
          rfqId: raw.rfq_id,
          network: config.profile.id,
          mode: 'live',
          kind: raw.kind,
          strikeCents: String(raw.strike),
          stakeSats: raw.stake,
          payoutSats: raw.collateral,
          multiplier: payoutMultiplier(stake, payout),
          expiry: raw.expiry,
          deadline: raw.expiry - 30,
          exit: raw.exit,
          voidAfter: raw.void_after,
          fallbackDelay: raw.fallback_delay,
          finalExitDelay: raw.final_exit_delay,
          holderAddress,
          holderPubkey: raw.holder_pubkey,
          deskName: config.desks[0]?.name ?? 'COINFLIP',
          deskPkHex: raw.writer_pubkey,
          backupPkHex: raw.backup_pubkey,
          oraclePkHex: raw.oracle_pubkey,
          intentAddress: '',
          vaultAddress: raw.vault_address,
          phase: 'filled',
          refundable: false,
          fillTxid: raw.fill_txid,
          createdAt: Math.max(0, raw.expiry - 300),
        })
      },
    })
    return () => sub.close()
  }, [config.demoMode, config.desks, config.profile.id, config.relays, holderAddress, savePosition])

  // 1-second clock for countdown & window rollover.
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1_000)
    return () => clearInterval(id)
  }, [])

  // Poll live DIA / Deribit BTC price feed every 5 seconds.
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const poll = async () => {
      const next = await fetchPredictMarket(config.oraclePricesUrl, marketRef.current?.samples ?? [], controller.signal)
      if (active && next) setMarket(next)
    }
    void poll()
    const id = setInterval(() => void poll(), 5_000)
    return () => {
      active = false
      controller.abort()
      clearInterval(id)
    }
  }, [config.oraclePricesUrl])

  const windows = useMemo(() => upcomingWindows(nowSec, 3), [nowSec])
  const [selectedExpiry, setSelectedExpiry] = useState<number>(
    () => upcomingWindows(Math.floor(Date.now() / 1000), 1)[0] ?? 0,
  )

  // Auto-advance selectedExpiry when the chosen window drops out of the quotable range.
  useEffect(() => {
    if (windows.length > 0 && !windows.includes(selectedExpiry)) {
      setSelectedExpiry(windows[0]!)
    }
  }, [windows, selectedExpiry])

  const lineCents = market?.priceCents ?? null

  const chartPoints = useMemo<LivelinePoint[]>(
    () => (market?.samples ?? []).map((s) => ({ time: s.time, value: s.priceCents / 100 })),
    [market?.samples],
  )

  const secondsToClose = Math.max(0, selectedExpiry - nowSec)

  const { higherMultiplier, lowerMultiplier } = useMemo(() => {
    if (!market || !lineCents || !selectedExpiry) return { higherMultiplier: null, lowerMultiplier: null }
    const years = Math.max(60, selectedExpiry - nowSec) / (365.25 * 86_400)
    return {
      higherMultiplier: predictMultiplier({
        kind: 2,
        spotCents: market.priceCents,
        lineCents,
        years,
        vol: market.vol,
      }),
      lowerMultiplier: predictMultiplier({
        kind: 3,
        spotCents: market.priceCents,
        lineCents,
        years,
        vol: market.vol,
      }),
    }
  }, [market, lineCents, selectedExpiry, nowSec])

  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const refreshingRef = useRef(false)
  const refreshQueuedRef = useRef(false)
  const settledBackfillTriedRef = useRef<Set<string>>(new Set())
  const storageKeyRef = useRef('')
  const currentScopeKey = storageKeyId ? `${config.profile.id}:${storageKeyId}` : ''
  storageKeyRef.current = currentScopeKey

  useEffect(() => {
    settledBackfillTriedRef.current = new Set()
  }, [currentScopeKey])

  const refreshPositions = useCallback(async () => {
    if (refreshingRef.current) {
      refreshQueuedRef.current = true
      return
    }
    refreshingRef.current = true
    const processedIds = new Set<string>()
    try {
      let runAgain = true
      while (runAgain) {
        runAgain = false
        refreshQueuedRef.current = false
        const scopeKey = storageKeyRef.current
        const current = positionsRef.current
        const pending = current.filter((p) => {
          if (processedIds.has(p.id)) return false
          if (p.phase !== 'settled' && p.phase !== 'refunded') return true
          if (p.phase === 'settled' && (p.userPayoutSats === undefined || !p.settleCents)) {
            return !settledBackfillTriedRef.current.has(p.id)
          }
          return false
        })
        if (pending.length > 0) {
          for (const p of pending) {
            processedIds.add(p.id)
            if (p.phase === 'settled') settledBackfillTriedRef.current.add(p.id)
          }
          const updatedList = await Promise.all(
            pending.map((p) => engine.refreshPosition(p, marketRef.current?.priceCents).catch(() => p)),
          )
          if (storageKeyRef.current !== scopeKey) break
          setPositions((prev) => {
            let next = prev
            for (const item of updatedList) next = upsertPredictPosition(next, item)
            if (storageKeyId) writePredictPositions(config.profile.id, storageKeyId, next)
            return next
          })
        }
        if (refreshQueuedRef.current) runAgain = true
      }
    } finally {
      refreshingRef.current = false
      refreshQueuedRef.current = false
    }
  }, [config.profile.id, engine, storageKeyId])

  const refreshKey = useMemo(
    () =>
      positions
        .filter(
          (p) =>
            (p.phase !== 'settled' && p.phase !== 'refunded') ||
            (p.phase === 'settled' && (p.userPayoutSats === undefined || !p.settleCents)),
        )
        .map((p) => `${p.id}:${p.phase}`)
        .join(','),
    [positions],
  )

  // Refresh immediately when active/incomplete positions load from storage or Nostr replay.
  useEffect(() => {
    if (!refreshKey) return
    void refreshPositions()
  }, [refreshKey, refreshPositions])

  // Refresh open/active positions every 6 seconds while on the Predict screen.
  useEffect(() => {
    const id = setInterval(() => void refreshPositions(), 6_000)
    return () => clearInterval(id)
  }, [refreshPositions])

  const requestQuote = useCallback(
    async (kind: PredictKind, stakeSats: bigint) => {
      if (!holderAddress) throw new Error('Wallet address is not ready yet')
      const liveCents = marketRef.current?.priceCents ?? lineCents
      if (!liveCents || !selectedExpiry) throw new Error('Waiting for live BTC price')
      return engine.requestQuote({
        kind,
        lineCents: liveCents,
        stakeSats,
        expiry: selectedExpiry,
        holderAddress,
        holderPubkey,
        spotCents: liveCents,
        vol: marketRef.current?.vol,
      })
    },
    [engine, holderAddress, holderPubkey, lineCents, selectedExpiry],
  )

  const fundQuote = useCallback(
    async (quote: PredictQuote) => {
      const pos = await engine.fundQuote(quote, holderAddress, holderPubkey)
      savePosition(pos)
      return pos
    },
    [engine, holderAddress, holderPubkey, savePosition],
  )

  const cancelPosition = useCallback(
    async (pos: PredictPosition) => {
      const { txid } = await engine.cancelPosition(pos)
      const next: PredictPosition = { ...pos, phase: 'refunded', refundable: false, closeTxid: txid }
      savePosition(next)
      return next
    },
    [engine, savePosition],
  )

  const settlePosition = useCallback(
    async (pos: PredictPosition) => {
      const out = await engine.settlePosition(pos, marketRef.current?.priceCents)
      if (out.result === 'settled') {
        const next: PredictPosition = {
          ...pos,
          phase: 'settled',
          settleTxid: out.txid || pos.settleTxid,
          settleCents: out.settleCents != null ? out.settleCents.toString() : pos.settleCents,
          userPayoutSats: out.payoutSats != null ? out.payoutSats.toString() : pos.userPayoutSats,
        }
        savePosition(next)
        return { position: next, result: out.result }
      }
      return { position: pos, result: out.result }
    },
    [engine, savePosition],
  )

  const refundVoidPosition = useCallback(
    async (pos: PredictPosition) => {
      const out = await engine.refundVoidPosition(pos)
      if (out.result === 'refunded') {
        const next: PredictPosition = {
          ...pos,
          phase: 'refunded',
          refundable: false,
          settleTxid: out.txid || pos.settleTxid,
          userPayoutSats: pos.stakeSats,
        }
        savePosition(next)
        return { position: next, result: out.result }
      }
      return { position: pos, result: out.result }
    },
    [engine, savePosition],
  )

  const reboardPosition = useCallback((pos: PredictPosition) => engine.reboardPosition(pos), [engine])

  const activeCount = useMemo(() => positions.filter(isActivePosition).length, [positions])

  return {
    config,
    engine,
    holderAddress,
    holderPubkey,
    market,
    chartPoints,
    windows,
    selectedExpiry,
    setSelectedExpiry,
    lineCents,
    secondsToClose,
    higherMultiplier,
    lowerMultiplier,
    positions,
    activeCount,
    savePosition,
    refreshPositions,
    requestQuote,
    fundQuote,
    cancelPosition,
    settlePosition,
    refundVoidPosition,
    reboardPosition,
  }
}
