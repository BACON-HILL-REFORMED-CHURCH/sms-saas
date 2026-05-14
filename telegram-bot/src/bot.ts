import { Telegraf, session, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import * as dotenv from 'dotenv';
dotenv.config();

import { mainKeyboard, adminKeyboard, cancelKeyboard, rechargeMethodKeyboard } from './keyboards/main.keyboard';
import { loginUser, isAdmin } from './middleware/auth.middleware';
import { walletApi, ordersApi, rechargeApi, adminApi } from './api/client';

// ── Session types ──────────────────────────────────────────────────
interface SessionData {
  rechargeStep?: 'method' | 'amount' | 'txid';
  rechargeMethod?: string;
  rechargeAmount?: number;
}

interface BotContext extends Context {
  session: SessionData;
}

const METHOD_LABEL: Record<string, string> = {
  '💛 Binance ID': 'BINANCE',
  '💚 USDT TRC20': 'USDT',
  '🏦 IBAN': 'IBAN',
  '🏧 CIH Bank': 'CIH',
};

const METHOD_DISPLAY: Record<string, string> = {
  BINANCE: '💛 Binance ID',
  USDT: '💚 USDT TRC20',
  IBAN: '🏦 IBAN',
  CIH: '🏧 CIH Bank',
};

// ── Bot setup ──────────────────────────────────────────────────────
const bot = new Telegraf<BotContext>(process.env.TELEGRAM_BOT_TOKEN!);

bot.use(session());

// ── /start ─────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const token = await loginUser(ctx);
  if (!token) {
    return ctx.reply('❌ Error connecting. Please try again.');
  }

  const name = ctx.from?.first_name || 'User';
  const admin = isAdmin(ctx.from!.id);
  const keyboard = admin ? adminKeyboard : mainKeyboard;

  await ctx.reply(
    `👋 Welcome *${name}*!\n\n` +
    `This is your SMS activation platform.\n` +
    `Choose an option below:`,
    { parse_mode: 'Markdown', ...keyboard }
  );
});

// ── 💰 Balance ─────────────────────────────────────────────────────
bot.hears('💰 Balance', async (ctx) => {
  const token = await loginUser(ctx);
  if (!token) return ctx.reply('❌ Please restart: /start');

  try {
    const res = await walletApi.getBalance();
    const { balanceFormatted } = res.data;
    await ctx.reply(
      `💰 *Your Balance*\n\n` +
      `Amount: *${balanceFormatted}*\n\n` +
      `To add funds, use 💳 Recharge`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    ctx.reply('❌ Error fetching balance.');
  }
});

// ── 📋 My Orders ───────────────────────────────────────────────────
bot.hears('📋 My Orders', async (ctx) => {
  const token = await loginUser(ctx);
  if (!token) return ctx.reply('❌ Please restart: /start');

  try {
    const res = await ordersApi.list();
    const orders = res.data.orders;
    if (!orders.length) return ctx.reply('📋 No orders yet.');

    const text = orders.slice(0, 5).map((o: any) =>
      `📱 *${o.service}* — ${o.country}\n` +
      `Status: ${o.status}\n` +
      `${o.smsCode ? `Code: \`${o.smsCode}\`` : 'Waiting for SMS...'}`
    ).join('\n\n');

    ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    ctx.reply('❌ Error fetching orders.');
  }
});

// ── 💳 Recharge / /recharge — start conversation flow ─────────────
async function startRecharge(ctx: BotContext) {
  ctx.session = { rechargeStep: 'method' };
  await ctx.reply(
    `💳 *Recharge Request*\n\n` +
    `Select your payment method:`,
    { parse_mode: 'Markdown', ...rechargeMethodKeyboard }
  );
}

bot.hears('💳 Recharge', (ctx) => startRecharge(ctx));
bot.command('recharge', (ctx) => startRecharge(ctx));

// ── Method selection ───────────────────────────────────────────────
Object.keys(METHOD_LABEL).forEach((label) => {
  bot.hears(label, async (ctx) => {
    if (ctx.session?.rechargeStep !== 'method') {
      return ctx.reply('Please use /recharge to start a recharge request.');
    }
    ctx.session.rechargeMethod = METHOD_LABEL[label];
    ctx.session.rechargeStep = 'amount';
    await ctx.reply(
      `✅ Method: *${label}*\n\n` +
      `Enter the amount in USD (e.g. 10):`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
    );
  });
});

// ── ❌ Cancel ──────────────────────────────────────────────────────
bot.hears('❌ Cancel', async (ctx) => {
  ctx.session = {};
  const admin = isAdmin(ctx.from!.id);
  const keyboard = admin ? adminKeyboard : mainKeyboard;
  await ctx.reply('❌ Cancelled.', keyboard);
});

// ── 👤 Profile ─────────────────────────────────────────────────────
bot.hears('👤 Profile', async (ctx) => {
  const name = ctx.from?.first_name || '';
  const username = ctx.from?.username ? `@${ctx.from.username}` : 'N/A';
  const id = ctx.from?.id;

  ctx.reply(
    `👤 *Your Profile*\n\n` +
    `Name: ${name}\n` +
    `Username: ${username}\n` +
    `Telegram ID: \`${id}\``,
    { parse_mode: 'Markdown' }
  );
});

// ── 🎧 Support ─────────────────────────────────────────────────────
bot.hears('🎧 Support', async (ctx) => {
  await ctx.reply(
    `🎧 *Support*\n\n` +
    `Send your message and our team will reply ASAP.\n\n` +
    `Type /support followed by your message.`,
    { parse_mode: 'Markdown' }
  );
});

// ── ⚙️ Admin Panel ─────────────────────────────────────────────────
bot.hears('⚙️ Admin Panel', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return ctx.reply('❌ Unauthorized');

  const token = await loginUser(ctx);
  if (!token) return ctx.reply('❌ Error');

  try {
    const res = await adminApi.getAllRecharges('PENDING');
    const pending = res.data;
    await ctx.reply(
      `⚙️ *Admin Panel*\n\n` +
      `📥 Pending recharges: *${pending.length}*\n\n` +
      `Commands:\n` +
      `/pending — view pending recharges\n` +
      `/approve [id] — approve recharge\n` +
      `/reject [id] [reason] — reject recharge`,
      { parse_mode: 'Markdown' }
    );
  } catch {
    ctx.reply('❌ Error loading admin panel.');
  }
});

