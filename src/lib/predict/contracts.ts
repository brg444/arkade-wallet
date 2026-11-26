import {
  arkade,
  ArkAddress,
  buildOffchainTx,
  ConditionWitness,
  DefaultVtxo,
  EmulatorPacket,
  Extension,
  P2A,
  PrevArkTxField,
  setArkPsbtField,
  Transaction,
  type ArkTxInput,
  type CSVMultisigTapscript,
  type EmulatorProvider,
  type ExtensionPacket,
} from '@arkade-os/sdk'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { base64 } from '@scure/base'
import intentArtifact from './artifacts/option_intent.artifact.json'
import predictArtifact from './artifacts/predict_vault.artifact.json'
import {
  DUST_SATS,
  MUTINYNET_FALLBACK_DELAY,
  MUTINYNET_FINAL_EXIT_DELAY,
  PREDICT_READ_FEE,
  PREDICT_VOID_AFTER,
  PRICE_MAX,
  type PredictKind,
} from './constants'
import { bytesToHex, hexToBytes, xOnly } from './hex'
import { holderPayoff, settlementOutputs } from './pricing'

export const STATE_TYPE = 32
export const STATE_SIZE = 329
export const SLOT_COUNT = 8
export const SLOT_SIZE = 40
export const SLOTS_AT = 9
const SLOT_OFFSETS = Array.from({ length: SLOT_COUNT }, (_, i) => SLOTS_AT + SLOT_SIZE * i)

export const DIA_SCALE = 10n ** 16n
const DIA_HALF = DIA_SCALE / 2n
/** `0x10 ||` compressed secp256k1 key of the pinned DIA Lasernet signer. */
export const DIA_PUBKEY = hexToBytes('100211ee120bca9f272034d98b1b026bb4ab735ebeb5da8be6a69bf7ee0ea24cfd48')
const DIA_DOMAIN = hexToBytes('f57d55f057fd4aba6b1a7f8bccb6a3e826cf71fd34971f22a39d7ffd6e620fb3')
const DIA_TYPEHASH = hexToBytes('24e574fa7512cc24e9109b981256e33759d91bc2ee9b74a2bf633e013c0620b5')
const DIA_INTENT_TYPE = hexToBytes('ef9b6324ed493183babb66ed98fcf36e9bcb0243ae4c5a29fcd99184b08f1899')
const DIA_VERSION = hexToBytes('e6bbd6277e1bf288eed5e8d1780f9a50b239e86b153736bceebccf4ea79d90b3')
const DIA_SYMBOL = hexToBytes('ee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489')
const DIA_SOURCE = hexToBytes('f5a695b63ab16fd8278cb1cf7d29f274a9574b64e0b894750e08c990fc8891bc')

export interface BeaconSlot {
  expiry: bigint
  value: Uint8Array
}

export interface BeaconState {
  version: number
  round: bigint
  slots: BeaconSlot[]
}

export interface OracleFixing {
  expiry: number
  cents: bigint
  price: bigint
  time: number
  nonce: bigint
  intentExpiry: number
  sig: Uint8Array
  oracleSig: Uint8Array
  oraclePk: Uint8Array
  oraclePkHex: string
}

export interface PredictTerms {
  kind: PredictKind
  strike: bigint
  collateral: bigint
  stake: bigint
  expiry: bigint
  deadline: bigint
  exit: bigint
  writerPk: Uint8Array
  holderPk: Uint8Array
  holderPayoutKey?: Uint8Array
  oraclePk: Uint8Array
  backupPk?: Uint8Array
  voidAfter?: bigint
  fallbackDelay?: bigint
  finalExitDelay?: bigint
  readFee?: bigint
  serverKey: Uint8Array
  emulatorKey: Uint8Array
  hrp: string
}

export interface BoundPredictContracts {
  intentAddress: string
  vaultAddress: string
  writerPkScript: Uint8Array
  holderPkScript: Uint8Array
  userPkScript: Uint8Array
  solverPkScript: Uint8Array
  vaultPkScript: Uint8Array
  intentPkScript: Uint8Array
  intent: Record<string, bigint | Uint8Array>
  vault: Record<string, bigint | Uint8Array>
}

export function exitSequence(seconds: bigint): bigint {
  if (seconds <= 0n || seconds % 512n !== 0n) {
    throw new Error(`exit must be a positive multiple of 512 seconds, got ${seconds}`)
  }
  const units = seconds / 512n
  if (units > 0xffffn) throw new Error(`exit ${seconds} exceeds BIP68 seconds range`)
  return (1n << 22n) | units
}

