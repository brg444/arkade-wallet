import { ARBITRUM_CHAIN_ID, USDC_ARBITRUM_ADDRESS } from './config'
import { isValidEvmAddress } from './keys'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type ScannedRecipient =
  | { address: string }
  /** `network`: the code asks for another chain. `token`: it asks for a token
   * other than USDC. `unsupported`: a contract call this wallet does not make. */
  | { error: 'network' | 'token' | 'unsupported' }

/**
 * Reads the recipient out of a scanned code: a bare address, or an EIP-681
 * `ethereum:` URI.
 *
 * In a token payment request (`ethereum:<token>@<chain>/transfer?address=<to>`)
 * the address after `ethereum:` is the token contract, not the payee. Taking it
 * as the recipient would send the money to the USDC contract itself, where it
 * is gone for good, so the URI is parsed properly: the payee comes from the
 * `address` parameter, the token must be this account's USDC, and a code that
 * names any chain but Arbitrum is refused rather than quietly paid on Arbitrum.
 */
export const parseScannedRecipient = (data: string): ScannedRecipient => {
  const text = data.trim()
  if (!/^ethereum:/i.test(text)) return { address: text }

  const match = text.match(/^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/([A-Za-z0-9_]+))?(?:\?(.*))?$/i)
  if (!match) return { error: 'unsupported' }
  const [, target, chainId, fn, query] = match
  if (chainId !== undefined && Number(chainId) !== ARBITRUM_CHAIN_ID) return { error: 'network' }
  if (!fn) return { address: target }
  if (fn !== 'transfer') return { error: 'unsupported' }
  if (target.toLowerCase() !== USDC_ARBITRUM_ADDRESS.toLowerCase()) return { error: 'token' }
  const payee = new URLSearchParams(query ?? '').get('address')
  return payee && /^0x[0-9a-fA-F]{40}$/.test(payee) ? { address: payee } : { error: 'unsupported' }
}

/**
 * An address USDC can sensibly be sent to: well formed, and neither the USDC
 * contract nor the zero address, both of which swallow a transfer for good.
 */
export const isSendableRecipient = (address: string): boolean => {
  if (!isValidEvmAddress(address)) return false
  const lower = address.toLowerCase()
  return lower !== USDC_ARBITRUM_ADDRESS.toLowerCase() && lower !== ZERO_ADDRESS
}
