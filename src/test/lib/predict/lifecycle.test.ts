import { arkade, CSVMultisigTapscript, networks, Transaction } from '@arkade-os/sdk'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { base64 } from '@scure/base'
import { describe, expect, it, vi } from 'vitest'
import {
  getPredictNetworkProfile,
  MAINNET_BACKUP_PUBKEY,
  MAINNET_DESK,
  MAINNET_EXIT,
  MAINNET_FALLBACK_DELAY,
  MAINNET_FINAL_EXIT_DELAY,
  PREDICT_VOID_AFTER,
} from '../../../lib/predict/constants'
import {
  bindPredictContracts,
  buildPredictSettleTx,
  DIA_SCALE,
  payoutVtxo,
  predictFixDigest,
  predictVaultProgram,
} from '../../../lib/predict/contracts'
import { bytesToHex, hexToBytes } from '../../../lib/predict/hex'
import { classifyPredictIntent, refreshLivePosition, splitPayouts } from '../../../lib/predict/lifecycle'
import { upsertPredictPosition, type PredictPosition } from '../../../lib/predict/storage'

const HOLDER = `5120${'aa'.repeat(32)}`
const VAULT = `5120${'bb'.repeat(32)}`
const DESK = `5120${'cc'.repeat(32)}`
const TX1 = '11'.repeat(32)
const TX2 = '22'.repeat(32)
const COMMIT_TX = '33'.repeat(32)
const FORFEIT_TX = '44'.repeat(32)
const SERVER_KEY = secp256k1.getPublicKey(hexToBytes('11'.repeat(32)), true).subarray(1)
const EMULATOR_KEY = secp256k1.getPublicKey(hexToBytes('22'.repeat(32)), true)
const HOLDER_KEY = secp256k1.getPublicKey(hexToBytes('33'.repeat(32)), true).subarray(1)
const ORACLE_SECRET = hexToBytes('44'.repeat(32))
const ORACLE_KEY = schnorr.getPublicKey(ORACLE_SECRET)
const CHECKPOINT_HEX = '03080040b27520dfcaec558c7e78cf3e38b898ba8a43cfb5727266bae32c5c5b3aeb32c558aa0bac'

function makeFixture(overrides: Partial<PredictPosition> = {}) {
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
    oraclePk: ORACLE_KEY,
    backupPk: hexToBytes(MAINNET_BACKUP_PUBKEY),
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: MAINNET_FALLBACK_DELAY,
    finalExitDelay: MAINNET_FINAL_EXIT_DELAY,
    serverKey: SERVER_KEY,
    emulatorKey: EMULATOR_KEY,
    hrp: networks.bitcoin.hrp,
  })
  const holderAddress = payoutVtxo(HOLDER_KEY, SERVER_KEY, MAINNET_EXIT)
    .address(networks.bitcoin.hrp, SERVER_KEY)
    .encode()

  const position: PredictPosition = {
    id: 'aa'.repeat(32),
    rfqId: 'aa'.repeat(32),
    network: 'bitcoin',
    mode: 'live',
    kind: 2,
    strikeCents: '6500000',
    stakeSats: '10000',
    payoutSats: '19000',
    multiplier: 1.9,
    expiry: Number(expiry),
    deadline: Number(expiry - 300n),
    exit: Number(MAINNET_EXIT),
    voidAfter: Number(PREDICT_VOID_AFTER),
    fallbackDelay: Number(MAINNET_FALLBACK_DELAY),
    finalExitDelay: Number(MAINNET_FINAL_EXIT_DELAY),
    holderAddress,
    holderPubkey: bytesToHex(HOLDER_KEY),
    deskName: MAINNET_DESK.name,
    deskPkHex: MAINNET_DESK.pubkey,
    backupPkHex: MAINNET_BACKUP_PUBKEY,
    oraclePkHex: bytesToHex(ORACLE_KEY),
    intentAddress: bound.intentAddress,
    vaultAddress: bound.vaultAddress,
    phase: 'filled',
    refundable: false,
    fillTxid: TX2,
    createdAt: Number(expiry - 300n),
    ...overrides,
  }

  return { bound, position, expiry }
}

