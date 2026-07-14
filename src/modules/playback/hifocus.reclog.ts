// src/modules/playback/hifocus.reclog.ts
//
// Native HiFocus HTTP CGI endpoints (reqLogin -> doLogin -> queryChlRecLog).
// Reverse-engineered from captured browser traffic + the NVR web UI's own
// login.js and CommonFunctions.js (NVMS-9000 platform).
//
// Auth flow:
//   1. POST reqLogin (empty body)      -> { sessionId, nonce }
//   2. Generate a throwaway RSA keypair
//   3. passwordHash = sha512(md5(password) + "#" + nonce + "#" + rsaPublicKeyPem)
//   4. POST doLogin  { userName, password: passwordHash, rsaPublic: publicKeyPem },
//        with `Cookie: sessionId=<sessionId from step 1>`             -> { token }
//   5. All further calls (queryChlRecLog etc.) send the same sessionId
//      cookie + <token> from step 4 in the XML body.
//
// We deliberately do NOT decrypt the `sessionKey` doLogin also returns
// (RSA-encrypted with our public key) -- it's used by the web UI for video
// stream encryption, not for XML/CGI calls like queryChlRecLog, which only
// need the sessionId cookie + token. Skipping it means no RSA private-key
// operations are needed at all, just a public key to send.
//
// WARNING - CHANNEL GUID: toHifocusChannelId assumes chlId is zero-padded
// hex of the numeric channel (channel 1 -> {00000001-0000-0000-0000-000000000000}),
// confirmed against real captured traffic for channel 1. Re-verify for
// multi-channel NVRs before relying on it for channel > 1.
//
// WARNING - RSA KEY SIZE: defaults to 1024-bit to match the observed sample
// public key's length. Not verified against the device's actual requirements
// beyond "the login succeeds" -- bump RSA_MODULUS_LENGTH if doLogin ever
// rejects the key.

import axios from 'axios'
import crypto from 'crypto'
import { XMLParser } from 'fast-xml-parser'
import { env } from '../../config/env.js'
import { withRetry } from '../../utils/retry.js'
import logger from '../../utils/logger.js'
import type { RecordingSegment } from './hikvision.search.js'

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: true })

const REQUEST_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Accept: 'application/xml, text/xml, */*; q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
}

// -- Channel GUID --------------------------------------------------------------

export const toHifocusChannelId = (channel: number): string => {
  const hex = channel.toString(16).padStart(8, '0')
  return `{${hex}-0000-0000-0000-000000000000}`
}

// -- XML request helpers --------------------------------------------------------

const xmlHeader = (token: string): string =>
  `<?xml version="1.0" encoding="utf-8" ?><request version="1.0" systemType="NVMS-9000" clientType="WEB"><token>${token}</token>`

const XML_FOOTER = '</request>'

// -- Session (login) -------------------------------------------------------------

export interface HifocusSession {
  sessionId: string
  token: string
}

const RSA_MODULUS_LENGTH = 1024 // see file header note

const generateSessionKeyPair = (): { publicKeyPem: string } => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: RSA_MODULUS_LENGTH,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  return { publicKeyPem: publicKey }
}

const computeLoginPasswordHash = (password: string, nonce: string, rsaPublicKeyPem: string): string => {
  // MD5 hex must be UPPERCASE here — confirmed against a real captured
  // login triple (nonce/rsaPublic/expected hash from the device's own web
  // UI). Node's default .digest('hex') is lowercase, so this must be
  // explicitly uppercased to match what the device expects.
  const md5Password = crypto.createHash('md5').update(password, 'utf8').digest('hex').toUpperCase()
  const cleanedKey = rsaPublicKeyPem.replace(/\r/g, '')
  const combined = `${md5Password}#${nonce}#${cleanedKey}`
  return crypto.createHash('sha512').update(combined, 'utf8').digest('hex')
}

const stripGuidBraces = (raw: string): string => {
  const start = raw.indexOf('{')
  const end = raw.indexOf('}')
  return start !== -1 && end !== -1 ? raw.substring(start + 1, end) : raw
}

const reqLogin = async (
  ip: string,
  httpPort: number
): Promise<{ sessionId: string; nonce: string }> => {
  const url = `http://${ip}:${httpPort}/reqLogin`
  const body = `${xmlHeader('null')}${XML_FOOTER}`

  const response = await axios.post<string>(url, body, {
    headers: REQUEST_HEADERS,
    responseType: 'text',
    timeout: 15000,
  })

  const parsed = parser.parse(response.data)
  const status = parsed?.response?.status
  if (status !== 'success') {
    throw new Error(`Hifocus reqLogin failed with status "${status}"`)
  }

  const rawSessionId: string = parsed.response.content.sessionId
  const nonce: string = parsed.response.content.nonce // kept with braces, matches web UI behaviour

  return { sessionId: stripGuidBraces(rawSessionId), nonce }
}

