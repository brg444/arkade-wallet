import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { consoleError } from '../lib/logs'
import { hasMnemonic } from '../lib/mnemonic'
import { fetchUsdcTransfers, readUsdcBalance, type UsdcTransfer } from '../lib/usdc/chain'
import { usdcAvailable } from '../lib/usdc/config'
import { getUsdcSession, onUsdcSession, type UsdcSession } from '../lib/usdc/keys'
import { loadUsdcSwaps, saveUsdcSwap, swapPhase, type UsdcSwapRecord } from '../lib/usdc/swaps'
import { AspContext } from './asp'

const BALANCE_POLL_MS = 30_000
const SWAP_POLL_MS = 10_000

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

  const available = usdcAvailable(aspInfo.network, hasMnemonic())
  const address = available ? session?.address : undefined
  const arkServerUrl = aspInfo.url

  useEffect(() => onUsdcSession(setSession), [])

  useEffect(() => {
    if (!session) {
      setBalance(undefined)
      setTransfers([])
    }
    setSwaps(loadUsdcSwaps())
  }, [session])

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
  // Satora has locked its side, refunds when a swap can no longer complete.
  const hasPending = swaps.some((record) => swapPhase(record) === 'pending')
  useEffect(() => {
    if (!session || !available || !hasPending || !arkServerUrl) return
    let cancelled = false
    const tick = async () => {
      if (advancing.current) return
      advancing.current = true
      try {
        const { satoraClient, advanceUsdcSwap } = await import('../lib/usdc/satora')
        const client = await satoraClient(session, arkServerUrl)
        for (const record of loadUsdcSwaps().filter((candidate) => swapPhase(candidate) === 'pending')) {
          if (cancelled) return
          try {
            const { record: next, continued } = await advanceUsdcSwap(client, record)
            saveUsdcSwap(next)
            if (continued) saveUsdcSwap(continued)
          } catch (err) {
            consoleError(err, `failed to advance USDC swap ${record.id}`)
            saveUsdcSwap({ ...record, error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() })
          }
        }
        if (!cancelled) {
          setSwaps(loadUsdcSwaps())
          refresh()
        }
      } catch (err) {
        consoleError(err, 'failed to start the Satora client')
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
  }, [session, available, hasPending, arkServerUrl, refresh])

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
