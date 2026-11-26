import {
  mockAspContextValue,
  mockConfigContextValue,
  mockFiatContextValue,
  mockFlowContextValue,
  mockLimitsContextValue,
  mockSvcWallet,
  mockTxId,
  mockWalletContextValue,
} from '../test/screens/mocks'
import { MUTINYNET_USDT_ASSET_ID } from '../lib/accountAssets'
import { Currencies, Themes, Unit } from '../lib/types'
import { SwapsContext } from '../providers/swaps'
import { btcUsdt } from '../test/lib/swapFixtures'

const BTC_PRICE = 120_000
const OFFCHAIN =
  'tark1qr340xg400jtxat9hdd0ungyu6s05zjtdf85uj9smyzxshf98ndah6u2nd5ac7lsqhsqxq84kgxzs7rj8vsp4ktjhny6chy9j6dr0q9qdmc7e3'
const BOARDING = 'tb1pq6gt72nxevsxk5fwl3h2sx56jeah6qfzh98mksxyakkg5l0q65gs7dp0x9'
const now = Math.floor(Date.now() / 1000)

const txs = [
  {
    amount: 21021,
    boardingTxid: '',
    redeemTxid: mockTxId,
    roundTxid: '',
    createdAt: now - 60 * 60 * 3,
    explorable: mockTxId,
    preconfirmed: false,
    settled: true,
    type: 'sent',
    lnurl: { address: 'maya@example.com', rail: 'arkade' },
    historyKey: 'tx-1',
  },
  {
    amount: 25000,
    boardingTxid: '',
    redeemTxid: mockTxId.replace('5', '6'),
    roundTxid: '',
    createdAt: now - 60 * 60 * 15,
    explorable: mockTxId,
    preconfirmed: false,
    settled: true,
    type: 'received',
    historyKey: 'tx-2',
  },
  {
    amount: 5000,
    boardingTxid: mockTxId.replace('5', '7'),
    redeemTxid: '',
    roundTxid: '',
    createdAt: now - 60 * 60 * 30,
    explorable: mockTxId,
    preconfirmed: true,
    settled: false,
    type: 'received',
    historyKey: 'tx-3',
  },
  {
    amount: 120000,
    boardingTxid: '',
    redeemTxid: mockTxId.replace('5', '8'),
    roundTxid: '',
    createdAt: now - 60 * 60 * 52,
    explorable: mockTxId,
    preconfirmed: false,
    settled: true,
    type: 'sent',
    historyKey: 'tx-4',
  },
]

// `?state=history-5000` (any count): a long history, for checking that nothing scales with it.
const longHistory = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    ...txs[i % txs.length],
    redeemTxid: `${mockTxId.slice(0, -8)}${i.toString(16).padStart(8, '0')}`,
    boardingTxid: '',
    preconfirmed: false,
    settled: true,
    createdAt: now - 60 * 60 * (3 + i * 7),
    historyKey: `history-${i}`,
  }))

// `?state=usd`: the USD account (lib/usdc), holding USDC beside the Arkade USDT it folds in.
const USD_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'
const usdcFixture = (enabled: boolean) => {
  const now = Date.now()
  return {
    available: enabled,
    session: enabled ? { address: USD_ADDRESS, privateKey: new Uint8Array(32), rootXprv: '' } : undefined,
    address: enabled ? USD_ADDRESS : undefined,
    balance: enabled ? BigInt(125_400_000) : undefined,
    transfers: enabled
      ? [
          {
            hash: '0x01',
            from: '0x1111111111111111111111111111111111111111',
            to: USD_ADDRESS.toLowerCase(),
            amount: BigInt(50_000_000),
            timestamp: now - 26 * 3_600_000,
            direction: 'in' as const,
          },
          {
            hash: '0x02',
            from: USD_ADDRESS.toLowerCase(),
            to: '0x2222222222222222222222222222222222222222',
            amount: BigInt(12_000_000),
            timestamp: now - 50 * 3_600_000,
            direction: 'out' as const,
          },
        ]
      : [],
    swaps: enabled
      ? [
          {
            id: 'preview-swap-1',
            direction: 'toUsdc' as const,
            createdAt: now - 2 * 3_600_000,
            updatedAt: now,
            sourceAmount: '100000',
            targetAmount: '87400000',
            status: 'clientredeemed',
            arkAddress: '',
            funded: true,
          },
          {
            id: 'preview-swap-2',
            direction: 'toArkade' as const,
            createdAt: now - 10 * 60_000,
            updatedAt: now,
            sourceAmount: '20000000',
            targetAmount: '22600',
            status: 'clientfunded',
            arkAddress: '',
            funded: true,
          },
        ]
      : [],
    refresh: () => Promise.resolve(),
    recordSwap: () => {},
  }
}

