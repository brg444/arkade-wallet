import { describe, expect, it } from 'vitest'
import { encodeBalanceOf, parseBlockscoutTransfers } from '../../../lib/usdc/chain'
import { USDC_ARBITRUM_ADDRESS } from '../../../lib/usdc/config'

const self = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const other = '0x1111111111111111111111111111111111111111'

describe('USD account chain reads', () => {
  it('encodes balanceOf calldata', () => {
    expect(encodeBalanceOf(self)).toBe(`0x70a08231${'0'.repeat(24)}${self.slice(2).toLowerCase()}`)
  })

  it('keeps only USDC transfers that touch the account, tagged by direction', () => {
    const transfers = parseBlockscoutTransfers(self, [
      {
        from: { hash: other },
        to: { hash: self },
        total: { value: '2500000' },
        transaction_hash: '0xaa',
        timestamp: '2026-11-20T10:00:00Z',
        token: { address_hash: USDC_ARBITRUM_ADDRESS },
      },
      {
        from: { hash: self },
        to: { hash: other },
        total: { value: '1000000' },
        transaction_hash: '0xbb',
        timestamp: '2026-11-21T10:00:00Z',
        token: { address: USDC_ARBITRUM_ADDRESS.toLowerCase() },
      },
      // another token at the same address: dropped
      {
        from: { hash: other },
        to: { hash: self },
        total: { value: '5' },
        transaction_hash: '0xcc',
        token: { address_hash: '0x2222222222222222222222222222222222222222' },
      },
      // malformed value: dropped
      {
        from: { hash: other },
        to: { hash: self },
        total: { value: '1.5' },
        transaction_hash: '0xdd',
        token: { address_hash: USDC_ARBITRUM_ADDRESS },
      },
    ])
    expect(transfers.map((transfer) => [transfer.hash, transfer.direction, transfer.amount])).toEqual([
      ['0xaa', 'in', BigInt(2_500_000)],
      ['0xbb', 'out', BigInt(1_000_000)],
    ])
    expect(transfers[0].timestamp).toBe(Date.parse('2026-11-20T10:00:00Z'))
  })
})
