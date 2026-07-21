// src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { AppError } from './errorHandler.js'
import { asyncLocalStorage } from './asyncContext.js'
import prisma from '../config/db.js'

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'VIEWER'

export interface AuthRequest extends Request {
  user?: {
    id: string
    email: string
    role: UserRole
  }
}

interface JwtPayload {
  id: string
  email: string
  role: UserRole
}

export const authenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
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

  let decoded: JwtPayload
  try {
    decoded = jwt.verify(token, env.JWT_SECRET) as JwtPayload
  } catch {
    next(new AppError(401, 'Invalid or expired token.'))
    return
  }

  try {
    // Revalidate against the database on every request instead of trusting
    // the JWT claims blindly. JWT_EXPIRES_IN defaults to 7d — without this
    // check, a user who was demoted, disabled, or deleted after their token
    // was issued would keep their old privileges until the token expires.
    // This one indexed primary-key lookup per request is the standard
    // trade-off for instant revocation, and this app already hits Postgres
    // on most requests, so the added cost is marginal.
    const currentUser = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, email: true, role: true, isActive: true },
    })

    if (!currentUser) {
      next(new AppError(401, 'User no longer exists.'))
      return
    }

    if (!currentUser.isActive) {
      next(new AppError(403, 'Account has been disabled. Contact your administrator.'))
      return
    }

    // Always trust the freshly-read role/email, never the JWT's copy of them.
    req.user = {
      id: currentUser.id,
      email: currentUser.email,
      role: currentUser.role as UserRole,
    }

    // Inject userId into current context
    const store = asyncLocalStorage.getStore()
    if (store) {
      store.userId = req.user.id
      store.userEmail = req.user.email
    }

    next()
  } catch (err) {
    next(err)
  }
}