import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { AppError } from './errorHandler.js'

// Extend Express Request type to carry user info after verification
export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    role: 'ADMIN' | 'VIEWER'
  }
}

export const authenticate = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError(401, 'No token provided.')
  }

  const token = authHeader.split(' ')[1]

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthRequest['user']
    req.user = decoded
    next()
  } catch {
    throw new AppError(401, 'Invalid or expired token.')
  }
}