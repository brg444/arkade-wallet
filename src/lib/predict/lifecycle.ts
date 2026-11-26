import {
  arkade,
  ArkAddress,
  InMemoryContractRepository,
  InMemoryWalletRepository,
  RestArkProvider,
  RestEmulatorProvider,
  RestIndexerProvider,
  SingleKey,
  Transaction,
  type EmulatorProvider,
} from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import {
  DUST_SATS,
  PREDICT_READ_FEE,
  PREDICT_VOID_AFTER,
  VAULT_EXPIRY_LAG,
  type PredictNetworkProfile,
} from './constants'
import {
  bindPredictContracts,
  buildPredictSettleTx,
  buildRefundTx,
  fetchOracleFixing,
  intentProgram,
  oracleKeyMatches,
  payoutVtxo,
  predictSettlePriceCents,
  predictVaultProgram,
  refundOutputs,
  settlePayouts,
  slotPrice,
  statePacketOf,
  submitCospend,
  verifiedSignerKey,
  type PredictTerms,
} from './contracts'
import { bytesToHex, hexToBytes, xOnly } from './hex'
import { holderPayoff, settlementOutputs } from './pricing'
import type { PredictPosition, PredictPositionPhase } from './storage'

export interface CoinView {
  value: bigint
  spent: boolean
  spentBy: string
  txid?: string
}

export interface TxOutput {
  amount: bigint
  script: string
}

export interface IntentView {
  phase: Exclude<PredictPositionPhase, 'settled'>
  refundable: boolean
  fundingTxid: string
  closeTxid: string
}

const TXID_RE = /^[0-9a-f]{64}$/

function cleanTxid(value: string | undefined): string {
  const id = (value ?? '').toLowerCase()
  return TXID_RE.test(id) ? id : ''
}

/** Predict side (side = 1): user's coin is the stake; a fill funds the vault with collateral. */
export function classifyPredictIntent(input: {
  coins: CoinView[]
  spends: Record<string, TxOutput[]>
  collateral: bigint
  stake: bigint
  holderScript: string
  vaultScript: string
  now: number
  deadline: number
}): IntentView {
  const holder = input.holderScript.toLowerCase()
  const vault = input.vaultScript.toLowerCase()
  const liveAboveDust = input.coins.find((coin) => !coin.spent && coin.value > DUST_SATS)
  const pastDeadline = input.now >= input.deadline

  const sumTo = (outputs: TxOutput[], script: string) =>
    outputs.reduce((sum, out) => (script && out.script.toLowerCase() === script ? sum + out.amount : sum), 0n)

  const spent = input.coins
    .filter((coin) => coin.spent && coin.value >= input.stake && coin.spentBy)
    .sort((a, b) => Number(b.value - a.value))

  for (const coin of spent) {
    const outputs = input.spends[coin.spentBy] ?? []
    if (sumTo(outputs, holder) >= coin.value) continue
    if (sumTo(outputs, vault) >= input.collateral) {
      return {
        phase: 'filled',
        refundable: Boolean(liveAboveDust && pastDeadline),
        fundingTxid: cleanTxid(coin.txid),
        closeTxid: cleanTxid(coin.spentBy),
      }
    }
  }

  const live = input.coins.find((coin) => !coin.spent && coin.value >= input.stake)
  if (live) {
    return {
      phase: pastDeadline ? 'expired' : 'funded',
      refundable: pastDeadline,
      fundingTxid: cleanTxid(live.txid),
      closeTxid: '',
    }
  }

  for (const coin of spent) {
    const outputs = input.spends[coin.spentBy] ?? []
    if (sumTo(outputs, holder) >= coin.value) {
      return {
        phase: 'refunded',
        refundable: Boolean(liveAboveDust && pastDeadline),
        fundingTxid: cleanTxid(coin.txid),
        closeTxid: cleanTxid(coin.spentBy),
      }
    }
  }

  if (liveAboveDust && pastDeadline) {
    return {
      phase: 'expired',
      refundable: true,
      fundingTxid: cleanTxid(liveAboveDust.txid),
      closeTxid: '',
    }
  }

  const spentSmall = input.coins
    .filter((coin) => coin.spent && coin.value > DUST_SATS && coin.value < input.stake && coin.spentBy)
    .sort((a, b) => Number(b.value - a.value))
  for (const coin of spentSmall) {
    const outputs = input.spends[coin.spentBy] ?? []
    if (sumTo(outputs, holder) >= coin.value) {
      return {
        phase: 'refunded',
        refundable: false,
        fundingTxid: cleanTxid(coin.txid),
        closeTxid: cleanTxid(coin.spentBy),
      }
    }
  }

  return {
    phase: input.now < input.deadline ? 'open' : 'expired',
    refundable: false,
    fundingTxid: '',
    closeTxid: '',
  }
}

