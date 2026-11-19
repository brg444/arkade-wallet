import type { Wallet } from './types'

/** The message a page sends its worker to say which network a stored wallet is about to open. */
export const WARM_UP = 'WARM_UP'

/**
 * Let the worker get ready for a stored wallet before the wallet itself can start.
 *
 * A browser stops an idle worker after about half a minute, so a returning visit usually starts
 * one from nothing, and the wallet's setup then waits on the chain connection: the Electrum client
 * holds every request for half a second after its socket opens, and the socket is only opened once
 * the worker has asked the server which network it is on. The page already knows the network a
 * stored wallet was last opened on, so it says so here, as the first thing it does. The connection
 * is then up by the time setup asks for it.
 *
 * Only a page its worker already controls has one to tell, and only a stored wallet has a network
 * to name. A message the worker does not act on costs nothing.
 */
export function warmUpWorker(
  container: ServiceWorkerContainer | undefined,
  wallet: Pick<Wallet, 'pubkey' | 'network'> | undefined,
): void {
  if (!container?.controller || !wallet?.pubkey || !wallet.network) return
  container.controller.postMessage({ type: WARM_UP, network: wallet.network })
}
