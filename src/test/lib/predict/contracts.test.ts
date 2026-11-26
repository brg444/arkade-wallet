import { arkade, CSVMultisigTapscript, networks, Transaction } from '@arkade-os/sdk'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { describe, expect, it } from 'vitest'
import {
  MAINNET_BACKUP_PUBKEY,
  MAINNET_DESK,
  MAINNET_EXIT,
  MAINNET_FALLBACK_DELAY,
  MAINNET_FINAL_EXIT_DELAY,
  MAINNET_ORACLE_PUBKEY,
  MUTINYNET_ORACLE_PUBKEY,
  PREDICT_READ_FEE,
  PREDICT_VOID_AFTER,
} from '../../../lib/predict/constants'
import {
  backupKeyMatches,
  bindPredictContracts,
  buildPredictSettleTx,
  decodeState,
  DIA_SCALE,
  exitSequence,
  oracleKeyMatches,
  predictFixDigest,
  predictSettlePriceCents,
  predictVaultProgram,
  slotFixing,
  STATE_SIZE,
} from '../../../lib/predict/contracts'
import { bytesToHex, hexToBytes } from '../../../lib/predict/hex'

const SERVER_KEY = secp256k1.getPublicKey(hexToBytes('11'.repeat(32)), true).subarray(1)
const EMULATOR_KEY = secp256k1.getPublicKey(hexToBytes('22'.repeat(32)), true)
const HOLDER_KEY = secp256k1.getPublicKey(hexToBytes('33'.repeat(32)), true).subarray(1)
const CHECKPOINT_HEX = '03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac'

