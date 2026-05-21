import { Context } from 'telegraf';
import { api } from '../api/client';
import Redis from 'ioredis';

const getRedisConfig = () => {
  const url = process.env.REDIS_URL;
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || 6379,
      password: parsed.password || undefined,
      username: parsed.username || undefined,
    };
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  };
};

const redis = new Redis(getRedisConfig());
const TOKEN_TTL = 86400; // 24 hours in seconds
const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number);

export const isAdmin = (telegramId: number) => adminIds.includes(telegramId);

export const loginUser = async (ctx: Context): Promise<string | null> => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return null;

  try {
    // Try to get token from Redis
    const redisKey = `tg_token:${telegramId}`;
    const existing = await redis.get(redisKey);
    if (existing) {
      api.defaults.headers.common['Authorization'] = `Bearer ${existing}`;
      return existing;
    }

    // Token not found, login to get new token
    const user = {
      id: telegramId,
      first_name: ctx.from?.first_name || '',
      last_name: ctx.from?.last_name || '',
      username: ctx.from?.username || '',
    };
    const initData = `user=${encodeURIComponent(JSON.stringify(user))}&hash=bot_bypass_${telegramId}`;

    const res = await api.post('/auth/telegram-webapp', { initData });
    const token = res.data.data?.accessToken || res.data.accessToken;

    // Store token in Redis with TTL
    await redis.set(redisKey, token, 'EX', TOKEN_TTL);
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    return token;
  } catch (err: any) {
    console.error('Login error:', err?.response?.data || err.message);
    return null;
  }
};
