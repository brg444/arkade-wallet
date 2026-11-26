import { describe, expect, it } from 'vitest'
import { resolveSwapRoute } from '../../lib/swapRoute'

const BTC = 'btc'
const USD = 'usd'
const ARKADE_USD = 'arkade-usd'
const BRL = 'brl'

const markets = new Set([`${ARKADE_USD}>${BTC}`, `${BTC}>${ARKADE_USD}`, `${BRL}>${ARKADE_USD}`, `${BTC}>${BRL}`])
const hasMarket = (a: string, b: string) => markets.has(`${a}>${b}`)
const base = { btcId: BTC, usdId: USD, hasMarket }

describe('resolveSwapRoute', () => {
  it('fills Bitcoin and USD through Satora when the account holds no Arkade dollars', () => {
    expect(resolveSwapRoute({ ...base, fromId: BTC, toId: USD })).toEqual({ rail: 'satora', direction: 'toUsdc' })
    expect(resolveSwapRoute({ ...base, fromId: USD, toId: BTC, giveUsd: 20 })).toEqual({
      rail: 'satora',
      direction: 'toArkade',
    })
  })

  it('sells Arkade dollars first when they cover the amount', () => {
    const withArkade = { ...base, arkadeUsdId: ARKADE_USD, arkadeUsdBalance: 50 }
    expect(resolveSwapRoute({ ...withArkade, fromId: USD, toId: BTC, giveUsd: 20 })).toEqual({
      rail: 'arkade',
      fromId: ARKADE_USD,
      toId: BTC,
    })
    // more than Arkade holds: the USDC goes through Satora instead, never split
    expect(resolveSwapRoute({ ...withArkade, fromId: USD, toId: BTC, giveUsd: 80 })).toEqual({
      rail: 'satora',
      direction: 'toArkade',
    })
  })

  it('lands new dollars bought with Bitcoin on the default chain', () => {
    expect(
      resolveSwapRoute({ ...base, arkadeUsdId: ARKADE_USD, arkadeUsdBalance: 50, fromId: BTC, toId: USD }),
    ).toEqual({ rail: 'satora', direction: 'toUsdc' })
  })

  it('reaches other Arkade assets through the Arkade dollar', () => {
    expect(resolveSwapRoute({ ...base, arkadeUsdId: ARKADE_USD, fromId: BRL, toId: USD })).toEqual({
      rail: 'arkade',
      fromId: BRL,
      toId: ARKADE_USD,
    })
    expect(resolveSwapRoute({ ...base, fromId: BRL, toId: USD })).toBeUndefined()
  })

  it('leaves every other pair to its Arkade market', () => {
    expect(resolveSwapRoute({ ...base, fromId: BTC, toId: BRL })).toEqual({ rail: 'arkade', fromId: BTC, toId: BRL })
    expect(resolveSwapRoute({ ...base, fromId: BRL, toId: BTC })).toBeUndefined()
    expect(resolveSwapRoute({ ...base, fromId: BTC, toId: BTC })).toBeUndefined()
  })
})
