import { USDC_ARBITRUM_ADDRESS, usdcConfig } from './config'

/** `balanceOf(address)` selector. */
const BALANCE_OF = '0x70a08231'
/** ERC-20 `Transfer(address,address,uint256)` topic0. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
/**
 * Block spans tried in order for `eth_getLogs`. Arbitrum's public RPC permits
 * up to 10M blocks (~28 days) per query; narrower spans act as fallbacks for
 * stricter custom RPC providers.
 */
const RPC_LOG_SPANS = [BigInt(9_500_000), BigInt(500_000), BigInt(50_000)]
const MAX_RPC_TRANSFERS = 40
const MAX_CACHED_BLOCKS = 200
const blockTimestampCache = new Map<string, number>()

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

export interface RpcLog {
  address?: string
  topics?: string[]
  data?: string
  blockNumber?: string
  transactionHash?: string
  logIndex?: string
  blockTimestamp?: string
  removed?: boolean
}

const HEX_UINT = /^0x[0-9a-f]+$/i
const TOPIC_WORD = /^0x[0-9a-f]{64}$/i

const parseHexBigInt = (value: string | undefined): bigint | undefined => {
  if (!value || !HEX_UINT.test(value)) return undefined
  return BigInt(value)
}

const encodeTopicAddress = (address: string): string =>
  `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`

const decodeTopicAddress = (topic: string | undefined): string | undefined => {
  if (!topic || !TOPIC_WORD.test(topic)) return undefined
  return `0x${topic.slice(26).toLowerCase()}`
}

const normalizeHexBlock = (blockNumber: string | undefined): string | undefined => {
  const parsed = parseHexBigInt(blockNumber)
  return parsed === undefined ? undefined : `0x${parsed.toString(16)}`
}

const compareDesc = (a: bigint, b: bigint): number => (a === b ? 0 : a > b ? -1 : 1)

interface ValidTransferLog {
  hash: string
  from: string
  to: string
  amount: bigint
  blockNumber: bigint
  blockKey: string
  logIndex: bigint
  inlineTimestampMs: number
}

const extractValidTransferLogs = (address: string, logs: RpcLog[]): ValidTransferLog[] => {
  const self = address.toLowerCase()
  const usdc = USDC_ARBITRUM_ADDRESS.toLowerCase()
  const seen = new Set<string>()
  const valid: ValidTransferLog[] = []
  for (const log of logs) {
    if (log.removed) continue
    if ((log.address ?? '').toLowerCase() !== usdc) continue
    if ((log.topics?.[0] ?? '').toLowerCase() !== TRANSFER_TOPIC) continue
    const hash = log.transactionHash?.toLowerCase()
    const from = decodeTopicAddress(log.topics?.[1])
    const to = decodeTopicAddress(log.topics?.[2])
    const amount = parseHexBigInt(log.data)
    const blockNumber = parseHexBigInt(log.blockNumber)
    const blockKey = normalizeHexBlock(log.blockNumber)
    const logIndex = parseHexBigInt(log.logIndex) ?? BigInt(0)
    if (!hash || !from || !to || amount === undefined || blockNumber === undefined || !blockKey) continue
    if (from !== self && to !== self) continue
    const dedupKey = `${hash}-${logIndex.toString()}`
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)
    const rawTs = parseHexBigInt(log.blockTimestamp)
    const inlineTimestampMs = rawTs && rawTs > BigInt(0) ? Number(rawTs) * 1000 : 0
    valid.push({ hash, from, to, amount, blockNumber, blockKey, logIndex, inlineTimestampMs })
  }
  valid.sort((a, b) => compareDesc(a.blockNumber, b.blockNumber) || compareDesc(a.logIndex, b.logIndex))
  return valid
}

export const parseRpcTransferLogs = (
  address: string,
  logs: RpcLog[],
  blockTimestamps: ReadonlyMap<string, number> = new Map(),
): UsdcTransfer[] => {
  const self = address.toLowerCase()
  return extractValidTransferLogs(address, logs).map((entry) => ({
    hash: entry.hash,
    from: entry.from,
    to: entry.to,
    amount: entry.amount,
    timestamp: entry.inlineTimestampMs || blockTimestamps.get(entry.blockKey) || 0,
    direction: entry.to === self ? 'in' : 'out',
  }))
}

const rememberBlockTimestamp = (blockKey: string, timestampMs: number): void => {
  if (blockTimestampCache.size >= MAX_CACHED_BLOCKS) {
    const oldest = blockTimestampCache.keys().next().value
    if (oldest !== undefined) blockTimestampCache.delete(oldest)
  }
  blockTimestampCache.set(blockKey, timestampMs)
}

