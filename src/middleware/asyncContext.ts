import { AsyncLocalStorage } from 'async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export interface RequestContext {
  requestId: string;
  userId?: string;
  userEmail?: string;
  ipAddress?: string;
  userAgent?: string;
}

export const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

export const requestContextMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] as string || randomUUID();
  const ipAddress = req.ip || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];

  const context: RequestContext = {
    requestId,
    ipAddress,
    userAgent,
    // userId and userEmail will be populated after authentication middleware
  };

  asyncLocalStorage.run(context, () => {
    next();
  });
};
