import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_EXPIRES_IN: z.string().default("7d"),

  AES_SECRET_KEY: z.string().length(32, "AES_SECRET_KEY must be exactly 32 characters"),

  MEDIAMTX_API_URL: z.string().min(1, "MEDIAMTX_API_URL is required"),
  MEDIAMTX_WEBRTC_URL: z.string().min(1, "MEDIAMTX_WEBRTC_URL is required"),
  
  RECORDINGS_PATH: z.string().min(1, 'RECORDINGS_PATH is required'),
  
  RECORDING_TOKEN_SECRET: z.string().min(1, "RECORDING_TOKEN_SECRET is required"),
  RECORDING_TOKEN_EXPIRES_IN: z.string().default("300"),
});

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('❌ Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1);
}

export const env = parsed.data