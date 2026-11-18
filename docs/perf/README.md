# Load-time work

This branch (`perf`, cut from `redesign`) carries the performance changes. It is separate so that `redesign`
stays reviewable on its own. So far everything is in the SDK, reaching the wallet through the pnpm patch
(`patches/@arkade-os__sdk@0.5.6.patch`); wallet-side changes come next.

The plan was reviewed by Codex on 2026-11-18. This revision follows that review: two changes came out, one
changed shape, and every figure below is restated with all of its samples.

## What the SDK patch holds here

On `redesign` the patch holds two correctness fixes (see `docs/redesign/README.md`). On this branch it holds
those plus the changes below. Each is a commit with tests in the SDK fork; the patch is a hand port of them
onto the 0.5.6 build, ESM and CJS, written by `patch-sdk3.py` in `.verify/perf/tools/`.

| Change | Kind | SDK branch and commit |
| --- | --- | --- |
| A paged read whose answer contradicts itself (more is said to follow, and the page is empty or the cursor has not moved) fails instead of returning what it has | Fix | `fix/vtxo-paging-clamped-page`, `8baf4fdc` |
| Exit data is asked for 50 transactions to a request and asked again by name for anything left out; a full exit capture records nothing until it has every transaction | Fix | `fix/vtxo-paging-clamped-page`, `e5b9b1e1` |
| No 500 ms pause between pages of coins | Performance | `perf/coin-sync`, `683146e8` |
| The check for coins under a deprecated signer reads only the contracts under such a signer | Performance | `perf/coin-sync`, `1d8304ff` |

The wallet does not capture or estimate exits today, so the second row changes nothing it does; it is carried
so that the patch and the SDK branch say the same thing.

Three changes that were here are not any more.

| Change | Where it is now | Why |
| --- | --- | --- |
| Pages of coins read four at a time | `perf/coin-page-fanout` | The server answers each page with its own query over a set that can change between requests. More reads at once on top of that is the wrong direction until it offers a stable cursor. |
| The settlement poll's first look reuses the boot sync | `perf/poll-first-look` | It made nothing faster, and the builds that carried it stalled more often (figures below). |
| Operator info memoised for 60 s in the worker | `perf/server-info-once` | `requireLive` reads could be answered from the memo, and no timing moved. |

## Measured

Test network, production build, Pixel 7 profile, fast machine, 2026-11-18. Two fixture wallets: typical (200
payments, 97 coins) and heavy (506 payments, 220 coins). Five builds of this branch that differ only in the
SDK patch were run in turn, round after round, so that drift in the network or the test server falls on all
of them alike. Each run is one restore followed by five or eight returning visits.

"Home on screen" and "syncing line gone" are read by a `MutationObserver` on the page's own clock. Playwright's
own waits re-check every 500 ms and round a time up by as much, which is where the half-second steps in the
earlier figures came from. Figures are the median with the full range; nothing is dropped.

**Heavy wallet, returning visit**

| Build | Visits | Home on screen | Syncing line gone | Coin requests |
| --- | --- | --- | --- | --- |
| Paging fix only (`redesign`) | 34 | 2.21 s (1.75 to 14.35) | 4.94 s (4.30 to 16.55) | 19 |
| Plus no pause | 34 | 2.41 s (1.95 to 7.40) | 2.72 s (2.33 to 11.14) | 19 |
| Plus no pause and the narrowed signer check (this branch) | 24 | 2.46 s (1.84 to 5.51) | 2.91 s (2.26 to 17.86) | 14 |
| Plus no pause and the first-look reuse | 26 | 2.40 s (2.02 to 5.70) | 2.72 s (2.31 to 7.88) | 13 |
| All three | 26 | 2.45 s (1.93 to 12.37) | 2.72 s (2.31 to 12.43) | 8 |

**Heavy wallet, restore to Home**, every run: paging fix only 12.7, 13.2, 12.9, 14.6, 14.2 s. No pause 8.3,
8.2, 9.7, 8.3, 9.8 s. This branch 7.7, 8.7, 8.3 s. With the first-look reuse 17.7, 9.3, 9.7, 16.4 s, and with
all three 7.7, 8.3, 8.7, 20.8 s.

**Typical wallet.** A returning visit is the same in every build: Home on screen at 1.8 to 1.9 s and the
syncing line gone at about 2.5 s, over 5 to 15 visits each. Its coins fit one page, so there was no pause to
remove. Restore to Home: paging fix only 9.8 and 8.2 s; no pause 7.2, 5.7 and 7.7 s; this branch 5.7 s.

What these say:

- Removing the pause is the change that moves time. On the heavy wallet the syncing line goes about 2.2 s
  sooner and a restore is about 5 s shorter.
- It costs about 0.2 s on the heavy wallet's time to Home. The worker now reads its pages back to back, and
  it is busy when the page asks for its first data.
- The narrowed signer check and the first-look reuse save requests and no time. The narrowed check also
  drops one full sync from every poll, once a minute while the wallet is open.
- The first-look reuse is out because of stalls. Counting every restore and visit of the heavy wallet, a run
  sat for more than 2.5 s with no request in flight in 9 of 60 with the reuse and 1 of 105 without. The cause
  is not found.
- In all 194 returning visits the balance Home first showed was already the final figure. Home shows stored
  state; what follows is the syncing line going away.

Two things outside the wallet's control showed up as the slowest visits. A `/v1/info` answer that took 5.3 s
put Home at 7.4 s, and a `/v1/delegator/info` answer that took 12.3 s put it at 14.4 s. Home waits on both.

Two of 33 runs never reached the restore: on a first visit the Restore choice could not be clicked within
30 seconds. The harness keeps no trace of a run that fails that early, so the cause is not known yet.

The fixtures were all built on one day. A returning visit re-reads the last 24 hours of coins, which for them
is everything, so these returning-visit figures say nothing about a wallet whose history is older, in either
direction.

## Checked by hand

The port is not what the SDK's tests run against, so the patched package was read against the test network
after install: `compare.mjs heavy` and `compare.mjs typical` (every spendable coin the indexer lists, none
missing: 220 coins and 89,039 sats, 97 coins and 148,000 sats) and `exit-data.mjs heavy` (a chain of 1,406
entries, all 1,010 transactions back in 21 requests, the longest URL 3.3 KB).

## Not done yet

- Wallet: Home waits for the page's `/v1/info`, the worker's `/v1/delegator/info` and the first reload,
  which itself waits on the swap client. None of that needs to stand between a stored balance and the screen.
- Wallet: the syncing line is cleared by a one-second poll of the worker, and a reload follows a second
  later. One coherent snapshot per sync, as the review asks, replaces both.
- Wallet: split the 2.8 MB bundle.
- SDK: restore reads the full history twice (at boot, then after the address scan).
- A question for the Operator: the request limit per address on `/v1/indexer/*`. Without the pause a large
  wallet sends its page requests back to back, and whether mainnet's ingress tolerates that cannot be tested
  from here.

The plan, the review, the raw results and the tools are in `.verify/perf/` (git-ignored).
