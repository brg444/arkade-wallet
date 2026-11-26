import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadUsdcSwaps,
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
})
