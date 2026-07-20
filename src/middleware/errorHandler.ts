import { Request, Response, NextFunction } from 'express'

import { addAuditLog } from '../modules/audit/audit.queue.js'
import { asyncLocalStorage } from './asyncContext.js'

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

const logError = (
  req: Request,
  action: string,
  message: string,
  details?: Record<string, any>
) => {
  const store = asyncLocalStorage.getStore()
  addAuditLog({
    userId: store?.userId,
    userEmail: store?.userEmail,
    action,
    resourceType: 'HTTP_ERROR',
    resourceId: req.path,
    newValues: {
      method: req.method,
      path: req.path,
      message,
      ...details,
    },
    ipAddress: store?.ipAddress,
    userAgent: store?.userAgent,
    requestId: store?.requestId,
  })
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Known operational error — thrown intentionally from services/controllers
  if (err instanceof AppError) {
    console.warn({
      message: err.message,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
    })

    // Only audit 4xx errors that aren't trivial validation (keep noise low)
    // Always audit auth errors (401, 403)
    const shouldAudit = err.statusCode === 401 || err.statusCode === 403 || err.statusCode >= 500
    if (shouldAudit) {
      logError(req, `ERROR_${err.statusCode}`, err.message, {
        statusCode: err.statusCode,
      })
    }

    res.status(err.statusCode).json({ error: err.message })
    return
  }

  // Prisma unique constraint violation
  if (err.constructor.name === 'PrismaClientKnownRequestError') {
    console.warn({
      message: 'Unique constraint violation',
      path: req.path,
      method: req.method,
    })

    logError(req, 'ERROR_DB_CONFLICT', 'Unique constraint violation', {
      statusCode: 409,
    })

    res.status(409).json({ error: 'Resource already exists.' })
    return
  }

  // Unknown / unexpected error — always audit these
  console.error({
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  })

  logError(req, 'ERROR_UNHANDLED', err.message, {
    statusCode: 500,
    stack: err.stack,
  })

  res.status(500).json({ error: 'Internal server error.' })
}