describe('predict PredictVaultV3 contracts & standalone settlement', () => {
  it('derives deterministic mainnet ark1 OptionIntent and PredictVaultV3 addresses', () => {
    const bound = bindPredictContracts({
      kind: 2,
      strike: 6_500_000n,
      collateral: 19_000n,
      stake: 10_000n,
      expiry: 1_800_000_000n,
      deadline: 1_799_999_700n,
      exit: MAINNET_EXIT,
      writerPk: hexToBytes(MAINNET_DESK.pubkey),
      holderPk: HOLDER_KEY,
      oraclePk: hexToBytes(MAINNET_ORACLE_PUBKEY),
      backupPk: hexToBytes(MAINNET_BACKUP_PUBKEY),
      voidAfter: PREDICT_VOID_AFTER,
      fallbackDelay: MAINNET_FALLBACK_DELAY,
      finalExitDelay: MAINNET_FINAL_EXIT_DELAY,
      readFee: PREDICT_READ_FEE,
      serverKey: SERVER_KEY,
      emulatorKey: EMULATOR_KEY,
      hrp: networks.bitcoin.hrp,
    })

    expect(bound.intentAddress.startsWith('ark1')).toBe(true)
    expect(bound.vaultAddress.startsWith('ark1')).toBe(true)
    expect(bound.intentAddress).not.toBe(bound.vaultAddress)
    expect(bound.intentPkScript).toHaveLength(34)
    expect(bound.vaultPkScript).toHaveLength(34)
  })

  it('builds a 1-input standalone settle tx and decodes the settlement price from its witness', () => {
    const oracleSecret = hexToBytes('44'.repeat(32))
    const oraclePk = schnorr.getPublicKey(oracleSecret)
    const expiry = 1_800_000_000n
    const bound = bindPredictContracts({
      kind: 2,
      strike: 6_500_000n,
      collateral: 19_000n,
      stake: 10_000n,
      expiry,
      deadline: expiry - 300n,
      exit: MAINNET_EXIT,
      writerPk: hexToBytes(MAINNET_DESK.pubkey),
      holderPk: HOLDER_KEY,
      oraclePk,
      backupPk: hexToBytes(MAINNET_BACKUP_PUBKEY),
      voidAfter: PREDICT_VOID_AFTER,
      fallbackDelay: MAINNET_FALLBACK_DELAY,
      finalExitDelay: MAINNET_FINAL_EXIT_DELAY,
      serverKey: SERVER_KEY,
      emulatorKey: EMULATOR_KEY,
      hrp: networks.bitcoin.hrp,
    })

    const prev = new Transaction({ version: 3, allowUnknownOutputs: true })
    prev.addInput({ txid: new Uint8Array(32).fill(7), index: 0 })
    prev.addOutput({ script: bound.vaultPkScript, amount: 19_000n })

    const cents = 6_543_210n
    const time = Number(expiry + 12n)
    const oracleSig = schnorr.sign(predictFixDigest({ expiry, cents, time: BigInt(time) }), oracleSecret)
    const vaultScript = new arkade.ArkadeProgramScript(predictVaultProgram(), bound.vault, {
      serverKey: SERVER_KEY,
      emulatorKey: EMULATOR_KEY,
    })
    const built = buildPredictSettleTx({
      vault: {
        script: vaultScript,
        coin: { txid: prev.id, vout: 0, value: 19_000, prevTx: prev.toBytes(true, true) },
      },
      fixing: {
        price: cents * DIA_SCALE,
        time,
        nonce: 1n,
        intentExpiry: time + 3600,
        sig: new Uint8Array(64).fill(9),
        oracleSig,
      },
      payouts: [{ script: bound.holderPkScript, amount: 19_000n }],
      checkpoint: CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT_HEX)),
    })

    expect(built.arkTx.inputsLength).toBe(1)
    expect(built.checkpoints).toHaveLength(1)
    expect(predictSettlePriceCents(built.arkTx)).toBe(cents)
  })

  it('matches only the pinned oracle x-only pubkey', () => {
    expect(oracleKeyMatches(MAINNET_ORACLE_PUBKEY, MAINNET_ORACLE_PUBKEY)).toBe(true)
    expect(oracleKeyMatches(MAINNET_ORACLE_PUBKEY.toUpperCase(), MAINNET_ORACLE_PUBKEY)).toBe(true)
    expect(oracleKeyMatches(MUTINYNET_ORACLE_PUBKEY, MAINNET_ORACLE_PUBKEY)).toBe(false)
    expect(oracleKeyMatches('not-hex', MAINNET_ORACLE_PUBKEY)).toBe(false)
  })

  it('enforces fail-closed backup key matching on mainnet', () => {
    expect(
      backupKeyMatches(MAINNET_BACKUP_PUBKEY, MAINNET_DESK.pubkey, EMULATOR_KEY, MAINNET_BACKUP_PUBKEY, 'bitcoin'),
    ).toBe(true)
    // Mainnet must reject when no backup key is pinned
    expect(backupKeyMatches(MAINNET_BACKUP_PUBKEY, MAINNET_DESK.pubkey, EMULATOR_KEY, null, 'bitcoin')).toBe(false)
    // Backup key cannot equal desk key
    expect(
      backupKeyMatches(MAINNET_DESK.pubkey, MAINNET_DESK.pubkey, EMULATOR_KEY, MAINNET_DESK.pubkey, 'bitcoin'),
    ).toBe(false)
    // Mutinynet allows emulator x-only key when no backup pin is provided
    expect(
      backupKeyMatches(bytesToHex(EMULATOR_KEY.subarray(1)), MAINNET_DESK.pubkey, EMULATOR_KEY, null, 'mutinynet'),
    ).toBe(true)
  })

  it('decodes legacy 329-byte beacon state packet and extracts valid slot fixing', () => {
    const bytes = new Uint8Array(STATE_SIZE)
    bytes[0] = 1 // version
    bytes[1] = 3 // round = 3
    const writeU64 = (offset: number, val: bigint) => {
      let rest = val
      for (let i = 0; i < 8; i++) {
        bytes[offset + i] = Number(rest & 0xffn)
        rest >>= 8n
      }
    }
    const expiry = 1_800_000_000n
    writeU64(9, expiry) // slot 0 expiry
    writeU64(17, 6_543_210n) // slot 0 price
    writeU64(25, expiry + 12n) // slot 0 sample time

    const state = decodeState(bytes)
    expect(state.version).toBe(1)
    expect(state.round).toBe(3n)
    expect(slotFixing(bytes, expiry)).toEqual({ price: 6_543_210n, time: expiry + 12n })
    expect(slotFixing(bytes, expiry + 300n)).toBeNull()
  })

  it('encodes BIP68 time-based exit sequence', () => {
    expect(exitSequence(2048n)).toBe((1n << 22n) | 4n)
    expect(() => exitSequence(100n)).toThrow()
  })
})