export function predictVaultProgram() {
  return arkade.programFromArtifact(predictArtifact as unknown as arkade.ContractArtifact)
}

export function intentProgram() {
  return arkade.programFromArtifact(intentArtifact as unknown as arkade.ContractArtifact)
}

export function payoutVtxo(pubKey: Uint8Array, serverKey: Uint8Array, exit: bigint) {
  return new DefaultVtxo.Script({
    pubKey: xOnly(pubKey),
    serverPubKey: xOnly(serverKey),
    csvTimelock: { type: 'seconds', value: exit },
  })
}

function directPayout(key: Uint8Array): { tweakedPublicKey: Uint8Array; pkScript: Uint8Array } {
  const tweakedPublicKey = xOnly(key)
  const pkScript = new Uint8Array(34)
  pkScript[0] = 0x51
  pkScript[1] = 0x20
  pkScript.set(tweakedPublicKey, 2)
  return { tweakedPublicKey, pkScript }
}

function scriptArg(name: string, program: Uint8Array): Record<string, bigint | Uint8Array> {
  return { [`${name}.program`]: program, [`${name}.version`]: 1n }
}

export function verifiedSignerKey(
  address: string,
  pubkey: string | undefined,
  serverKey: Uint8Array,
  exit: bigint,
): Uint8Array | undefined {
  const hex = pubkey?.trim().toLowerCase() ?? ''
  if (!/^[0-9a-f]{64}$/.test(hex) || hex === '0'.repeat(64)) return undefined
  const decoded = ArkAddress.decode(address.trim())
  const candidate = hexToBytes(hex)
  return bytesToHex(payoutVtxo(candidate, serverKey, exit).pkScript) === bytesToHex(decoded.pkScript)
    ? candidate
    : undefined
}

export function oracleKeyMatches(quoteOraclePk: string, pinnedOraclePk: string): boolean {
  const candidate = quoteOraclePk.trim().toLowerCase()
  const expected = pinnedOraclePk.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(candidate) && /^[0-9a-f]{64}$/.test(expected) && candidate === expected
}

export function backupKeyMatches(
  quoteBackupPk: string,
  deskPk: string,
  emulatorKey: Uint8Array,
  pinned: string | null,
  network: string,
): boolean {
  const candidate = quoteBackupPk.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(candidate)) return false
  if (candidate === deskPk.trim().toLowerCase()) return false
  const pinnedClean = pinned?.trim().toLowerCase() || ''
  if ((network === 'bitcoin' || network === 'mainnet') && !pinnedClean) return false
  const expected = pinnedClean || bytesToHex(xOnly(emulatorKey))
  return candidate === expected
}

export function bindPredictContracts(terms: PredictTerms): BoundPredictContracts {
  const serverKey = xOnly(terms.serverKey)
  const writerPk = xOnly(terms.writerPk)
  const holderPk = xOnly(terms.holderPk)
  const oraclePk = xOnly(terms.oraclePk)
  if (terms.emulatorKey.length !== 33) throw new Error('emulatorKey must be 33 bytes')

  const writer = payoutVtxo(writerPk, serverKey, terms.exit)
  const holder = terms.holderPayoutKey
    ? directPayout(terms.holderPayoutKey)
    : payoutVtxo(holderPk, serverKey, terms.exit)
  const keys = { serverKey, emulatorKey: terms.emulatorKey }

  const voidAfter = terms.voidAfter ?? PREDICT_VOID_AFTER
  const fallbackDelay = terms.fallbackDelay ?? MUTINYNET_FALLBACK_DELAY
  const finalExitDelay = terms.finalExitDelay ?? MUTINYNET_FINAL_EXIT_DELAY
  if (voidAfter <= 0n) throw new Error('voidAfter must be positive')
  if (fallbackDelay < terms.exit) throw new Error('fallbackDelay must be at least exit')
  if (finalExitDelay <= fallbackDelay) throw new Error('finalExitDelay must exceed fallbackDelay')

  const backupPk = xOnly(terms.backupPk ?? terms.emulatorKey)
  const vaultArgs: Record<string, bigint | Uint8Array> = {
    kind: BigInt(terms.kind),
    writerPk,
    holderPk,
    ...scriptArg('writerScript', writer.tweakedPublicKey),
    ...scriptArg('holderScript', holder.tweakedPublicKey),
    strike: terms.strike,
    collateral: terms.collateral,
    stake: terms.stake,
    expiry: terms.expiry,
    oraclePk,
    backupPk,
    voidAfter,
    fallbackDelay: exitSequence(fallbackDelay),
    finalExitDelay: exitSequence(finalExitDelay),
    server: serverKey,
  }
  const vaultScript = new arkade.ArkadeProgramScript(predictVaultProgram(), vaultArgs, keys)

  const intentArgs: Record<string, bigint | Uint8Array> = {
    userPk: holderPk,
    ...scriptArg('userScript', holder.tweakedPublicKey),
    ...scriptArg('solverScript', writer.tweakedPublicKey),
    ...scriptArg('optionScript', vaultScript.tweakedPublicKey),
    side: 1n,
    collateral: terms.collateral,
    premium: terms.stake,
    deadline: terms.deadline,
    exit: exitSequence(terms.exit),
    server: serverKey,
  }
  const intentScript = new arkade.ArkadeProgramScript(intentProgram(), intentArgs, keys)

  return {
    intentAddress: intentScript.address(terms.hrp, serverKey).encode(),
    vaultAddress: vaultScript.address(terms.hrp, serverKey).encode(),
    writerPkScript: writer.pkScript,
    holderPkScript: holder.pkScript,
    userPkScript: holder.pkScript,
    solverPkScript: writer.pkScript,
    vaultPkScript: vaultScript.pkScript,
    intentPkScript: intentScript.pkScript,
    intent: intentArgs,
    vault: vaultArgs,
  }
}

