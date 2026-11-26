import { networks, type Network, type NetworkName } from '@arkade-os/sdk'
import { fromRuntimeEnv } from '../constants'

export const PAIR = 'arkade:BTC->arkade:BTC-OPTION'
export const RFQ_KIND = 24859
export const POSITION_KIND = 30078
export const POSITION_TAG = 'arkade-option'
export const PREDICT_VAULT_PROGRAM_ID = 'PredictVaultV3'

export const DUST_SATS = 330n
export const PREDICT_READ_FEE = 0n
export const QUOTE_TTL_S = 30
export const PRICE_MAX = 1_000_000_000n
export const VAULT_EXPIRY_LAG = 60n

export const DEFAULT_RELAYS = ['wss://nostr.arkade.sh']

export type PredictKind = 2 | 3 // 2 = Higher, 3 = Lower

export const PREDICT_GRID_S = 300
export const PREDICT_LOCK_S = 60
export const PREDICT_MIN_LEFT_S = 60
export const PREDICT_MAX_AHEAD_S = 3600
export const STAKE_MIN = 25_000n
export const STAKE_MAX_MUTINYNET = 1_000_000n
export const STAKE_MAX_MAINNET = 100_000n
export const Q_MAX_MUTINYNET = 1_000_000_000n
export const Q_MAX_MAINNET = 50_000_000n

export const PREDICT_EDGE = 0.05
export const MULTIPLIER_MIN = 1.05
export const MULTIPLIER_MAX = 10
export const PREDICT_VOID_AFTER = 86_400n

export const MUTINYNET_EXIT = 2048n
export const MUTINYNET_FALLBACK_DELAY = 22_016n
export const MUTINYNET_FINAL_EXIT_DELAY = 108_032n

export const MAINNET_EXIT = 605_184n
export const MAINNET_FALLBACK_DELAY = 605_184n
export const MAINNET_FINAL_EXIT_DELAY = 691_200n

export type PredictNetworkId = 'bitcoin' | 'mutinynet' | 'regtest' | 'testnet' | 'signet'

export interface PredictNetworkProfile {
  id: PredictNetworkId
  label: string
  isMainnet: boolean
  network: Network
  hrp: string
  arkUrl: string
  emulatorUrl: string
  executorUrl: string
  exit: bigint
  voidAfter: bigint
  fallbackDelay: bigint
  finalExitDelay: bigint
  qMax: bigint
  stakeMin: bigint
  stakeMax: bigint
}

export interface PredictDeskConfig {
  name: string
  pubkey: string
}

export interface PredictConfig {
  enabled: boolean
  demoMode: boolean
  profile: PredictNetworkProfile
  relays: string[]
  desks: PredictDeskConfig[]
  backupPubkey: string | null
  oraclePubkey: string
  oraclePricesUrl: string
  oracleFixingUrl: string
}

const PROFILES: Record<PredictNetworkId, PredictNetworkProfile> = {
  bitcoin: {
    id: 'bitcoin',
    label: 'Bitcoin',
    isMainnet: true,
    network: networks.bitcoin,
    hrp: networks.bitcoin.hrp,
    arkUrl: 'https://arkade.computer',
    emulatorUrl: 'https://emulator.arkade.computer',
    executorUrl: 'https://executor.arkade.sh',
    exit: MAINNET_EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: MAINNET_FALLBACK_DELAY,
    finalExitDelay: MAINNET_FINAL_EXIT_DELAY,
    qMax: Q_MAX_MAINNET,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX_MAINNET,
  },
  mutinynet: {
    id: 'mutinynet',
    label: 'Mutinynet',
    isMainnet: false,
    network: networks.mutinynet,
    hrp: networks.mutinynet.hrp,
    arkUrl: 'https://mutinynet.arkade.sh',
    emulatorUrl: 'https://emulator.mutinynet.arkade.sh',
    executorUrl: 'https://executor.mutinynet.arkade.sh',
    exit: MUTINYNET_EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: MUTINYNET_FALLBACK_DELAY,
    finalExitDelay: MUTINYNET_FINAL_EXIT_DELAY,
    qMax: Q_MAX_MUTINYNET,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX_MUTINYNET,
  },
  regtest: {
    id: 'regtest',
    label: 'Regtest',
    isMainnet: false,
    network: networks.regtest,
    hrp: networks.regtest.hrp,
    arkUrl: 'http://127.0.0.1:7070',
    emulatorUrl: 'http://127.0.0.1:7073',
    executorUrl: '',
    exit: MUTINYNET_EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: MUTINYNET_FALLBACK_DELAY,
    finalExitDelay: MUTINYNET_FINAL_EXIT_DELAY,
    qMax: Q_MAX_MUTINYNET,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX_MUTINYNET,
  },
  testnet: {
    id: 'testnet',
    label: 'Testnet',
    isMainnet: false,
    network: networks.testnet,
    hrp: networks.testnet.hrp,
    arkUrl: 'https://mutinynet.arkade.sh',
    emulatorUrl: 'https://emulator.mutinynet.arkade.sh',
    executorUrl: 'https://executor.mutinynet.arkade.sh',
    exit: MUTINYNET_EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: MUTINYNET_FALLBACK_DELAY,
    finalExitDelay: MUTINYNET_FINAL_EXIT_DELAY,
    qMax: Q_MAX_MUTINYNET,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX_MUTINYNET,
  },
  signet: {
    id: 'signet',
    label: 'Signet',
    isMainnet: false,
    network: networks.signet,
    hrp: networks.signet.hrp,
    arkUrl: 'https://mutinynet.arkade.sh',
    emulatorUrl: 'https://emulator.mutinynet.arkade.sh',
    executorUrl: 'https://executor.mutinynet.arkade.sh',
    exit: MUTINYNET_EXIT,
    voidAfter: PREDICT_VOID_AFTER,
    fallbackDelay: MUTINYNET_FALLBACK_DELAY,
    finalExitDelay: MUTINYNET_FINAL_EXIT_DELAY,
    qMax: Q_MAX_MUTINYNET,
    stakeMin: STAKE_MIN,
    stakeMax: STAKE_MAX_MUTINYNET,
  },
}

