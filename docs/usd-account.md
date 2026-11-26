# USD account

The wallet holds dollars as native Circle USDC on Arbitrum One. People see a single USD account: the
chain and the token stay behind it, so another chain can later sit behind the same account without
changing what anyone sees. The only place Arbitrum or USDC is named in the UI is the Receive screen, so
nobody deposits from the wrong network.

## How it works

- **Keys.** The account key is derived from the wallet's own mnemonic and BIP-39 seed (no passphrase, the
  same seed `MnemonicIdentity` reads for Arkade) at the standard Ethereum path `m/44'/60'/0'/0/0`. One
  backup restores both, and any BIP-44 wallet can recover the account from the phrase. The key lives in
  memory only, set on unlock and wiped on lock and reset (`src/lib/usdc/keys.ts`). Wallets restored from
  an nsec have no BIP-32 root, so they get no USD account.
- **Balance and history.** A single `eth_call` to `balanceOf` (`src/lib/usdc/chain.ts`), and a Blockscout
  v2 compatible indexer for the transfer list. The balance never depends on the indexer.
- **Swaps with Arkade.** Satora (`@lendasat/lendaswap-sdk-pure`) in both directions, gasless on each side
  (`src/lib/usdc/satora.ts`). Bitcoin to USD: the wallet funds Satora's VHTLC on Arkade and claims gasless
  into the account. USD to Bitcoin: a Permit2 witness signature funds the swap through Satora's relay and
  the wallet claims on Arkade. `UsdcProvider` resumes every unfinished swap across reloads, claiming once
  Satora has locked its side and refunding when a swap can no longer complete.
- **Sends.** The account's own address is upgraded in place with EIP-7702 to Kernel V3.3 (the one
  delegation Satora also signs for), and each send is one UserOperation through ZeroDev's ERC-20 paymaster
  that approves at most 1 USDC for gas and makes the transfer. Gas is paid in USDC, so there is never any
  ETH to hold (`src/lib/usdc/send.ts`).
- **Swap screen.** USD is an asset in the one Swap screen, next to the Arkade markets. Each pair picks its
  rail (`src/lib/swapRoute.ts`): Bitcoin and USD go through Satora (`src/lib/usdc/route.ts`,
  `useSatoraQuote`), everything else through an Arkade intent market (`useOfferQuote`). Both rails produce
  the same `RouteQuote`, so the composer, review and confirmation are shared, and only quoting and
  execution differ underneath. While the USD account exists it is the only USD offered: any other
  USD-designated asset is left out of the pickers.

The Satora and ZeroDev code paths load in their own chunk, only when the USD screens need them.

## Configuration

All runtime, through the Docker entrypoint like the other `VITE_*` variables.

| Variable                    | Purpose                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| `VITE_USDC_ENABLED`         | `true` turns the account on. Mainnet only, whatever this says.                |
| `VITE_ZERODEV_PROJECT_ID`   | ZeroDev project for the bundler and ERC-20 paymaster. Sends need it.          |
| `VITE_ARBITRUM_RPC_URL`     | Arbitrum One JSON-RPC. Defaults to `https://arb1.arbitrum.io/rpc`.            |
| `VITE_SATORA_API_URL`       | Overrides Satora's API base URL. Defaults to the SDK's.                       |
| `VITE_USDC_HISTORY_URL`     | Blockscout v2 API base. Defaults to `https://arbitrum.blockscout.com/api/v2`. |
| `VITE_USDC_HISTORY_API_KEY` | Bearer key for that indexer, if it asks for one.                              |

The CSP sets no `connect-src`, so none of these origins needs a header change.

## Reset

A wallet reset drops the account's swap records with the rest of localStorage and deletes Satora's
IndexedDB (`lendaswap-v3`), which holds the per-swap secrets.