function buildSettledPsbt(
  bound: ReturnType<typeof bindPredictContracts>,
  expiry: bigint,
  cents: bigint,
  holderWon: boolean,
) {
  const prev = new Transaction({ version: 3, allowUnknownOutputs: true })
  prev.addInput({ txid: new Uint8Array(32).fill(7), index: 0 })
  prev.addOutput({ script: bound.vaultPkScript, amount: 19_000n })

  const time = Number(expiry + 12n)
  const oracleSig = schnorr.sign(predictFixDigest({ expiry, cents, time: BigInt(time) }), ORACLE_SECRET)
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
    payouts: [{ script: holderWon ? bound.holderPkScript : bound.writerPkScript, amount: 19_000n }],
    checkpoint: CSVMultisigTapscript.decode(hexToBytes(CHECKPOINT_HEX)),
  })
  return {
    txid: built.arkTx.id.toLowerCase(),
    psbtBase64: base64.encode(built.arkTx.toPSBT()),
  }
}

function makeOpaquePsbt(amount: bigint) {
  const tx = new Transaction({ version: 3, allowUnknownOutputs: true })
  tx.addInput({ txid: new Uint8Array(32).fill(5), index: 0 })
  tx.addOutput({ script: hexToBytes(`5120${'ee'.repeat(32)}`), amount })
  return {
    txid: tx.id.toLowerCase(),
    psbtBase64: base64.encode(tx.toPSBT()),
  }
}

describe('predict intent lifecycle classification', () => {
  it('classifies open, funded, expired-refundable, filled, and refunded states', () => {
    expect(
      classifyPredictIntent({
        coins: [],
        spends: {},
        collateral: 19_000n,
        stake: 10_000n,
        holderScript: HOLDER,
        vaultScript: VAULT,
        now: 1_000,
        deadline: 1_060,
      }).phase,
    ).toBe('open')

    const funded = classifyPredictIntent({
      coins: [{ value: 10_000n, spent: false, spentBy: '', txid: TX1 }],
      spends: {},
      collateral: 19_000n,
      stake: 10_000n,
      holderScript: HOLDER,
      vaultScript: VAULT,
      now: 1_010,
      deadline: 1_060,
    })
    expect(funded.phase).toBe('funded')
    expect(funded.refundable).toBe(false)

    const expired = classifyPredictIntent({
      coins: [{ value: 10_000n, spent: false, spentBy: '', txid: TX1 }],
      spends: {},
      collateral: 19_000n,
      stake: 10_000n,
      holderScript: HOLDER,
      vaultScript: VAULT,
      now: 1_070,
      deadline: 1_060,
    })
    expect(expired.phase).toBe('expired')
    expect(expired.refundable).toBe(true)

    const filled = classifyPredictIntent({
      coins: [{ value: 10_000n, spent: true, spentBy: TX2, txid: TX1 }],
      spends: { [TX2]: [{ amount: 19_000n, script: VAULT }] },
      collateral: 19_000n,
      stake: 10_000n,
      holderScript: HOLDER,
      vaultScript: VAULT,
      now: 1_020,
      deadline: 1_060,
    })
    expect(filled.phase).toBe('filled')
    expect(filled.closeTxid).toBe(TX2)

    const refunded = classifyPredictIntent({
      coins: [{ value: 10_000n, spent: true, spentBy: TX2, txid: TX1 }],
      spends: { [TX2]: [{ amount: 10_000n, script: HOLDER }] },
      collateral: 19_000n,
      stake: 10_000n,
      holderScript: HOLDER,
      vaultScript: VAULT,
      now: 1_090,
      deadline: 1_060,
    })
    expect(refunded.phase).toBe('refunded')
    expect(refunded.refundable).toBe(false)
  })

  it('splits settlement payouts for standalone PredictVaultV3 and legacy beacon transactions', () => {
    const ext = '6a0441524b01'
    const anchor = '51024e73'
    expect(
      splitPayouts(
        [
          { amount: 19_000n, script: HOLDER },
          { amount: 0n, script: ext },
          { amount: 0n, script: anchor },
        ],
        HOLDER,
        DESK,
      ),
    ).toEqual({ user: 19_000n, desk: 0n })

    expect(
      splitPayouts(
        [
          { amount: 19_000n, script: DESK },
          { amount: 0n, script: ext },
          { amount: 0n, script: anchor },
        ],
        HOLDER,
        DESK,
      ),
    ).toEqual({ user: 0n, desk: 19_000n })

    const beacon = `5120${'dd'.repeat(32)}`
    const win = splitPayouts(
      [
        { amount: 2_000n, script: beacon },
        { amount: 18_000n, script: HOLDER },
      ],
      HOLDER,
      DESK,
    )
    expect(win).toEqual({ user: 18_000n, desk: 0n })
  })
})

