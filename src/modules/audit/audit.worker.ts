import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../../config/env.js';
import { connection } from '../../config/bullmq.js';

import { AuditLogPayload } from './audit.queue.js';

// We instantiate a dedicated PrismaClient for the audit worker that does
// NOT use the extended client from config/db.ts. This prevents a feedback
// loop where saving an audit log would trigger another audit log event.
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const auditPrisma = new PrismaClient({ adapter });

let auditWorker: Worker | null = null;

export const startAuditWorker = () => {
  if (auditWorker) return;

  auditWorker = new Worker<AuditLogPayload>(
    'audit-log-queue',
    async (job: Job<AuditLogPayload>) => {
      await auditPrisma.auditLog.create({
        data: {
          userId: job.data.userId ?? null,
          userEmail: job.data.userEmail ?? null,
          action: job.data.action,
          resourceType: job.data.resourceType,
          resourceId: job.data.resourceId ?? null,
          oldValues: job.data.oldValues ?? undefined,
          newValues: job.data.newValues ?? undefined,
          ipAddress: job.data.ipAddress ?? null,
          userAgent: job.data.userAgent ?? null,
          requestId: job.data.requestId ?? null,
          userRole: job.data.userRole ?? null,
          method: job.data.method ?? null,
          route: job.data.route ?? null,
          url: job.data.url ?? null,
          statusCode: job.data.statusCode ?? null,
          responseTime: job.data.responseTime ?? null,
        },
      });
    },
    { connection }
  );

  auditWorker.on('failed', (job, err) => {
    console.error(`[audit] Job ${job?.id} failed permanently: ${err.message}`);
  });

  console.log('✅ Audit log worker started');
};

export const stopAuditWorker = async () => {
  if (auditWorker) {
    await auditWorker.close();
    await auditPrisma.$disconnect();
    auditWorker = null;
    console.log('Audit log worker stopped');
  }
};
