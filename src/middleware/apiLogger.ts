import { Request, Response, NextFunction } from 'express';
import { addAuditLog } from '../modules/audit/audit.queue.js';
import { AuthRequest } from './auth.js';
import { asyncLocalStorage } from './asyncContext.js';

export const apiLoggerMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const authReq = req as AuthRequest;

    // Use the route path if available (e.g. "/api/nvrs/:id"), otherwise fallback to generic path
    const routePath = req.route?.path || req.path;
    
    // Retrieve the context to get the requestId, userAgent, ipAddress
    const context = asyncLocalStorage.getStore();

    addAuditLog({
      action: req.method,
      resourceType: routePath,
      resourceId: undefined,
      userId: authReq.user?.id || undefined,
      userEmail: authReq.user?.email || undefined,
      userRole: authReq.user?.role || undefined,
      method: req.method,
      route: routePath,
      url: req.originalUrl,
      ipAddress: context?.ipAddress || req.ip,
      userAgent: context?.userAgent || req.get('user-agent'),
      requestId: context?.requestId || req.headers['x-request-id'] as string || undefined,
      statusCode: res.statusCode,
      responseTime: duration,
    });
  });

  next();
};