describe('predict position storage merge', () => {
  it('preserves local intentAddress, deadline, deskName, and createdAt when Nostr replay arrives', () => {
    const { position } = makeFixture({
      phase: 'funded',
      deadline: 1_799_999_730,
      deskName: 'COINFLIP',
      fundingTxid: TX1,
      fillTxid: undefined,
      createdAt: 1_799_999_710,
    })

    const replayed: PredictPosition = {
      ...position,
      intentAddress: '',
      deadline: position.expiry - 30,
      deskName: 'Fallback',
      phase: 'filled',
      fundingTxid: undefined,
      fillTxid: TX2,
      createdAt: position.expiry - 300,
    }

    const [merged] = upsertPredictPosition([position], replayed)
    expect(merged!.phase).toBe('filled')
    expect(merged!.intentAddress).toBe(position.intentAddress)
    expect(merged!.deadline).toBe(1_799_999_730)
    expect(merged!.deskName).toBe('COINFLIP')
    expect(merged!.fundingTxid).toBe(TX1)
    expect(merged!.fillTxid).toBe(TX2)
    expect(merged!.createdAt).toBe(1_799_999_710)
  })

  it('never downgrades a settled position or wipes settlement fields on Nostr replay', () => {
    const { position } = makeFixture({
      phase: 'settled',
      settleTxid: COMMIT_TX,
      settleCents: '6543210',
      userPayoutSats: '19000',
      deskPayoutSats: '0',
    })

    const [merged] = upsertPredictPosition([position], {
      ...position,
      intentAddress: '',
      phase: 'filled',
      settleTxid: undefined,
      settleCents: undefined,
      userPayoutSats: undefined,
      deskPayoutSats: undefined,
    })

    expect(merged!.phase).toBe('settled')
    expect(merged!.intentAddress).toBe(position.intentAddress)
    expect(merged!.settleTxid).toBe(COMMIT_TX)
    expect(merged!.settleCents).toBe('6543210')
    expect(merged!.userPayoutSats).toBe('19000')
    expect(merged!.deskPayoutSats).toBe('0')
  })
})

