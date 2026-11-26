import { ARBITRUM_CHAIN_ID, USDC_ARBITRUM_ADDRESS } from './config'

/**
 * Cross-chain USDC sends via Circle CCTP V2 + Circle Forwarding Service.
 *
 * The wallet holds native USDC on Arbitrum One (CCTP domain 3). Sends to
 * Arbitrum use a direct ERC-20 transfer. Sends to Ethereum, Base, Optimism,
 * Polygon, or Avalanche burn USDC on Arbitrum through Circle's TokenMessengerV2
 * with the Forwarding Service hook (`cctp-forward`), so Circle automatically
 * mints native USDC on the destination chain — no ETH or native gas needed on
 * either chain.
 */
export type UsdcSendNetworkId = 'arbitrum' | 'ethereum' | 'base' | 'optimism' | 'polygon' | 'avalanche'

export interface UsdcSendNetwork {
  id: UsdcSendNetworkId
  name: string
  chainId: number
  /** CAIP-2 identifier matching `ChainLogo`. */
  caip2: string
  cctpDomain: number
  /** Native Circle USDC contract address on this network. */
  usdcAddress: string
  /**
   * Conservative fallback ceiling (USDC base units) used if Circle's IRIS fee
   * API cannot be reached, and as the initial reserve for "Max" before quoting.
   */
  defaultForwardingFee: bigint
}

export const CCTP_ARBITRUM_DOMAIN = 3
export const CCTP_TOKEN_MESSENGER_V2 = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
/** `"cctp-forward"` (bytes24) + version 0 (uint32) + data length 0 (uint32). */
export const CCTP_FORWARDING_HOOK_DATA = '0x636374702d666f72776172640000000000000000000000000000000000000000'
export const CCTP_FINALITY_FAST = 1000
export const CCTP_ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'
export const CIRCLE_IRIS_API_URL = 'https://iris-api.circle.com'

const FALLBACK_FAST_FEE_BPS = 2 // 0.02% conservative fast-transfer headroom
const IRIS_CACHE_TTL_MS = 60_000
const IRIS_TIMEOUT_MS = 5_000

export const USDC_SEND_NETWORKS: readonly UsdcSendNetwork[] = [
  {
    id: 'arbitrum',
    name: 'Arbitrum',
    chainId: ARBITRUM_CHAIN_ID,
    caip2: 'eip155:42161',
    cctpDomain: CCTP_ARBITRUM_DOMAIN,
    usdcAddress: USDC_ARBITRUM_ADDRESS,
    defaultForwardingFee: BigInt(0),
  },
  {
    id: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    caip2: 'eip155:1',
    cctpDomain: 0,
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    defaultForwardingFee: BigInt(1_500_000), // $1.50 (Circle baseline $1.25 + headroom)
  },
  {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    caip2: 'eip155:8453',
    cctpDomain: 6,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    defaultForwardingFee: BigInt(250_000), // $0.25 (Circle baseline $0.20 + headroom)
  },
  {
    id: 'optimism',
    name: 'Optimism',
    chainId: 10,
    caip2: 'eip155:10',
    cctpDomain: 2,
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    defaultForwardingFee: BigInt(250_000),
  },
  {
    id: 'polygon',
    name: 'Polygon',
    chainId: 137,
    caip2: 'eip155:137',
    cctpDomain: 7,
    usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    defaultForwardingFee: BigInt(250_000),
  },
  {
    id: 'avalanche',
    name: 'Avalanche',
    chainId: 43114,
    caip2: 'eip155:43114',
    cctpDomain: 1,
    usdcAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    defaultForwardingFee: BigInt(250_000),
  },
] as const

const NETWORKS_BY_ID = new Map<UsdcSendNetworkId, UsdcSendNetwork>(USDC_SEND_NETWORKS.map((net) => [net.id, net]))
const NETWORKS_BY_CHAIN_ID = new Map<number, UsdcSendNetwork>(USDC_SEND_NETWORKS.map((net) => [net.chainId, net]))

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DISALLOWED_RECIPIENTS = new Set<string>([
  ZERO_ADDRESS,
  CCTP_TOKEN_MESSENGER_V2.toLowerCase(),
  ...USDC_SEND_NETWORKS.map((net) => net.usdcAddress.toLowerCase()),
])

export const usdcSendNetwork = (id: UsdcSendNetworkId): UsdcSendNetwork => {
  const net = NETWORKS_BY_ID.get(id)
  if (!net) throw new Error(`Unsupported USDC send network: ${id}`)
  return net
}

export const usdcSendNetworkByChainId = (chainId: number): UsdcSendNetwork | undefined =>
  NETWORKS_BY_CHAIN_ID.get(chainId)

export const isCrossChainNetwork = (id: UsdcSendNetworkId): boolean => id !== 'arbitrum'

export const isDisallowedUsdcRecipient = (address: string): boolean => DISALLOWED_RECIPIENTS.has(address.toLowerCase())

