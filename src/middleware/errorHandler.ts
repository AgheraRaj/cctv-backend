import { Request, Response, NextFunction } from 'express'
import logger from '../utils/logger.js'

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Known operational error — thrown intentionally from services/controllers
  if (err instanceof AppError) {
    logger.warn({
      message: err.message,
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
    })

    res.status(err.statusCode).json({ error: err.message })
    return
  }

  // Prisma unique constraint violation
  if (err.constructor.name === 'PrismaClientKnownRequestError') {
    logger.warn({
      message: 'Unique constraint violation',
      path: req.path,
      method: req.method,
    })

    res.status(409).json({ error: 'Resource already exists.' })
    return
  }

  // Unknown error — log full stack trace
  logger.error({
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  })

  res.status(500).json({ error: 'Internal server error.' })
}