export function buildFixtures(theme: Themes, variant: string) {
  const usd = variant === 'usd'
  const empty = variant === 'empty'
  const historyCount = Number(/^history-(\d+)$/.exec(variant)?.[1] ?? 0)
  const history = historyCount ? longHistory(historyCount) : txs
  const balance = empty ? 0 : 3_512_500
  const fiat = {
    ...mockFiatContextValue,
    toFiat: (sats = 0) => (sats * BTC_PRICE) / 1e8,
    fromFiat: (value = 0) => Math.round((value * 1e8) / BTC_PRICE),
    toFiatAmount: (amount: number) => (amount * BTC_PRICE) / 1e8,
    fromFiatAmount: (amount: number) => Math.round((amount * 1e8) / BTC_PRICE),
    fiatDecimals: () => 2,
  }
  return {
    asp: { ...mockAspContextValue, aspInfo: { ...mockAspContextValue.aspInfo, network: 'mutinynet' } },
    assets: { isRegistered: (assetId: string) => assetId === MUTINYNET_USDT_ASSET_ID },
    config: {
      ...mockConfigContextValue,
      config: {
        ...mockConfigContextValue.config,
        // state=btc: a Bitcoin-only wallet set to BTC, whose amounts are the longest the UI shows.
        currency: variant === 'btc' ? Currencies.BTC : Currencies.USD,
        unit: variant === 'btc' ? Unit.BTC : Unit.SATS,
        theme,
        showBalance: variant !== 'hidden',
      },
      effectiveTheme: theme,
      systemTheme: theme,
    },
    fiat,
    flow: {
      ...mockFlowContextValue,
      txInfo: txs[0],
      sendInfo: {
        ...mockFlowContextValue.sendInfo,
        arkAddress: OFFCHAIN,
        recipient: OFFCHAIN,
        satoshis: variant === 'btc' ? 10_000 : 21000,
        total: variant === 'btc' ? 10_021 : 21021,
      },
      recvInfo: {
        ...mockFlowContextValue.recvInfo,
        satoshis: 25000,
        boardingAddr: 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
        offchainAddr:
          'ark1qq4hfssprtcgnjzf8qlw2f78yvjau5kldfugg29k34y7j96q2w4t567uy9ukgfl2ntulzvlzj7swsprfs4wy4h47m7z48khygt7qsyazckttpz',
      },
    },
    limits: mockLimitsContextValue,
    usdc: usdcFixture(usd),
    swaps: {
      ...((SwapsContext as any)._currentValue ?? {}),
      swapAvailable: true,
      swaps: [],
      // one registry market, so Swap can be composed and reviewed; its quote reads the market's price feed
      markets: [btcUsdt],
      exchange: () => Promise.resolve({}),
    },
    wallet: {
      ...mockWalletContextValue,
      walletLoaded: true,
      dataReady: true,
      svcWallet: {
        ...mockSvcWallet,
        getAddress: () => Promise.resolve(OFFCHAIN),
        getBoardingAddress: () => Promise.resolve(BOARDING),
      },
      wallet: { ...mockWalletContextValue.wallet, pubkey: '02'.padEnd(66, 'a') },
      balance,
      availableBalance: balance,
      txs: empty ? [] : history,
      ungroupedTxs: empty ? [] : history,
      isVerifiedAsset: (assetId: string) => assetId === MUTINYNET_USDT_ASSET_ID,
      assetBalances: empty ? [] : [{ assetId: MUTINYNET_USDT_ASSET_ID, amount: BigInt(17_000) }],
      availableAssetBalances: empty ? [] : [{ assetId: MUTINYNET_USDT_ASSET_ID, amount: BigInt(17_000) }],
      assetMetadataCache: new Map([
        [MUTINYNET_USDT_ASSET_ID, { metadata: { decimals: 2, name: 'Tether USD', ticker: 'USDT' } }],
      ]),
    },
  }
}
