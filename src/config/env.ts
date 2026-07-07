import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("3000"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  AES_SECRET_KEY: z
    .string()
    .length(32, "AES_SECRET_KEY must be exactly 32 characters"),

  MEDIAMTX_API_URL: z.string().min(1, "MEDIAMTX_API_URL is required"),
  MEDIAMTX_WEBRTC_URL: z.string().min(1, "MEDIAMTX_WEBRTC_URL is required"),
  MEDIAMTX_HLS_URL: z.string().min(1, "MEDIAMTX_HLS_URL is required"),
  BACKEND_PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  // ── Playback tuning (all optional, sane defaults) ───────────────────────────
  PLAYBACK_ORPHAN_GRACE_MS: z.coerce.number().int().positive().default(60_000),
  PLAYBACK_RESUME_RESEEK_THRESHOLD_MS: z.coerce.number().int().positive().default(15_000),
  PLAYBACK_NVR_SLOT_RELEASE_MS: z.coerce.number().int().positive().default(1_500),
  PLAYBACK_PATH_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PLAYBACK_MEDIAMTX_API_RETRIES: z.coerce.number().int().min(0).default(2),
  PLAYBACK_SEARCH_RETRIES: z.coerce.number().int().min(0).default(2),
  PLAYBACK_SEARCH_MAX_CONCURRENCY: z.coerce.number().int().positive().default(5),
  PLAYBACK_RECORDING_INFO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;