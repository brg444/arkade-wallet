import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { consoleError } from '../lib/logs'
import { hasMnemonic } from '../lib/mnemonic'
import { fetchUsdcTransfers, readUsdcBalance, type UsdcTransfer } from '../lib/usdc/chain'
import { usdcAvailable } from '../lib/usdc/config'
import { getUsdcSession, onUsdcSession, type UsdcSession } from '../lib/usdc/keys'
import {
  USDC_SWAPS_STORAGE_KEY,
  UsdcStoreWiped,
  isCreatingSwap,
  isFunding,
  loadUsdcSwaps,
  satoraWipeCount,
  saveUsdcSwap,
  storedSatoraSwapIds,
  swapPhase,
  type UsdcSwapRecord,
} from '../lib/usdc/swaps'
import { getReceivingAddresses } from '../lib/asp'
import { AspContext } from './asp'
import { WalletContext } from './wallet'

const BALANCE_POLL_MS = 30_000
const SWAP_POLL_MS = 10_000
const RECONCILE_RETRY_MS = 60_000
const RECONCILE_DEFER_MS = 2_000
const SWAP_DRIVER_LOCK = 'usdc-swap-driver'

interface UsdcContextProps {
  /** The account exists for this wallet on this deployment. */
  available: boolean
  /** Unlocked: the Arbitrum key is in memory. */
  session: UsdcSession | undefined
  address: string | undefined
  /** Base units; undefined until the first read lands. */
  balance: bigint | undefined
  transfers: UsdcTransfer[]
  swaps: UsdcSwapRecord[]
  refresh: () => Promise<void>
  recordSwap: (record: UsdcSwapRecord) => void
}

export const UsdcContext = createContext<UsdcContextProps>({
  available: false,
  session: undefined,
  address: undefined,
  balance: undefined,
  transfers: [],
  swaps: [],
  refresh: () => Promise.resolve(),
  recordSwap: () => {},
})

