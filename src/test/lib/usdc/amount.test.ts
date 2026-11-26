import { describe, expect, it } from 'vitest'
import { formatUsd, formatUsdBalance, formatUsdc, parseUsdc, usdcToNumber } from '../../../lib/usdc/amount'

describe('USD account amounts', () => {
  it('parses typed amounts into base units', () => {
    expect(parseUsdc('12')).toBe(BigInt(12_000_000))
    expect(parseUsdc('12.5')).toBe(BigInt(12_500_000))
    expect(parseUsdc('0.000001')).toBe(BigInt(1))
    expect(parseUsdc('.5')).toBe(BigInt(500_000))
    expect(parseUsdc('1,000.25')).toBe(BigInt(1_000_250_000))
  })

  it('refuses rather than rounds what is not an amount', () => {
    expect(parseUsdc('')).toBeUndefined()
    expect(parseUsdc('.')).toBeUndefined()
    expect(parseUsdc('1.0000001')).toBeUndefined()
    expect(parseUsdc('-1')).toBeUndefined()
    expect(parseUsdc('1e3')).toBeUndefined()
  })

  it('formats base units as dollars', () => {
    expect(formatUsdc(BigInt(12_500_000))).toBe('12.50')
    expect(formatUsdc(BigInt(1))).toBe('0.000001')
    expect(formatUsdc(BigInt(1_234_000_000))).toBe('1,234.00')
    expect(formatUsd(BigInt(12_500_000))).toBe('12.50 USD')
    // a balance shows whole cents, never rounded up past what is there
    expect(formatUsdBalance(BigInt(10_249_530))).toBe('10.24 USD')
    expect(formatUsdBalance(BigInt(999))).toBe('0.00 USD')
    expect(usdcToNumber(BigInt(2_500_000))).toBe(2.5)
  })
})
