// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { AppError } from './errorHandler.js'

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
  // Primary: Authorization header (all API calls via axios)
  // Fallback: ?token= query param (native <video src="..."> can't send headers)
  const authHeader = req.headers.authorization
  let token: string | undefined

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1]
  } else if (typeof req.query.token === 'string' && req.query.token) {
    token = req.query.token
  }

  if (!token) {
    next(new AppError(401, 'No token provided.'))
    return
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as AuthRequest['user']
    req.user = decoded
    next()
  } catch {
    next(new AppError(401, 'Invalid or expired token.'))
  }
}