export const UsdcProvider = ({ children }: { children: ReactNode }) => {
  const { aspInfo } = useContext(AspContext)
  const [session, setSession] = useState<UsdcSession | undefined>(getUsdcSession)
  const [balance, setBalance] = useState<bigint>()
  const [transfers, setTransfers] = useState<UsdcTransfer[]>([])
  const [swaps, setSwaps] = useState<UsdcSwapRecord[]>(loadUsdcSwaps)
  const advancing = useRef(false)
  const reconciledFor = useRef<string>()
  const { svcWallet } = useContext(WalletContext)

  const available = usdcAvailable(aspInfo.network, hasMnemonic())
  const address = available ? session?.address : undefined
  const arkServerUrl = aspInfo.url

  useEffect(() => onUsdcSession(setSession), [])

  useEffect(() => {
    if (!session) {
      // locked or reset: nothing of the account stays on screen, and a reset
      // has not emptied storage yet when this runs, so storage is not re-read
      setBalance(undefined)
      setTransfers([])
      setSwaps([])
      reconciledFor.current = undefined
      return
    }
    setSwaps(loadUsdcSwaps())
  }, [session])

  // another tab drove a swap forward
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === USDC_SWAPS_STORAGE_KEY && getUsdcSession()) setSwaps(loadUsdcSwaps())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const refresh = useCallback(async () => {
    if (!address) return
    const generation = satoraWipeCount()
    const [balanceResult, transfersResult] = await Promise.allSettled([
      readUsdcBalance(address),
      fetchUsdcTransfers(address),
    ])
    // Locked, reset, or switched wallet while the fetch was in flight.
    if (satoraWipeCount() !== generation || getUsdcSession()?.address !== address) return
    if (balanceResult.status === 'fulfilled') setBalance(balanceResult.value)
    else consoleError(balanceResult.reason, 'failed to read USDC balance')
    if (transfersResult.status === 'fulfilled') setTransfers(transfersResult.value)
  }, [address])

  useEffect(() => {
    if (!address) return
    refresh()
    const id = setInterval(refresh, BALANCE_POLL_MS)
    return () => clearInterval(id)
  }, [address, refresh])

  const recordSwap = useCallback((record: UsdcSwapRecord) => {
    setSwaps(saveUsdcSwap(record))
  }, [])

  // Serializes swap-driving and unlock reconcile across tabs (Web Locks) and
  // within this tab (`advancing`), so reconcile never overlaps with an active
  // advance pass.
  const runExclusive = useCallback(async (mode: 'wait' | 'skip', task: () => Promise<void>): Promise<boolean> => {
    const runInTab = async (): Promise<boolean> => {
      if (advancing.current) return false
      advancing.current = true
      try {
        await task()
        return true
      } finally {
        advancing.current = false
      }
    }
    if (typeof navigator !== 'undefined' && navigator.locks) {
      if (mode === 'skip') {
        let ran = false
        await navigator.locks.request(SWAP_DRIVER_LOCK, { ifAvailable: true }, async (lock) => {
          if (lock) ran = await runInTab()
        })
        return ran
      }
      return navigator.locks.request(SWAP_DRIVER_LOCK, () => runInTab())
    }
    return runInTab()
  }, [])

  // Once per unlock, whether or not anything is pending here: adopt swaps
  // Satora's own store knows and this index does not (a continuation created
  // right before a crash, an index lost to storage eviction). Satora's store
  // is read natively first, so the chunk only loads when there is a gap.
  useEffect(() => {
    if (!session || !available || !arkServerUrl || !svcWallet) return
    if (reconciledFor.current === session.address) return
    let cancelled = false
    const generation = satoraWipeCount()
    const live = () => !cancelled && satoraWipeCount() === generation && getUsdcSession()?.address === session.address
    const reconcile = async (): Promise<'done' | 'defer'> => {
      const ids = await storedSatoraSwapIds()
      if (!live()) return 'done'
      const known = new Set(loadUsdcSwaps().map((record) => record.id))
      if (ids === undefined || ids.some((id) => !known.has(id))) {
        if (isCreatingSwap()) return 'defer'
        let deferred = false
        const ran = await runExclusive('wait', async () => {
          if (!live()) return
          if (isCreatingSwap()) {
            deferred = true
            return
          }
          const currentKnown = new Set(loadUsdcSwaps().map((record) => record.id))
          if (ids !== undefined && !ids.some((id) => !currentKnown.has(id))) return
          const { satoraClient, reconcileStoredSwaps } = await import('../lib/usdc/satora')
          if (!live()) return
          const client = await satoraClient(session, arkServerUrl)
          const { offchainAddr } = await getReceivingAddresses(svcWallet)
          const adopted = await reconcileStoredSwaps(client, loadUsdcSwaps(), offchainAddr)
          if (!live()) return
          if (isCreatingSwap()) {
            deferred = true
            return
          }
          // Only adopt ids still missing from the index: never overwrite a
          // swap created or advanced while listAllSwaps was in flight.
          const latestKnown = new Set(loadUsdcSwaps().map((record) => record.id))
          let added = 0
          for (const record of adopted) {
            if (latestKnown.has(record.id)) continue
            saveUsdcSwap(record)
            added += 1
          }
          if (added > 0) setSwaps(loadUsdcSwaps())
        })
        if (!ran || deferred) return 'defer'
      }
      if (live()) reconciledFor.current = session.address
      return 'done'
    }
    let retry: number | undefined
    const attempt = () =>
      reconcile()
        .then((outcome) => {
          if (outcome === 'defer' && live()) retry = window.setTimeout(attempt, RECONCILE_DEFER_MS)
        })
        .catch((err) => {
          consoleError(err, 'failed to reconcile USDC swaps')
          if (live()) retry = window.setTimeout(attempt, RECONCILE_RETRY_MS)
        })
    attempt()
    return () => {
      cancelled = true
      window.clearTimeout(retry)
    }
  }, [session, available, arkServerUrl, svcWallet, runExclusive])

  // Drives every unfinished swap to its end, across reloads: claims once
  // Satora has locked its side, refunds when a swap can no longer complete,
  // and continues a refunded swap on to Arkade.
  const hasPending = swaps.some((record) => swapPhase(record) === 'pending')
  useEffect(() => {
    if (!session || !available || !hasPending || !arkServerUrl || !svcWallet) return
    let cancelled = false
    const drive = async () => {
      // A reset empties storage while a pass may still be awaiting Satora:
      // nothing this pass holds may be written back after it, so the count is
      // taken before the first await. A lock is different, the storage stays
      // and so do the writes.
      const generation = satoraWipeCount()
      const { satoraClient, advanceUsdcSwap } = await import('../lib/usdc/satora')
      // Do not rebuild a client (which holds the root xprv) after a lock or reset.
      if (cancelled || satoraWipeCount() !== generation || !getUsdcSession()) return
      const client = await satoraClient(session, arkServerUrl)
      const { offchainAddr } = await getReceivingAddresses(svcWallet)
      const assertLive = () => {
        if (satoraWipeCount() !== generation) throw new UsdcStoreWiped()
      }
      const write = (record: UsdcSwapRecord) => {
        assertLive()
        saveUsdcSwap(record)
      }
      const pending = loadUsdcSwaps().filter((candidate) => swapPhase(candidate) === 'pending')
      for (const record of pending) {
        if (cancelled || satoraWipeCount() !== generation) return
        // its funding call is still out: acting on this snapshot could undo it
        if (isFunding(record.id)) continue
        try {
          const { record: next, continued } = await advanceUsdcSwap(client, record, {
            persist: write,
            arkAddress: offchainAddr,
            assertLive,
          })
          write(next)
          if (continued) write(continued)
        } catch (err) {
          if (err instanceof UsdcStoreWiped || satoraWipeCount() !== generation) return
          consoleError(err, `failed to advance USDC swap ${record.id}`)
          // onto the stored record, not this pass's snapshot of it
          const latest = loadUsdcSwaps().find((candidate) => candidate.id === record.id) ?? record
          saveUsdcSwap({ ...latest, error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() })
        }
      }
    }
    const tick = async () => {
      try {
        // one tab drives at a time; the others pick the result up from storage
        const ran = await runExclusive('skip', drive)
        if (ran && !cancelled && getUsdcSession()) {
          setSwaps(loadUsdcSwaps())
          refresh()
        }
      } catch (err) {
        consoleError(err, 'failed to drive USDC swaps')
      }
    }
    tick()
    const id = setInterval(tick, SWAP_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [session, available, hasPending, arkServerUrl, svcWallet, refresh, runExclusive])

  return (
    <UsdcContext.Provider
      value={{
        available,
        session: available ? session : undefined,
        address,
        balance,
        transfers,
        swaps,
        refresh,
        recordSwap,
      }}
    >
      {children}
    </UsdcContext.Provider>
  )
}