const fetchBlockTimestamps = async (blockKeys: string[], signal?: AbortSignal): Promise<Map<string, number>> => {
  const resolved = new Map<string, number>()
  const missing: string[] = []
  for (const key of blockKeys) {
    const cached = blockTimestampCache.get(key)
    if (cached !== undefined) resolved.set(key, cached)
    else missing.push(key)
  }
  if (missing.length === 0) return resolved
  const settled = await Promise.allSettled(
    missing.map(async (key) => {
      const block = await rpc<{ timestamp?: string } | null>('eth_getBlockByNumber', [key, false], signal)
      const seconds = parseHexBigInt(block?.timestamp)
      return seconds && seconds > BigInt(0) ? { key, ms: Number(seconds) * 1000 } : undefined
    }),
  )
  for (const item of settled) {
    if (item.status === 'fulfilled' && item.value) {
      rememberBlockTimestamp(item.value.key, item.value.ms)
      resolved.set(item.value.key, item.value.ms)
    }
  }
  return resolved
}

const fetchRpcUsdcTransfers = async (address: string, signal?: AbortSignal): Promise<UsdcTransfer[]> => {
  const latestHex = await rpc<string>('eth_blockNumber', [], signal)
  const latest = parseHexBigInt(latestHex)
  if (latest === undefined) throw new Error('Arbitrum RPC returned no block number')
  const paddedSelf = encodeTopicAddress(address)
  let rawLogs: RpcLog[] | undefined
  let lastError: unknown
  for (const span of RPC_LOG_SPANS) {
    const fromBlock = `0x${(latest > span ? latest - span : BigInt(0)).toString(16)}`
    try {
      const [incoming, outgoing] = await Promise.all([
        rpc<RpcLog[]>(
          'eth_getLogs',
          [
            {
              fromBlock,
              toBlock: 'latest',
              address: USDC_ARBITRUM_ADDRESS,
              topics: [TRANSFER_TOPIC, null, paddedSelf],
            },
          ],
          signal,
        ),
        rpc<RpcLog[]>(
          'eth_getLogs',
          [
            {
              fromBlock,
              toBlock: 'latest',
              address: USDC_ARBITRUM_ADDRESS,
              topics: [TRANSFER_TOPIC, paddedSelf, null],
            },
          ],
          signal,
        ),
      ])
      rawLogs = [...(incoming ?? []), ...(outgoing ?? [])]
      break
    } catch (err) {
      if (signal?.aborted) throw err
      lastError = err
    }
  }
  if (!rawLogs) throw lastError instanceof Error ? lastError : new Error('Arbitrum RPC transfer history failed')
  const recent = extractValidTransferLogs(address, rawLogs).slice(0, MAX_RPC_TRANSFERS)
  const blocksNeedingTime = [
    ...new Set(recent.filter((entry) => entry.inlineTimestampMs === 0).map((entry) => entry.blockKey)),
  ]
  const timestamps = await fetchBlockTimestamps(blocksNeedingTime, signal)
  const self = address.toLowerCase()
  return recent.map((entry) => ({
    hash: entry.hash,
    from: entry.from,
    to: entry.to,
    amount: entry.amount,
    timestamp: entry.inlineTimestampMs || timestamps.get(entry.blockKey) || 0,
    direction: entry.to === self ? 'in' : 'out',
  }))
}

/**
 * The latest USDC transfers in and out of the account. Uses a configured
 * Blockscout v2 compatible indexer when `VITE_USDC_HISTORY_URL` is set, and
 * otherwise (or if the indexer fails) reads `Transfer` logs directly from the
 * Arbitrum RPC. History is a convenience: the balance never depends on it.
 */
export const fetchUsdcTransfers = async (address: string, signal?: AbortSignal): Promise<UsdcTransfer[]> => {
  const { historyUrl, historyApiKey } = usdcConfig()
  if (historyUrl) {
    try {
      const url = `${historyUrl.replace(/\/$/, '')}/addresses/${address}/token-transfers?type=ERC-20&token=${USDC_ARBITRUM_ADDRESS}`
      const res = await fetch(url, {
        headers: historyApiKey ? { authorization: `Bearer ${historyApiKey}` } : undefined,
        signal,
      })
      if (!res.ok) throw new Error(`USDC history failed: ${res.status}`)
      const body = (await res.json()) as { items?: BlockscoutTransfer[] }
      return parseBlockscoutTransfers(address, body.items ?? [])
    } catch (err) {
      if (signal?.aborted) throw err
    }
  }
  return fetchRpcUsdcTransfers(address, signal)
}
