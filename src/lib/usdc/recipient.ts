import { isDisallowedUsdcRecipient, usdcSendNetwork, usdcSendNetworkByChainId, type UsdcSendNetworkId } from './cctp'
import { isValidEvmAddress } from './keys'

export type ScannedRecipient =
  | { address: string; network?: UsdcSendNetworkId }
  /** `network`: the code asks for an unsupported chain. `token`: it asks for a token
   * other than native USDC on that chain. `unsupported`: a contract call this wallet does not make. */
  | { error: 'network' | 'token' | 'unsupported' }

/**
 * Reads the recipient (and optional network) out of a scanned code: a bare
 * address, or an EIP-681 `ethereum:` URI.
 *
 * In a token payment request (`ethereum:<token>@<chain>/transfer?address=<to>`)
 * the address after `ethereum:` is the token contract, not the payee. Taking it
 * as the recipient would send the money to the USDC contract itself, where it
 * is gone for good, so the URI is parsed properly: the payee comes from the
 * `address` parameter, the token must be native USDC on that chain, and a code
 * that names an unsupported chain is refused rather than quietly paid elsewhere.
 */
export const parseScannedRecipient = (data: string): ScannedRecipient => {
  const text = data.trim()
  if (!/^ethereum:/i.test(text)) return { address: text }

  const match = text.match(/^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/([A-Za-z0-9_]+))?(?:\?(.*))?$/i)
  if (!match) return { error: 'unsupported' }
  const [, target, chainId, fn, query] = match
  const network = chainId !== undefined ? usdcSendNetworkByChainId(Number(chainId)) : undefined
  if (chainId !== undefined && !network) return { error: 'network' }
  if (!fn) return network ? { address: target, network: network.id } : { address: target }
  if (fn !== 'transfer') return { error: 'unsupported' }
  const expectedNet = network ?? usdcSendNetwork('arbitrum')
  if (target.toLowerCase() !== expectedNet.usdcAddress.toLowerCase()) return { error: 'token' }
  const payee = new URLSearchParams(query ?? '').get('address')
  if (!payee || !/^0x[0-9a-fA-F]{40}$/.test(payee)) return { error: 'unsupported' }
  return network ? { address: payee, network: network.id } : { address: payee }
}

/**
 * An address USDC can sensibly be sent to: well formed, and neither a known
 * USDC contract, Circle's CCTP TokenMessenger, nor the zero address, any of
 * which would swallow a transfer for good.
 */
export const isSendableRecipient = (address: string): boolean => {
  if (!isValidEvmAddress(address)) return false
  return !isDisallowedUsdcRecipient(address)
}
