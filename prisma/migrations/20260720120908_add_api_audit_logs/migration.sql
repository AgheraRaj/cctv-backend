-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "method" TEXT,
ADD COLUMN     "responseTime" INTEGER,
ADD COLUMN     "route" TEXT,
ADD COLUMN     "statusCode" INTEGER,
ADD COLUMN     "url" TEXT,
ADD COLUMN     "userRole" TEXT;
