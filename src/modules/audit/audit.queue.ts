import { Queue } from 'bullmq';
import { connection } from '../../config/bullmq.js';

export interface AuditLogPayload {
  userId?: string;
  userEmail?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  oldValues?: any;
  newValues?: any;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
  userRole?: string;
  method?: string;
  route?: string;
  url?: string;
  statusCode?: number;
  responseTime?: number;
}

export const auditLogQueue = new Queue<AuditLogPayload>('audit-log-queue', {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 100,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
});

export const addAuditLog = (payload: AuditLogPayload): void => {
  // Fire-and-forget: intentionally not awaited so audit logging never
  // blocks the critical path of any request or background job.
  auditLogQueue.add('log-action', payload).catch((err) => {
    console.error('[audit] Failed to enqueue audit log:', err);
  });
};
