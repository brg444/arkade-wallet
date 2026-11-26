/**
 * Browser stand-in for `import * as crypto from 'crypto'`.
 *
 * The Satora SDK ships a bundled copy of @noble/hashes 1.x whose Node entry
 * reads `crypto.webcrypto`. Vite externalizes `crypto` to an empty module in
 * the browser, which would leave noble without a random source and make every
 * swap preimage throw; this hands it the browser's own Web Crypto instead.
 */
export const webcrypto: Crypto = globalThis.crypto
export const getRandomValues: Crypto['getRandomValues'] = (array) => globalThis.crypto.getRandomValues(array)
export default { webcrypto, getRandomValues }
