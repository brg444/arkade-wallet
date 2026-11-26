import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_BLIND_REFUND_ATTEMPTS,
  loadUsdcSwaps,
  mergeUsdcSwap,
  needsClaim,
  needsRefund,
  saveUsdcSwap,
  swapPhase,
  type UsdcSwapRecord,
} from '../../../lib/usdc/swaps'

const record = (overrides: Partial<UsdcSwapRecord> = {}): UsdcSwapRecord => ({
  id: 'swap-1',
  direction: 'toUsdc',
  createdAt: 1,
  updatedAt: 1,
  sourceAmount: '100000',
  targetAmount: '95000000',
  status: 'pending',
  arkAddress: 'ark1qq',
  funded: false,
  ...overrides,
})

describe('USD account swap records', () => {
  beforeEach(() => localStorage.clear())

  it('maps Satora statuses to phases', () => {
    expect(swapPhase(record())).toBe('pending')
    expect(swapPhase(record({ status: 'serverfunded', funded: true }))).toBe('pending')
    expect(swapPhase(record({ status: 'clientredeemed', funded: true }))).toBe('complete')
    expect(swapPhase(record({ status: 'clientrefunded', funded: true }))).toBe('refunded')
    // expired before this wallet funded it: nothing is locked
    expect(swapPhase(record({ status: 'expired' }))).toBe('failed')
    // expired after funding: still ours to refund
    expect(swapPhase(record({ status: 'expired', funded: true }))).toBe('pending')
  })

  it('claims on serverfunded and refunds only what this wallet funded', () => {
    expect(needsClaim(record({ status: 'serverfunded' }))).toBe(true)
    expect(needsRefund(record({ status: 'serverwontfund', funded: true }))).toBe(true)
    expect(needsRefund(record({ status: 'serverwontfund', funded: false }))).toBe(false)
    expect(needsRefund(record({ status: 'clientredeemed', funded: true }))).toBe(false)
  })

  it('upserts records newest first', () => {
    saveUsdcSwap(record({ id: 'a', createdAt: 1 }))
    saveUsdcSwap(record({ id: 'b', createdAt: 2 }))
    saveUsdcSwap(record({ id: 'a', createdAt: 1, status: 'clientfunded' }))
    expect(loadUsdcSwaps().map((swap) => [swap.id, swap.status])).toEqual([
      ['b', 'pending'],
      ['a', 'clientfunded'],
    ])
  })

  it('survives corrupt storage', () => {
    localStorage.setItem('usdcSwaps', '{not json')
    expect(loadUsdcSwaps()).toEqual([])
  })

  it('never lets a stale snapshot undo a funding that was recorded', () => {
    // the funding call saved funded: true while the resume loop still held
    // the unfunded snapshot it read before; its later save must not win
    saveUsdcSwap(record({ id: 'a', funded: true, fundingAttempted: true }))
    saveUsdcSwap(record({ id: 'a', funded: false, status: 'pending', error: 'timeout' }))
    expect(loadUsdcSwaps()[0]).toMatchObject({ funded: true, fundingAttempted: true, error: 'timeout' })
    expect(
      mergeUsdcSwap(record({ continuation: 'done', continuedTo: 'b' }), record({ continuation: 'needed' })),
    ).toMatchObject({
      continuation: 'done',
      continuedTo: 'b',
    })
  })

  it('still refunds a swap that only attempted funding, a bounded number of times', () => {
    const attempted = record({ status: 'expired', fundingAttempted: true })
    expect(needsRefund(attempted)).toBe(true)
    expect(swapPhase(attempted)).toBe('pending')
    const exhausted = { ...attempted, refundAttempts: MAX_BLIND_REFUND_ATTEMPTS }
    expect(needsRefund(exhausted)).toBe(false)
    expect(swapPhase(exhausted)).toBe('failed')
  })

  it('keeps a refunded swap pending until its refund has been swapped on', () => {
    const refunded = record({ direction: 'toArkade', status: 'clientrefunded', funded: true })
    expect(swapPhase({ ...refunded, continuation: 'needed' })).toBe('pending')
    expect(swapPhase({ ...refunded, continuation: 'done' })).toBe('refunded')
    expect(swapPhase({ ...refunded, continuation: 'unavailable' })).toBe('refunded')
    // marked before a refund that then turned out to have nothing to refund
    expect(
      swapPhase(
        record({
          status: 'expired',
          fundingAttempted: true,
          refundAttempts: MAX_BLIND_REFUND_ATTEMPTS,
          continuation: 'needed',
        }),
      ),
    ).toBe('failed')
  })
})
