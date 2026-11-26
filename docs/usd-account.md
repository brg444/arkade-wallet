# USD account

The wallet holds dollars as native Circle USDC on Arbitrum One. People see a single USD account: the
chain and the token stay behind it, so another chain can later sit behind the same account without
changing what anyone sees. Arbitrum and USDC only surface on Receive (so nobody deposits from the wrong
network) and in the USD account breakdown when dollars sit on both Arkade and Arbitrum.

## How it works

- **Keys.** The account key is derived from the wallet's own mnemonic and BIP-39 seed (no passphrase, the
  same seed `MnemonicIdentity` reads for Arkade) at the standard Ethereum path `m/44'/60'/0'/0/0`. One
  backup restores both, and any BIP-44 wallet can recover the account from the phrase. The key lives in
  memory only, set on unlock and wiped on lock and reset (`src/lib/usdc/keys.ts`). Wallets restored from
  an nsec have no BIP-32 root, so they get no USD account.
- **Balance and history.** A single `eth_call` to `balanceOf` (`src/lib/usdc/chain.ts`), and recent USDC
  `Transfer` logs read from the Arbitrum RPC (or an optional Blockscout v2 compatible indexer when
  `VITE_USDC_HISTORY_URL` is configured, falling back to RPC logs on error). The balance never depends on
  history.
- **Swaps with Arkade.** Satora (`@lendasat/lendaswap-sdk-pure`) in both directions, gasless on each side
  (`src/lib/usdc/satora.ts`). Bitcoin to USD: the wallet funds Satora's VHTLC on Arkade and claims gasless
  into the account. USD to Bitcoin: a Permit2 witness signature funds the swap through Satora's relay and
  the wallet claims on Arkade. `UsdcProvider` resumes every unfinished swap across reloads, claiming once
  Satora has locked its side and refunding when a swap can no longer complete.
- **Sends.** The account's own address is upgraded in place with EIP-7702 to Kernel V3.3 (the one
  delegation Satora also signs for), and each send is one EntryPoint v0.7 UserOperation paid through
  Circle's permissionless USDC Paymaster v0.7 (`0x6C973eBe80dCD8660841D4356bf15c32460271C9`) via an
  EIP-2612 permit bounded to 1 USDC. Circle fronts the ETH gas and refunds any unused USDC in `postOp`,
  so there is never any ETH to hold and no paid paymaster API key is required (`src/lib/usdc/send.ts`).
- **One USD.** A USD-designated asset on Arkade folds into the same account: Home shows one USD row with
  the combined balance, and the account screen breaks it down by where it sits (Arkade, Arbitrum). The
  Arkade share opens its own account screen, where it sends, receives and swaps natively.
- **Swap screen.** USD is an asset in the one Swap screen, next to the Arkade markets. Each pair picks its
  rail (`src/lib/swapRoute.ts`): Bitcoin and USD go through Satora (`src/lib/usdc/route.ts`,
  `useSatoraQuote`), everything else through an Arkade intent market (`useOfferQuote`). Both rails produce
  the same `RouteQuote`, so the composer, review and confirmation are shared, and only quoting and
  execution differ underneath (`resolveSwapRoute`). The pickers show one USD. Selling USD spends Arkade
  dollars through their market when they cover the amount, and otherwise the USDC through Satora; buying
  USD with Bitcoin lands as USDC, Arbitrum being the default chain. A swap never splits across the two,
  so Max is the larger of the two balances.

The Satora and ZeroDev code paths load in their own chunk, only when the USD screens need them.

## Fund safety

- **Before funding.** Creating a swap prices it afresh, so the created swap is checked against the reviewed
  quote first: it must ask for exactly the reviewed amount and pay out no less than the reviewed figure,
  within 1%. Otherwise nothing is sent and the composer asks for a fresh review.
- **Around funding.** The record is saved, marked as attempting funding, before the funding call goes out,
  and the resume loop is held off it until the call returns. `funded` only ever moves forward when two
  writers save the same record. A funding call that fails where the wallet cannot tell whether it landed
  closes the review and points at the USD activity, and Confirm is never offered a second time for it.
- **After funding.** A swap that only attempted funding is still refunded when it cannot complete, for a
  bounded number of tries spaced over more than a day, and Satora's own record of the funding transaction
  counts even on a swap it has expired. Claim and Arkade-refund results are checked for `{ success: false }`
  so a rejected attempt never marks an unfunded swap funded. A USD to Bitcoin swap is refunded with Satora's
  co-signature, and once the HTLC's timelock has passed, via a sponsored UserOp from this key if Satora will
  not co-sign (using Satora's refund calldata checked client-side and Satora's default AA paymaster). Its
  refund is Satora's lock token, so the swap stays pending until that token has been swapped on to Arkade:
  the need is recorded before the refund goes out and retried for a day from when the refund lands. The
  continuation is indexed, with placeholder amounts until its terms are read, before the refunded swap is
  closed. On every unlock, pending or not, the index is checked against Satora's own store (read natively
  via `indexedDB.databases()`, so the Satora chunk only loads when there is a gap or the browser cannot list
  databases) under the same swap-driver lock, deferring while a swap is being created, and any swap it lacks
  is adopted without overwriting existing records. A swap created on moved terms is deleted from Satora's
  store, since it was never funded.
- **Sends.** Scanned codes are parsed as EIP-681: the payee comes from the `address` parameter of a USDC
  payment request, never the token contract, and a code naming another chain or token is refused. The
  USDC contract and the zero address are never accepted as recipients. A send is only offered once its
  fee is quoted, fits the balance and fits the 1 USDC paymaster approval. If confirmation fails or times
  out after the bundler has accepted the UserOperation, Send closes and points at USD activity instead of
  offering a second Send tap.
- **One driver.** One tab drives swaps and reconcile at a time (`navigator.locks`); the others follow
  through storage.

## Configuration

All runtime, through the Docker entrypoint like the other `VITE_*` variables.

| Variable                    | Purpose                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `VITE_USDC_ENABLED`         | `true` turns the account on. Mainnet only, whatever this says.                        |
| `VITE_ARBITRUM_RPC_URL`     | Arbitrum One JSON-RPC. Defaults to `https://arb1.arbitrum.io/rpc`.                    |
| `VITE_ARBITRUM_BUNDLER_URL` | ERC-4337 bundler RPC for sends. Defaults to `https://public.pimlico.io/v2/42161/rpc`. |
| `VITE_ZERODEV_PROJECT_ID`   | Optional ZeroDev v3 project id used as bundler fallback if bundler URL is unset.      |
| `VITE_SATORA_API_URL`       | Overrides Satora's API base URL. Defaults to the SDK's.                               |
| `VITE_USDC_HISTORY_URL`     | Optional Blockscout v2 API base. When unset, reads `Transfer` logs from RPC.          |
| `VITE_USDC_HISTORY_API_KEY` | Bearer key for that indexer, if it asks for one.                                      |

The CSP sets no `connect-src`, so none of these origins needs a header change.

## Reset

Locking drops the key and the Satora client built from the wallet root; failed unlocks never retain a USD
session, locking while the Satora chunk loads does not cache a client, and in-flight balance or history
reads drop their results after lock or reset. A reset also empties Satora's stores through the client's own
handles, deletes its IndexedDB (`lendaswap-v3`, the per-swap secrets), and drops the account's swap records
with the rest of localStorage. A resume pass still awaiting Satora when the reset runs aborts before any
irreversible step and writes nothing back afterwards.
