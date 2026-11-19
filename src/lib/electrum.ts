import { ELECTRUM_WS_URL, ElectrumOnchainProvider, getNetwork, type NetworkName } from '@arkade-os/sdk'
import { ElectrumWS } from 'ws-electrumx-client'

const providers = new Map<NetworkName, ElectrumOnchainProvider>()

// One connection per network, never closed: every `ElectrumWS` shares one options object,
// so closing any of them turns reconnection off for all the others.
export const electrumProvider = (network: NetworkName): ElectrumOnchainProvider => {
  let provider = providers.get(network)
  if (!provider) {
    provider = new ElectrumOnchainProvider(new ElectrumWS(ELECTRUM_WS_URL[network]), getNetwork(network))
    providers.set(network, provider)
  }
  return provider
}

/**
 * Open the connection for `network` ahead of its first use. The value arrives in a message, so
 * anything that is not a network with an endpoint is ignored rather than passed to a socket.
 */
export const warmElectrum = (network: unknown): void => {
  if (typeof network !== 'string' || !Object.hasOwn(ELECTRUM_WS_URL, network)) return
  electrumProvider(network as NetworkName)
}
