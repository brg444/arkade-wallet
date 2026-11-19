import { describe, expect, it, vi } from 'vitest'
import { WARM_UP, warmUpWorker } from '../../lib/workerWarmUp'

const controlledBy = (postMessage: ReturnType<typeof vi.fn> | null) =>
  ({ controller: postMessage ? { postMessage } : null }) as unknown as ServiceWorkerContainer

describe('warmUpWorker', () => {
  it('names the stored wallet’s network to the worker that controls the page', () => {
    const postMessage = vi.fn()

    warmUpWorker(controlledBy(postMessage), { pubkey: '02ab', network: 'mutinynet' })

    expect(postMessage.mock.calls).toEqual([[{ type: WARM_UP, network: 'mutinynet' }]])
  })

  it('says nothing when there is no wallet, or no network to name', () => {
    const postMessage = vi.fn()

    warmUpWorker(controlledBy(postMessage), undefined)
    warmUpWorker(controlledBy(postMessage), { network: 'mutinynet' })
    warmUpWorker(controlledBy(postMessage), { pubkey: '02ab' })
    warmUpWorker(controlledBy(postMessage), { pubkey: '02ab', network: '' })

    expect(postMessage).not.toHaveBeenCalled()
  })

  it('does nothing on a page no worker controls yet, or without service worker support', () => {
    expect(() => warmUpWorker(controlledBy(null), { pubkey: '02ab', network: 'mutinynet' })).not.toThrow()
    expect(() => warmUpWorker(undefined, { pubkey: '02ab', network: 'mutinynet' })).not.toThrow()
  })
})
