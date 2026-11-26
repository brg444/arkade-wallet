import { useCallback, useContext, useEffect, useState } from 'react'
import { consoleError } from '../lib/logs'
import { fetchSatoraQuote, satoraSourceUnits } from '../lib/usdc/route'
import type { UsdcSwapQuote } from '../lib/usdc/satora'
import type { UsdcSwapDirection } from '../lib/usdc/swaps'
import { AspContext } from '../providers/asp'
import { UsdcContext } from '../providers/usdc'

export type SatoraQuoteStatus = 'idle' | 'loading' | 'success' | 'error'

/**
 * The Satora rail's counterpart to `useOfferQuote`: the Swap screen sets the
 * give amount (whole units, already debounced) and reads back a quote tagged
 * with the amount it priced, so a stale answer never passes for a fresh one.
 * Idle while `direction` is undefined, that is, while an Arkade market fills
 * the pair.
 */
export function useSatoraQuote(direction: UsdcSwapDirection | undefined) {
  const { aspInfo } = useContext(AspContext)
  const { session } = useContext(UsdcContext)
  const [give, setGive] = useState('')
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{
    status: SatoraQuoteStatus
    give: string
    direction?: UsdcSwapDirection
    quote?: UsdcSwapQuote
  }>({ status: 'idle', give: '' })

  useEffect(() => {
    const units = direction ? satoraSourceUnits(direction, give) : undefined
    if (!direction || !session || !aspInfo.url || !units || units <= BigInt(0)) {
      setState({ status: 'idle', give })
      return
    }
    let cancelled = false
    setState({ status: 'loading', give, direction })
    fetchSatoraQuote(session, aspInfo.url, direction, units)
      .then((quote) => {
        if (!cancelled) setState({ status: 'success', give, direction, quote })
      })
      .catch((err) => {
        consoleError(err, 'failed to quote a Satora swap')
        if (!cancelled) setState({ status: 'error', give, direction })
      })
    return () => {
      cancelled = true
    }
  }, [direction, give, nonce, session, aspInfo.url])

  /** Prices the same amount again: a Satora quote carries no expiry of its own. */
  const refresh = useCallback(() => setNonce((current) => current + 1), [])

  return { ...state, setGiveAmount: setGive, refresh }
}
