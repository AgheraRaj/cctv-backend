-- NVR-based playback: recordings live on the NVR HDD, not our filesystem.
-- Replace the file-centric columns with NVR-centric ones.

ALTER TABLE "Recording"
  DROP COLUMN IF EXISTS "filename",
  DROP COLUMN IF EXISTS "filePath",
  DROP COLUMN IF EXISTS "sizeBytes";

ALTER TABLE "Recording"
  ADD COLUMN IF NOT EXISTS "recordingToken" TEXT,        -- ONVIF token (e.g. "Record_1_0")
  ADD COLUMN IF NOT EXISTS "isOngoing"      BOOLEAN NOT NULL DEFAULT false;

-- Index for fast "what's recorded for channel X on date Y" queries
CREATE INDEX IF NOT EXISTS "Recording_startTime_endTime_idx"
  ON "Recording" ("nvrId", "channel", "startTime", "endTime");