// --- Lightweight PSBT output reader ---

function readVarint(bytes: Uint8Array, at: number): [number, number] {
  const first = bytes[at] ?? 0
  if (first < 0xfd) return [first, at + 1]
  if (first === 0xfd) return [(bytes[at + 1] ?? 0) | ((bytes[at + 2] ?? 0) << 8), at + 3]
  const view = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4)
  return [view.getUint32(0, true), at + 5]
}

function readAmount(bytes: Uint8Array, at: number): bigint {
  let value = 0n
  for (let i = 0; i < 8; i++) value |= BigInt(bytes[at + i] ?? 0) << BigInt(8 * i)
  return value
}

function readTxOut(bytes: Uint8Array, at: number): [TxOutput, number] {
  const amount = readAmount(bytes, at)
  at += 8
  const [scriptLen, next] = readVarint(bytes, at)
  const script = bytes.slice(next, next + scriptLen)
  return [{ amount, script: bytesToHex(script) }, next + scriptLen]
}

export function psbtOutputs(b64: string): TxOutput[] {
  const bytes = base64.decode(b64)
  if (bytes[0] !== 0x70 || bytes[1] !== 0x73 || bytes[2] !== 0x62 || bytes[3] !== 0x74) {
    throw new Error('not a psbt')
  }
  let unsigned: Uint8Array | null = null
  let at = 5
  while (at < bytes.length && bytes[at] !== 0) {
    const [keyLen, keyAt] = readVarint(bytes, at)
    const key = bytes.subarray(keyAt, keyAt + keyLen)
    const [valLen, valAt] = readVarint(bytes, keyAt + keyLen)
    if (key.length === 1 && key[0] === 0) unsigned = bytes.subarray(valAt, valAt + valLen)
    at = valAt + valLen
  }
  if (!unsigned) return []
  let pos = 4
  if (unsigned[pos] === 0 && unsigned[pos + 1] === 1) pos += 2
  const [inputCount, afterInputs] = readVarint(unsigned, pos)
  pos = afterInputs
  for (let i = 0; i < inputCount; i++) {
    pos += 36
    const [scriptLen, next] = readVarint(unsigned, pos)
    pos = next + scriptLen + 4
  }
  const [outputCount, afterCount] = readVarint(unsigned, pos)
  pos = afterCount
  const parsed: TxOutput[] = []
  for (let i = 0; i < outputCount; i++) {
    const [out, next] = readTxOut(unsigned, pos)
    parsed.push(out)
    pos = next
  }
  return parsed
}

export function virtualTxsById(raws: readonly string[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const raw of raws) {
    if (!raw) continue
    try {
      found.set(Transaction.fromPSBT(base64.decode(raw)).id.toLowerCase(), raw)
    } catch {
      continue
    }
  }
  return found
}

export function splitPayouts(
  outputs: TxOutput[],
  holderScript: string,
  deskScript?: string,
): { user: bigint; desk: bigint } | null {
  const want = holderScript.toLowerCase()
  const wantDesk = (deskScript ?? '').toLowerCase()
  let user = 0n
  let desk = 0n
  let matched = false
  const firstScript = outputs[0]?.script.toLowerCase() ?? ''
  const startIndex = firstScript === want || (wantDesk !== '' && firstScript === wantDesk) ? 0 : 1
  outputs.forEach((output, index) => {
    if (index < startIndex || output.amount <= 0n) return
    const script = output.script.toLowerCase()
    if (script === '51024e73' || script.startsWith('6a')) return
    if (script === want) {
      user += output.amount
      matched = true
    } else if (wantDesk && script === wantDesk) {
      desk += output.amount
      matched = true
    } else {
      desk += output.amount
    }
  })
  return matched ? { user, desk } : null
}

