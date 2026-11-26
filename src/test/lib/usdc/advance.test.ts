import { beforeEach, describe, expect, it, vi } from 'vitest'
import { advanceUsdcSwap, reconcileStoredSwaps } from '../../../lib/usdc/satora'
import { loadUsdcSwaps, saveUsdcSwap, swapPhase, type UsdcSwapRecord } from '../../../lib/usdc/swaps'

type Client = Parameters<typeof advanceUsdcSwap>[0]

const record = (overrides: Partial<UsdcSwapRecord> = {}): UsdcSwapRecord => ({
  id: 'swap-1',
  direction: 'toArkade',
  createdAt: 1,
  updatedAt: 1,
  sourceAmount: '100000000',
  targetAmount: '99000',
  status: 'clientfunded',
  arkAddress: 'ark1dest',
  funded: true,
  ...overrides,
})

const swapResponse = (overrides: Record<string, unknown> = {}) => ({
  id: 'swap-1',
  direction: 'evm_to_arkade',
  status: 'clientfunded',
  created_at: '2026-11-26T00:00:00Z',
  source_amount: '100000000',
  target_amount: '99000',
  target_arkade_address: 'ark1dest',
  evm_coordinator_address: '0xC0',
  evm_htlc_address: '0xH1',
  ...overrides,
})

const options = { persist: (next: UsdcSwapRecord) => void saveUsdcSwap(next), arkAddress: 'ark1fallback' }

