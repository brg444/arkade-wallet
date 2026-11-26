import { describe, expect, it } from 'vitest'
import type { UsdcTransfer } from '../../lib/usdc/chain'
import { usdcActivityEntries } from '../../screens/Wallet/Usdc/Activity'

const transfer = (overrides: Partial<UsdcTransfer>): UsdcTransfer => ({
  hash: '0xaa',
  from: '0xself',
  to: '0xpayee',
  amount: BigInt(20_000_000),
  timestamp: 1_000,
  direction: 'out',
  ...overrides,
})

describe('USD activity', () => {
  it('shows a send and the gas its paymaster took as one row', () => {
    const entries = usdcActivityEntries(
      [
        transfer({}),
        transfer({ to: '0xpaymaster', amount: BigInt(12_000) }),
        transfer({ hash: '0xbb', direction: 'in' }),
      ],
      [],
    )
    expect(entries).toHaveLength(2)
    const sent = entries.find((entry) => entry.kind === 'transfer' && entry.transfer.hash === '0xaa')
    expect(sent?.kind === 'transfer' && sent.transfer.amount).toBe(BigInt(20_012_000))
  })

  it('leaves a swap leg to its swap row', () => {
    const swap = {
      id: 's1',
      direction: 'toArkade' as const,
      createdAt: 2_000,
      updatedAt: 2_000,
      sourceAmount: '1',
      targetAmount: '1',
      status: 'clientfunded',
      arkAddress: '',
      funded: true,
      counterparties: ['0xhtlc'],
    }
    const entries = usdcActivityEntries([transfer({ to: '0xhtlc' })], [swap])
    expect(entries.map((entry) => entry.kind)).toEqual(['swap'])
  })
})