export function bin2num(bytes: Uint8Array): bigint {
  if (bytes.length === 0) return 0n
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(i === bytes.length - 1 ? bytes[i]! & 0x7f : bytes[i]!)
  }
  return bytes[bytes.length - 1]! & 0x80 ? -value : value
}

export function num2bin(value: bigint, size: number): Uint8Array {
  if (value < 0n) throw new Error('num2bin: negative')
  if (value >= 1n << BigInt(size * 8 - 1)) throw new Error(`num2bin: ${value} does not fit ${size} bytes`)
  const out = new Uint8Array(size)
  let rest = value
  for (let i = 0; i < size; i++) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function abiWord(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 255n) throw new Error('abi word')
  const out = new Uint8Array(32)
  let rest = value
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

export function centsOf(price: bigint): bigint {
  if (price <= 0n) throw new Error('nonpositive price')
  const q = price / DIA_SCALE
  const r = price % DIA_SCALE
  const cents = r >= DIA_HALF ? q + 1n : q
  if (cents <= 0n) throw new Error('price')
  return cents
}

export function diaIntentDigest(intent: {
  price: bigint
  time: number
  nonce: bigint
  intentExpiry: number
}): Uint8Array {
  const body = concatBytes(
    DIA_TYPEHASH,
    DIA_INTENT_TYPE,
    DIA_VERSION,
    abiWord(1050n),
    abiWord(intent.nonce),
    abiWord(BigInt(intent.intentExpiry)),
    DIA_SYMBOL,
    abiWord(intent.price),
    abiWord(BigInt(intent.time)),
    DIA_SOURCE,
  )
  return keccak_256(concatBytes(Uint8Array.of(0x19, 0x01), DIA_DOMAIN, keccak_256(body)))
}

export function intentSigned(
  intent: { price: bigint; time: number; nonce: bigint; intentExpiry: number; sig: Uint8Array },
  oraclePk: Uint8Array = DIA_PUBKEY,
): boolean {
  if (intent.sig.length !== 64 || oraclePk.length !== 34 || oraclePk[0] !== 0x10) return false
  try {
    return (
      secp256k1.verify(intent.sig, diaIntentDigest(intent), oraclePk.subarray(1), { prehash: false, lowS: false }) ===
      true
    )
  } catch {
    return false
  }
}

/**
 * Digest signed by `oraclePk` for standalone `PredictVault.settle`:
 * `sha256("BTCUSD-FIX" || "fix" || int2bytes(expiry, 8) || int2bytes(cents, 8) || int2bytes(time, 8))`.
 */
export function predictFixDigest(input: { expiry: bigint; cents: bigint; time: bigint }): Uint8Array {
  const enc = new TextEncoder()
  return sha256(
    concatBytes(
      enc.encode('BTCUSD-FIX'),
      enc.encode('fix'),
      num2bin(input.expiry, 8),
      num2bin(input.cents, 8),
      num2bin(input.time, 8),
    ),
  )
}

function parseWhole(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value)
  return null
}

