import winston from 'winston'
import { env } from '../config/env.js'

const { combine, timestamp, errors, json, colorize, printf } = winston.format

// Readable format for development terminal
const devFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level}]: ${message}`

    // Append extra fields like path, method, statusCode
    if (Object.keys(meta).length) {
      log += ` ${JSON.stringify(meta)}`
    }

    // Append stack trace for errors
    if (stack) {
      log += `\n${stack}`
    }

    return log
  })
)

// Structured JSON format for production (easy to parse by log aggregators)
const prodFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json()
)

const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: env.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: combine(timestamp(), errors({ stack: true }), json()),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: combine(timestamp(), json()),
    }),
  ],
})

export default logger