import { fromRuntimeEnv, isMainnet } from '../constants'

/**
 * Native Circle USDC on Arbitrum One: the only stablecoin rail this wallet
 * holds outside Arkade. Satora moves value between it and Arkade, and ZeroDev
 * carries plain USDC sends, so the account never needs ETH for gas.
 */
export const ARBITRUM_CHAIN_ID = 42161
export const USDC_ARBITRUM_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
export const USDC_DECIMALS = 6

/**
 * The portfolio row id of the USD account. People see one USD balance; that it
 * is native USDC on Arbitrum is an implementation detail the UI keeps out of
 * sight, so a later chain can sit behind the same account.
 */
export const USD_ACCOUNT_ID = 'usd'

/** Kernel V3.3, the EIP-7702 delegate used for sends and supported by Satora. */
export const KERNEL_V3_3_DELEGATE = '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28'

/** Permissionless Circle Paymaster v0.7 on Arbitrum One (gas paid in USDC via EIP-2612 permit). */
export const CIRCLE_PAYMASTER_V07 = '0x6C973eBe80dCD8660841D4356bf15c32460271C9'

/** Upper bound on what one send permits the paymaster to pull for gas. */
export const PAYMASTER_ALLOWANCE = BigInt(1_000_000) // 1 USDC

const DEFAULT_ARBITRUM_RPC_URL = 'https://arb1.arbitrum.io/rpc'
const DEFAULT_ARBITRUM_BUNDLER_URL = 'https://public.pimlico.io/v2/42161/rpc'
const DEFAULT_EXPLORER_URL = 'https://arbiscan.io'

export interface UsdcConfig {
  rpcUrl: string
  /** ERC-4337 bundler RPC for Arbitrum One sends (defaults to Pimlico's public Arbitrum bundler). */
  bundlerUrl: string
  /** Optional ZeroDev v3 project RPC (also used as bundler fallback if `VITE_ARBITRUM_BUNDLER_URL` is unset). */
  zerodevRpcUrl?: string
  satoraApiUrl?: string
  /** Optional Blockscout v2 compatible indexer; when unset, transfers read from the RPC. */
  historyUrl?: string
  historyApiKey?: string
  explorerUrl: string
}

export const usdcConfig = (): UsdcConfig => {
  const projectId = fromRuntimeEnv(import.meta.env.VITE_ZERODEV_PROJECT_ID)
  const zerodevRpcUrl = projectId ? `https://rpc.zerodev.app/api/v3/${projectId}/chain/${ARBITRUM_CHAIN_ID}` : undefined
  return {
    rpcUrl: fromRuntimeEnv(import.meta.env.VITE_ARBITRUM_RPC_URL) ?? DEFAULT_ARBITRUM_RPC_URL,
    bundlerUrl:
      fromRuntimeEnv(import.meta.env.VITE_ARBITRUM_BUNDLER_URL) ?? zerodevRpcUrl ?? DEFAULT_ARBITRUM_BUNDLER_URL,
    zerodevRpcUrl,
    satoraApiUrl: fromRuntimeEnv(import.meta.env.VITE_SATORA_API_URL),
    historyUrl: fromRuntimeEnv(import.meta.env.VITE_USDC_HISTORY_URL),
    historyApiKey: fromRuntimeEnv(import.meta.env.VITE_USDC_HISTORY_API_KEY),
    explorerUrl: DEFAULT_EXPLORER_URL,
  }
}

/**
 * The account only exists on mainnet (Satora runs no Arkade signet corridor
 * and Arbitrum USDC is real money), only behind the deployment flag, and only
 * for wallets with a mnemonic: an nsec-only wallet has no BIP-32 root to
 * derive the Arbitrum key from.
 */
export const usdcAvailable = (network: string | undefined, walletHasMnemonic: boolean): boolean =>
  fromRuntimeEnv(import.meta.env.VITE_USDC_ENABLED) === 'true' && !!network && isMainnet(network) && walletHasMnemonic

export const explorerTxUrl = (hash: string): string => `${usdcConfig().explorerUrl}/tx/${hash}`
