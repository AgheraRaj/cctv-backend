import prisma from "../../config/db.js";
import { AppError } from "../../middleware/errorHandler.js";
import { decrypt } from "../../utils/crypto.js";
import { env } from "../../config/env.js";
import { generatePlaybackRTSP } from "./playback.generator.js";
import { provisionPath, removePath } from "../streams/mediamtx.client.js";
import { searchHikvisionRecordings } from "./hikvision.search.js";
// import { searchHifocusRecordings } from './hifocus.search.js'
import type { RecordingSegment } from "./hikvision.search.js";

// ─── Resolve Playback ────────────────────────────────────────────────────────

export interface PlaybackResult {
  whepUrl: string;
  pathName: string;
}

export const resolvePlayback = async (
  nvrId: string,
  channel: number,
  startTime: Date,
  endTime: Date,
): Promise<PlaybackResult> => {
  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } });
  if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`);

  const camera = await prisma.camera.findUnique({
    where: { nvrId_channel: { nvrId, channel } },
  });
  if (!camera) throw new AppError(404, `No camera on channel ${channel}.`);
  if (!camera.isActive)
    throw new AppError(400, `Camera on channel ${channel} is inactive.`);

  const decryptedPassword = decrypt(nvr.password);

  const rtspUrl = generatePlaybackRTSP(
    {
      username: nvr.username,
      password: decryptedPassword,
      ip: nvr.ip,
      rtspPort: nvr.rtspPort,
      type: nvr.type,
    },
    channel,
    startTime,
    endTime,
  );

  // Each playback session gets a unique path — multiple ranges can be played simultaneously
  const timestamp = Date.now();
  const pathName = `${nvrId}-ch${channel}-pb-${timestamp}`;

  await provisionPath(pathName, rtspUrl, {
    // Playback sessions close faster than live streams — viewer won't keep watching long
    sourceOnDemandCloseAfter: "60s",
  });

  const whepUrl = `${env.MEDIAMTX_WEBRTC_URL}/${pathName}/whep`;

  return { whepUrl, pathName };
};

// ─── Stop Playback ───────────────────────────────────────────────────────────

export const stopPlayback = async (pathName: string): Promise<void> => {
  // Only allow removing paths that look like playback paths (safety guard)
  if (!pathName.includes("-pb-")) {
    throw new AppError(400, "Invalid playback path name.");
  }
  await removePath(pathName);
};

// ─── Search Recordings ───────────────────────────────────────────────────────

export const getRecordings = async (
  nvrId: string,
  channel: number,
  date: string, // "2026-05-12"
): Promise<RecordingSegment[]> => {
  const nvr = await prisma.nVR.findUnique({ where: { id: nvrId } });
  if (!nvr) throw new AppError(404, `NVR ${nvrId} not found.`);

  // Build full-day time range from the date string
  const startTime = new Date(`${date}T00:00:00Z`)
  const endTime = new Date(`${date}T23:59:59Z`)

  // const startTime = new Date(`${date}T14:58:23Z`); 
  // const endTime = new Date(`${date}T15:19:14Z`); 

  if (isNaN(startTime.getTime())) {
    throw new AppError(400, "Invalid date format. Expected YYYY-MM-DD.");
  }

  const decryptedPassword = decrypt(nvr.password);

  if (nvr.type === "HIKVISION") {
    return searchHikvisionRecordings(
      nvr.ip,
      nvr.httpPort,
      nvr.username,
      decryptedPassword,
      channel,
      startTime,
      endTime,
    );
  }

  // if (nvr.type === 'HIFOCUS') {
  //   return searchHifocusRecordings(
  //     nvr.ip,
  //     nvr.httpPort,
  //     nvr.username,
  //     decryptedPassword,
  //     channel,
  //     startTime,
  //     endTime
  //   )
  // }

  if (nvr.type === "HIFOCUS") {
    throw new AppError(
      400,
      "Playback is not supported for Hifocus NVRs without a hard disk installed.",
    );
  }

  throw new AppError(400, `Unsupported NVR type: ${nvr.type}`);
};