function pkScriptHex(address: string): string {
  return bytesToHex(ArkAddress.decode(address).pkScript)
}

function randomEphemeralKey(): SingleKey {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  if (bytes.every((b) => b === 0)) bytes[0] = 1
  return SingleKey.fromHex(bytesToHex(bytes))
}

/** Isolated Arkade client (in-memory repos so it never contends with the wallet service worker's IndexedDB). */
export async function connectPredictClient(profile: PredictNetworkProfile) {
  const ark = new RestArkProvider(profile.arkUrl)
  const indexer = new RestIndexerProvider(profile.arkUrl)
  const emulator = new RestEmulatorProvider(profile.emulatorUrl)
  const contractManager = await arkade.Arkade.connect({
    arkade: ark,
    indexer,
    emulator,
    identity: randomEphemeralKey(),
    network: profile.network,
    contractRepository: new InMemoryContractRepository(),
    walletRepository: new InMemoryWalletRepository(),
  } as Parameters<typeof arkade.Arkade.connect>[0])
  return { client: contractManager, indexer, emulator }
}

function termsFromPosition(
  pos: PredictPosition,
  profile: PredictNetworkProfile,
  serverKey: Uint8Array,
  emulatorKey: Uint8Array,
): PredictTerms {
  const decoded = ArkAddress.decode(pos.holderAddress)
  const exit = BigInt(pos.exit || Number(profile.exit))
  const signerKey = verifiedSignerKey(pos.holderAddress, pos.holderPubkey, serverKey, exit)
  const payoutKey = xOnly(decoded.vtxoTaprootKey)
  if (!pos.oraclePkHex) throw new Error('Prediction is missing oracle signing key')
  return {
    kind: pos.kind,
    strike: BigInt(pos.strikeCents),
    collateral: BigInt(pos.payoutSats),
    stake: BigInt(pos.stakeSats),
    expiry: BigInt(pos.expiry),
    deadline: BigInt(pos.deadline),
    exit,
    writerPk: hexToBytes(pos.deskPkHex),
    holderPk: signerKey ?? payoutKey,
    holderPayoutKey: signerKey ? undefined : payoutKey,
    oraclePk: hexToBytes(pos.oraclePkHex),
    backupPk: pos.backupPkHex ? hexToBytes(pos.backupPkHex) : undefined,
    voidAfter: BigInt(pos.voidAfter || Number(profile.voidAfter)),
    fallbackDelay: BigInt(pos.fallbackDelay || Number(profile.fallbackDelay)),
    finalExitDelay: BigInt(pos.finalExitDelay || Number(profile.finalExitDelay)),
    readFee: PREDICT_READ_FEE,
    serverKey,
    emulatorKey,
    hrp: profile.hrp,
  }
}

export interface RefreshLivePositionDeps {
  indexer?: Pick<RestIndexerProvider, 'getVtxos' | 'getVirtualTxs'>
  fetchFixing?: typeof fetchOracleFixing
}

interface CoinSpendFlags {
  isSpent?: boolean
  spentBy?: string
  settledBy?: string
  arkTxId?: string
}

function isCoinSpent(coin: CoinSpendFlags): boolean {
  return Boolean(coin.isSpent || coin.spentBy || coin.settledBy || coin.arkTxId)
}

function coinCreatedMs(coin: { createdAt?: Date | number | string }): number {
  if (coin.createdAt instanceof Date) return coin.createdAt.getTime()
  if (typeof coin.createdAt === 'number') return coin.createdAt
  if (typeof coin.createdAt === 'string') {
    const parsed = Number(coin.createdAt)
    return Number.isFinite(parsed) ? parsed : Date.parse(coin.createdAt) || 0
  }
  return 0
}

