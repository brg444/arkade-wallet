import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CCTP_TOKEN_MESSENGER_V2,
  USDC_SEND_NETWORKS,
  clearCctpFeeCache,
  computeCctpBridgeMaxFee,
  evmAddressToBytes32,
  isCrossChainNetwork,
  isDisallowedUsdcRecipient,
  quoteCctpBridgeFee,
  usdcSendNetwork,
  usdcSendNetworkByChainId,
} from '../../../lib/usdc/cctp'

describe('Circle CCTP V2 multi-chain sends', () => {
  beforeEach(() => {
    clearCctpFeeCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers Arbitrum plus all five Circle Forwarding EVM destinations', () => {
    expect(USDC_SEND_NETWORKS.map((net) => net.id)).toEqual([
      'arbitrum',
      'ethereum',
      'base',
      'optimism',
      'polygon',
      'avalanche',
    ])
    expect(usdcSendNetworkByChainId(42161)?.id).toBe('arbitrum')
    expect(usdcSendNetworkByChainId(1)?.id).toBe('ethereum')
    expect(usdcSendNetworkByChainId(8453)?.id).toBe('base')
    expect(usdcSendNetworkByChainId(10)?.id).toBe('optimism')
    expect(usdcSendNetworkByChainId(137)?.id).toBe('polygon')
    expect(usdcSendNetworkByChainId(43114)?.id).toBe('avalanche')
    expect(usdcSendNetworkByChainId(56)).toBeUndefined()
    expect(isCrossChainNetwork('arbitrum')).toBe(false)
    expect(isCrossChainNetwork('base')).toBe(true)
  })

  it('left-pads 20-byte EVM addresses into 32-byte CCTP words', () => {
    expect(evmAddressToBytes32('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(
      '0x0000000000000000000000009858effd232b4033e47d90003d41ec34ecaeda94',
    )
    expect(() => evmAddressToBytes32('0x1234')).toThrow()
  })

  it('blocks the zero address, TokenMessengerV2, and every network USDC contract as recipients', () => {
    expect(isDisallowedUsdcRecipient('0x0000000000000000000000000000000000000000')).toBe(true)
    expect(isDisallowedUsdcRecipient(CCTP_TOKEN_MESSENGER_V2)).toBe(true)
    for (const net of USDC_SEND_NETWORKS) {
      expect(isDisallowedUsdcRecipient(net.usdcAddress)).toBe(true)
    }
    expect(isDisallowedUsdcRecipient('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')).toBe(false)
  })

  it('computes CCTP fast + forwarding maxFee from an IRIS entry with 25% protocol-fee buffer', () => {
    // $100 send, 1 bps fast fee (0.01%), $0.20 high forwardFee
    const maxFee = computeCctpBridgeMaxFee(
      { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 150_000, med: 180_000, high: 200_000 } },
      BigInt(100_000_000),
      BigInt(250_000),
    )
    // baseBurn = 100_200_000; protocolFee = ceil(100_200_000 * 100 / 1_000_000) = 10_020
    // bufferedProtocol = ceil(10_020 * 125 / 100) = 12_525 -> total 212_525
    expect(maxFee).toBe(BigInt(212_525))
  })

  it('returns zero fee for Arbitrum without contacting IRIS', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(quoteCctpBridgeFee('arbitrum', BigInt(10_000_000))).resolves.toEqual({
      maxFee: BigInt(0),
      source: 'iris',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('quotes live IRIS fees for cross-chain sends and caches per destination domain', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 100_000, med: 120_000, high: 150_000 } },
          { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 150_000, med: 200_000, high: 220_000 } },
        ]),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = await quoteCctpBridgeFee('base', BigInt(10_000_000))
    const second = await quoteCctpBridgeFee('base', BigInt(20_000_000))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v2/burn/USDC/fees/3/6?forward=true')
    expect(first.source).toBe('iris')
    expect(second.source).toBe('iris')
    expect(second.maxFee).toBeGreaterThan(first.maxFee)
  })

  it('falls back to conservative baseline fees when IRIS is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network blocked')
      }),
    )

    const ethQuote = await quoteCctpBridgeFee('ethereum', BigInt(10_000_000))
    const baseQuote = await quoteCctpBridgeFee('base', BigInt(10_000_000))

    expect(ethQuote.source).toBe('fallback')
    expect(ethQuote.maxFee).toBeGreaterThanOrEqual(usdcSendNetwork('ethereum').defaultForwardingFee)
    expect(baseQuote.source).toBe('fallback')
    expect(baseQuote.maxFee).toBeGreaterThanOrEqual(usdcSendNetwork('base').defaultForwardingFee)
  })
})
