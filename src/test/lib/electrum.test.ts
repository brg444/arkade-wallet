import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ElectrumWS } = vi.hoisted(() => ({ ElectrumWS: vi.fn() }))
vi.mock('ws-electrumx-client', () => ({ ElectrumWS }))

import { ELECTRUM_WS_URL } from '@arkade-os/sdk'
import { electrumProvider, warmElectrum } from '../../lib/electrum'

beforeEach(() => ElectrumWS.mockClear())

describe('electrumProvider', () => {
  it('opens one connection per network, however often the worker re-inits', () => {
    expect(electrumProvider('regtest')).toBe(electrumProvider('regtest'))
    expect(electrumProvider('mutinynet')).not.toBe(electrumProvider('regtest'))
    expect(ElectrumWS.mock.calls).toEqual([[ELECTRUM_WS_URL.regtest], [ELECTRUM_WS_URL.mutinynet]])
  })
})

describe('warmElectrum', () => {
  it('opens the connection the wallet is then handed, and no second one', () => {
    warmElectrum('signet')
    warmElectrum('signet')

    electrumProvider('signet')

    expect(ElectrumWS.mock.calls).toEqual([[ELECTRUM_WS_URL.signet]])
  })

  it('ignores anything that is not a network with an endpoint', () => {
    for (const value of [
      'wss://elsewhere.example',
      'toString',
      '__proto__',
      '',
      undefined,
      null,
      7,
      { network: 'signet' },
    ]) {
      warmElectrum(value)
    }

    expect(ElectrumWS).not.toHaveBeenCalled()
  })
})
