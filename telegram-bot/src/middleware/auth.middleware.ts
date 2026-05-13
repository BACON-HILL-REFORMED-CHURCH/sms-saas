import { Context } from 'telegraf';
import { api } from '../api/client';

const tokenStore = new Map<number, string>();
const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number);
const BOT_SECRET = process.env.BOT_SECRET || 'sms-bot-secret-2024';

export const isAdmin = (telegramId: number) => adminIds.includes(telegramId);

export const loginUser = async (ctx: Context): Promise<string | null> => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return null;

  const existing = tokenStore.get(telegramId);
  if (existing) return existing;

  try {
    const res = await api.post('/auth/bot-login', {
      telegramId: String(telegramId),
      secret: BOT_SECRET,
      firstName: ctx.from?.first_name || '',
      username: ctx.from?.username || '',
    });

    const token = res.data.accessToken;
    tokenStore.set(telegramId, token);
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    return token;
  } catch (err: any) {
    console.error('Login error:', err?.response?.data || err.message);
    return null;
  }
};