// Known NVMS-9000 doLogin error codes worth surfacing distinctly.
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  '536870947': 'Invalid username or password',
  '536870948': 'Invalid username or password',
  '536870951': 'Account is locked',
  '536870953': 'User not permitted on this connection type',
}

const doLogin = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  sessionId: string,
  nonce: string
): Promise<{ token: string }> => {
  const url = `http://${ip}:${httpPort}/doLogin`
  const { publicKeyPem } = generateSessionKeyPair()
  const passwordHash = computeLoginPasswordHash(password, nonce, publicKeyPem)

  const body =
    `${xmlHeader('null')}` +
    `<content><userName><![CDATA[${username}]]></userName>` +
    `<password><![CDATA[${passwordHash}]]></password>` +
    `<rsaPublic>${publicKeyPem}</rsaPublic></content>` +
    XML_FOOTER

  const response = await axios.post<string>(url, body, {
    headers: { ...REQUEST_HEADERS, Cookie: `sessionId=${sessionId}` },
    responseType: 'text',
    timeout: 15000,
  })

  const parsed = parser.parse(response.data)
  const status = parsed?.response?.status
  if (status !== 'success') {
    const errorCode = String(parsed?.response?.errorCode ?? '')
    const message = LOGIN_ERROR_MESSAGES[errorCode] ?? `doLogin failed (errorCode ${errorCode || 'unknown'})`
    const err = new Error(`Hifocus doLogin failed: ${message}`)
    ;(err as any).nonRetryable = true // wrong credentials/locked account should never retry
    throw err
  }

  const token: string = parsed.response.content.token // kept with braces, matches subsequent-request usage
  return { token }
}

export const login = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string
): Promise<HifocusSession> => {
  const { sessionId, nonce } = await reqLogin(ip, httpPort)
  const { token } = await doLogin(ip, httpPort, username, password, sessionId, nonce)
  return { sessionId, token }
}

// TODO(perf): sessions are short-lived server-side but this logs in fresh on
// every fetchChlRecLog call. Fine for correctness; if this endpoint gets hit
// frequently, cache { sessionId, token, expiresAt } per NVR and only
// re-login on expiry or a 401/session-invalid response -- same shape as a
// JWT-refresh cache.

// -- Parsing ----------------------------------------------------------------------

// HiFocus timestamps are "YYYY-MM-DD HH:mm:ss" in the timezone declared by
// recList's timeZone attribute. The sample response has timeZone="UTC", so
// treating them as UTC directly is safe for that case -- if a given NVR
// reports timeZone="LOCAL" (or similar) this needs a tz-aware conversion
// instead of a flat "Z" suffix.
const parseHifocusTime = (raw: string): Date => new Date(raw.replace(' ', 'T') + 'Z')

interface RawRecLogItem {
  recType?: string
  recSubType?: string
  startTime?: string
  endTime?: string
  size?: number
}

export const parseChlRecLogResponse = (xml: string, channel: number): RecordingSegment[] => {
  const parsed = parser.parse(xml)

  const status = parsed?.response?.status
  if (status !== 'success') {
    logger.warn(`Hifocus queryChlRecLog: non-success status "${status}"`)
    return []
  }

  const rawItems = parsed?.response?.content?.recList?.item
  const items: RawRecLogItem[] = rawItems ? (Array.isArray(rawItems) ? rawItems : [rawItems]) : []

  return items
    .map((item) => {
      if (!item.startTime || !item.endTime) return null
      const startTime = parseHifocusTime(item.startTime)
      const endTime = parseHifocusTime(item.endTime)
      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) return null
      return { channel, startTime, endTime }
    })
    .filter((s): s is RecordingSegment => s !== null)
}

// -- Time formatting for queryChlRecLog ------------------------------------------
// The real request sends TWO time pairs:
//   startTime/endTime      -- local device time, "YYYY-MM-DD HH:mm:ss"
//   startTimeEx/endTimeEx  -- UTC-equivalent of the day boundary, offset by
//                             the device's local timezone (captured request
//                             showed a -5:30 shift, i.e. IST/UTC+5:30)

const pad = (n: number): string => String(n).padStart(2, '0')

const toLocalTimeString = (date: Date): string =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
  `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`

