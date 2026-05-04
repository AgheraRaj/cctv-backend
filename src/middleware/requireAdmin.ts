import { Response, NextFunction } from 'express'
import { AuthRequest } from './auth.js'
import { AppError } from './errorHandler.js'

export const requireAdmin = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  if (req.user?.role !== 'ADMIN') {
    throw new AppError(403, 'Admin access required.')
  }
  next()
}