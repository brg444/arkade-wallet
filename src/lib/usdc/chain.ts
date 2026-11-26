import { USDC_ARBITRUM_ADDRESS, usdcConfig } from './config'

/** `balanceOf(address)` selector. */
const BALANCE_OF = '0x70a08231'

const rpc = async <T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> => {
  const res = await fetch(usdcConfig().rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal,
  })
  if (!res.ok) throw new Error(`Arbitrum RPC ${method} failed: ${res.status}`)
  const body = (await res.json()) as { result?: T; error?: { message?: string } }
  if (body.error) throw new Error(body.error.message ?? `Arbitrum RPC ${method} failed`)
  return body.result as T
}

export const encodeBalanceOf = (address: string): string =>
  `${BALANCE_OF}${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`

/**
 * Reads the balance straight from the USDC contract with one `eth_call`, so
 * Home can show it without loading viem or any account-abstraction code.
 */
export const readUsdcBalance = async (address: string, signal?: AbortSignal): Promise<bigint> => {
  const result = await rpc<string>(
    'eth_call',
    [{ to: USDC_ARBITRUM_ADDRESS, data: encodeBalanceOf(address) }, 'latest'],
    signal,
  )
  // an empty answer means no USDC contract lives at this address on the chain
  // the RPC serves: a misconfigured endpoint, not a balance of zero
  if (!result || result === '0x') throw new Error('Arbitrum RPC returned no balance: is it pointed at Arbitrum One?')
  return BigInt(result)
}

export interface UsdcTransfer {
  hash: string
  from: string
  to: string
  /** Base units. */
  amount: bigint
  /** ms since epoch. */
  timestamp: number
  direction: 'in' | 'out'
}

interface BlockscoutTransfer {
  from?: { hash?: string }
  to?: { hash?: string }
  total?: { value?: string }
  transaction_hash?: string
  tx_hash?: string
  timestamp?: string
  token?: { address?: string; address_hash?: string }
}

export const parseBlockscoutTransfers = (address: string, items: BlockscoutTransfer[]): UsdcTransfer[] => {
  const self = address.toLowerCase()
  const usdc = USDC_ARBITRUM_ADDRESS.toLowerCase()
  const transfers: UsdcTransfer[] = []
  for (const item of items) {
    const token = (item.token?.address_hash ?? item.token?.address ?? '').toLowerCase()
    const hash = item.transaction_hash ?? item.tx_hash
    const from = item.from?.hash?.toLowerCase()
    const to = item.to?.hash?.toLowerCase()
    const value = item.total?.value
    if (token !== usdc || !hash || !from || !to || !value || !/^\d+$/.test(value)) continue
    if (from !== self && to !== self) continue
    transfers.push({
      hash,
      from,
      to,
      amount: BigInt(value),
      timestamp: item.timestamp ? Date.parse(item.timestamp) || 0 : 0,
      direction: to === self ? 'in' : 'out',
    })
  }
  return transfers
}

/**
 * The latest USDC transfers in and out of the account, from a Blockscout v2
 * compatible indexer. History is a convenience: the balance never depends on
 * it, so a missing or rate-limited indexer only empties the list.
 */
export const fetchUsdcTransfers = async (address: string, signal?: AbortSignal): Promise<UsdcTransfer[]> => {
  const { historyUrl, historyApiKey } = usdcConfig()
  const url = `${historyUrl.replace(/\/$/, '')}/addresses/${address}/token-transfers?type=ERC-20&token=${USDC_ARBITRUM_ADDRESS}`
  const res = await fetch(url, {
    headers: historyApiKey ? { authorization: `Bearer ${historyApiKey}` } : undefined,
    signal,
  })
  if (!res.ok) throw new Error(`USDC history failed: ${res.status}`)
  const body = (await res.json()) as { items?: BlockscoutTransfer[] }
  return parseBlockscoutTransfers(address, body.items ?? [])
}