// ── /pending ───────────────────────────────────────────────────────
bot.command('pending', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return ctx.reply('❌ Unauthorized');
  const token = await loginUser(ctx);
  if (!token) return ctx.reply('❌ Error');

  try {
    const res = await adminApi.getAllRecharges('PENDING');
    const list = res.data;
    if (!list.length) return ctx.reply('✅ No pending recharges!');

    const text = list.map((r: any) =>
      `🆔 \`${r.id}\`\n` +
      `👤 ${r.user?.email}\n` +
      `💰 ${r.amount / 100}$ — ${r.method}\n` +
      `📎 ${r.txid || 'No txid'}`
    ).join('\n\n');

    ctx.reply(text, { parse_mode: 'Markdown' });
  } catch {
    ctx.reply('❌ Error.');
  }
});

// ── /approve ───────────────────────────────────────────────────────
bot.command('approve', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return ctx.reply('❌ Unauthorized');
  const token = await loginUser(ctx);
  if (!token) return ctx.reply('❌ Error');

  const id = ctx.message.text.split(' ')[1];
  if (!id) return ctx.reply('Usage: /approve [id]');

  try {
    await adminApi.reviewRecharge(id, { status: 'APPROVED' });
    ctx.reply(`✅ Recharge *${id}* approved!`, { parse_mode: 'Markdown' });
  } catch (err: any) {
    ctx.reply(`❌ Error: ${err?.response?.data?.message || err.message}`);
  }
});

// ── /reject ────────────────────────────────────────────────────────
bot.command('reject', async (ctx) => {
  if (!isAdmin(ctx.from!.id)) return ctx.reply('❌ Unauthorized');
  const token = await loginUser(ctx);
  if (!token) return ctx.reply('❌ Error');

  const parts = ctx.message.text.split(' ');
  const id = parts[1];
  const reason = parts.slice(2).join(' ') || 'Rejected by admin';
  if (!id) return ctx.reply('Usage: /reject [id] [reason]');

  try {
    await adminApi.reviewRecharge(id, { status: 'REJECTED', adminNote: reason });
    ctx.reply(`❌ Recharge *${id}* rejected.`, { parse_mode: 'Markdown' });
  } catch (err: any) {
    ctx.reply(`❌ Error: ${err?.response?.data?.message || err.message}`);
  }
});

// ── Free-text handler — recharge amount & txid steps ──────────────
bot.on(message('text'), async (ctx) => {
  const step = ctx.session?.rechargeStep;
  if (!step) return;

  const text = ctx.message.text.trim();

  if (step === 'amount') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 1) {
      return ctx.reply('❌ Please enter a valid amount (minimum $1):');
    }
    ctx.session.rechargeAmount = amount;
    ctx.session.rechargeStep = 'txid';
    await ctx.reply(
      `✅ Amount: *$${amount}*\n\n` +
      `Enter your transaction ID (txid) or reference number:`,
      { parse_mode: 'Markdown', ...cancelKeyboard }
    );
    return;
  }

  if (step === 'txid') {
    const token = await loginUser(ctx);
    if (!token) {
      ctx.session = {};
      return ctx.reply('❌ Authentication error. Please restart: /start');
    }

    const { rechargeMethod, rechargeAmount } = ctx.session;

    try {
      await rechargeApi.create({
        method: rechargeMethod,
        amountUsd: rechargeAmount,
        txid: text,
      });

      ctx.session = {};

      const admin = isAdmin(ctx.from!.id);
      const keyboard = admin ? adminKeyboard : mainKeyboard;

      await ctx.reply(
        `✅ *Recharge Request Submitted!*\n\n` +
        `Method: ${METHOD_DISPLAY[rechargeMethod!] || rechargeMethod}\n` +
        `Amount: *$${rechargeAmount}*\n` +
        `TxID: \`${text}\`\n` +
        `Status: *PENDING* ⏳\n\n` +
        `Our team will review and approve within 24h.`,
        { parse_mode: 'Markdown', ...keyboard }
      );
    } catch (err: any) {
      ctx.session = {};
      const admin = isAdmin(ctx.from!.id);
      const keyboard = admin ? adminKeyboard : mainKeyboard;
      const msg = err?.response?.data?.message || err.message || 'Unknown error';
      await ctx.reply(`❌ Error submitting request: ${msg}`, keyboard);
    }
  }
});

// ── Launch ─────────────────────────────────────────────────────────
bot.launch(() => console.log('🤖 Bot started!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