/** Left-pads a 20-byte EVM address into CCTP's 32-byte `mintRecipient` word. */
export const evmAddressToBytes32 = (address: string): `0x${string}` => {
  const clean = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`Invalid EVM address for CCTP: ${address}`)
  return `0x${clean.padStart(64, '0')}`
}

interface IrisFeeEntry {
  finalityThreshold: number
  minimumFee: number
  forwardFee?: { low?: number; med?: number; high?: number }
}

const irisFeeCache = new Map<string, { entry: IrisFeeEntry; expiresAt: number }>()

/** Clears the in-memory IRIS fee cache (for tests). */
export const clearCctpFeeCache = (): void => {
  irisFeeCache.clear()
}

const fetchIrisFeeEntry = async (
  destinationDomain: number,
  irisApiUrl: string,
  signal?: AbortSignal,
): Promise<IrisFeeEntry> => {
  const cacheKey = `${irisApiUrl}:${destinationDomain}`
  const cached = irisFeeCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.entry

  const controller = signal ? undefined : new AbortController()
  const timer = controller ? setTimeout(() => controller.abort(), IRIS_TIMEOUT_MS) : undefined
  try {
    const url = `${irisApiUrl.replace(/\/$/, '')}/v2/burn/USDC/fees/${CCTP_ARBITRUM_DOMAIN}/${destinationDomain}?forward=true`
    const response = await fetch(url, { signal: signal ?? controller?.signal })
    if (!response.ok) throw new Error(`IRIS fee lookup failed: ${response.status}`)
    const entries = (await response.json()) as IrisFeeEntry[]
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`IRIS returned no fee entries for domain ${destinationDomain}`)
    }
    const entry = entries.find((item) => item.finalityThreshold === CCTP_FINALITY_FAST) ?? entries[0]
    irisFeeCache.set(cacheKey, { entry, expiresAt: Date.now() + IRIS_CACHE_TTL_MS })
    return entry
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Computes the CCTP V2 Fast Transfer + Forwarding Service `maxFee` ceiling in
 * USDC base units from an IRIS fee entry. Rounded up with a 25% buffer on the
 * basis-point protocol fee so minor drift between quote and burn never
 * downgrades the transfer.
 */
export const computeCctpBridgeMaxFee = (
  entry: IrisFeeEntry,
  sendAmount: bigint,
  fallbackForwardFee: bigint,
): bigint => {
  const rawForward = entry.forwardFee?.high ?? entry.forwardFee?.med ?? entry.forwardFee?.low
  const forwardFee =
    typeof rawForward === 'number' && Number.isFinite(rawForward) && rawForward >= 0
      ? BigInt(Math.ceil(rawForward))
      : fallbackForwardFee
  const bpsScaled =
    typeof entry.minimumFee === 'number' && Number.isFinite(entry.minimumFee) && entry.minimumFee > 0
      ? BigInt(Math.round(entry.minimumFee * 100))
      : BigInt(0)
  if (bpsScaled === BigInt(0)) return forwardFee
  const baseBurn = sendAmount + forwardFee
  const protocolFee = (baseBurn * bpsScaled + BigInt(999_999)) / BigInt(1_000_000)
  const bufferedProtocol = (protocolFee * BigInt(125) + BigInt(99)) / BigInt(100)
  return forwardFee + bufferedProtocol
}

export interface CctpBridgeFeeQuote {
  /** Maximum USDC base units Circle CCTP V2 + Forwarding Service may take. */
  maxFee: bigint
  /** `'iris'` when quoted live from Circle IRIS, `'fallback'` when IRIS was unreachable. */
  source: 'iris' | 'fallback'
}

/**
 * Quotes the Circle CCTP V2 Fast + Forwarding Service `maxFee` for sending
 * `sendAmount` USDC from Arbitrum to `networkId`. Queries Circle's live IRIS
 * API first and falls back to Circle's documented baseline schedule if IRIS is
 * unreachable from the user's network.
 */
export const quoteCctpBridgeFee = async (
  networkId: UsdcSendNetworkId,
  sendAmount: bigint,
  options?: { irisApiUrl?: string; signal?: AbortSignal },
): Promise<CctpBridgeFeeQuote> => {
  if (!isCrossChainNetwork(networkId)) return { maxFee: BigInt(0), source: 'iris' }
  const net = usdcSendNetwork(networkId)
  try {
    const entry = await fetchIrisFeeEntry(net.cctpDomain, options?.irisApiUrl ?? CIRCLE_IRIS_API_URL, options?.signal)
    return { maxFee: computeCctpBridgeMaxFee(entry, sendAmount, net.defaultForwardingFee), source: 'iris' }
  } catch {
    const fallback = computeCctpBridgeMaxFee(
      { finalityThreshold: CCTP_FINALITY_FAST, minimumFee: FALLBACK_FAST_FEE_BPS },
      sendAmount,
      net.defaultForwardingFee,
    )
    return { maxFee: fallback, source: 'fallback' }
  }
}
