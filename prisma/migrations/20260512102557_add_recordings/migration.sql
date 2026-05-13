-- CreateTable
CREATE TABLE "Recording" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "nvrId" TEXT NOT NULL,
    "channel" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Recording_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recording_nvrId_channel_idx" ON "Recording"("nvrId", "channel");

-- CreateIndex
CREATE INDEX "Recording_startTime_idx" ON "Recording"("startTime");

-- AddForeignKey
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;
