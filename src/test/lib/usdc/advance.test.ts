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
    expect(adopted.map((swap) => [swap.id, swap.direction, swap.funded, swap.arkAddress])).toEqual([
      ['swap-2', 'toArkade', true, 'ark1dest'],
    ])
  })
})