export async function refreshLivePosition(
  pos: PredictPosition,
  profile: PredictNetworkProfile,
  oracleFixingUrl?: string,
  deps?: RefreshLivePositionDeps,
): Promise<PredictPosition> {
  const indexer = deps?.indexer ?? new RestIndexerProvider(profile.arkUrl)
  const fetchFixing = deps?.fetchFixing ?? fetchOracleFixing
  const holderScript = pkScriptHex(pos.holderAddress)
  const vaultScript = pos.vaultAddress ? pkScriptHex(pos.vaultAddress) : ''

  let intentScript = ''
  if (pos.intentAddress) {
    try {
      intentScript = pkScriptHex(pos.intentAddress)
    } catch {
      intentScript = ''
    }
  }

  let phase: PredictPositionPhase = pos.phase
  let refundable = pos.refundable
  let fundingTxid = pos.fundingTxid
  let fillTxid = pos.fillTxid
  let closeTxid = pos.closeTxid
  let settleTxid = pos.settleTxid
  let settleCents = pos.settleCents
  let userPayoutSats = pos.userPayoutSats
  let deskPayoutSats = pos.deskPayoutSats

  const alreadyFilledOrSettled = pos.phase === 'filled' || pos.phase === 'settled'

  if (intentScript && pos.phase !== 'settled') {
    try {
      const intentPage = await indexer.getVtxos({ scripts: [intentScript] })
      const coins: CoinView[] = (intentPage.vtxos ?? []).map((coin) => ({
        value: BigInt(coin.value),
        spent: isCoinSpent(coin),
        spentBy: coin.arkTxId || coin.spentBy || coin.settledBy || '',
        txid: coin.txid || '',
      }))

      const spentIds = [...new Set(coins.flatMap((c) => (c.spent && c.spentBy ? [c.spentBy] : [])))]
      const spends: Record<string, TxOutput[]> = {}
      if (spentIds.length > 0) {
        const page = await indexer.getVirtualTxs(spentIds)
        const byId = virtualTxsById(page.txs ?? [])
        for (const id of spentIds) {
          const raw = byId.get(id.toLowerCase())
          if (!raw) continue
          try {
            spends[id] = psbtOutputs(raw)
          } catch {
            // ignore non-PSBT checkpoint ids
          }
        }
      }

      const view = classifyPredictIntent({
        coins,
        spends,
        collateral: BigInt(pos.payoutSats),
        stake: BigInt(pos.stakeSats),
        holderScript,
        vaultScript,
        now: Math.floor(Date.now() / 1000),
        deadline: pos.deadline,
      })

      if (!alreadyFilledOrSettled || view.phase === 'filled') {
        phase = view.phase
      }
      refundable = view.refundable
      fundingTxid = view.fundingTxid || fundingTxid
      closeTxid = view.closeTxid || closeTxid
      if (view.phase === 'filled' && view.closeTxid) {
        fillTxid = view.closeTxid
      }
    } catch (err) {
      if (!alreadyFilledOrSettled && !vaultScript) throw err
      // Filled positions and positions with a known vault address still proceed to vault inspection.
    }
  }

  // Check vault vtxos directly too (covers Nostr-replayed filled positions, missing intentAddress, and aged-out intents).
  if (vaultScript && phase !== 'refunded') {
    const vaultPage = await indexer.getVtxos({ scripts: [vaultScript] })
    const vaultVtxos = vaultPage.vtxos ?? []
    const collateral = BigInt(pos.payoutSats)
    const liveVault = vaultVtxos.find(
      (c) => !isCoinSpent(c) && !c.isSwept && !c.isUnrolled && BigInt(c.value) >= collateral,
    )

    if (liveVault) {
      if (phase !== 'settled') phase = 'filled'
      if (!fillTxid) {
        const liveTxid = cleanTxid(liveVault.txid)
        if (liveTxid) fillTxid = liveTxid
      }
    } else {
      const spentVaults = vaultVtxos.filter((c) => isCoinSpent(c)).sort((a, b) => coinCreatedMs(b) - coinCreatedMs(a))
      if (spentVaults.length > 0) {
        phase = 'settled'

        const arkTxIds: string[] = []
        const spentByIds: string[] = []
        const settledByIds: string[] = []
        const seen = new Set<string>()
        const pushUnique = (list: string[], value: string | undefined) => {
          const id = cleanTxid(value)
          if (!id || seen.has(id)) return
          seen.add(id)
          list.push(id)
        }
        for (const coin of spentVaults) pushUnique(arkTxIds, coin.arkTxId)
        for (const coin of spentVaults) pushUnique(spentByIds, coin.spentBy)
        for (const coin of spentVaults) pushUnique(settledByIds, coin.settledBy)

        const virtualIds = [...arkTxIds, ...spentByIds]
        const fallbackTxid = arkTxIds[0] || spentByIds[0] || settledByIds[0] || ''

        let deskScript: string | undefined
        try {
          if (pos.deskPkHex) {
            const serverKey = ArkAddress.decode(pos.holderAddress).serverPubKey
            const exit = BigInt(pos.exit || Number(profile.exit))
            deskScript = bytesToHex(payoutVtxo(hexToBytes(pos.deskPkHex), serverKey, exit).pkScript)
          }
        } catch {
          deskScript = undefined
        }

        let matchedVirtual = false
        if (virtualIds.length > 0) {
          try {
            const txPage = await indexer.getVirtualTxs(virtualIds)
            const byId = virtualTxsById(txPage.txs ?? [])
            for (const txid of virtualIds) {
              const raw = byId.get(txid)
              if (!raw) continue
              let split: { user: bigint; desk: bigint } | null = null
              try {
                split = splitPayouts(psbtOutputs(raw), holderScript, deskScript)
              } catch {
                split = null
              }
              let cents: bigint | null = null
              try {
                const tx = Transaction.fromPSBT(base64.decode(raw))
                cents = predictSettlePriceCents(tx) ?? slotPrice(statePacketOf(tx), BigInt(pos.expiry))
              } catch {
                // refund tx has no settlement witness or state packet
              }
              if (split || cents != null) {
                settleTxid = txid
                if (split) {
                  userPayoutSats = split.user.toString()
                  deskPayoutSats = split.desk.toString()
                }
                if (cents != null) settleCents = cents.toString()
                matchedVirtual = true
                break
              }
            }
          } catch {
            // keep settled phase even if virtual tx fetch fails transiently
          }
        }

        if (!matchedVirtual && fallbackTxid && !settleTxid) {
          settleTxid = fallbackTxid
        }

        if ((!settleCents || userPayoutSats === undefined) && oracleFixingUrl && pos.oraclePkHex) {
          try {
            const fetched = await fetchFixing(oracleFixingUrl, pos.expiry, pos.oraclePkHex)
            if (fetched.fixing) {
              const cents = fetched.fixing.cents
              if (!settleCents) settleCents = cents.toString()
              if (userPayoutSats === undefined) {
                const locked = spentVaults.reduce(
                  (best, coin) => (BigInt(coin.value) > best ? BigInt(coin.value) : best),
                  collateral,
                )
                const gross = holderPayoff(pos.kind, cents, BigInt(pos.strikeCents), collateral)
                const split = settlementOutputs(gross, locked, PREDICT_READ_FEE)
                if (split.mode === 'holder') {
                  userPayoutSats = split.holder.toString()
                  deskPayoutSats = '0'
                } else if (split.mode === 'writer') {
                  userPayoutSats = '0'
                  deskPayoutSats = split.writer.toString()
                } else {
                  userPayoutSats = split.holder.toString()
                  deskPayoutSats = split.writer.toString()
                }
              }
            }
          } catch {
            // keep settled phase even if oracle fixing fetch fails transiently
          }
        }
      }
    }
  }

  return {
    ...pos,
    phase,
    refundable,
    fundingTxid,
    fillTxid,
    closeTxid,
    settleTxid,
    settleCents,
    userPayoutSats,
    deskPayoutSats,
  }
}

