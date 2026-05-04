import redis from '../config/redis.js'

export const setCache = async (
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> => {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
}

export const getCache = async <T>(key: string): Promise<T | null> => {
  const data = await redis.get(key)
  if (!data) return null
  return JSON.parse(data) as T
}

export const deleteCache = async (key: string): Promise<void> => {
  await redis.del(key)
}

export const deleteCacheByPattern = async (pattern: string): Promise<void> => {
  const keys = await redis.keys(pattern)
  if (keys.length > 0) {
    await redis.del(...keys)
  }
}