// verify-hash.js
//
// Offline sanity check for the HiFocus login password-hash formula.
// Uses a REAL captured nonce + rsaPublic + resulting password hash from an
// earlier successful browser login (captured via DevTools), and re-derives
// the hash locally using the same formula implemented in hifocus.reclog.ts.
//
// If this prints MATCH, the hash formula is correct and the "Invalid
// username or password" error means the credentials stored in the database
// don't match what's actually set on the device right now.
//
// If it prints NO MATCH, the formula itself has a bug and needs fixing
// before touching the live device again (no lockout risk running this,
// since it never contacts the NVR).
//
// Usage:
//   node verify-hash.js <the-real-admin-password-used-for-that-login>

import crypto from "crypto"

const CAPTURED_NONCE = '{13BFA601-8707-4960-A711-F30E549B5320}'

const CAPTURED_RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGeMA0GCSqGSIb3DQEBAQUAA4GMADCBiAKBgFHFKqCf3kKz1092e4+3szwuac51
Fm+CV/JqEBek64h5TVZgO5jyFxUcbiueTt085zA13EZAP25Oh+KF8YHyBSKIVM2B
ejzLmIHQstC5xhAyfl6DdRxIpii2arqJGXYvoR7k475bTSPQzTaUy4fU9P2FqurZ
01qUkBX25dSQLSrpAgMBAAE=
-----END PUBLIC KEY-----
`

const EXPECTED_HASH =
  'cff49c52b1e105d7390db208882aa46e2a3b656f4ca0c884ee2de6a3f91fa5ed21c2d5fc2b885914fa3d04a170ca35964eea8703f6c1470f47446e5f5c60d747'

const password = process.argv[2]
if (!password) {
  console.error('Usage: node verify-hash.js <the-real-admin-password-used-for-that-login>')
  process.exit(1)
}

// Exact same formula as computeLoginPasswordHash() in hifocus.reclog.ts
const md5Password = crypto.createHash('md5').update(password, 'utf8').digest('hex')
const cleanedKey = CAPTURED_RSA_PUBLIC_KEY_PEM.replace(/\r/g, '')
const combined = `${md5Password}#${CAPTURED_NONCE}#${cleanedKey}`
const computedHash = crypto.createHash('sha512').update(combined, 'utf8').digest('hex')

console.log('md5(password):   ', md5Password)
console.log('computed hash:    ', computedHash)
console.log('expected hash:    ', EXPECTED_HASH)
console.log()
console.log(computedHash === EXPECTED_HASH ? '✅ MATCH — formula is correct' : '❌ NO MATCH — formula needs fixing')