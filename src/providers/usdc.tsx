import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { consoleError } from '../lib/logs'
import { hasMnemonic } from '../lib/mnemonic'
import { fetchUsdcTransfers, readUsdcBalance, type UsdcTransfer } from '../lib/usdc/chain'
import { usdcAvailable } from '../lib/usdc/config'
import { getUsdcSession, onUsdcSession, type UsdcSession } from '../lib/usdc/keys'
import {
  USDC_SWAPS_STORAGE_KEY,
  isFunding,
  loadUsdcSwaps,
  saveUsdcSwap,
  swapPhase,
  type UsdcSwapRecord,
} from '../lib/usdc/swaps'
import { getReceivingAddresses } from '../lib/asp'
import { AspContext } from './asp'
import { WalletContext } from './wallet'

const BALANCE_POLL_MS = 30_000
const SWAP_POLL_MS = 10_000
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
    const [balanceResult, transfersResult] = await Promise.allSettled([
      readUsdcBalance(address),
      fetchUsdcTransfers(address),
    ])
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

  // Drives every unfinished swap to its end, across reloads: claims once
  // Satora has locked its side, refunds when a swap can no longer complete,
  // and continues a refunded swap on to Arkade.
  const hasPending = swaps.some((record) => swapPhase(record) === 'pending')
  useEffect(() => {
    if (!session || !available || !hasPending || !arkServerUrl || !svcWallet) return
    let cancelled = false
    const drive = async () => {
      const { satoraClient, advanceUsdcSwap, reconcileStoredSwaps } = await import('../lib/usdc/satora')
      const client = await satoraClient(session, arkServerUrl)
      const { offchainAddr } = await getReceivingAddresses(svcWallet)
      // once per unlock: adopt swaps Satora's own store knows and this index
      // does not, such as a continuation created right before a crash
      if (reconciledFor.current !== session.address) {
        for (const adopted of await reconcileStoredSwaps(client, loadUsdcSwaps(), offchainAddr)) saveUsdcSwap(adopted)
        reconciledFor.current = session.address
      }
      const pending = loadUsdcSwaps().filter((candidate) => swapPhase(candidate) === 'pending')
      for (const record of pending) {
        if (cancelled) return
        // its funding call is still out: acting on this snapshot could undo it
        if (isFunding(record.id)) continue
        try {
          const { record: next, continued } = await advanceUsdcSwap(client, record, {
            persist: saveUsdcSwap,
            arkAddress: offchainAddr,
          })
          saveUsdcSwap(next)
          if (continued) saveUsdcSwap(continued)
        } catch (err) {
          consoleError(err, `failed to advance USDC swap ${record.id}`)
          // onto the stored record, not this pass's snapshot of it
          const latest = loadUsdcSwaps().find((candidate) => candidate.id === record.id) ?? record
          saveUsdcSwap({ ...latest, error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() })
        }
      }
    }
    const tick = async () => {
      if (advancing.current) return
      advancing.current = true
      try {
        // one tab drives at a time; the others pick the result up from storage
        if (typeof navigator !== 'undefined' && navigator.locks) {
          await navigator.locks.request(SWAP_DRIVER_LOCK, { ifAvailable: true }, (lock) => (lock ? drive() : undefined))
        } else {
          await drive()
        }
        if (!cancelled && getUsdcSession()) {
          setSwaps(loadUsdcSwaps())
          refresh()
        }
      } catch (err) {
        consoleError(err, 'failed to drive USDC swaps')
      } finally {
        advancing.current = false
      }
    }
    tick()
    const id = setInterval(tick, SWAP_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [session, available, hasPending, arkServerUrl, svcWallet, refresh])

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
