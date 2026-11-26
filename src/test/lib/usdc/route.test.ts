import { describe, expect, it } from 'vitest'
import { routeQuoteFromSatora, satoraGiveLimit, satoraSourceUnits } from '../../../lib/usdc/route'

describe('Satora swap rail', () => {
  it('turns the composer give amount into sats or USDC base units', () => {
    expect(satoraSourceUnits('toUsdc', '0.001')).toBe(BigInt(100_000))
    expect(satoraSourceUnits('toUsdc', '1')).toBe(BigInt(100_000_000))
    expect(satoraSourceUnits('toArkade', '12.5')).toBe(BigInt(12_500_000))
    expect(satoraSourceUnits('toArkade', '')).toBeUndefined()
    expect(satoraSourceUnits('toUsdc', '0.000000001')).toBeUndefined()
    expect(satoraSourceUnits('toArkade', '1,000')).toBeUndefined()
  })

  it('maps a Bitcoin to USD quote onto the shared route shape', () => {
    // 100,000 sats in, 1,000 sats of fees, 99 USD out: 100k USD per BTC pre-fee
    const route = routeQuoteFromSatora('toUsdc', {
      sourceAmount: BigInt(100_000),
      targetAmount: BigInt(99_000_000),
      minSats: BigInt(10_000),
      maxSats: BigInt(10_000_000),
      feeSats: 1_000,
    })
    expect(route.rail).toBe('satora')
    expect(route.deposit).toBe(0.001)
    expect(route.receive).toBe(99)
    expect(route.feeFraction).toBeCloseTo(0.01)
    expect(route.rate).toBeCloseTo(100_000)
    expect(satoraGiveLimit('toUsdc', BigInt(10_000), route)).toBe(0.0001)
  })

  it('maps a USD to Bitcoin quote and converts its sats bound to dollars', () => {
    // 100 USD in, 99,000 sats out after 1,000 sats of fees
    const route = routeQuoteFromSatora('toArkade', {
      sourceAmount: BigInt(100_000_000),
      targetAmount: BigInt(99_000),
      minSats: BigInt(10_000),
      maxSats: BigInt(10_000_000),
      feeSats: 1_000,
    })
    expect(route.deposit).toBe(100)
    expect(route.receive).toBe(0.00099)
    expect(route.feeFraction).toBeCloseTo(0.01)
    // 0.001 BTC per 100 USD pre-fee
    expect(route.rate).toBeCloseTo(0.00001)
    expect(satoraGiveLimit('toArkade', BigInt(10_000), route)).toBeCloseTo(10)
  })
})
