import { describe, expect, it } from 'vitest'
import { USDC_ARBITRUM_ADDRESS } from '../../../lib/usdc/config'
import { isSendableRecipient, parseScannedRecipient } from '../../../lib/usdc/recipient'

const payee = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

describe('USD send recipients', () => {
  it('reads a bare address and a plain ethereum: URI', () => {
    expect(parseScannedRecipient(` ${payee} `)).toEqual({ address: payee })
    expect(parseScannedRecipient(`ethereum:${payee}`)).toEqual({ address: payee })
    expect(parseScannedRecipient(`ethereum:${payee}@42161`)).toEqual({ address: payee })
  })

  it('takes the payee, never the token contract, from a USDC payment request', () => {
    const uri = `ethereum:${USDC_ARBITRUM_ADDRESS}@42161/transfer?address=${payee}&uint256=5000000`
    expect(parseScannedRecipient(uri)).toEqual({ address: payee })
  })

  it('refuses another chain, another token, or a call it does not make', () => {
    expect(parseScannedRecipient(`ethereum:${payee}@1`)).toEqual({ error: 'network' })
    expect(parseScannedRecipient(`ethereum:${USDC_ARBITRUM_ADDRESS}@8453/transfer?address=${payee}`)).toEqual({
      error: 'network',
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

  it('never offers the USDC contract or the zero address as a recipient', () => {
    expect(isSendableRecipient(payee)).toBe(true)
    expect(isSendableRecipient(USDC_ARBITRUM_ADDRESS)).toBe(false)
    expect(isSendableRecipient(USDC_ARBITRUM_ADDRESS.toLowerCase())).toBe(false)
    expect(isSendableRecipient('0x0000000000000000000000000000000000000000')).toBe(false)
    expect(isSendableRecipient('0x1234')).toBe(false)
  })
})