// Live Bitcoin mainnet COINFLIP production pins (verified from coinflip-mainnet-production.up.railway.app).
export const MAINNET_DESK: PredictDeskConfig = {
  name: 'COINFLIP',
  pubkey: '5e38115019ef7f12437ac8c9aa92205ed937c7c737e9d1c2100fffe104c34ed3',
}

export const MAINNET_BACKUP_PUBKEY = '0d81ac7eff0c1d6263ee37ee8e7e966f5a23b6ab4be34184b568e69c140f27c5'

export const MAINNET_ORACLE_PUBKEY = '8fe6e977203e72ed451ac868119134793fb319757e9f902f16ab778d0241bde4'

export const MUTINYNET_DESK: PredictDeskConfig = {
  name: 'Mutinynet',
  pubkey: 'eb36be79b231beeecbea9609767139974137d1f5dbaab56f19396bda3f07edc9',
}

export const MUTINYNET_ORACLE_PUBKEY = 'e96d459a88359d713db09e7b226644b84765ac33b0b84f4cb60bc9d39ffb5bbe'

export function normalizePredictNetwork(name?: NetworkName | string | null): PredictNetworkId {
  const clean = name?.trim().toLowerCase() ?? ''
  if (clean === 'mainnet' || clean === 'bitcoin' || clean === '') return 'bitcoin'
  if (clean === 'mutinynet') return 'mutinynet'
  if (clean === 'regtest') return 'regtest'
  if (clean === 'testnet') return 'testnet'
  if (clean === 'signet') return 'signet'
  return 'bitcoin'
}

export function getPredictNetworkProfile(name?: NetworkName | string | null): PredictNetworkProfile {
  return PROFILES[normalizePredictNetwork(name)]
}

const HEX64 = /^[0-9a-f]{64}$/

export function getPredictConfig(network?: NetworkName | string | null, arkServerUrl?: string): PredictConfig {
  const baseProfile = getPredictNetworkProfile(network)
  const demoMode = fromRuntimeEnv(import.meta.env.VITE_PREDICT_DEMO) === 'true'
  const envDeskPubkey = fromRuntimeEnv(import.meta.env.VITE_PREDICT_DESK_PUBKEY)
    ?.trim()
    .toLowerCase()
  const envDeskName = fromRuntimeEnv(import.meta.env.VITE_PREDICT_DESK_NAME)?.trim()
  const envBackup = fromRuntimeEnv(import.meta.env.VITE_PREDICT_BACKUP_PUBKEY)
    ?.trim()
    .toLowerCase()
  const envRelays = fromRuntimeEnv(import.meta.env.VITE_PREDICT_RELAYS)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const envEmulatorUrl = fromRuntimeEnv(import.meta.env.VITE_PREDICT_EMULATOR_URL)
  const envExecutorUrl = fromRuntimeEnv(import.meta.env.VITE_PREDICT_EXECUTOR_URL)
  const envOracleUrl = fromRuntimeEnv(import.meta.env.VITE_PREDICT_ORACLE_URL)
  const envOracleFixingUrl = fromRuntimeEnv(import.meta.env.VITE_PREDICT_ORACLE_FIXING_URL)
  const envOraclePubkey = fromRuntimeEnv(import.meta.env.VITE_PREDICT_ORACLE_PUBKEY)
    ?.trim()
    .toLowerCase()

  const defaultDesk = baseProfile.isMainnet ? MAINNET_DESK : MUTINYNET_DESK
  const desk: PredictDeskConfig =
    envDeskPubkey && HEX64.test(envDeskPubkey)
      ? { name: envDeskName || defaultDesk.name, pubkey: envDeskPubkey }
      : { name: envDeskName || defaultDesk.name, pubkey: defaultDesk.pubkey }

  const backupPubkey =
    envBackup && HEX64.test(envBackup) ? envBackup : baseProfile.isMainnet ? MAINNET_BACKUP_PUBKEY : null

  const oraclePubkey =
    envOraclePubkey && HEX64.test(envOraclePubkey)
      ? envOraclePubkey
      : baseProfile.isMainnet
        ? MAINNET_ORACLE_PUBKEY
        : MUTINYNET_ORACLE_PUBKEY

  const oraclePricesUrl = envOracleUrl || '/predict-api/oracle/prices'
  const oracleFixingUrl =
    envOracleFixingUrl ||
    (envOracleUrl && envOracleUrl.endsWith('/prices')
      ? `${envOracleUrl.slice(0, -'/prices'.length)}/fixing`
      : '/predict-api/oracle/fixing')

  const profile: PredictNetworkProfile = {
    ...baseProfile,
    arkUrl: arkServerUrl || baseProfile.arkUrl,
    emulatorUrl: envEmulatorUrl || baseProfile.emulatorUrl,
    executorUrl: envExecutorUrl ?? baseProfile.executorUrl,
  }

  return {
    enabled: profile.id === 'bitcoin' || profile.id === 'mutinynet' || demoMode,
    demoMode,
    profile,
    relays: envRelays && envRelays.length > 0 ? envRelays : DEFAULT_RELAYS,
    desks: [desk],
    backupPubkey,
    oraclePubkey,
    oraclePricesUrl,
    oracleFixingUrl,
  }
}