describe('advancing a USD swap', () => {
  beforeEach(() => localStorage.clear())

  it('retries the continuation of a refunded swap until it lands, instead of stranding the refund', async () => {
    const statuses = ['serverwontfund', 'clientrefunded']
    const client = {
      getSwap: vi.fn(async (id: string) =>
        id === 'swap-2'
          ? swapResponse({ id: 'swap-2', status: 'clientfundingseen', target_amount: '98000' })
          : swapResponse({ status: statuses.length > 1 ? statuses.shift() : statuses[0] }),
      ),
      collabRefundEvmSwap: vi.fn(async () => ({ txHash: '0xrefund' })),
      getRefundedEvmSwapContinuation: vi.fn(async () => ({ eligible: true })),
      continueRefundedEvmSwap: vi
        .fn()
        .mockRejectedValueOnce(new Error('network dropped'))
        .mockResolvedValueOnce({ newSwapId: 'swap-2' }),
    } as unknown as Client

    saveUsdcSwap(record())
    // first pass: the refund lands, the continuation call fails
    await expect(advanceUsdcSwap(client, record(), options)).rejects.toThrow('network dropped')
    const afterFailure = loadUsdcSwaps()[0]
    expect(afterFailure).toMatchObject({ status: 'clientrefunded', continuation: 'needed' })
    // refunded on Satora's side, yet still pending here: the loop comes back
    expect(swapPhase(afterFailure)).toBe('pending')

    // second pass: no second refund, the continuation goes through
    const { record: done, continued } = await advanceUsdcSwap(client, afterFailure, options)
    expect(client.collabRefundEvmSwap).toHaveBeenCalledTimes(1)
    expect(done).toMatchObject({ continuation: 'done', continuedTo: 'swap-2' })
    expect(swapPhase(done)).toBe('refunded')
    // the new swap carries its own terms, not the refunded swap's
    expect(continued).toMatchObject({ id: 'swap-2', targetAmount: '98000', funded: true, direction: 'toArkade' })
  })

  it('treats an expired swap as funded when Satora recorded its funding transaction', async () => {
    const client = {
      getSwap: vi
        .fn()
        .mockResolvedValueOnce(
          swapResponse({ direction: 'arkade_to_evm', status: 'expired', btc_fund_txid: 'ab'.repeat(32) }),
        )
        .mockResolvedValue(swapResponse({ direction: 'arkade_to_evm', status: 'clientrefunded' })),
      refundSwap: vi.fn(async () => ({})),
    } as unknown as Client
    const unfunded = record({ direction: 'toUsdc', status: 'pending', funded: false })

    const { record: next } = await advanceUsdcSwap(client, unfunded, options)
    expect(client.refundSwap).toHaveBeenCalledWith('swap-1', { destinationAddress: 'ark1dest' })
    expect(next).toMatchObject({ status: 'clientrefunded', funded: true })
  })

  it('leaves an expired swap that was never funded alone', async () => {
    const client = {
      getSwap: vi.fn(async () => swapResponse({ direction: 'arkade_to_evm', status: 'expired' })),
      refundSwap: vi.fn(),
    } as unknown as Client
    const { record: next } = await advanceUsdcSwap(client, record({ direction: 'toUsdc', funded: false }), options)
    expect(client.refundSwap).not.toHaveBeenCalled()
    expect(swapPhase(next)).toBe('failed')
  })

  it('adopts swaps Satora stored that the wallet index never recorded', async () => {
    const client = {
      listAllSwaps: vi.fn(async () => [
        { swapId: 'swap-1', response: swapResponse() },
        { swapId: 'swap-2', response: swapResponse({ id: 'swap-2', status: 'clientfundingseen' }) },
        { swapId: 'swap-3', response: swapResponse({ id: 'swap-3', direction: 'lightning_to_evm' }) },
        { swapId: 'swap-9', response: swapResponse({ id: 'swap-9' }) },
      ]),
    } as unknown as Client
    const adopted = await reconcileStoredSwaps(
      client,
      [record(), record({ id: 'old', continuedTo: 'swap-9' })],
      'ark1x',
    )
    // a continuation the index only points at is adopted too, as funded
    expect(adopted.map((swap) => [swap.id, swap.direction, swap.funded, swap.arkAddress])).toEqual([
      ['swap-2', 'toArkade', true, 'ark1dest'],
      ['swap-9', 'toArkade', true, 'ark1dest'],
    ])
  })

  it('spaces out refund tries on a swap that only attempted funding', async () => {
    const client = {
      getSwap: vi.fn(async () => swapResponse({ direction: 'arkade_to_evm', status: 'expired' })),
      refundSwap: vi.fn(async () => {
        throw new Error('nothing to refund yet')
      }),
    } as unknown as Client
    const attempted = record({ direction: 'toUsdc', funded: false, fundingAttempted: true })

    // the first try goes out at once, and is on record before it can fail
    await expect(advanceUsdcSwap(client, attempted, options)).rejects.toThrow('nothing to refund yet')
    const afterFirst = loadUsdcSwaps()[0]
    expect(afterFirst).toMatchObject({ refundAttempts: 1 })
    expect(swapPhase(afterFirst)).toBe('pending')

    // ten seconds later the loop is back: too soon, no second try
    await advanceUsdcSwap(client, afterFirst, options)
    expect(client.refundSwap).toHaveBeenCalledTimes(1)

    // past the wait, it tries again
    await expect(
      advanceUsdcSwap(client, { ...afterFirst, refundAttemptAt: Date.now() - 61_000 }, options),
    ).rejects.toThrow('nothing to refund yet')
    expect(client.refundSwap).toHaveBeenCalledTimes(2)
  })

  it('indexes a continuation before closing the refunded swap, so a failed read cannot strand it', async () => {
    const client = {
      getSwap: vi.fn(async (id: string) => {
        if (id === 'swap-2') throw new Error('502')
        return swapResponse({ status: 'clientrefunded' })
      }),
      getRefundedEvmSwapContinuation: vi.fn(async () => ({ eligible: true })),
      continueRefundedEvmSwap: vi.fn(async () => ({ newSwapId: 'swap-2' })),
    } as unknown as Client
    const refunded = record({ status: 'clientrefunded', continuation: 'needed' })
    saveUsdcSwap(refunded)

    await expect(advanceUsdcSwap(client, refunded, options)).rejects.toThrow('502')
    const stored = loadUsdcSwaps()
    expect(stored.find((swap) => swap.id === 'swap-1')).toMatchObject({ continuation: 'done', continuedTo: 'swap-2' })
    const stub = stored.find((swap) => swap.id === 'swap-2')
    expect(stub).toMatchObject({ provisional: true, funded: true, direction: 'toArkade', arkAddress: 'ark1dest' })
    expect(swapPhase(stub!)).toBe('pending')

    // the next pass reads the continuation's own terms onto it
    const live = {
      getSwap: vi.fn(async () =>
        swapResponse({ id: 'swap-2', status: 'clientfundingseen', source_amount: '99500', target_amount: '98000' }),
      ),
    } as unknown as Client
    const { record: read } = await advanceUsdcSwap(live, stub!, options)
    expect(read).toMatchObject({ sourceAmount: '99500', targetAmount: '98000', funded: true })
    expect(read.provisional).toBeUndefined()
  })

  it('counts the continuation window from the refund landing, not from the first refund try', async () => {
    vi.useFakeTimers()
    try {
      const start = Date.parse('2026-11-26T00:00:00Z')
      vi.setSystemTime(start)
      let refunded = false
      const client = {
        getSwap: vi.fn(async () => swapResponse({ status: refunded ? 'clientrefunded' : 'serverwontfund' })),
        collabRefundEvmSwap: vi.fn(async () => {
          if (!refunded) throw new Error('server down')
          return { txHash: '0xrefund' }
        }),
        getRefundedEvmSwapContinuation: vi.fn(async () => ({ eligible: false, reason: 'indexing' })),
      } as unknown as Client
      saveUsdcSwap(record())

      // the refund cannot go out yet: nothing starts the clock
      await expect(advanceUsdcSwap(client, record(), options)).rejects.toThrow('server down')
      const waiting = loadUsdcSwaps()[0]
      expect(waiting).toMatchObject({ continuation: 'needed' })
      expect(waiting.continuationSince).toBeUndefined()

      // a day and more later it lands, and Satora has not indexed it yet
      vi.setSystemTime(start + 25 * 60 * 60 * 1000)
      refunded = true
      const { record: after } = await advanceUsdcSwap(client, waiting, options)
      expect(after).toMatchObject({ continuation: 'needed', continuationSince: start + 25 * 60 * 60 * 1000 })
      expect(swapPhase(after)).toBe('pending')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refunds on its own authority once the timelock has passed and Satora will not co-sign', async () => {
    const past = Math.floor(Date.now() / 1000) - 60
    const future = Math.floor(Date.now() / 1000) + 3600
    const make = (locktime: number) =>
      ({
        getSwap: vi.fn(async () => swapResponse({ status: 'serverwontfund', evm_refund_locktime: locktime })),
        collabRefundEvmSwap: vi.fn(async () => {
          throw new Error('refused')
        }),
        refundEvmSponsored: vi.fn(async () => ({ txHash: '0xown', userOpHash: '0xop' })),
      }) as unknown as Client & { refundEvmSponsored: ReturnType<typeof vi.fn> }

    // before the timelock, only Satora can refund: the failure stands
    const early = make(future)
    await expect(advanceUsdcSwap(early, record(), options)).rejects.toThrow('refused')
    expect(early.refundEvmSponsored).not.toHaveBeenCalled()

    // after it, the wallet refunds without Satora
    const late = make(past)
    await advanceUsdcSwap(late, record(), options)
    expect(late.refundEvmSponsored).toHaveBeenCalledWith('swap-1')
  })
})
