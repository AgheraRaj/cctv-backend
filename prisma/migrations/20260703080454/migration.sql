-- DropIndex
DROP INDEX "Recording_nvrId_channel_idx";

-- RenameIndex
ALTER INDEX "Recording_startTime_endTime_idx" RENAME TO "Recording_nvrId_channel_startTime_endTime_idx";
