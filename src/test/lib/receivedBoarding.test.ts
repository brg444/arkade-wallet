import { describe, expect, it } from 'vitest'
import { boardingOutpoints, newBoardingCoins } from '../../lib/receivedBoarding'

const coin = (txid: string, value = 1_000) => ({ txid: txid.repeat(64).slice(0, 64), vout: 0, value })

describe('newBoardingCoins', () => {
  it('counts only the coins that were not held before', () => {
    const held = boardingOutpoints([coin('a'), coin('b')])

    const { fresh } = newBoardingCoins(held, [coin('a'), coin('b'), coin('c', 5_000)])

    expect(fresh).toEqual([coin('c', 5_000)])
  })

  it('counts nothing when an update only repeats what was held', () => {
    expect(newBoardingCoins(boardingOutpoints([coin('a')]), [coin('a')]).fresh).toEqual([])
  })

  it('remembers what it has counted, so the next update does not count it again', () => {
    const first = newBoardingCoins(boardingOutpoints([]), [coin('c')])
    const second = newBoardingCoins(first.seen, [coin('c')])

    expect(first.fresh).toHaveLength(1)
    expect(second.fresh).toEqual([])
  })

  it('takes the first update as the starting set when there was none, and counts none of it', () => {
    const first = newBoardingCoins(undefined, [coin('a'), coin('b')])
    const second = newBoardingCoins(first.seen, [coin('a'), coin('b'), coin('d')])

    expect(first.fresh).toEqual([])
    expect(second.fresh).toEqual([coin('d')])
  })

  it('tells coins of one transaction apart by output', () => {
    const held = boardingOutpoints([coin('a')])

    expect(newBoardingCoins(held, [coin('a'), { ...coin('a'), vout: 1 }]).fresh).toEqual([{ ...coin('a'), vout: 1 }])
  })
})
