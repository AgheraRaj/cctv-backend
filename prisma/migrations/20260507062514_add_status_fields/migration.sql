-- CreateEnum
CREATE TYPE "NVRStatus" AS ENUM ('ONLINE', 'OFFLINE');

-- AlterTable
ALTER TABLE "Camera" ADD COLUMN     "isOnline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "offlineSince" TIMESTAMP(3),
ADD COLUMN     "protocol" TEXT;

-- AlterTable
ALTER TABLE "NVR" ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "offlineSince" TIMESTAMP(3),
ADD COLUMN     "status" "NVRStatus" NOT NULL DEFAULT 'OFFLINE';
