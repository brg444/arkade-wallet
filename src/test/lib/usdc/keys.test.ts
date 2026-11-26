import { MnemonicIdentity } from '@arkade-os/sdk'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { describe, expect, it } from 'vitest'
import {
  clearUsdcSession,
  deriveUsdcSession,
  EVM_DERIVATION_PATH,
  getUsdcSession,
  isValidEvmAddress,
  setUsdcSessionFromMnemonic,
  toChecksumAddress,
} from '../../../lib/usdc/keys'

const testMnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('USD account keys', () => {
  it('derives the standard BIP-44 Ethereum address for the seed', () => {
    // the well-known m/44'/60'/0'/0/0 address of the "abandon … about" vector,
    // the same one MetaMask or any BIP-44 wallet restores from this phrase
    expect(EVM_DERIVATION_PATH).toBe("m/44'/60'/0'/0/0")
    expect(deriveUsdcSession(testMnemonic).address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
  })

  it.each([true, false])('shares its BIP-32 root with the Arkade wallet identity (mainnet %s)', async (isMainnet) => {
    // one seed, no passphrase, exactly as MnemonicIdentity reads it: the
    // Arkade signing key is the BIP-86 child of the very root the USD key uses
    const { rootXprv } = deriveUsdcSession(testMnemonic)
    const root = HDKey.fromExtendedKey(rootXprv)
    const arkadeKey = root.derive(`m/86'/${isMainnet ? 0 : 1}'/0'/0/0`).privateKey!
    const identity = MnemonicIdentity.fromMnemonic(testMnemonic, { isMainnet })
    expect(hex.encode(secp256k1.getPublicKey(arkadeKey, true))).toBe(hex.encode(await identity.compressedPublicKey()))
  })

  it('matches the address Satora derives as its gasless depositor', async () => {
    const { Client } = await import('@lendasat/lendaswap-sdk-pure')
    const session = deriveUsdcSession(testMnemonic)
    const client = await Client.builder().withXprv(session.rootXprv).build()
    expect(client.getEvmAddress()).toBe(session.address)
  })

  it('rejects an invalid mnemonic', () => {
    expect(() => deriveUsdcSession('not a real mnemonic')).toThrow()
  })

  it('keeps the session in memory only and wipes the key on clear', () => {
    setUsdcSessionFromMnemonic(testMnemonic)
    const session = getUsdcSession()!
    expect(session.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    expect(JSON.stringify(localStorage)).not.toContain(session.rootXprv)
    clearUsdcSession()
    expect(getUsdcSession()).toBeUndefined()
    expect(session.privateKey.every((byte) => byte === 0)).toBe(true)
  })

  it('validates addresses and their EIP-55 checksum', () => {
    const address = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
    expect(toChecksumAddress(address.toLowerCase())).toBe(address)
    expect(isValidEvmAddress(address)).toBe(true)
    expect(isValidEvmAddress(address.toLowerCase())).toBe(true)
    expect(isValidEvmAddress('0x9858efFD232B4033E47d90003D41EC34EcaEda94')).toBe(false)
    expect(isValidEvmAddress('0x1234')).toBe(false)
    expect(isValidEvmAddress('ark1qq')).toBe(false)
  })
})
