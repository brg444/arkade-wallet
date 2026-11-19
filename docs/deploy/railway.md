# A test deployment on Railway

How to run a build of this branch, with the SDK patch it carries, on mainnet behind a password, for
testing with small amounts. Railway builds the repository's `Dockerfile` and serves the container on
an `*.up.railway.app` address.

## Before you start

The patch in `patches/` changes how the SDK syncs coins, reads exit data and starts the worker. None
of it has been reviewed by the SDK's owners, and it has only been run against the test network. Use a
new wallet created in this deployment, fund it with an amount you are prepared to lose, and keep your
main wallet in the official app. Restoring the same recovery phrase in both would have two apps renew
and settle the same coins.

The patch also contains a fix that has not been published. Anyone who can load the site can read it
in the served JavaScript, which is one more reason to keep the password gate on.

## Set up the service

1. In Railway, create a project and add a service from GitHub. Grant Railway access to your fork and
   choose the branch to deploy. Railway finds the `Dockerfile` at the root and builds it.
2. In the service's variables, set:

   | Variable | Value |
   | --- | --- |
   | `VITE_ARK_SERVER` | `https://arkade.computer` |
   | `BASIC_AUTH_USERNAME` | a user name of your choice |
   | `BASIC_AUTH_PASSWORD` | a long random password |
   | `DISABLE_ANALYTICS` | `true` |

   Leave `VITE_SENTRY_DSN` and the Chatwoot variables unset, so nothing reports to the company's
   accounts. Railway sets `PORT`, and the container listens on it.
3. Under networking, generate a public domain. If Railway asks for a target port, give the value of
   `PORT`, or leave it to Railway's default.
4. Deploy. Each push to the branch deploys again. The build id the app keys its stored state on
   comes from the commit Railway built.

## First visit

Open the address, enter the user name and password, and create a new wallet. Settings should show
`arkade.computer` as the server. Without `VITE_ARK_SERVER` the wallet would still pick mainnet on
this host, but setting it removes the doubt. The wallet's data lives in the browser under this
address: a new address, such as a new Railway domain, starts empty.

## What to check, in order

1. Receive a small Arkade payment from the official app, and see it arrive in history and balance.
2. Close the tab, wait a minute and come back: Home should appear at once with the syncing line, and
   the line should go within two seconds or so.
3. Receive a small onchain payment to the boarding address. Receive should announce that amount
   alone, and the balance should count it once it confirms.
4. Send a small Arkade payment back to the official app.
5. If the wallet holds more than a hundred coins at some point, compare its balance with the
   official app's.

Stop and note what happened if a balance looks wrong, a payment does not arrive, or a request is
refused with a `429`. Without the pause between coin pages, a large wallet sends its page requests
back to back, and the server's limit per address is not known.
