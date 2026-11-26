import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IWallet } from '@arkade-os/sdk'
import { SatoraQuoteMoved, executeSatoraSwap } from '../../../lib/usdc/route'
import type { UsdcSession } from '../../../lib/usdc/keys'

const satora = vi.hoisted(() => ({
  satoraClient: vi.fn(async () => ({})),
  createToArkadeSwap: vi.fn(),
  createdTerms: vi.fn(),
  forgetUnfundedSwap: vi.fn(async () => {}),
  fundToArkadeSwap: vi.fn(),
}))

vi.mock('../../../lib/usdc/satora', () => satora)
vi.mock('../../../lib/asp', () => ({
  getReceivingAddresses: vi.fn(async () => ({ offchainAddr: 'ark1me' })),
  sendOffChain: vi.fn(),
}))

describe('starting a Satora swap', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drops a swap created on moved terms from Satora’s store, so it never shows up later', async () => {
    satora.createToArkadeSwap.mockResolvedValue({ id: 'swap-1', sourceAmount: '100000000', targetAmount: '90000' })
    satora.createdTerms.mockReturnValue({ sourceAmount: BigInt(100_000_000), targetAmount: BigInt(90_000) })
    const recordSwap = vi.fn()

    await expect(
      executeSatoraSwap({
        session: { address: '0xme' } as UsdcSession,
        arkServerUrl: 'https://arkade.example',
        wallet: {} as IWallet,
        direction: 'toArkade',
        quote: {
          sourceAmount: BigInt(100_000_000),
          targetAmount: BigInt(99_000),
          minSats: BigInt(0),
          maxSats: BigInt(0),
          feeSats: 0,
        },
        recordSwap,
      }),
    ).rejects.toThrow(SatoraQuoteMoved)
    expect(satora.forgetUnfundedSwap).toHaveBeenCalledWith(expect.anything(), 'swap-1')
    expect(satora.fundToArkadeSwap).not.toHaveBeenCalled()
    expect(recordSwap).not.toHaveBeenCalled()
  })
})