// Full recType list from the captured request's <types><recType> block --
// send all of them so the query isn't accidentally filtered to a subset.
const ALL_REC_TYPES = [
  'MOTION', 'SMDHUMAN', 'SMDVEHICLE', 'SCHEDULE', 'SENSOR', 'MANUAL',
  'INTELLIGENT', 'POS', 'NORMALALL', 'FACEDETECTION', 'FACEMATCH', 'VEHICLE',
  'TRIPWIRE', 'INVADE', 'AOIENTRY', 'AOILEAVE', 'ITEMCARE', 'CROWDDENSITY',
  'VIDEOEXCEPTION', 'LOITERING', 'AUDIOEXCEPTION', 'PVD', 'THRESHOLD', 'CROWDGATHER',
]

const buildQueryChlRecLogXML = (
  token: string,
  channelId: string,
  startTime: Date,
  endTime: Date,
  tzOffsetMinutes: number
): string => {
  const startEx = new Date(startTime.getTime() - tzOffsetMinutes * 60_000)
  const endEx = new Date(endTime.getTime() - tzOffsetMinutes * 60_000)
  const recTypeItems = ALL_REC_TYPES.map((t) => `<item>${t}</item>`).join('')
  const enumList = ALL_REC_TYPES.map((t) => `<enum>${t}</enum>`).join('')

  return (
    `${xmlHeader(token)}` +
    `<types><recType>${enumList}</recType></types>` +
    `<requireField><chl/><recList><item><recType/><startTime/><endTime/><size/></item></recList></requireField>` +
    `<condition><modeType>modeOne</modeType>` +
    `<startTime>${toLocalTimeString(startTime)}</startTime>` +
    `<endTime>${toLocalTimeString(endTime)}</endTime>` +
    `<startTimeEx>${toLocalTimeString(startEx)}</startTimeEx>` +
    `<endTimeEx>${toLocalTimeString(endEx)}</endTimeEx>` +
    `<recType type='list'><itemType type='recType'/>${recTypeItems}</recType>` +
    `<keyword></keyword>` +
    `<chl id='${channelId}'></chl>` +
    `</condition>${XML_FOOTER}`
  )
}

// -- HTTP call --------------------------------------------------------------------

export const fetchChlRecLog = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  channelId: string,
  startTime: Date,
  endTime: Date,
  tzOffsetMinutes: number = 330 // WARNING: defaults to IST (+5:30) per the captured request -- confirm per-NVR
): Promise<string> => {
  const url = `http://${ip}:${httpPort}/queryChlRecLog`

  // TEMP DEBUG — remove after confirming credentials are exactly right.
  // JSON.stringify reveals hidden whitespace/newlines that console.log alone
  // would hide (e.g. "admin2026\n" would just look like "admin2026").
  logger.warn(`Hifocus login debug: username=${JSON.stringify(username)} password=${JSON.stringify(password)} passwordLength=${password.length}`)

  const { sessionId, token } = await login(ip, httpPort, username, password)
  const body = buildQueryChlRecLogXML(token, channelId, startTime, endTime, tzOffsetMinutes)

  return withRetry(
    async () => {
      try {
        const response = await axios.post<string>(url, body, {
          headers: { ...REQUEST_HEADERS, Cookie: `sessionId=${sessionId}` },
          responseType: 'text',
          timeout: 15000,
        })
        return response.data
      } catch (err) {
        if (axios.isAxiosError(err) && err.response) {
          logger.error(`Hifocus queryChlRecLog raw response: ${err.response.data}`)
          if (err.response.status >= 400 && err.response.status < 500) {
            const nonRetryable = new Error(`Hifocus queryChlRecLog rejected (HTTP ${err.response.status})`)
            ;(nonRetryable as any).nonRetryable = true
            throw nonRetryable
          }
        }
        throw err
      }
    },
    {
      retries: env.PLAYBACK_SEARCH_RETRIES,
      baseDelayMs: 500,
      isRetryable: (err) => !(err as any)?.nonRetryable,
      label: `Hifocus queryChlRecLog (ch=${channelId})`,
    }
  )
}

// -- Combined search ----------------------------------------------------------------

export const searchHifocusRecLog = async (
  ip: string,
  httpPort: number,
  username: string,
  password: string,
  channel: number,
  startTime: Date,
  endTime: Date
): Promise<RecordingSegment[]> => {
  const channelId = toHifocusChannelId(channel)
  const xml = await fetchChlRecLog(ip, httpPort, username, password, channelId, startTime, endTime)
  return parseChlRecLogResponse(xml, channel)
}