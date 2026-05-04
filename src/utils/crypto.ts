import crypto from 'crypto'
import { env } from '../config/env.js'

const ALGORITHM = 'aes-256-cbc'
const KEY = Buffer.from(env.AES_SECRET_KEY, 'utf8')  // must be 32 bytes
const IV_LENGTH = 16

export const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text), cipher.final()])

  // store iv alongside encrypted text so we can decrypt later
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

export const decrypt = (encryptedText: string): string => {
  const [ivHex, encryptedHex] = encryptedText.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const encrypted = Buffer.from(encryptedHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])

  return decrypted.toString()
}