export async function cancelLivePredictIntent(
  pos: PredictPosition,
  profile: PredictNetworkProfile,
): Promise<{ txid: string }> {
  const { client, indexer } = await connectPredictClient(profile)
  if (!client.emulatorKey) throw new Error('Emulator key unavailable')
  const terms = termsFromPosition(pos, profile, client.serverKey, client.emulatorKey)
  const bound = bindPredictContracts(terms)
  const intent = client.contract(intentProgram(), bound.intent)
  const page = await indexer.getVtxos({ scripts: [bytesToHex(bound.intentPkScript)], spendableOnly: true })
  const coins = (page.vtxos ?? []).filter((c) => !isCoinSpent(c) && BigInt(c.value) > DUST_SATS)
  if (!coins.length) throw new Error('No refundable coin found on this prediction address')
  let lastTxid = ''
  for (const coin of coins) {
    const sent = await intent.functions
      .cancel()
      .from(coin as never)
      .to(bound.userPkScript, BigInt(coin.value))
      .send()
    lastTxid = sent.txid
  }
  return { txid: lastTxid }
}

export async function settleLivePredictVault(
  pos: PredictPosition,
  profile: PredictNetworkProfile,
  oracleFixingUrl: string,
  pinnedOraclePkHex: string,
): Promise<{ result: string; txid?: string; payoutSats?: bigint; settleCents?: bigint }> {
  if (!oracleKeyMatches(pos.oraclePkHex, pinnedOraclePkHex)) {
    throw new Error('Oracle key mismatch')
  }
  const now = Math.floor(Date.now() / 1000)
  if (now < pos.expiry + Number(VAULT_EXPIRY_LAG)) return { result: 'waiting' }

  const { client, indexer, emulator } = await connectPredictClient(profile)
  if (!client.emulatorKey) throw new Error('Emulator key unavailable')
  const terms = termsFromPosition(pos, profile, client.serverKey, client.emulatorKey)
  const bound = bindPredictContracts(terms)

  const vaultScriptHex = bytesToHex(bound.vaultPkScript)
  const live = await indexer.getVtxos({ scripts: [vaultScriptHex], spendableOnly: true })
  const vaults = (live.vtxos ?? []).filter((c) => !isCoinSpent(c) && BigInt(c.value) >= terms.collateral)
  if (!vaults.length) {
    const hist = await indexer.getVtxos({ scripts: [vaultScriptHex], spentOnly: true })
    const gone = (hist.vtxos ?? [])[0]
    if (gone) return { result: 'settled', txid: cleanTxid(gone.arkTxId || gone.spentBy || gone.settledBy) }
    return { result: 'waiting' }
  }
  const vaultCoin = vaults.find((c) => c.txid === pos.fillTxid) ?? vaults[0]!

  const fetched = await fetchOracleFixing(oracleFixingUrl, pos.expiry, pos.oraclePkHex)
  if (!fetched.fixing) {
    if (fetched.status === 400 || fetched.status === 404) return { result: 'unfixed' }
    throw new Error(fetched.error ?? 'Failed to fetch oracle fixing')
  }
  const fixing = fetched.fixing

  const rawPage = await indexer.getVirtualTxs([vaultCoin.txid])
  const vaultRaw = virtualTxsById(rawPage.txs ?? []).get(vaultCoin.txid.toLowerCase())
  if (!vaultRaw) return { result: 'waiting' }
  const vaultPrev = Transaction.fromPSBT(base64.decode(vaultRaw))

  const payout = settlePayouts({
    kind: terms.kind,
    price: fixing.cents,
    strike: terms.strike,
    collateral: terms.collateral,
    locked: BigInt(vaultCoin.value),
    readFee: PREDICT_READ_FEE,
    holderScript: bound.holderPkScript,
    writerScript: bound.writerPkScript,
  })
  if ('error' in payout) throw new Error(payout.error)

  const vaultScript = new arkade.ArkadeProgramScript(predictVaultProgram(), bound.vault, {
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  })
  const built = buildPredictSettleTx({
    vault: {
      script: vaultScript,
      coin: {
        txid: vaultCoin.txid,
        vout: vaultCoin.vout,
        value: vaultCoin.value,
        prevTx: vaultPrev.toBytes(true, true),
      },
    },
    fixing,
    payouts: payout.payouts,
    checkpoint: client.checkpoint,
  })

  const submitted = await submitCospend(built, emulator as EmulatorProvider)
  const holderHex = bytesToHex(bound.holderPkScript)
  const holderOut = payout.payouts.find((o) => bytesToHex(o.script) === holderHex)
  return {
    result: 'settled',
    txid: submitted.txid,
    payoutSats: holderOut?.amount ?? 0n,
    settleCents: fixing.cents,
  }
}