function parseHexBytes(value: unknown, size: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length !== size * 2 || !/^[0-9a-fA-F]+$/.test(value)) return null
  return hexToBytes(value)
}

/** Parse and cryptographically verify a signed fixing payload from `GET /api/fixing?expiry=...`. */
export function parseOracleFixing(body: unknown, expectedOraclePkHex?: string): OracleFixing | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const root = body as Record<string, unknown>
  const expiry =
    typeof root.expiry === 'number' && Number.isSafeInteger(root.expiry) && root.expiry > 1800 ? root.expiry : null
  const time = typeof root.time === 'number' && Number.isSafeInteger(root.time) && root.time > 0 ? root.time : null
  const intentExpiry =
    typeof root.intentExpiry === 'number' && Number.isSafeInteger(root.intentExpiry) ? root.intentExpiry : null
  const price = parseWhole(root.raw)
  const nonce = parseWhole(root.nonce)
  const sig = parseHexBytes(root.sig, 64)
  const oracleSig = parseHexBytes(root.oracleSig, 64)
  const oraclePk = parseHexBytes(root.oraclePk, 32)
  if (
    expiry == null ||
    time == null ||
    intentExpiry == null ||
    price == null ||
    price <= 0n ||
    nonce == null ||
    !sig ||
    !oracleSig ||
    !oraclePk
  ) {
    return null
  }
  const oraclePkHex = bytesToHex(oraclePk)
  if (expectedOraclePkHex && oraclePkHex !== expectedOraclePkHex.trim().toLowerCase()) return null
  if (time < expiry || time > expiry + 60) return null
  let cents: bigint
  try {
    cents = centsOf(price)
  } catch {
    return null
  }
  if (!intentSigned({ price, time, nonce, intentExpiry, sig })) return null
  const digest = predictFixDigest({ expiry: BigInt(expiry), cents, time: BigInt(time) })
  if (!schnorr.verify(oracleSig, digest, oraclePk)) return null
  return { expiry, cents, price, time, nonce, intentExpiry, sig, oracleSig, oraclePk, oraclePkHex }
}

/** Fetch and verify the canonical signed fixing for `expiry`. */
export async function fetchOracleFixing(
  url: string,
  expiry: number,
  expectedOraclePkHex?: string,
  signal?: AbortSignal,
): Promise<{ status: number; fixing: OracleFixing | null; error?: string }> {
  const endpoint = `${url}${url.includes('?') ? '&' : '?'}expiry=${expiry}`
  const res = await fetch(endpoint, { signal, cache: 'no-store' })
  const raw = (await res.json().catch(() => null)) as { error?: string } | null
  if (!res.ok) return { status: res.status, fixing: null, error: raw?.error ?? `oracle fixing ${res.status}` }
  const fixing = parseOracleFixing(raw, expectedOraclePkHex)
  if (!fixing) return { status: 502, fixing: null, error: 'invalid fixing signature' }
  return { status: 200, fixing }
}

export function decodeState(bytes: Uint8Array): BeaconState {
  if (bytes.length !== STATE_SIZE) throw new Error(`state is ${bytes.length} bytes, want ${STATE_SIZE}`)
  return {
    version: bytes[0]!,
    round: bin2num(bytes.subarray(1, 9)),
    slots: SLOT_OFFSETS.map((at) => ({
      expiry: bin2num(bytes.subarray(at, at + 8)),
      value: bytes.slice(at + 8, at + SLOT_SIZE),
    })),
  }
}

export function statePacketOf(tx: Transaction): Uint8Array {
  const packet = Extension.fromTx(tx).getPacketByType(STATE_TYPE)
  if (!packet) throw new Error('state packet missing')
  return packet.serialize()
}

export function slotFixing(state: Uint8Array, expiry: bigint): { price: bigint; time: bigint } | null {
  let decoded: BeaconState
  try {
    decoded = decodeState(state)
  } catch {
    return null
  }
  if (decoded.version !== 1) return null
  const slot = decoded.slots.find((item) => item.expiry === expiry)
  if (!slot || slot.value.length < 16) return null
  const price = bin2num(slot.value.subarray(0, 8))
  const time = bin2num(slot.value.subarray(8, 16))
  if (price <= 0n || price > PRICE_MAX || time < expiry || time > expiry + 60n) return null
  return { price, time }
}

