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

/**
 * `needed`: a USD → Bitcoin swap was refunded as Satora's lock token, which
 * still has to be swapped on to Arkade. `done`: it was. `unavailable`: the
 * refund could not be continued and stays in the account as that token.
 */
export type UsdcSwapContinuation = 'needed' | 'done' | 'unavailable'

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
  /** Set once this wallet knows it has locked its side of the swap. Never
   * goes back to false: see {@link mergeUsdcSwap}. */
  funded: boolean
  /** Set just before the funding call goes out. Funding can land without this
   * wallet ever hearing back (a timeout, a closed tab), so a swap that only
   * got this far is still refunded when it can no longer complete. */
  fundingAttempted?: boolean
  /** Refunds tried on a swap that is only known to have attempted funding,
   * and when the last one went out: they are spaced, see
   * {@link BLIND_REFUND_BACKOFF_MS}. */
  refundAttempts?: number
  refundAttemptAt?: number
  continuation?: UsdcSwapContinuation
  /** When the continuation became needed, to bound how long it is retried. */
  continuationSince?: number
  /** The swap a refund was continued into. */
  continuedTo?: string
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
/** Statuses Satora reports before it has seen this wallet's funding. */
const UNFUNDED = new Set(['pending', 'expired'])

/**
 * How long to wait before each refund try on a swap that may never have been
 * funded. Spread over more than a day, so a refund that cannot go through yet
 * (a timelock still running, a server briefly down) is not given up on within
 * a minute of polling.
 */
export const BLIND_REFUND_BACKOFF_MS = [0, 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]
export const MAX_BLIND_REFUND_ATTEMPTS = BLIND_REFUND_BACKOFF_MS.length
/** How long a refunded swap keeps trying to continue on to Arkade. */
export const CONTINUATION_WINDOW_MS = 24 * 60 * 60 * 1000

type PhaseFields = Pick<UsdcSwapRecord, 'status' | 'funded'> &
  Partial<Pick<UsdcSwapRecord, 'fundingAttempted' | 'refundAttempts' | 'continuation'>>

export const isRefundedStatus = (status: string): boolean => REFUNDED.has(status)
export const isUnfundedStatus = (status: string): boolean => UNFUNDED.has(status)

export const needsRefund = (record: PhaseFields): boolean => {
  if (!NEEDS_REFUND.has(record.status)) return false
  if (record.funded) return true
  return Boolean(record.fundingAttempted) && (record.refundAttempts ?? 0) < MAX_BLIND_REFUND_ATTEMPTS
}

/** Whether the next spaced refund try on a not-known-funded swap is due. */
export const blindRefundDue = (
  record: Pick<UsdcSwapRecord, 'refundAttempts' | 'refundAttemptAt'>,
  now = Date.now(),
): boolean => {
  const attempts = record.refundAttempts ?? 0
  if (attempts >= MAX_BLIND_REFUND_ATTEMPTS) return false
  return now - (record.refundAttemptAt ?? 0) >= BLIND_REFUND_BACKOFF_MS[attempts]
}

export const needsContinuation = (record: Pick<UsdcSwapRecord, 'continuation'>): boolean =>
  record.continuation === 'needed'

export const swapPhase = (record: PhaseFields): UsdcSwapPhase => {
  if (COMPLETE.has(record.status)) return 'complete'
  // refunded (or about to be) on Satora's side, but the money is not back
  // where it belongs until the refund has been swapped on
  if (needsContinuation(record) && (REFUNDED.has(record.status) || needsRefund(record))) return 'pending'
  if (REFUNDED.has(record.status)) return 'refunded'
  if (NEEDS_REFUND.has(record.status)) return needsRefund(record) ? 'pending' : 'failed'
  return 'pending'
}

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

const CONTINUATION_RANK: Record<UsdcSwapContinuation, number> = { needed: 1, unavailable: 2, done: 3 }

/**
 * Folds a new version of a record into the stored one. Two writers touch a
 * record at once (the funding call and the resume loop), each from its own
 * snapshot, so the facts that only ever move forward are merged, never
 * overwritten: a swap known to be funded stays funded, and a continuation
 * never steps back.
 */
export const mergeUsdcSwap = (existing: UsdcSwapRecord | undefined, incoming: UsdcSwapRecord): UsdcSwapRecord => {
  if (!existing) return incoming
  const continuation =
    existing.continuation && incoming.continuation
      ? CONTINUATION_RANK[existing.continuation] > CONTINUATION_RANK[incoming.continuation]
        ? existing.continuation
        : incoming.continuation
      : (incoming.continuation ?? existing.continuation)
  const counterparties = [...new Set([...(existing.counterparties ?? []), ...(incoming.counterparties ?? [])])]
  return {
    ...incoming,
    funded: existing.funded || incoming.funded,
    fundingAttempted: existing.fundingAttempted || incoming.fundingAttempted || undefined,
    refundAttempts: Math.max(existing.refundAttempts ?? 0, incoming.refundAttempts ?? 0) || undefined,
    refundAttemptAt: Math.max(existing.refundAttemptAt ?? 0, incoming.refundAttemptAt ?? 0) || undefined,
    continuation,
    continuationSince: existing.continuationSince ?? incoming.continuationSince,
    continuedTo: incoming.continuedTo ?? existing.continuedTo,
    counterparties: counterparties.length ? counterparties : undefined,
  }
}

export const saveUsdcSwap = (record: UsdcSwapRecord): UsdcSwapRecord[] => {
  const stored = loadUsdcSwaps()
  const merged = mergeUsdcSwap(
    stored.find((existing) => existing.id === record.id),
    record,
  )
  const next = [merged, ...stored.filter((existing) => existing.id !== record.id)].sort(
    (a, b) => b.createdAt - a.createdAt,
  )
  localStorage.setItem(USDC_SWAPS_STORAGE_KEY, JSON.stringify(next))
  return next
}

// Swaps whose funding call is in flight right now. The resume loop leaves them
// alone until it returns, so it never acts on a half-funded snapshot.
const funding = new Set<string>()
export const beginFunding = (id: string): void => void funding.add(id)
export const endFunding = (id: string): void => void funding.delete(id)
export const isFunding = (id: string): boolean => funding.has(id)

// The Satora client lives in a lazy chunk; once built it registers how to
// drop itself and empty its stores, so lock and reset reach it without
// loading that chunk themselves.
let forgetSatora: (() => void) | undefined
let wipeSatora: (() => Promise<void>) | undefined

export const registerSatoraLifecycle = (hooks: { forget: () => void; wipe: () => Promise<void> }): void => {
  forgetSatora = hooks.forget
  wipeSatora = hooks.wipe
}

/** Drops the cached Satora client, and with it the wallet root it was built from. */
export const forgetSatoraSession = (): void => forgetSatora?.()

/** Empties and deletes Satora's own database. Never throws: a reset must finish. */
export const wipeSatoraData = async (): Promise<void> => {
  try {
    await wipeSatora?.()
  } catch {
    // fall through to the delete below
  }
  forgetSatora?.()
  if (typeof indexedDB !== 'undefined') indexedDB.deleteDatabase(SATORA_DATABASE_NAME)
}
