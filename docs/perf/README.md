# Load-time work

This branch (`perf`, cut from `redesign`) carries the performance changes. It is separate so that `redesign`
stays reviewable on its own. So far everything is in the SDK, reaching the wallet through the pnpm patch
(`patches/@arkade-os__sdk@0.5.6.patch`); wallet-side changes come next.

## What the SDK patch adds here

On `redesign` the patch holds two correctness fixes (see `docs/redesign/README.md`). On this branch it also
holds four performance changes. Each is a commit with tests in the SDK fork.

| Change | SDK branch and commit |
| --- | --- |
| No 500 ms pause between pages of coins | `perf/coin-sync`, `683146e8` |
| The settlement poll's first look reuses a sync up to 30 s old; what it selects is still re-read before it is settled | `perf/coin-sync`, `683146e8` |
| Pages of coins after the first are read four at a time | `perf/coin-sync`, `005c9e13` |
| The worker reads operator info through the SDK's caching provider (60 s, replaced at once on a change) | `perf/server-info-once`, `637606e1` |

`requireLive` reads of operator info can now be answered from that 60 s memo. That is how a wallet built on
the caching provider already behaves on the main thread, and the swap package uses `requireLive` before it
binds operator info into a covenant, so it is the one change here to weigh before merging anywhere.

## Measured

Test network, production build, Pixel 7 profile, fast machine. Fixture wallets: light (21 payments), typical
(200), heavy (506). "Before" is `redesign` with the paging fix, which is what makes the wallet read every coin.

| | Before | This branch |
| --- | --- | --- |
| Fresh sync of the heavy wallet, SDK alone (Node) | 10.4 to 11.5 s | 2.1 s |
| Heavy: restore to Home | 12.9 s | 7.1 to 7.7 s |
| Heavy: returning visit, settled balance | 4.4 to 4.8 s | 2.1 to 2.8 s |
| Typical: restore to Home | 7.2 s | 4.7 to 5.7 s |
| Typical: returning visit, settled balance | 3.4 to 4.0 s | 2.1 to 2.4 s |
| Returning visit to Home, any fixture | 1.5 to 2.5 s | 1.4 to 2.5 s |

Read the ranges as they are: the same build varies by about half a second from run to run, so differences
smaller than that are not shown as gains. Operator info caching halves the `/v1/info` requests on a returning
visit (four to two) and did not move a timing on the test network, where the request takes about 60 ms.

Two things these numbers say about what is left. Time to Home on a returning visit did not move, because by
then the coin sync is a small part of it: the rest is the page and worker starting up and the wallet waiting
for its first reads. A restore takes about 4.6 s even for the light wallet, so most of what remains there is
the restore flow itself, not history.

The fixtures were all built on one day. A returning visit re-reads the last 24 hours of coins, which for them
is everything, so returning-visit figures are a worst case for a wallet with older history.

## Not done yet

- SDK: restore reads the full history twice (at boot, then after the address scan); the signer-migration
  pass syncs again on servers that advertise deprecated signers.
- Wallet: show Home from stored state before the network answers; remove the second reload a second after
  boot; split the 2.8 MB bundle.

The plan, the raw results and the tools are in `.verify/perf/` (git-ignored).
