import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeBalanceOf,
  fetchUsdcTransfers,
  parseBlockscoutTransfers,
  parseRpcTransferLogs,
} from '../../../lib/usdc/chain'
import { USDC_ARBITRUM_ADDRESS } from '../../../lib/usdc/config'

const self = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const other = '0x1111111111111111111111111111111111111111'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const pad = (addr: string) => `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`

describe('USD account chain reads', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

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

  it('parses, deduplicates, and sorts RPC Transfer logs newest first', () => {
    const timestamps = new Map([['0x64', 1_700_000_000_000]])
    const transfers = parseRpcTransferLogs(
      self,
      [
        {
          address: USDC_ARBITRUM_ADDRESS,
          topics: [TRANSFER_TOPIC, pad(other), pad(self)],
          data: '0x2625a0', // 2_500_000
          blockNumber: '0x64',
          transactionHash: '0xaa',
          logIndex: '0x1',
          blockTimestamp: '0x0',
        },
        // duplicate self-transfer returned by both in & out log queries: kept once
        {
          address: USDC_ARBITRUM_ADDRESS,
          topics: [TRANSFER_TOPIC, pad(self), pad(self)],
          data: '0xf4240', // 1_000_000
          blockNumber: '0xc8',
          transactionHash: '0xbb',
          logIndex: '0x2',
          blockTimestamp: '0x6553f100',
        },
        {
          address: USDC_ARBITRUM_ADDRESS,
          topics: [TRANSFER_TOPIC, pad(self), pad(self)],
          data: '0xf4240',
          blockNumber: '0xc8',
          transactionHash: '0xbb',
          logIndex: '0x2',
          blockTimestamp: '0x6553f100',
        },
        // removed reorg log: dropped
        {
          address: USDC_ARBITRUM_ADDRESS,
          topics: [TRANSFER_TOPIC, pad(self), pad(other)],
          data: '0x1',
          blockNumber: '0xc9',
          transactionHash: '0xcc',
          logIndex: '0x0',
          removed: true,
        },
      ],
      timestamps,
    )
    expect(transfers).toEqual([
      {
        hash: '0xbb',
        from: self.toLowerCase(),
        to: self.toLowerCase(),
        amount: BigInt(1_000_000),
        timestamp: Number(BigInt('0x6553f100')) * 1000,
        direction: 'in',
      },
      {
        hash: '0xaa',
        from: other,
        to: self.toLowerCase(),
        amount: BigInt(2_500_000),
        timestamp: 1_700_000_000_000,
        direction: 'in',
      },
    ])
  })

  it('reads transfer history from Arbitrum RPC by default and narrows log range if rejected', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { method: string; params: unknown[] }
      if (req.method === 'eth_blockNumber') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1000000' }))
      }
      if (req.method === 'eth_getLogs') {
        const filter = req.params[0] as { fromBlock: string; topics: (string | null)[] }
        // simulate a stricter RPC rejecting the 9.5M block window
        if (BigInt(filter.fromBlock) < BigInt('0xf00000')) {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'range too large' } }))
        }
        const isIncoming = filter.topics[2] === pad(self)
        const logs = isIncoming
          ? [
              {
                address: USDC_ARBITRUM_ADDRESS,
                topics: [TRANSFER_TOPIC, pad(other), pad(self)],
                data: '0x1e8480', // 2_000_000
                blockNumber: '0xfff001',
                transactionHash: '0x11',
                logIndex: '0x0',
                blockTimestamp: '0x0',
              },
            ]
          : []
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: logs }))
      }
      if (req.method === 'eth_getBlockByNumber') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { timestamp: '0x6b03e3e5' } }))
      }
      throw new Error(`unexpected RPC method: ${req.method}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const transfers = await fetchUsdcTransfers(self)
    expect(transfers).toEqual([
      {
        hash: '0x11',
        from: other,
        to: self.toLowerCase(),
        amount: BigInt(2_000_000),
        timestamp: Number(BigInt('0x6b03e3e5')) * 1000,
        direction: 'in',
      },
    ])
  })

  it('falls back to Arbitrum RPC when a configured Blockscout indexer returns 403', async () => {
    vi.stubEnv('VITE_USDC_HISTORY_URL', 'https://indexer.example/api/v2')
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://indexer.example')) {
        return new Response('Forbidden', { status: 403 })
      }
      const req = JSON.parse(String(init?.body)) as { method: string }
      if (req.method === 'eth_blockNumber') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x200' }))
      }
      if (req.method === 'eth_getLogs') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: [] }))
      }
      throw new Error(`unexpected call: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchUsdcTransfers(self)).resolves.toEqual([])
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('https://indexer.example'))).toBe(true)
  })
})