export function slotPrice(state: Uint8Array, expiry: bigint): bigint | null {
  return slotFixing(state, expiry)?.price ?? null
}

function readCompactSize(bytes: Uint8Array, at: number): [number, number] | null {
  if (at >= bytes.length) return null
  const first = bytes[at]!
  if (first < 0xfd) return [first, at + 1]
  if (first === 0xfd) {
    if (at + 3 > bytes.length) return null
    return [bytes[at + 1]! | (bytes[at + 2]! << 8), at + 3]
  }
  if (first === 0xfe) {
    if (at + 5 > bytes.length) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4)
    return [view.getUint32(0, true), at + 5]
  }
  return null
}

function decodeWitness(bytes: Uint8Array): Uint8Array[] | null {
  const count = readCompactSize(bytes, 0)
  if (!count) return null
  const [n, start] = count
  let at = start
  const items: Uint8Array[] = []
  for (let i = 0; i < n; i++) {
    const len = readCompactSize(bytes, at)
    if (!len) return null
    const [size, dataAt] = len
    if (dataAt + size > bytes.length) return null
    items.push(bytes.subarray(dataAt, dataAt + size))
    at = dataAt + size
  }
  return at === bytes.length ? items : null
}

/** Extract the rounded USD cents settlement price from a standalone `PredictVault.settle` transaction. */
export function predictSettlePriceCents(tx: Transaction): bigint | null {
  try {
    const ext = Extension.fromTx(tx)
    const emu = ext.getEmulatorPacket()
    const entry = emu?.entries.find((item) => item.vin === 0)
    if (!entry) return null
    const stack = decodeWitness(entry.witness)
    if (!stack || stack.length !== 6) return null
    const rawPrice =
      stack[0]!.length === 64 && stack[1]!.length === 64
        ? stack[5]!
        : stack[4]!.length === 64 && stack[5]!.length === 64
          ? stack[0]!
          : null
    if (!rawPrice) return null
    const price = bin2num(rawPrice)
    const cents = centsOf(price)
    return cents > 0n && cents <= PRICE_MAX ? cents : null
  } catch {
    return null
  }
}

// --- Covenant transaction builders for manual settle & void refund ---

type ProgramScript = InstanceType<typeof arkade.ArkadeProgramScript>
type CoinRef = { txid: string; vout: number; value: number | bigint; prevTx: Uint8Array }

interface BuiltCospend {
  arkTx: Transaction
  checkpoints: Transaction[]
}

function anchorIndex(tx: Transaction): number {
  for (let i = tx.outputsLength - 1; i >= 0; i--) {
    const script = tx.getOutput(i)?.script
    if (script && bytesToHex(script) === bytesToHex(P2A.script)) return i
  }
  throw new Error('anchor output missing')
}

function buildCovenantTx(
  spends: { script: ProgramScript; fn: string; callArgs?: Record<string, bigint | Uint8Array>; coin: CoinRef }[],
  outputs: { script: Uint8Array; amount: bigint }[],
  packets: ExtensionPacket[],
  checkpoint: CSVMultisigTapscript.Type,
): BuiltCospend {
  const inputs: ArkTxInput[] = []
  const entries: { vin: number; script: Uint8Array; witness: Uint8Array }[] = []
  const conditions = new Map<number, Uint8Array[]>()

  spends.forEach((spend, vin) => {
    const fn = spend.script.functionByName(spend.fn)
    if (!fn || !fn.arkadeScript) throw new Error(`${spend.script.program.name}.${spend.fn} is not a covenant`)
    const callArgs = spend.callArgs ?? {}
    const stack = (fn.def.arkadeScript?.witness ?? []).map((ref) =>
      arkade.witnessRefToBytes(ref, callArgs, spend.script.args),
    )
    const condition = (fn.def.tapscript.witness ?? []).map((ref) =>
      arkade.witnessRefToBytes(ref, callArgs, spend.script.args),
    )
    inputs.push({
      txid: spend.coin.txid,
      vout: spend.coin.vout,
      value: Number(spend.coin.value),
      tapLeafScript: fn.tapLeafScript,
      tapTree: spend.script.encode(),
    })
    entries.push({ vin, script: fn.arkadeScript, witness: ConditionWitness.encode(stack)[1] })
    if (condition.length > 0) conditions.set(vin, condition)
  })

  const { arkTx, checkpoints } = buildOffchainTx(inputs, outputs, checkpoint)
  spends.forEach((spend, vin) => {
    setArkPsbtField(arkTx, vin, PrevArkTxField, spend.coin.prevTx)
    const condition = conditions.get(vin)
    if (condition) {
      setArkPsbtField(arkTx, vin, ConditionWitness, condition)
      setArkPsbtField(checkpoints[vin]!, 0, ConditionWitness, condition)
    }
  })

  const extOut = Extension.create([...packets, EmulatorPacket.create(entries)]).txOut()
  const anchor = anchorIndex(arkTx)
  const last = arkTx.getOutput(anchor)
  arkTx.updateOutput(anchor, { script: extOut.script, amount: extOut.amount })
  arkTx.addOutput({ script: last!.script!, amount: last!.amount ?? 0n })

  return { arkTx, checkpoints }
}

