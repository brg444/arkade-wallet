import { USDC_DECIMALS } from './config'

const UNIT = BigInt(10) ** BigInt(USDC_DECIMALS)

/**
 * Parses what a person typed ("12", "12.5", "0.000001") into USDC base units.
 * Returns undefined for anything that is not a non-negative decimal with at
 * most six fractional digits, rather than rounding a typo into an amount.
 */
export const parseUsdc = (input: string): bigint | undefined => {
  const value = input.trim().replace(/,/g, '')
  if (!/^\d*(\.\d*)?$/.test(value) || value === '' || value === '.') return undefined
  const [whole = '', fraction = ''] = value.split('.')
  if (fraction.length > USDC_DECIMALS) return undefined
  return BigInt(whole || '0') * UNIT + BigInt(fraction.padEnd(USDC_DECIMALS, '0') || '0')
}

/** Base units to a plain decimal string with two to six fraction digits. */
export const formatUsdc = (units: bigint, minFractionDigits = 2): string => {
  const negative = units < BigInt(0)
  const abs = negative ? -units : units
  const whole = (abs / UNIT).toLocaleString('en-US')
  let fraction = (abs % UNIT).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  if (fraction.length < minFractionDigits) fraction = fraction.padEnd(minFractionDigits, '0')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** A dollar value for fiat conversion; USDC is treated as 1:1 with USD. */
export const usdcToNumber = (units: bigint): number => Number(units) / Number(UNIT)

/**
 * How the account shows an amount to people: as dollars, the same way every
 * other USD account in the wallet does ("12.50 USD"), never as a token.
 */
export const formatUsd = (units: bigint): string => `${formatUsdc(units)} USD`
