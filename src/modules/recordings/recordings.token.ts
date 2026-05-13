import jwt from 'jsonwebtoken'
import { env } from '../../config/env.js'
import { AppError } from '../../middleware/errorHandler.js'

interface RecordingTokenPayload {
  recordingId: string
  userId: string
}

export const generateRecordingToken = (
  recordingId: string,
  userId: string
): string => {
  return jwt.sign(
    { recordingId, userId },
    env.RECORDING_TOKEN_SECRET,
    { expiresIn: parseInt(env.RECORDING_TOKEN_EXPIRES_IN, 10) }
  )
}

export const verifyRecordingToken = (token: string): RecordingTokenPayload => {
  try {
    return jwt.verify(token, env.RECORDING_TOKEN_SECRET) as RecordingTokenPayload
  } catch {
    throw new AppError(401, 'Invalid or expired recording token.')
  }
}