describe('predict live settlement refresh', () => {
  const profile = getPredictNetworkProfile('bitcoin')

  it('resolves settlement when intentAddress is empty (Nostr-replayed position)', async () => {
    const { bound, position, expiry } = makeFixture({ intentAddress: '', phase: 'filled' })
    const settle = buildSettledPsbt(bound, expiry, 6_543_210n, true)

    const getVtxos = vi.fn(async () => ({
      vtxos: [
        {
          txid: TX2,
          vout: 0,
          value: 19_000,
          isSpent: true,
          spentBy: FORFEIT_TX,
          arkTxId: settle.txid,
          createdAt: new Date(1_800_000_010_000),
        },
      ],
    }))
    const getVirtualTxs = vi.fn(async () => ({ txs: [settle.psbtBase64] }))

    const refreshed = await refreshLivePosition(position, profile, '/predict-api/oracle/fixing', {
      indexer: { getVtxos: getVtxos as never, getVirtualTxs: getVirtualTxs as never },
    })

    expect(getVtxos).toHaveBeenCalledTimes(1)
    expect(getVtxos).toHaveBeenCalledWith({ scripts: [bytesToHex(bound.vaultPkScript)] })
    expect(refreshed.phase).toBe('settled')
    expect(refreshed.settleTxid).toBe(settle.txid)
    expect(refreshed.settleCents).toBe('6543210')
    expect(refreshed.userPayoutSats).toBe('19000')
    expect(refreshed.deskPayoutSats).toBe('0')
  })

  it('keeps a reboarded vault in filled phase while a live renewed vault coin exists', async () => {
    const { position } = makeFixture({ intentAddress: '', phase: 'filled' })

    const getVtxos = vi.fn(async () => ({
      vtxos: [
        {
          txid: TX1,
          vout: 0,
          value: 19_000,
          isSpent: true,
          spentBy: '',
          settledBy: COMMIT_TX,
          createdAt: new Date(1_799_999_800_000),
        },
        {
          txid: TX2,
          vout: 0,
          value: 19_000,
          isSpent: false,
          isSwept: false,
          isUnrolled: false,
          spentBy: '',
          createdAt: new Date(1_799_999_900_000),
        },
      ],
    }))
    const getVirtualTxs = vi.fn(async () => ({ txs: [] }))

    const refreshed = await refreshLivePosition(position, profile, '/predict-api/oracle/fixing', {
      indexer: { getVtxos: getVtxos as never, getVirtualTxs: getVirtualTxs as never },
    })

    expect(refreshed.phase).toBe('filled')
    expect(refreshed.settleTxid).toBeUndefined()
    expect(getVirtualTxs).not.toHaveBeenCalled()
  })

  it('prefers the settlement arkTxId over an earlier reboarded forfeit spend', async () => {
    const { bound, position, expiry } = makeFixture({ intentAddress: '', phase: 'filled' })
    const opaqueForfeit = makeOpaquePsbt(19_000n)
    const settle = buildSettledPsbt(bound, expiry, 6_450_000n, false)

    const getVtxos = vi.fn(async () => ({
      vtxos: [
        // Older reboarded coin appears first in the indexer response
        {
          txid: TX1,
          vout: 0,
          value: 19_000,
          isSpent: true,
          spentBy: opaqueForfeit.txid,
          settledBy: COMMIT_TX,
          createdAt: new Date(1_799_999_800_000),
        },
        // Newer settled coin
        {
          txid: TX2,
          vout: 0,
          value: 19_000,
          isSpent: true,
          spentBy: FORFEIT_TX,
          arkTxId: settle.txid,
          createdAt: new Date(1_800_000_060_000),
        },
      ],
    }))
    const getVirtualTxs = vi.fn(async () => ({ txs: [opaqueForfeit.psbtBase64, settle.psbtBase64] }))

    const refreshed = await refreshLivePosition(position, profile, '/predict-api/oracle/fixing', {
      indexer: { getVtxos: getVtxos as never, getVirtualTxs: getVirtualTxs as never },
    })

    expect(refreshed.phase).toBe('settled')
    expect(refreshed.settleTxid).toBe(settle.txid)
    expect(refreshed.settleCents).toBe('6450000')
    expect(refreshed.userPayoutSats).toBe('0')
    expect(refreshed.deskPayoutSats).toBe('19000')
  })

  it('marks vault settled and falls back to verified oracle fixing when only settledBy or isSpent is present', async () => {
    const { position, expiry } = makeFixture({ intentAddress: '', phase: 'filled' })

    const getVtxos = vi.fn(async () => ({
      vtxos: [
        {
          txid: TX2,
          vout: 0,
          value: 19_000,
          isSpent: true,
          spentBy: '',
          settledBy: COMMIT_TX,
        },
      ],
    }))
    const getVirtualTxs = vi.fn(async () => ({ txs: [] }))
    const fetchFixing = vi.fn(async () => ({
      status: 200,
      fixing: {
        expiry: Number(expiry),
        cents: 6_520_000n,
        price: 6_520_000n * DIA_SCALE,
        time: Number(expiry + 10n),
        nonce: 1n,
        intentExpiry: Number(expiry + 3600n),
        sig: new Uint8Array(64),
        oracleSig: new Uint8Array(64),
        oraclePk: ORACLE_KEY,
        oraclePkHex: bytesToHex(ORACLE_KEY),
      },
    }))

    const refreshed = await refreshLivePosition(position, profile, '/predict-api/oracle/fixing', {
      indexer: { getVtxos: getVtxos as never, getVirtualTxs: getVirtualTxs as never },
      fetchFixing: fetchFixing as never,
    })

    expect(refreshed.phase).toBe('settled')
    expect(refreshed.settleTxid).toBe(COMMIT_TX)
    expect(refreshed.settleCents).toBe('6520000')
    expect(refreshed.userPayoutSats).toBe('19000')
    expect(refreshed.deskPayoutSats).toBe('0')
    expect(fetchFixing).toHaveBeenCalledWith('/predict-api/oracle/fixing', Number(expiry), bytesToHex(ORACLE_KEY))
  })

  it('transitions to settled even when isSpent is true with all spend txids empty', async () => {
    const { position, expiry } = makeFixture({ intentAddress: '', phase: 'filled' })

    const getVtxos = vi.fn(async () => ({
      vtxos: [{ txid: TX2, vout: 0, value: 19_000, isSpent: true, spentBy: '' }],
    }))
    const getVirtualTxs = vi.fn(async () => ({ txs: [] }))
    const fetchFixing = vi.fn(async () => ({
      status: 200,
      fixing: {
        expiry: Number(expiry),
        cents: 6_400_000n,
        price: 6_400_000n * DIA_SCALE,
        time: Number(expiry + 10n),
        nonce: 1n,
        intentExpiry: Number(expiry + 3600n),
        sig: new Uint8Array(64),
        oracleSig: new Uint8Array(64),
        oraclePk: ORACLE_KEY,
        oraclePkHex: bytesToHex(ORACLE_KEY),
      },
    }))

    const refreshed = await refreshLivePosition(position, profile, '/predict-api/oracle/fixing', {
      indexer: { getVtxos: getVtxos as never, getVirtualTxs: getVirtualTxs as never },
      fetchFixing: fetchFixing as never,
    })

    expect(refreshed.phase).toBe('settled')
    expect(refreshed.settleCents).toBe('6400000')
    expect(refreshed.userPayoutSats).toBe('0')
    expect(refreshed.deskPayoutSats).toBe('19000')
  })

  it('still inspects the vault when a locally funded position intent query fails', async () => {
    const { bound, position, expiry } = makeFixture({ phase: 'funded', fillTxid: undefined })
    const settle = buildSettledPsbt(bound, expiry, 6_550_000n, true)

    const getVtxos = vi.fn(async (opts: { scripts?: string[] }) => {
      if (opts.scripts?.[0] === bytesToHex(bound.intentPkScript)) {
        throw new Error('transient intent indexer error')
      }
      return {
        vtxos: [{ txid: TX2, vout: 0, value: 19_000, isSpent: true, spentBy: FORFEIT_TX, arkTxId: settle.txid }],
      }
    })
    const getVirtualTxs = vi.fn(async () => ({ txs: [settle.psbtBase64] }))

    const refreshed = await refreshLivePosition(position, profile, '/predict-api/oracle/fixing', {
      indexer: { getVtxos: getVtxos as never, getVirtualTxs: getVirtualTxs as never },
    })

    expect(refreshed.phase).toBe('settled')
    expect(refreshed.settleTxid).toBe(settle.txid)
    expect(refreshed.settleCents).toBe('6550000')
    expect(refreshed.userPayoutSats).toBe('19000')
  })
})