export function settlePayouts(input: {
  kind: PredictKind
  price: bigint
  strike: bigint
  collateral: bigint
  locked: bigint
  readFee?: bigint
  holderScript: Uint8Array
  writerScript: Uint8Array
}): { payouts: { script: Uint8Array; amount: bigint }[] } | { error: string } {
  if (input.locked < input.collateral) return { error: 'underfunded' }
  const readFee = input.readFee ?? PREDICT_READ_FEE
  if (input.locked < readFee) return { error: 'fee' }
  const gross = holderPayoff(input.kind, input.price, input.strike, input.collateral)
  const split = settlementOutputs(gross, input.locked, readFee)
  if (split.mode === 'split') {
    return {
      payouts: [
        { script: input.holderScript, amount: split.holder },
        { script: input.writerScript, amount: split.writer },
      ],
    }
  }
  if (split.mode === 'writer') return { payouts: [{ script: input.writerScript, amount: split.writer }] }
  return { payouts: [{ script: input.holderScript, amount: split.holder }] }
}

/** Standalone 1-input PredictVault settlement: verifies DIA + oracle signatures directly on the stack. */
export function buildPredictSettleTx(input: {
  vault: { script: ProgramScript; coin: CoinRef }
  fixing: Pick<OracleFixing, 'price' | 'time' | 'nonce' | 'intentExpiry' | 'sig' | 'oracleSig'>
  payouts: { script: Uint8Array; amount: bigint }[]
  checkpoint: CSVMultisigTapscript.Type
}): BuiltCospend {
  return buildCovenantTx(
    [
      {
        script: input.vault.script,
        fn: 'settle',
        callArgs: {
          price: input.fixing.price,
          time: BigInt(input.fixing.time),
          nonce: input.fixing.nonce,
          intentExpiry: BigInt(input.fixing.intentExpiry),
          sig: input.fixing.sig,
          oracleSig: input.fixing.oracleSig,
        },
        coin: input.vault.coin,
      },
    ],
    input.payouts,
    [],
    input.checkpoint,
  )
}

export function refundOutputs(
  locked: bigint,
  stake: bigint,
  holderScript: Uint8Array,
  writerScript: Uint8Array,
): { script: Uint8Array; amount: bigint }[] {
  if (stake <= DUST_SATS) throw new Error('stake must exceed dust')
  if (locked < stake) throw new Error('vault underfunded for stake refund')
  const house = locked - stake
  if (house > DUST_SATS) {
    return [
      { script: holderScript, amount: stake },
      { script: writerScript, amount: house },
    ]
  }
  return [{ script: holderScript, amount: locked }]
}

export function buildRefundTx(input: {
  vault: { script: ProgramScript; coin: CoinRef }
  stake: bigint
  holderScript: Uint8Array
  writerScript: Uint8Array
  checkpoint: CSVMultisigTapscript.Type
}): BuiltCospend {
  const outputs = refundOutputs(BigInt(input.vault.coin.value), input.stake, input.holderScript, input.writerScript)
  return buildCovenantTx(
    [{ script: input.vault.script, fn: 'refund', coin: input.vault.coin }],
    outputs,
    [],
    input.checkpoint,
  )
}

export async function submitCospend(
  built: BuiltCospend,
  emulator: Pick<EmulatorProvider, 'submitTx'>,
): Promise<{ txid: string; signedArkTx: string }> {
  const res = await emulator.submitTx(
    base64.encode(built.arkTx.toPSBT()),
    built.checkpoints.map((cp) => base64.encode(cp.toPSBT())),
  )
  return { txid: Transaction.fromPSBT(base64.decode(res.signedArkTx)).id, signedArkTx: res.signedArkTx }
}
