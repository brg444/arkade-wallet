# Load-time work

This branch (`perf`, cut from `redesign`) carries the performance changes. It is separate so that `redesign`
stays reviewable on its own. The SDK changes reach the wallet through the pnpm patch
(`patches/@arkade-os__sdk@0.5.6.patch`). The wallet changes are below them: Home from what it showed on the
last visit, then the load behind it.

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

## Home from what it showed last time

A returning visit used to hold a loading screen until three things had happened in a row: the worker had
started and built the wallet, the swap client was ready, and the first reload had run. Traced on the page's
own clock, with the worker stopped beforehand as a browser does after about 30 seconds without a client,
that is 2.4 to 2.6 s: 0.4 s waiting for the page's `/v1/info`, 1.9 s inside the worker's setup, 0.2 s for
the swap client and 0.2 to 0.3 s for the reload. The setup is that long because it waits, one after the
other, on `/v1/info` and `/v1/delegator/info`, a coin sync, the pending-transaction read and the
subscription.

Home now does not wait for any of it.

- **Server info and prices** start from their last answers (`77bdd37`). The passwordless unlock, and with
  it the worker, no longer waits for the page's `/v1/info`.
- **Home** is drawn from what it showed on the last visit, with the syncing line beside it, until the
  first load takes over (`cbe00fd`).

| Returning visit | Before | Now |
| --- | --- | --- |
| Typical, worker still running: Home on screen | 1.63 s (1.29 to 2.13) | 0.11 s (0.08 to 0.23) |
| Typical, worker still running: wallet loaded | 1.63 s | 1.43 s (1.20 to 1.80) |
| Typical, worker stopped: Home on screen | 2.43 s (2.15 to 2.91) | 0.10 s (0.08 to 0.26) |
| Typical, worker stopped: wallet loaded | 2.43 s | 2.37 s (2.14 to 2.66) |
| Heavy, worker still running: Home on screen | 1.98 s (1.57 to 3.93) | 0.11 s (0.08 to 0.24) |
| Heavy, worker still running: wallet loaded | 1.98 s | 1.85 s (1.50 to 3.28) |
| Heavy, worker stopped: Home on screen | 2.55 s (2.22 to 3.46) | 0.11 s (0.09 to 0.24) |
| Heavy, worker stopped: wallet loaded | 2.55 s | 2.53 s (2.37 to 3.56) |

Sixteen visits per cell over two rounds, the two builds taking turns, median with the full range, same
machine and network as above. "Wallet loaded" is when the app stops being marked busy; before this change
that was the moment Home appeared. The earlier tables on this page were all taken with the worker still
running, which is the less common case.

What keeps the stored figures honest:

- A snapshot is read only by its own wallet, on its own server, by the build that wrote it. It is written
  after a completed load. A reset stops the writing before it wipes, and the wipe takes the snapshot with
  everything else in storage. The first visit after an update therefore loads as it did before.
- A locked wallet shows nothing. Home is drawn once the password has been accepted.
- Until the load lands, Home is the only wallet screen shown. A tap that navigates is kept and takes
  effect then, so Send, Receive, Activity and Settings never open on a wallet that has not loaded.
- With no price there is no stored Home, so a balance is never drawn as zero. An app request, an
  unreachable server and a failed first load all come first, as before.
- The fiat figure can move by a few cents a moment after it appears, when the live price replaces the
  last one. That happened in 2 of every 16 visits.

Checked in a browser besides the unit tests: a tap on Send, Receive or View all 0.3 to 0.5 s into a visit
opens its screen at 1.7 s, when the wallet has loaded, with no error; a password wallet shows only the
unlock screen while locked, Home 0.15 s after the right password and nothing after a wrong one.

Known gaps. A held tap gives no sign that it was taken until the screen opens. The stored figures carry
no time, only the syncing line. The end-to-end suite has not been run with this; its `waitForWalletPage`
helper now waits for the app to stop being busy.

## The load behind it

With Home on screen at once, what a returning visit still waits for is the wallet behind it: the syncing
line, and any tap, which is held until the load lands. That took 2.3 to 2.7 s when the worker had to start.

A build with timing marks on the page and inside the worker's setup shows where it goes. The marks are not
committed; the tools that add them are in `.verify/perf/tools`. Typical wallet, worker stopped, the median
of six to eight visits for each step.

| Step | Before | With the early connection |
| --- | --- | --- |
| Page, until it calls the worker: config, the stored secret, the identity | 0.41 s | 0.36 s |
| Worker: `/v1/info` and `/v1/delegator/info`, side by side | 0.35 s | 0.25 s |
| Worker: contracts read from storage | 0.10 s | 0.10 s |
| Worker: waiting for the chain connection | 0.46 s | 0.11 s |
| Worker: coins on chain, then the address watch | 0.20 s | 0.19 s |
| Worker: boarding coins, a second time | 0.10 s | 0.10 s |
| Worker: history and pending transactions, from storage | 0.05 s | 0.05 s |
| Worker: the incoming-funds subscription | 0.10 s | 0.10 s |
| Page: swap client ready, one `/v1/info` through the worker | 0.49 s | 0.45 s |
| Page: the first reload | 0.24 s | 0.21 s |
| Wallet loaded | 2.56 s | 1.93 s |

