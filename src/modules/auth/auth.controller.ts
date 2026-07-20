import { Request, Response, NextFunction } from 'express'
import { loginService, getMeService } from './auth.service.js'
import { AuthRequest } from '../../middleware/auth.js'
import { z } from 'zod'
import { AppError } from '../../middleware/errorHandler.js'
import { addAuditLog } from '../audit/audit.queue.js'
import { asyncLocalStorage } from '../../middleware/asyncContext.js'

const loginSchema = z.object({
  email: z.string().email('Invalid email format.'),
  password: z.string().min(1, 'Password is required.'),
})

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const store = asyncLocalStorage.getStore()

  try {
    const parsed = loginSchema.safeParse(req.body)

    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues[0].message)
    }

    const { email, password } = parsed.data

    let result: Awaited<ReturnType<typeof loginService>>
    try {
      result = await loginService(email, password)
    } catch (err) {
      // Log failed login attempts (wrong password / user not found)
      addAuditLog({
        action: 'LOGIN_FAILED',
        resourceType: 'User',
        userEmail: email,
        newValues: {
          reason: err instanceof AppError ? err.message : 'Unknown error',
        },
        ipAddress: store?.ipAddress,
        userAgent: store?.userAgent,
        requestId: store?.requestId,
      })
      throw err
    }

    // Inject user into context so other middleware can use it
    if (store) {
      store.userId = result.user.id
      store.userEmail = result.user.email
    }

    // Log successful login
    addAuditLog({
      action: 'LOGIN_SUCCESS',
      resourceType: 'User',
      resourceId: result.user.id,
      userId: result.user.id,
      userEmail: result.user.email,
      newValues: { role: result.user.role },
      ipAddress: store?.ipAddress,
      userAgent: store?.userAgent,
      requestId: store?.requestId,
    })

    res.status(200).json(result)
  } catch (err) {
    next(err)
  }
}

export const logout = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const store = asyncLocalStorage.getStore()

    // JWT is stateless — logout is client-side token discard.
    // We still log the event for audit purposes.
    addAuditLog({
      action: 'LOGOUT',
      resourceType: 'User',
      resourceId: req.user?.id,
      userId: req.user?.id,
      userEmail: req.user?.email,
      ipAddress: store?.ipAddress,
      userAgent: store?.userAgent,
      requestId: store?.requestId,
    })

    res.status(200).json({ message: 'Logged out successfully.' })
  } catch (err) {
    next(err)
  }
}

export const getMe = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user?.id) {
      throw new AppError(401, 'Unauthorized.')
    }

    const user = await getMeService(req.user.id)
    res.status(200).json(user)
  } catch (err) {
    next(err)
  }
}