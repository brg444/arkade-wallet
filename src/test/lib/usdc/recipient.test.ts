import { describe, expect, it } from 'vitest'
import { CCTP_TOKEN_MESSENGER_V2, usdcSendNetwork } from '../../../lib/usdc/cctp'
import { USDC_ARBITRUM_ADDRESS } from '../../../lib/usdc/config'
import { isSendableRecipient, parseScannedRecipient } from '../../../lib/usdc/recipient'

const payee = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const baseUsdc = usdcSendNetwork('base').usdcAddress
const ethUsdc = usdcSendNetwork('ethereum').usdcAddress

describe('USD send recipients', () => {
  it('reads a bare address and a plain ethereum: URI', () => {
    expect(parseScannedRecipient(` ${payee} `)).toEqual({ address: payee })
    expect(parseScannedRecipient(`ethereum:${payee}`)).toEqual({ address: payee })
    expect(parseScannedRecipient(`ethereum:${payee}@42161`)).toEqual({ address: payee, network: 'arbitrum' })
  })

  it('detects supported cross-chain networks from EIP-681 @chainId URIs', () => {
    expect(parseScannedRecipient(`ethereum:${payee}@1`)).toEqual({ address: payee, network: 'ethereum' })
    expect(parseScannedRecipient(`ethereum:${payee}@8453`)).toEqual({ address: payee, network: 'base' })
    expect(parseScannedRecipient(`ethereum:${payee}@10`)).toEqual({ address: payee, network: 'optimism' })
    expect(parseScannedRecipient(`ethereum:${payee}@137`)).toEqual({ address: payee, network: 'polygon' })
    expect(parseScannedRecipient(`ethereum:${payee}@43114`)).toEqual({ address: payee, network: 'avalanche' })
  })

  it('takes the payee, never the token contract, from a USDC payment request on any supported chain', () => {
    expect(
      parseScannedRecipient(`ethereum:${USDC_ARBITRUM_ADDRESS}@42161/transfer?address=${payee}&uint256=5000000`),
    ).toEqual({
      address: payee,
      network: 'arbitrum',
    })
    expect(parseScannedRecipient(`ethereum:${baseUsdc}@8453/transfer?address=${payee}&uint256=5000000`)).toEqual({
      address: payee,
      network: 'base',
    })
    expect(parseScannedRecipient(`ethereum:${ethUsdc}@1/transfer?address=${payee}`)).toEqual({
      address: payee,
      network: 'ethereum',
    })
  })

  it('refuses an unsupported chain, another token, a mismatched chain token, or an unsupported call', () => {
    expect(parseScannedRecipient(`ethereum:${payee}@56`)).toEqual({ error: 'network' })
    expect(parseScannedRecipient(`ethereum:${USDC_ARBITRUM_ADDRESS}@8453/transfer?address=${payee}`)).toEqual({
      error: 'token',
    })
    expect(
      parseScannedRecipient(`ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7@42161/transfer?address=${payee}`),
    ).toEqual({ error: 'token' })
    expect(parseScannedRecipient(`ethereum:${USDC_ARBITRUM_ADDRESS}@42161/approve?address=${payee}`)).toEqual({
      error: 'unsupported',
    })
    expect(parseScannedRecipient(`ethereum:${USDC_ARBITRUM_ADDRESS}@42161/transfer`)).toEqual({ error: 'unsupported' })
    expect(parseScannedRecipient('ethereum:vitalik.eth')).toEqual({ error: 'unsupported' })
  })

  it('never offers any USDC contract, TokenMessengerV2, or the zero address as a recipient', () => {
    expect(isSendableRecipient(payee)).toBe(true)
    expect(isSendableRecipient(USDC_ARBITRUM_ADDRESS)).toBe(false)
    expect(isSendableRecipient(USDC_ARBITRUM_ADDRESS.toLowerCase())).toBe(false)
    expect(isSendableRecipient(ethUsdc)).toBe(false)
    expect(isSendableRecipient(baseUsdc)).toBe(false)
    expect(isSendableRecipient(CCTP_TOKEN_MESSENGER_V2)).toBe(false)
    expect(isSendableRecipient('0x0000000000000000000000000000000000000000')).toBe(false)
    expect(isSendableRecipient('0x1234')).toBe(false)
  })
})
