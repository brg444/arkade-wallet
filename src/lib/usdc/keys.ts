import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { hex } from '@scure/base'
import { HDKey } from '@scure/bip32'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { forgetSatoraSession } from './swaps'

/**
 * The standard BIP-44 Ethereum path. Satora derives its gasless depositor key
 * from the same root at the same path, so the address that holds the USDC
 * balance is the one Satora funds swaps from and pays claims into, and any
 * Ethereum wallet can recover it from the seed in an emergency.
 */
export const EVM_DERIVATION_PATH = "m/44'/60'/0'/0/0"

export interface UsdcSession {
  /** EIP-55 checksummed address of the Arbitrum account. */
  address: string
  /** 32-byte secp256k1 key at {@link EVM_DERIVATION_PATH}. */
  privateKey: Uint8Array
  /** BIP-32 root as xprv, handed to Satora, which never persists it. */
  rootXprv: string
}

export const toChecksumAddress = (address: string): string => {
  const lower = address.toLowerCase().replace(/^0x/, '')
  const hash = hex.encode(keccak_256(new TextEncoder().encode(lower)))
  let out = '0x'
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i]
  }
  return out
}

export const evmAddressFromPrivateKey = (privateKey: Uint8Array): string => {
  const uncompressed = secp256k1.getPublicKey(privateKey, false)
  const digest = keccak_256(uncompressed.slice(1))
  return toChecksumAddress(hex.encode(digest.slice(-20)))
}

/**
 * A plain EVM address: 20 hex bytes. All-lowercase and all-uppercase forms
 * carry no checksum and are accepted as typed; a mixed-case address must match
 * its EIP-55 checksum, which catches most single-character typos.
 */
export const isValidEvmAddress = (value: string): boolean => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return false
  const body = value.slice(2)
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true
  return toChecksumAddress(value) === value
}

export const deriveUsdcSession = (mnemonic: string): UsdcSession => {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Invalid mnemonic phrase')
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic))
  const privateKey = root.derive(EVM_DERIVATION_PATH).privateKey
  if (!privateKey) throw new Error('BIP32 derivation yielded no private key')
  return { address: evmAddressFromPrivateKey(privateKey), privateKey, rootXprv: root.privateExtendedKey }
}

// Memory only, like the Nostr backup key: set on unlock, dropped on lock and
// reset, never written to storage.
let session: UsdcSession | undefined
const listeners = new Set<(session: UsdcSession | undefined) => void>()

export const setUsdcSessionFromMnemonic = (mnemonic: string): void => {
  const next = deriveUsdcSession(mnemonic)
  // a session being replaced is wiped like one being cleared
  if (session) session.privateKey.fill(0)
  session = next
  listeners.forEach((listener) => listener(session))
}

export const clearUsdcSession = (): void => {
  if (session) session.privateKey.fill(0)
  session = undefined
  // the Satora client holds the same root; it goes with the session
  forgetSatoraSession()
  listeners.forEach((listener) => listener(undefined))
}

export const getUsdcSession = (): UsdcSession | undefined => session

export const onUsdcSession = (listener: (session: UsdcSession | undefined) => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