The chain is reached over an Electrum WebSocket, which is why none of the worker's chain steps showed up as
requests in the earlier traces. Two changes came out of this.

**The chain connection opens as the page starts** (`8df2734`). The Electrum client holds every request for
half a second after its socket opens, and a worker that has just started only opened the socket once it had
asked the server which network it is on, so setup stood still for about 0.45 s. The page now names the
stored wallet's network to the worker as the first thing it does, and the worker opens the connection then.
The worker acts only on a network the SDK lists an endpoint for.

**A reload asks for its coins, history and balance together** (`25d602f`). They were read one after the
other, and the balance alone is a round trip to the chain. Every reload is shorter by the same amount, not
only the first.

| Returning visit, wallet loaded | Stored Home only | Early connection |
| --- | --- | --- |
| Typical, worker stopped | 2.27 s (2.12 to 2.42) | 1.86 s (1.59 to 2.11) |
| Heavy, worker stopped | 2.65 s (2.38 to 2.76) | 2.16 s (1.97 to 2.62) |
| Typical, worker running | 1.44 s (1.26 to 1.82) | 1.40 s (1.30 to 1.68) |
| Heavy, worker running | 1.93 s (1.57 to 2.43) | 1.80 s (1.59 to 2.00) |

| Returning visit, wallet loaded | Early connection | Reads together as well |
| --- | --- | --- |
| Typical, worker stopped | 1.85 s (1.68 to 2.14) | 1.75 s (1.59 to 1.93) |
| Heavy, worker stopped | 2.07 s (1.83 to 2.33) | 1.96 s (1.85 to 2.12) |
| Typical, worker running | 1.42 s (1.30 to 1.66) | 1.35 s (1.21 to 1.50) |
| Heavy, worker running | 1.70 s (1.52 to 1.82) | 1.56 s (1.46 to 1.72) |

Each table is its own session of sixteen visits per cell, the two builds taking turns, median with the full
range. With the worker stopped the syncing line also goes about 0.4 s sooner (typical 2.64 to 2.26 s, heavy
2.87 to 2.46 s). It is cleared by a one-second poll, so the second change does not move it.

One cost: when the worker has to start, Home is on screen at 0.14 to 0.15 s instead of 0.12 s, because the
worker now starts while the page draws. This machine has two cores, so a phone should lose less.

One figure in the first table is not to be trusted beyond this machine. On visits where the worker had to
start, the `/v1/info` the swap client waits for took 0.4 to 0.5 s instead of 0.15 s, all of it in opening a
connection. Requests here leave through a proxy that opens connections its own way, and a phone that talks
to the server directly may not pay this. It has not been checked on one.

## What the load still waits for

Largest first, for the typical wallet with the worker stopped, out of about 1.8 s.

- **Five round trips to the chain, 0.5 s.** Setup makes four of them one after the other (the coins of
  every onchain address, the watch on them, the boarding coins again, the incoming-funds subscription), and
  each reload makes one for the balance. All five are about boarding coins. The SDK has an option that
  takes them off the path, `lazyBoarding`, and the wallet deliberately does not use it, for two reasons
  noted beside the setup call: its refresh is never retried, and its update message carries every stored
  coin, which the receive screen reads as a payment. Reading the SDK adds a third: with the option on, the
  history cache is written only after that refresh. Mending this is work in the SDK's worker message
  handler, which upstream has changed heavily since the version this wallet pins. It is the largest step
  left and it needs a decision before any code.
- **The page before it calls the worker, 0.36 s.** The stored secret is decrypted twice, once to learn that
  there is no password and once to unlock, and the recovery phrase is stretched into a seed twice, once for
  the identity and once for the backup key. Here that is about 0.05 s for each decryption and 0.12 s for
  the two seeds together, and a slow phone takes several times as long. Left alone for now: it is
  key-handling code, and the gain on this machine is small.
- **Server info in the worker, 0.25 to 0.35 s.** It lasts as long as `/v1/delegator/info`, which is on a host
  nothing has connected to yet. A preconnect from the page might shorten it on a phone. It cannot be
  measured through this machine's proxy, so it is not done.
- **The swap client's `/v1/info`, 0.15 to 0.2 s.** The worker read the same thing a second earlier. The parked
  operator-info memo would answer it, once reads that must be live go around the memo.
- **The half second in the Electrum client, 0.1 s of it.** A worker takes 0.08 s to start and the socket
  0.19 s to open, so even opened first the connection is ready a little after setup wants it.
- **A worker that is still running rebuilds its wallet, 0.8 s of that visit's 1.35 s.** This is the less
  common visit, and the fix is in the SDK's worker lifecycle.

## Not done yet

- Wallet: the syncing line is cleared by a one-second poll of the worker, and a reload follows a second
  later. One coherent snapshot per sync, as the review asks, replaces both.
- Wallet: split the 2.8 MB bundle.
- SDK: restore reads the full history twice (at boot, then after the address scan).
- A question for the Operator: the request limit per address on `/v1/indexer/*`. Without the pause a large
  wallet sends its page requests back to back, and whether mainnet's ingress tolerates that cannot be tested
  from here.

The plan, the review, the raw results and the tools are in `.verify/perf/` (git-ignored).
