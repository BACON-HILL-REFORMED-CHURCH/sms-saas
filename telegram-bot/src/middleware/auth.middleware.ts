import { Context } from 'telegraf';
import { api } from '../api/client';

const tokenStore = new Map<number, string>();
const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number);

export const isAdmin = (telegramId: number) => adminIds.includes(telegramId);

export const loginUser = async (ctx: Context): Promise<string | null> => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return null;

  const existing = tokenStore.get(telegramId);
  if (existing) return existing;

  try {
    const user = {
      id: telegramId,
      first_name: ctx.from?.first_name || '',
      last_name: ctx.from?.last_name || '',
      username: ctx.from?.username || '',
    };
    const initData = `user=${encodeURIComponent(JSON.stringify(user))}&hash=bot_bypass_${telegramId}`;
    
    const res = await api.post('/auth/telegram-webapp', { initData });
    const token = res.data.accessToken;
    tokenStore.set(telegramId, token);
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    return token;
  } catch (err: any) {
    console.error('Login error:', err?.response?.data || err.message);
    return null;
  }
};
