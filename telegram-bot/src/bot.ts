import { Telegraf, session } from 'telegraf';
import * as dotenv from 'dotenv';
dotenv.config();

import { mainKeyboard, adminKeyboard } from './keyboards/main.keyboard';
import { loginUser, isAdmin } from './middleware/auth.middleware';
import { walletApi, ordersApi, rechargeApi, adminApi } from './api/client';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

bot.use(session());

// ── /start ─────────────────────────────────────────────
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

// ── 💰 Balance ─────────────────────────────────────────
bot.hears('💰 Balance', async (ctx) => {
  const token = await loginUser(ctx);
  if (!token) return ctx.reply('❌ Please restart: /start');

  try {
    const res = await walletApi.getBalance();
    const { balance, balanceFormatted } = res.data;
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

// ── 📋 My Orders ───────────────────────────────────────
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

// ── 💳 Recharge ────────────────────────────────────────
bot.hears('💳 Recharge', async (ctx) => {
  await ctx.reply(
    `💳 *Recharge Methods*\n\n` +
    `1️⃣ Binance ID\n` +
    `2️⃣ USDT TRC20\n` +
    `3️⃣ IBAN\n` +
    `4️⃣ CIH Bank\n\n` +
    `Send payment then use /recharge to submit request.`,
    { parse_mode: 'Markdown' }
  );
});

// ── 👤 Profile ─────────────────────────────────────────
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

// ── 🎧 Support ─────────────────────────────────────────
bot.hears('🎧 Support', async (ctx) => {
  await ctx.reply(
    `🎧 *Support*\n\n` +
    `Send your message and our team will reply ASAP.\n\n` +
    `Type /support followed by your message.`,
    { parse_mode: 'Markdown' }
  );
});

// ── ⚙️ Admin Panel ─────────────────────────────────────
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

// ── /pending ───────────────────────────────────────────
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

// ── /approve ───────────────────────────────────────────
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

// ── /reject ────────────────────────────────────────────
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

// ── Launch ─────────────────────────────────────────────
bot.launch(() => console.log('🤖 Bot started!'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