export async function refundLivePredictVault(
  pos: PredictPosition,
  profile: PredictNetworkProfile,
): Promise<{ result: string; txid?: string }> {
  const now = Math.floor(Date.now() / 1000)
  const voidAfter = pos.voidAfter || Number(PREDICT_VOID_AFTER)
  if (now < pos.expiry + voidAfter) return { result: 'early' }

  const { client, indexer, emulator } = await connectPredictClient(profile)
  if (!client.emulatorKey) throw new Error('Emulator key unavailable')
  const terms = termsFromPosition(pos, profile, client.serverKey, client.emulatorKey)
  const bound = bindPredictContracts(terms)

  const vaultScriptHex = bytesToHex(bound.vaultPkScript)
  const live = await indexer.getVtxos({ scripts: [vaultScriptHex], spendableOnly: true })
  const liveVaults = (live.vtxos ?? []).filter((c) => !isCoinSpent(c) && BigInt(c.value) >= terms.stake)
  if (!liveVaults.length) return { result: 'waiting' }
  const vaultCoin = liveVaults.find((c) => c.txid === pos.fillTxid) ?? liveVaults[0]!

  const rawPage = await indexer.getVirtualTxs([vaultCoin.txid])
  const vaultRaw = virtualTxsById(rawPage.txs ?? []).get(vaultCoin.txid.toLowerCase())
  if (!vaultRaw) return { result: 'waiting' }
  const vaultPrev = Transaction.fromPSBT(base64.decode(vaultRaw))

  const vaultScript = new arkade.ArkadeProgramScript(predictVaultProgram(), bound.vault, {
    serverKey: client.serverKey,
    emulatorKey: client.emulatorKey,
  })
  // Validate outputs before building
  refundOutputs(BigInt(vaultCoin.value), terms.stake, bound.holderPkScript, bound.writerPkScript)
  const built = buildRefundTx({
    vault: {
      script: vaultScript,
      coin: {
        txid: vaultCoin.txid,
        vout: vaultCoin.vout,
        value: vaultCoin.value,
        prevTx: vaultPrev.toBytes(true, true),
      },
    },
    stake: terms.stake,
    holderScript: bound.holderPkScript,
    writerScript: bound.writerPkScript,
    checkpoint: client.checkpoint,
  })
  const submitted = await submitCospend(built, emulator as EmulatorProvider)
  return { result: 'refunded', txid: submitted.txid }
}

export async function reboardLivePredictVault(
  pos: PredictPosition,
  profile: PredictNetworkProfile,
): Promise<{ result: 'reboarded' | 'missing'; commitmentTxid?: string }> {
  const { client, indexer } = await connectPredictClient(profile)
  if (!client.emulatorKey) throw new Error('Emulator key unavailable')
  const terms = termsFromPosition(pos, profile, client.serverKey, client.emulatorKey)
  const bound = bindPredictContracts(terms)
  const contract = client.contract(predictVaultProgram(), bound.vault)
  const page = await indexer.getVtxos({ scripts: [bytesToHex(bound.vaultPkScript)] })
  const coins = (page.vtxos ?? []).filter((c) => !isCoinSpent(c))
  const target = (pos.fillTxid ? coins.find((c) => c.txid === pos.fillTxid) : undefined) ?? coins[0]
  if (!target) return { result: 'missing' }
  const res = await arkade.renewProgramContractOutputs(client, [{ contract, coin: target as never, fn: 'reboard' }])
  return { result: 'reboarded', commitmentTxid: res.commitmentTxid }
}
