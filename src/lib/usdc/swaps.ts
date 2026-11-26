/**
 * The wallet's own record of the Satora swaps it started between Arkade and
 * USDC. Satora keeps the swap secrets in its IndexedDB store; this is the small
 * typed index the screens and the resume loop read, kept in localStorage so a
 * wallet reset wipes it with everything else.
 */
export const USDC_SWAPS_STORAGE_KEY = 'usdcSwaps'

/** Satora's own IndexedDB database (swap secrets, key index), dropped on wallet reset. */
export const SATORA_DATABASE_NAME = 'lendaswap-v3'

/** `toUsdc`: Bitcoin on Arkade in, USDC out. `toArkade`: the reverse. */
export type UsdcSwapDirection = 'toUsdc' | 'toArkade'

export type UsdcSwapPhase = 'pending' | 'complete' | 'refunded' | 'failed'

export interface UsdcSwapRecord {
  id: string
  direction: UsdcSwapDirection
  createdAt: number
  updatedAt: number
  /** Sats for `toUsdc`, USDC base units for `toArkade`, as decimal strings. */
  sourceAmount: string
  targetAmount: string
  /** Satora's raw status. */
  status: string
  /** Arkade address that receives Bitcoin, or refunds for `toUsdc`. */
  arkAddress: string
  /** Set once this wallet has locked its side of the swap. */
  funded: boolean
  /** Satora's EVM contracts for this swap (lowercase), so the USDC legs of a
   * swap are not listed a second time as plain transfers. */
  counterparties?: string[]
  error?: string
}

const COMPLETE = new Set(['clientredeemed', 'serverredeemed'])
const REFUNDED = new Set([
  'clientrefunded',
  'clientrefundedserverfunded',
  'clientrefundedserverrefunded',
  'clientredeemedandclientrefunded',
])
/** States where this wallet's funds are locked and the swap will not complete. */
const NEEDS_REFUND = new Set([
  'expired',
  'clientinvalidfunded',
  'clientfundedtoolate',
  'serverwontfund',
  'clientfundedserverrefunded',
])

export const swapPhase = (record: Pick<UsdcSwapRecord, 'status' | 'funded'>): UsdcSwapPhase => {
  if (COMPLETE.has(record.status)) return 'complete'
  if (REFUNDED.has(record.status)) return 'refunded'
  if (NEEDS_REFUND.has(record.status)) return record.funded ? 'pending' : 'failed'
  return 'pending'
}

export const needsRefund = (record: Pick<UsdcSwapRecord, 'status' | 'funded'>): boolean =>
  record.funded && NEEDS_REFUND.has(record.status)

export const needsClaim = (record: Pick<UsdcSwapRecord, 'status'>): boolean => record.status === 'serverfunded'

export const loadUsdcSwaps = (): UsdcSwapRecord[] => {
  try {
    const raw = localStorage.getItem(USDC_SWAPS_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? (parsed as UsdcSwapRecord[]) : []
  } catch {
    return []
  }
}

export const saveUsdcSwap = (record: UsdcSwapRecord): UsdcSwapRecord[] => {
  const others = loadUsdcSwaps().filter((existing) => existing.id !== record.id)
  const next = [record, ...others].sort((a, b) => b.createdAt - a.createdAt)
  localStorage.setItem(USDC_SWAPS_STORAGE_KEY, JSON.stringify(next))
  return next
}
