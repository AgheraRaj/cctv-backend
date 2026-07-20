import { Request, Response } from 'express';
import prisma from '../../config/db.js';

export const getAuditLogs = async (req: Request, res: Response) => {
  const { page = 1, limit = 50, userId, action, resourceType } = req.query;

  const pageNum = Math.max(1, parseInt(page as string, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10)));
  const skip = (pageNum - 1) * limitNum;

  const where: any = {};
  if (userId) where.userId = userId as string;
  if (action) where.action = action as string;
  if (resourceType) where.resourceType = resourceType as string;

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take: limitNum,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({
    data: logs,
    meta: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
    },
  });
};
