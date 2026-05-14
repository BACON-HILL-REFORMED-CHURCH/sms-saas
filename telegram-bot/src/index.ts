// ============================================================
// SMS Shop — Telegram Bot
// Direct SMSPool API integration (no backend for SMS orders)
// Backend used only for: Auth, Wallet, eSIM, Admin
// ============================================================

import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import crypto from 'crypto';
import express from 'express';
import path from 'path';
import fs from 'fs';

// ── Config ────────────────────────────────────────────────────
const BOT_TOKEN          = process.env.TELEGRAM_BOT_TOKEN!;
const API_URL            = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '') + '/api/v1';
const SMSPOOL_KEY        = process.env.SMSPOOL_API_KEY ?? '';
const MARKUP_PERCENT     = parseFloat(process.env.MARKUP_PERCENT ?? '50');
const CREDITS_PER_USD    = 100;   // 100 credits = $1
const REFERRAL_BONUS     = parseInt(process.env.REFERRAL_BONUS ?? '100');
const POLL_INTERVAL      = 30_000;
const POLL_MAX           = 20;
const CRYPTOMUS_MERCHANT = process.env.CRYPTOMUS_MERCHANT_ID ?? '';
const CRYPTOMUS_KEY      = process.env.CRYPTOMUS_API_KEY ?? '';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
console.log(`🤖 API: ${API_URL} | SMSPool: ${SMSPOOL_KEY ? '✅' : '❌'} | Cryptomus: ${CRYPTOMUS_MERCHANT ? '✅' : '❌'}`);

// ── Types ─────────────────────────────────────────────────────
interface UserSession  { token: string; email: string; role: string; userId: string; }
interface PendingState { state: string; data: Record<string, string>; }
interface Coupon       { amount: number; maxUses: number; usesLeft: number; usedBy: Set<number>; }

interface SMSLocalOrder {
  orderId:     string;
  phoneNumber: string;
  service:     string;
  country:     string;
  credits:     number;
  status:      'pending' | 'received' | 'canceled' | 'expired';
  smsCode?:    string;
  smsText?:    string;
}

interface SMSCountry { ID: string; name: string; short_name: string; }
interface SMSService  { ID: string; name: string; short_name: string; }

// ── Storage ───────────────────────────────────────────────────
const sessions    = new Map<number, UserSession>();
const pending     = new Map<number, PendingState>();
const coupons     = new Map<string, Coupon>();
const referrals   = new Map<number, number>();
const referred    = new Set<number>();
const activePolls    = new Map<string, NodeJS.Timeout>();
const smsOrders      = new Map<string, SMSLocalOrder>();
const userOrders     = new Map<number, string[]>();
const paymentPolls   = new Map<string, NodeJS.Timeout>(); // uuid → interval
const pendingDeposits= new Map<string, { chatId: number; amountUsd: number; credits: number }>(); // uuid → info

let botAdminToken: string | null  = null;
let botUsername                   = 'smsshopbot';
let countryCache: SMSCountry[]    = [];
let serviceCache: SMSService[]    = [];
let cacheTime                     = 0;
const CACHE_TTL                   = 3_600_000; // 1h

// ── Backend API helper ────────────────────────────────────────
function makeApi(token?: string) {
  return axios.create({
    baseURL: API_URL, timeout: 15_000,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
}
function unwrap(res: any): any {
  return res.data?.success === true && 'data' in res.data ? res.data.data : res.data;
}
function errMsg(err: any): string {
  const msg = err?.response?.data?.message;
  return Array.isArray(msg) ? msg.join(', ') : typeof msg === 'string' ? msg : (err?.message ?? 'Unknown error');
}

// ── SMSPool API helper ────────────────────────────────────────
function smsPost(path: string, data: Record<string, string> = {}) {
  const body = new URLSearchParams({ key: SMSPOOL_KEY, ...data });
  return axios.post(`https://api.smspool.net${path}`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15_000,
  });
}

async function getSMSCountries(): Promise<SMSCountry[]> {
  if (countryCache.length && Date.now() - cacheTime < CACHE_TTL) return countryCache;
  try {
    const res  = await axios.post('https://api.smspool.net/country/retrieve_all', '');
    const data = res.data;
    countryCache = Array.isArray(data) ? data : Object.values(data);
    cacheTime    = Date.now();
  } catch {}
  return countryCache;
}

async function getSMSServices(): Promise<SMSService[]> {
  if (serviceCache.length) return serviceCache;
  try {
    const res  = await axios.post('https://api.smspool.net/service/retrieve_all', '');
    const data = res.data;
    serviceCache = Array.isArray(data) ? data : Object.values(data);
  } catch {}
  return serviceCache;
}

// ── SMSPool eSIM API ──────────────────────────────────────────
interface EsimCountry { name: string; short_name: string; }
interface EsimPlan    { plan_id: string; name?: string; data: string; validity: string; price: string; }

let esimCountryCache: EsimCountry[] = [];
let esimCacheTime = 0;

async function getEsimCountries(): Promise<EsimCountry[]> {
  if (esimCountryCache.length && Date.now() - esimCacheTime < CACHE_TTL) return esimCountryCache;
  try {
    const res  = await smsPost('/esim/retrieve_countries');
    const data = res.data;
    esimCountryCache = Array.isArray(data) ? data : Object.values(data);
    esimCacheTime    = Date.now();
  } catch (e) { console.error('eSIM countries error:', e); }
  return esimCountryCache;
}

async function getEsimPlans(country: string): Promise<EsimPlan[]> {
  try {
    const res  = await smsPost('/esim/retrieve_plans', { country });
    const data = res.data;
    return Array.isArray(data) ? data : Object.values(data);
  } catch { return []; }
}

// Apply markup to eSIM plan price ($)
function esimToCredits(usd: number): number {
  return Math.ceil(usd * CREDITS_PER_USD * (1 + MARKUP_PERCENT / 100));
}

// Parse GB from SMSPool data string (e.g. "5 GB", "500 MB", "10240 MB")
function parseGb(dataStr: string): number {
  if (!dataStr) return 0;
  const s = dataStr.trim().toUpperCase();
  const n = parseFloat(s);
  if (s.includes('MB'))  return Math.round(n / 1024 * 10) / 10;
  if (s.includes('GB'))  return n;
  return n; // assume GB
}

// SMSPool price ($) → credits with markup
function toCredits(usd: number): number {
  return Math.ceil(usd * CREDITS_PER_USD * (1 + MARKUP_PERCENT / 100));
}

// Auto-login to get admin token for balance deductions
async function tryAutoAdminLogin() {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  try {
    const res    = await makeApi().post('/auth/login', { email, password });
    const result = unwrap(res);
    if (result.user?.role === 'ADMIN') {
      botAdminToken = result.accessToken;
      console.log('✅ Admin auto-login successful');
    }
  } catch (e) { console.log('⚠️ Admin auto-login failed:', errMsg(e)); }
}

// ── Cryptomus helpers ─────────────────────────────────────────
function cryptomusSign(body: object, apiKey: string): string {
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
  return crypto.createHash('md5').update(encoded + apiKey).digest('hex');
}

async function createCryptomusPayment(orderId: string, amountUsd: number) {
  const body = {
    amount:   amountUsd.toFixed(2),
    currency: 'USD',
    order_id: orderId,
    lifetime: 3600,
    url_return: '',
  };
  const sign = cryptomusSign(body, CRYPTOMUS_KEY);
  const res  = await axios.post('https://api.cryptomus.com/v1/payment', body, {
    headers: { merchant: CRYPTOMUS_MERCHANT, sign, 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
  return res.data?.result ?? res.data;
}

async function checkCryptomusPayment(uuid: string) {
  const body = { uuid };
  const sign = cryptomusSign(body, CRYPTOMUS_KEY);
  const res  = await axios.post('https://api.cryptomus.com/v1/payment/info', body, {
    headers: { merchant: CRYPTOMUS_MERCHANT, sign, 'Content-Type': 'application/json' },
    timeout: 15_000,
  });
  return res.data?.result ?? res.data;
}

function startPaymentPolling(uuid: string) {
  if (paymentPolls.has(uuid)) return;
  const info   = pendingDeposits.get(uuid);
  if (!info) return;
  let attempts = 0;

  const t = setInterval(async () => {
    attempts++;
    if (attempts > 120) { // 1 hour max
      clearInterval(t); paymentPolls.delete(uuid); pendingDeposits.delete(uuid);
      try { await bot.telegram.sendMessage(info.chatId, `⏰ Payment expired. Your deposit session timed out. Tap 💳 Deposit to try again.`); } catch {}
      return;
    }
    try {
      const data   = await checkCryptomusPayment(uuid);
      const status = data?.payment_status ?? data?.status ?? '';
      if (status === 'paid' || status === 'paid_over' || status === 'wrong_amount_waiting') {
        // Only credit if fully paid
        if (status !== 'wrong_amount_waiting') {
          clearInterval(t); paymentPolls.delete(uuid); pendingDeposits.delete(uuid);
          const session = sessions.get(info.chatId);
          if (botAdminToken && session) {
            try {
              await makeApi(botAdminToken).post('/admin/balance/adjust', {
                userId: session.userId,
                amount: info.credits,
                reason: `Crypto deposit — $${info.amountUsd.toFixed(2)} USD`,
              });
            } catch (e) { console.error('Deposit credit failed:', errMsg(e)); }
          }
          await bot.telegram.sendMessage(info.chatId,
            `💰 *Deposit Confirmed!*\n\n` +
            `✅ Payment received: *$${info.amountUsd.toFixed(2)} USD*\n` +
            `💎 *+${info.credits} credits* added to your balance!\n\n` +
            `Happy shopping 🛒`,
            { parse_mode: 'Markdown' },
          );
        }
      } else if (status === 'cancel' || status === 'expired' || status === 'fail') {
        clearInterval(t); paymentPolls.delete(uuid); pendingDeposits.delete(uuid);
        await bot.telegram.sendMessage(info.chatId, `❌ Payment canceled or expired. Tap 💳 Deposit to try again.`);
      }
    } catch {}
  }, 30_000); // check every 30 seconds

  paymentPolls.set(uuid, t);
}

// ── Keyboards ─────────────────────────────────────────────────
function getKeyboard(role: string) {
  const appUrl = process.env.BOT_PUBLIC_URL
    ? `${process.env.BOT_PUBLIC_URL.replace(/\/$/, '')}/app`
    : null;

  const rows: any[] = [
    ['💰 Balance',       '💳 Deposit'],
    ['📱 Buy Number',    '📡 eSIM'],
    ['📋 My Orders',     '🎟️ Redeem Coupon'],
    ['👥 Referral',      role === 'ADMIN' ? '⚙️ Admin Panel' : '🚪 Logout'],
  ];

  if (role === 'ADMIN') rows.push(['🚪 Logout']);

  if (appUrl) {
    rows.unshift([Markup.button.webApp('🌐 Open App', appUrl)]);
  }

  return Markup.keyboard(rows).resize();
}

// ── Flag helper ───────────────────────────────────────────────
const FLAGS: Record<string, string> = {
  us:'🇺🇸', gb:'🇬🇧', ru:'🇷🇺', ua:'🇺🇦', pl:'🇵🇱', de:'🇩🇪', fr:'🇫🇷',
  in:'🇮🇳', br:'🇧🇷', ph:'🇵🇭', id:'🇮🇩', vn:'🇻🇳', ng:'🇳🇬', pk:'🇵🇰',
  tr:'🇹🇷', es:'🇪🇸', it:'🇮🇹', nl:'🇳🇱', se:'🇸🇪', ro:'🇷🇴', mx:'🇲🇽',
  co:'🇨🇴', ca:'🇨🇦', au:'🇦🇺', za:'🇿🇦', ae:'🇦🇪', sa:'🇸🇦', ma:'🇲🇦',
  eg:'🇪🇬', tn:'🇹🇳', ke:'🇰🇪', cn:'🇨🇳', jp:'🇯🇵', kr:'🇰🇷', ar:'🇦🇷',
  bd:'🇧🇩', pt:'🇵🇹', gr:'🇬🇷', cz:'🇨🇿', hu:'🇭🇺',
};
const flag = (code: string) => FLAGS[code?.toLowerCase()] ?? '🌍';

// Popular country short names (order matters — shown first)
const POPULAR_SHORT = [
  'US','GB','RU','UA','PL','DE','FR','IN','BR','PH',
  'ID','VN','NG','PK','TR','ES','IT','NL','SE','RO',
  'MX','CO','CA','AU','ZA','AE','SA','MA','EG','KE',
  'CN','JP','KR','AR','BD',
];

// Popular services to show
const POPULAR_SERVICES = [
  'WhatsApp','Telegram','Facebook','Instagram','Google','TikTok',
  'Snapchat','Twitter','Discord','Amazon','Microsoft','Viber',
  'Signal','LinkedIn','Uber','Netflix','Spotify','PayPal',
  'Apple','Tinder','Airbnb','Steam','Binance','Coinbase',
];

// ── Bot ───────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

bot.telegram.getMe().then((me) => { botUsername = me.username ?? botUsername; });

// ════════════════════════════════════════════════════════════════
// /start
// ════════════════════════════════════════════════════════════════
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  pending.delete(chatId);

  const payload = ctx.startPayload;
  if (payload?.startsWith('ref_')) {
    const ref = parseInt(payload.replace('ref_', ''));
    if (ref && ref !== chatId && !referrals.has(chatId)) referrals.set(chatId, ref);
  }

  const session = sessions.get(chatId);
  if (session) {
    const appUrl = process.env.BOT_PUBLIC_URL
      ? `${process.env.BOT_PUBLIC_URL.replace(/\/$/, '')}/app`
      : null;
    const inlineButtons: any[] = appUrl
      ? [[Markup.button.webApp('🌐 Open Dashboard', appUrl)]]
      : [];
    await ctx.reply(
      `👋 Welcome back, *${session.email}*!\n\nUse the menu below or open your dashboard.`,
      { parse_mode:'Markdown', ...getKeyboard(session.role) },
    );
    if (inlineButtons.length) {
      await ctx.reply('Open the full app:', Markup.inlineKeyboard(inlineButtons));
    }
    return;
  }

  await ctx.reply(
    `🎉 *Welcome to SMS Shop!*\n\n` +
    `📲 Buy virtual phone numbers to verify any app.\n` +
    `📡 eSIM data plans for travelers.\n` +
    `⚡ Instant delivery at the best prices.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Login',         'do_login')],
        [Markup.button.callback('✨ Create Account', 'do_register')],
      ]),
    },
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *SMS Shop — Help*\n\n` +
    `*How to buy a number:*\n` +
    `1. Tap 📱 Buy Number\n` +
    `2. Select country\n` +
    `3. Select service (WhatsApp, Telegram...)\n` +
    `4. Confirm purchase\n` +
    `5. Get your number + wait for SMS automatically! 🔔\n\n` +
    `*Credits:* 100 credits = $1.00\n` +
    `*Referral:* Earn ${REFERRAL_BONUS} credits per friend\n\n` +
    `_Contact admin to top up your balance._`,
    { parse_mode: 'Markdown' },
  );
});

// ── Auth ──────────────────────────────────────────────────────
bot.action('do_login',    async (ctx) => { pending.set(ctx.chat!.id, {state:'login_email',    data:{}}); await ctx.reply('📧 Enter your email:');  await ctx.answerCbQuery(); });
bot.action('do_register', async (ctx) => { pending.set(ctx.chat!.id, {state:'register_email', data:{}}); await ctx.reply('📧 Enter your email:'); await ctx.answerCbQuery(); });

// ════════════════════════════════════════════════════════════════
// BALANCE
// ════════════════════════════════════════════════════════════════
async function showBalance(ctx: any, session: UserSession) {
  try {
    const res = await makeApi(session.token).get('/wallet/balance');
    const { balance } = unwrap(res);
    await ctx.reply(
      `💰 *Your Balance*\n\n*${balance}* credits\n≈ $${(balance / CREDITS_PER_USD).toFixed(2)} USD`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
}

// ════════════════════════════════════════════════════════════════
// DEPOSIT — Cryptomus crypto payments
// ════════════════════════════════════════════════════════════════
async function showDeposit(ctx: any) {
  if (!CRYPTOMUS_MERCHANT || !CRYPTOMUS_KEY) {
    const chatId = ctx.chat.id;
    pending.set(chatId, { state: 'recharge_method', data: {} });
    await ctx.reply(
      `💳 *Recharge Request*\n\nSelect your payment method:`,
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([
          ['💛 Binance ID', '💚 USDT TRC20'],
          ['🏦 IBAN', '🏧 CIH Bank'],
          ['❌ Cancel'],
        ]).resize(),
      }
    );
    return;
  }
  await ctx.reply(
    `💳 *Deposit Credits*\n\n` +
    `💱 Pay with crypto (Bitcoin, USDT, ETH and more)\n` +
    `📊 Rate: $1 = ${CREDITS_PER_USD} credits\n\n` +
    `Choose deposit amount:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('$5  → 500cr',  'dep_5'),
          Markup.button.callback('$10 → 1000cr', 'dep_10'),
        ],
        [
          Markup.button.callback('$20 → 2000cr', 'dep_20'),
          Markup.button.callback('$50 → 5000cr', 'dep_50'),
        ],
        [Markup.button.callback('✏️ Custom amount', 'dep_custom')],
      ]),
    },
  );
}

async function processDeposit(ctx: any, session: UserSession, amountUsd: number) {
  const chatId  = ctx.chat?.id ?? ctx.chat!.id;
  const credits = amountUsd * CREDITS_PER_USD;

  await ctx.reply(`⏳ Creating payment for $${amountUsd.toFixed(2)}...`);

  try {
    const orderId = `tg_${chatId}_${Date.now()}`;
    const payment = await createCryptomusPayment(orderId, amountUsd);

    if (!payment || !payment.uuid || !payment.url) {
      await ctx.reply('❌ Failed to create payment. Try again later.');
      return;
    }

    const uuid = payment.uuid;
    pendingDeposits.set(uuid, { chatId, amountUsd, credits });

    await ctx.reply(
      `💳 *Payment Created!*\n\n` +
      `💵 Amount: *$${amountUsd.toFixed(2)} USD*\n` +
      `💎 You will receive: *${credits} credits*\n` +
      `⏰ Expires in: *1 hour*\n\n` +
      `👇 Click to pay with crypto:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.url('💳 Pay Now', payment.url)],
          [Markup.button.callback('🔄 Check Payment', `depcheck_${uuid}`)],
        ]),
      },
    );

    startPaymentPolling(uuid);
  } catch (err) {
    await ctx.reply(`❌ Payment error: ${errMsg(err)}`);
  }
}

// Deposit preset buttons
bot.action('dep_5',  async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  await ctx.answerCbQuery();
  await processDeposit(ctx, session, 5);
});
bot.action('dep_10', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  await ctx.answerCbQuery();
  await processDeposit(ctx, session, 10);
});
bot.action('dep_20', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  await ctx.answerCbQuery();
  await processDeposit(ctx, session, 20);
});
bot.action('dep_50', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  await ctx.answerCbQuery();
  await processDeposit(ctx, session, 50);
});
bot.action('dep_custom', async (ctx) => {
  const chatId = ctx.chat!.id;
  if (!sessions.get(chatId)) { await ctx.answerCbQuery('Please login first'); return; }
  pending.set(chatId, { state: 'deposit_custom', data: {} });
  await ctx.reply('💵 Enter amount in USD (min $1, max $500):\n_Example: 25_', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

// Manual payment check
bot.action(/^depcheck_(.+)$/, async (ctx) => {
  const uuid    = ctx.match[1];
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery('⏳ Checking...');
  try {
    const data   = await checkCryptomusPayment(uuid);
    const status = data?.payment_status ?? data?.status ?? 'unknown';
    const info   = pendingDeposits.get(uuid);
    const paid   = status === 'paid' || status === 'paid_over';
    const failed = status === 'cancel' || status === 'expired' || status === 'fail';

    if (paid && info) {
      // Clear polling
      const t = paymentPolls.get(uuid); if (t) { clearInterval(t); paymentPolls.delete(uuid); }
      pendingDeposits.delete(uuid);
      if (botAdminToken) {
        await makeApi(botAdminToken).post('/admin/balance/adjust', {
          userId: session.userId,
          amount: info.credits,
          reason: `Crypto deposit — $${info.amountUsd.toFixed(2)} USD`,
        });
      }
      await ctx.reply(`✅ *Payment Confirmed!*\n\n💎 *+${info?.credits} credits* added!`, { parse_mode: 'Markdown' });
    } else if (failed) {
      const t = paymentPolls.get(uuid); if (t) { clearInterval(t); paymentPolls.delete(uuid); }
      pendingDeposits.delete(uuid);
      await ctx.reply(`❌ Payment was ${status}. Tap 💳 Deposit to create a new one.`);
    } else {
      const labels: Record<string, string> = {
        process: '🔄 Processing', check: '🔍 Being verified',
        confirm_check: '🔍 Confirming', wrong_amount: '⚠️ Wrong amount sent',
      };
      await ctx.reply(
        `⏳ *Status: ${labels[status] ?? status}*\n\nPayment not confirmed yet.\nI'm checking automatically every 30 seconds!`,
        { parse_mode: 'Markdown' },
      );
    }
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ════════════════════════════════════════════════════════════════
// BUY NUMBER — SMSPool Direct
// ════════════════════════════════════════════════════════════════
async function showCountries(ctx: any) {
  await ctx.reply('⏳ Loading countries...');
  try {
    const countries = await getSMSCountries();
    // Sort by popularity
    const popular  = POPULAR_SHORT
      .map((code) => countries.find((c) => c.short_name?.toUpperCase() === code))
      .filter(Boolean) as SMSCountry[];
    const rest     = countries.filter((c) => !POPULAR_SHORT.includes(c.short_name?.toUpperCase()));
    const sorted   = [...popular, ...rest].slice(0, 40);

    const rows: any[][] = [];
    for (let i = 0; i < sorted.length; i += 2) {
      const c1  = sorted[i];
      const c2  = sorted[i + 1];
      const f1  = flag(c1.short_name);
      const btn = [Markup.button.callback(`${f1} ${c1.name}`, `csms_${c1.ID}`)];
      if (c2) btn.push(Markup.button.callback(`${flag(c2.short_name)} ${c2.name}`, `csms_${c2.ID}`));
      rows.push(btn);
    }

    await ctx.reply('🌍 *Select a country:*', { parse_mode:'Markdown', ...Markup.inlineKeyboard(rows) });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
}

// Country selected → show services
bot.action(/^csms_(\d+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }

  const countryId = ctx.match[1];
  await ctx.answerCbQuery('⏳ Loading services...');

  try {
    const countries = await getSMSCountries();
    const services  = await getSMSServices();
    const country   = countries.find((c) => String(c.ID) === String(countryId));
    if (!country) { await ctx.reply('❌ Country not found.'); return; }

    // Filter to popular services first, then rest
    const popular = POPULAR_SERVICES
      .map((name) => services.find((s) => s.name?.toLowerCase().includes(name.toLowerCase())))
      .filter(Boolean) as SMSService[];
    const uniquePopular = popular.filter((s, i, a) => a.findIndex((x) => x.ID === s.ID) === i);
    const rest = services.filter((s) => !uniquePopular.find((p) => p.ID === s.ID));
    const sorted = [...uniquePopular, ...rest].slice(0, 20);

    const buttons = sorted.map((s) => [
      Markup.button.callback(s.name, `ssms_${countryId}_${s.ID}`),
    ]);
    buttons.push([Markup.button.callback('🔙 Back', 'back_countries')]);

    await ctx.reply(
      `${flag(country.short_name)} *${country.name}* — Select a service:`,
      { parse_mode:'Markdown', ...Markup.inlineKeyboard(buttons) },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('back_countries', async (ctx) => {
  await ctx.answerCbQuery();
  await showCountries(ctx);
});

// Service selected → fetch price → show confirmation
bot.action(/^ssms_(\d+)_(\d+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }

  const [, countryId, serviceId] = ctx.match;
  await ctx.answerCbQuery('⏳ Fetching price...');

  try {
    const [countries, services] = await Promise.all([getSMSCountries(), getSMSServices()]);
    const country = countries.find((c) => String(c.ID) === String(countryId));
    const service = services.find((s) => String(s.ID) === String(serviceId));
    if (!country || !service) { await ctx.reply('❌ Not found.'); return; }

    // Fetch price from SMSPool
    const priceRes = await smsPost('/request/price', { country: countryId, service: serviceId });
    const priceData = priceRes.data;

    if (!priceData || priceData.success === 0) {
      await ctx.reply(`❌ No numbers available for ${service.name} in ${country.name} right now. Try another country!`);
      return;
    }

    const usdPrice = parseFloat(priceData.price ?? priceData.cost ?? '0');
    const credits  = toCredits(usdPrice);
    const stock    = priceData.stock ?? '?';

    // cb data: cbuy_{cId}_{sId}_{credits} (well within 64 chars)
    const cbData = `cbuy_${countryId}_${serviceId}_${credits}`;

    await ctx.reply(
      `📱 *Order Summary*\n\n` +
      `🌍 Country: ${flag(country.short_name)} ${country.name}\n` +
      `📲 Service: ${service.name}\n` +
      `💰 Price: *${credits} credits* (~$${(credits / CREDITS_PER_USD).toFixed(2)})\n` +
      `📦 Stock: ${stock} numbers available\n\n` +
      `Your balance will be deducted after confirmation.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Buy Now', cbData)],
          [Markup.button.callback('🔙 Back',    `csms_${countryId}`)],
        ]),
      },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// Confirmed — purchase from SMSPool
bot.action(/^cbuy_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }

  const [, countryId, serviceId, creditsStr] = ctx.match;
  const credits = parseInt(creditsStr);
  await ctx.answerCbQuery('⏳ Processing...');

  try {
    // 1. Check balance
    const balRes   = await makeApi(session.token).get('/wallet/balance');
    const { balance } = unwrap(balRes);
    if (balance < credits) {
      await ctx.reply(`❌ Insufficient balance!\n\nYou need *${credits} credits* but only have *${balance}*.`, { parse_mode:'Markdown' });
      return;
    }

    // 2. Purchase from SMSPool
    const [countries, services] = await Promise.all([getSMSCountries(), getSMSServices()]);
    const country = countries.find((c) => String(c.ID) === String(countryId));
    const service = services.find((s) => String(s.ID) === String(serviceId));

    const purchaseRes  = await smsPost('/purchase/sms', {
      country: countryId,
      service: serviceId,
      pricing_option: '1', // highest success rate
    });
    const purchase = purchaseRes.data;

    if (!purchase || purchase.success === 0 || purchase.success === '0') {
      await ctx.reply(`❌ Purchase failed: ${purchase?.message ?? 'No numbers available. Try again.'}`);
      return;
    }

    const orderId     = purchase.order_code ?? purchase.orderid ?? String(purchase.number);
    const phoneNumber = purchase.phonenumber ?? purchase.number ?? 'N/A';

    // 3. Deduct credits from user wallet
    if (botAdminToken) {
      try {
        await makeApi(botAdminToken).post('/admin/balance/adjust', {
          userId: session.userId,
          amount: -credits,
          reason: `SMS order: ${service?.name} (${country?.name})`,
        });
      } catch (e) { console.error('Balance deduct failed:', errMsg(e)); }
    }

    // 4. Store order locally
    const order: SMSLocalOrder = {
      orderId, phoneNumber,
      service: service?.name ?? serviceId,
      country: country?.name ?? countryId,
      credits, status: 'pending',
    };
    smsOrders.set(orderId, order);
    const existing = userOrders.get(chatId) ?? [];
    userOrders.set(chatId, [orderId, ...existing].slice(0, 10));

    // 5. Reply + auto-poll
    await ctx.reply(
      `✅ *Number Assigned!*\n\n` +
      `📱 Number: \`${phoneNumber}\`\n` +
      `📲 Service: ${service?.name ?? serviceId}\n` +
      `🌍 Country: ${flag(country?.short_name ?? '')} ${country?.name ?? countryId}\n` +
      `💰 Charged: ${credits} credits\n\n` +
      `🔔 *I'll notify you automatically when the SMS arrives!*\n_(checking every 30 seconds)_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🔄 Check Now', `poll_${orderId}`),
          Markup.button.callback('❌ Cancel',    `cancel_${orderId}`),
        ]]),
      },
    );

    startAutoPolling(chatId, orderId, session);
    await rewardReferrer(chatId, session);

  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ════════════════════════════════════════════════════════════════
// AUTO SMS POLLING — via SMSPool check
// ════════════════════════════════════════════════════════════════
function startAutoPolling(chatId: number, orderId: string, session: UserSession) {
  if (activePolls.has(orderId)) return;
  let attempts = 0;

  const t = setInterval(async () => {
    attempts++;
    if (attempts > POLL_MAX) {
      clearInterval(t); activePolls.delete(orderId);
      const order = smsOrders.get(orderId);
      if (order) order.status = 'expired';
      try { await bot.telegram.sendMessage(chatId, `⏰ *Order Timed Out*\n\nNo SMS received after 10 minutes.\n📱 Number: \`${smsOrders.get(orderId)?.phoneNumber}\``, { parse_mode:'Markdown' }); } catch {}
      return;
    }
    try {
      const res  = await smsPost('/sms/check', { orderid: orderId });
      const data = res.data;
      // status: 1=waiting, 2=received, 3=expired
      if (data.sms && data.sms.length > 0) {
        clearInterval(t); activePolls.delete(orderId);
        const smsItem = data.sms[0];
        const code    = smsItem.code ?? smsItem.sms;
        const full    = smsItem.full_code ?? smsItem.sms ?? code;
        const order   = smsOrders.get(orderId);
        if (order) { order.status = 'received'; order.smsCode = code; order.smsText = full; }
        await bot.telegram.sendMessage(chatId,
          `🎉 *SMS Received!*\n\n` +
          `📱 Number: \`${order?.phoneNumber}\`\n` +
          `🔐 Code: \`${code}\`\n\n` +
          `📄 _${full}_`,
          { parse_mode:'Markdown' },
        );
      } else if (data.status === 3 || data.status === 'expired') {
        clearInterval(t); activePolls.delete(orderId);
        const order = smsOrders.get(orderId);
        if (order) order.status = 'expired';
        await bot.telegram.sendMessage(chatId, `⏰ Order expired. No SMS received.`);
      }
    } catch {}
  }, POLL_INTERVAL);

  activePolls.set(orderId, t);
}

// Manual check
bot.action(/^poll_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }
  const orderId = ctx.match[1];
  await ctx.answerCbQuery('⏳ Checking...');

  try {
    const res  = await smsPost('/sms/check', { orderid: orderId });
    const data = res.data;
    if (data.sms && data.sms.length > 0) {
      const smsItem = data.sms[0];
      const code    = smsItem.code ?? smsItem.sms;
      const full    = smsItem.full_code ?? smsItem.sms ?? code;
      await ctx.reply(`✅ *SMS Received!*\n\n🔐 Code: \`${code}\`\n\n📄 _${full}_`, { parse_mode:'Markdown' });
    } else if (data.status === 3 || data.status === 'expired') {
      await ctx.reply('⏰ This order has expired.');
    } else {
      await ctx.reply('⏳ No SMS yet. I\'m auto-checking every 30 seconds!',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Check Again', `poll_${orderId}`)]]));
      startAutoPolling(chatId, orderId, session);
    }
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// Cancel order
bot.action(/^cancel_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }
  const orderId = ctx.match[1];
  await ctx.answerCbQuery('⏳ Canceling...');

  const t = activePolls.get(orderId);
  if (t) { clearInterval(t); activePolls.delete(orderId); }

  try {
    await smsPost('/sms/cancel', { orderid: orderId });
    const order = smsOrders.get(orderId);
    if (order) order.status = 'canceled';

    // Refund credits
    if (botAdminToken && order && session.userId) {
      try {
        await makeApi(botAdminToken).post('/admin/balance/adjust', {
          userId: session.userId,
          amount: order.credits,
          reason: `Refund: canceled SMS order`,
        });
        await ctx.reply(`✅ Order canceled.\n💰 *${order.credits} credits refunded* to your balance.`, { parse_mode:'Markdown' });
      } catch { await ctx.reply('✅ Order canceled on SMSPool. Contact admin for refund.'); }
    } else {
      await ctx.reply('✅ Order canceled.');
    }
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ════════════════════════════════════════════════════════════════
// MY ORDERS — from local SMS storage
// ════════════════════════════════════════════════════════════════
async function showOrders(ctx: any, _session: UserSession) {
  const chatId   = ctx.chat?.id;
  const orderIds = userOrders.get(chatId) ?? [];

  if (!orderIds.length) {
    await ctx.reply('📋 No orders yet.\n\nTap *📱 Buy Number* to get started!', { parse_mode:'Markdown' });
    return;
  }

  const statusIcon: Record<string, string> = { pending:'⏳', received:'✅', canceled:'❌', expired:'⏰' };

  for (const id of orderIds.slice(0, 5)) {
    const o = smsOrders.get(id);
    if (!o) continue;
    const text =
      `${statusIcon[o.status] ?? '❓'} *${o.service}* — ${o.country}\n` +
      `📱 \`${o.phoneNumber}\`\n` +
      (o.smsCode ? `🔐 Code: \`${o.smsCode}\`\n📄 _${o.smsText ?? ''}_` : '⏳ Waiting for SMS...');

    const btns: any[] = [];
    if (o.status === 'pending') {
      btns.push([
        Markup.button.callback('🔄 Check', `poll_${o.orderId}`),
        Markup.button.callback('❌ Cancel', `cancel_${o.orderId}`),
      ]);
    }
    await ctx.reply(text, { parse_mode:'Markdown', ...(btns.length ? Markup.inlineKeyboard(btns) : {}) });
  }
}

// ════════════════════════════════════════════════════════════════
// REFERRAL REWARD
// ════════════════════════════════════════════════════════════════
async function rewardReferrer(newChatId: number, newSession: UserSession) {
  if (referred.has(newChatId)) return;
  const refId = referrals.get(newChatId);
  if (!refId || !botAdminToken) return;
  const refSession = sessions.get(refId);
  if (!refSession) return;
  try {
    await makeApi(botAdminToken).post('/admin/balance/adjust', {
      userId: refSession.userId, amount: REFERRAL_BONUS,
      reason: `Referral bonus — ${newSession.email}`,
    });
    referred.add(newChatId);
    await bot.telegram.sendMessage(refId,
      `🎉 *Referral Bonus!*\n\nYour friend *${newSession.email}* just made a purchase!\nYou earned *+${REFERRAL_BONUS} credits* 🎁`,
      { parse_mode:'Markdown' },
    );
  } catch {}
}

// ════════════════════════════════════════════════════════════════
// eSIM — SMSPool Direct Integration (TomMobile-style UI)
// ════════════════════════════════════════════════════════════════

// Regions map (countryCode → region)
const REGION_MAP: Record<string, string> = {
  // Europe
  GB:'Europe', DE:'Europe', FR:'Europe', IT:'Europe', ES:'Europe', NL:'Europe',
  SE:'Europe', PL:'Europe', RO:'Europe', PT:'Europe', GR:'Europe', CZ:'Europe',
  HU:'Europe', UA:'Europe', RU:'Europe',
  // Middle East & North Africa
  MA:'Middle East & North Africa', EG:'Middle East & North Africa',
  TN:'Middle East & North Africa', SA:'Middle East & North Africa',
  AE:'Middle East & North Africa', TR:'Middle East & North Africa',
  // Asia
  CN:'Asia', JP:'Asia', KR:'Asia', IN:'Asia', PH:'Asia', ID:'Asia',
  VN:'Asia', PK:'Asia', BD:'Asia',
  // North America
  US:'North America', CA:'North America', MX:'North America',
  // Latin America
  BR:'Latin America', CO:'Latin America', AR:'Latin America',
  // Africa
  NG:'Africa', KE:'Africa', ZA:'Africa',
  // Oceania
  AU:'Oceania',
};

function getRegion(code: string): string {
  return REGION_MAP[code?.toUpperCase()] ?? 'Global';
}

// Format price-per-GB helper
function pricePerGb(priceUsd: number, gb: number): string {
  if (!gb || gb <= 0) return '';
  const ppg = priceUsd / gb;
  return ppg < 1 ? `$${ppg.toFixed(2)}/GB` : `$${Math.round(ppg)}/GB`;
}

async function showEsimProducts(ctx: any, session: UserSession) {
  try {
    const res      = await makeApi(session.token).get('/esim/products');
    const products: any[] = unwrap(res) ?? [];
    if (!products.length) {
      await ctx.reply(
        `📡 *eSIM Store*\n\n` +
        `No plans available yet.\n_Admin is adding plans soon! 🔜_`,
        { parse_mode:'Markdown' },
      );
      return;
    }
    await ctx.reply(
      `📡 *eSIM Store*\n\n` +
      `🌐 Internet-only · No calls · Instant delivery\n` +
      `💳 ${CREDITS_PER_USD} credits = $1\n\n` +
      `Browse by:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('🌍 Countries', 'esim_tab_countries'),
            Markup.button.callback('🗺️ Regions',   'esim_tab_regions'),
          ],
          [Markup.button.callback('📋 My eSIM Orders', 'esim_orders')],
        ]),
      },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
}

// helper — fetch all products grouped by country
async function fetchEsimGrouped(session: UserSession): Promise<Record<string, any[]>> {
  const res      = await makeApi(session.token).get('/esim/products');
  const all: any[] = unwrap(res) ?? [];
  const grouped: Record<string, any[]> = {};
  for (const p of all) {
    if (!grouped[p.country]) grouped[p.country] = [];
    grouped[p.country].push(p);
  }
  return grouped;
}

// ── Tab: Countries ────────────────────────────────────────────
bot.action('esim_tab_countries', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  await ctx.answerCbQuery('⏳ Loading...');
  try {
    const grouped = await fetchEsimGrouped(session);
    const sorted  = Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b));
    if (!sorted.length) { await ctx.reply('📡 No eSIM plans available yet.'); return; }
    const rows: any[][] = [];
    for (let i = 0; i < sorted.length; i += 2) {
      const [c1, p1] = sorted[i];
      const code1    = p1[0].countryCode?.toLowerCase() ?? '';
      const btn1     = Markup.button.callback(`${flag(code1)} ${c1}`, `esim_c_${c1}`);
      if (sorted[i+1]) {
        const [c2, p2] = sorted[i+1];
        rows.push([btn1, Markup.button.callback(`${flag(p2[0].countryCode?.toLowerCase())} ${c2}`, `esim_c_${c2}`)]);
      } else { rows.push([btn1]); }
    }
    rows.push([Markup.button.callback('🔙 Back', 'esim_back')]);
    await ctx.reply('🌍 *Select a Country:*', { parse_mode:'Markdown', ...Markup.inlineKeyboard(rows) });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ── Tab: Regions ──────────────────────────────────────────────
bot.action('esim_tab_regions', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  await ctx.answerCbQuery('⏳ Loading...');
  try {
    const grouped = await fetchEsimGrouped(session);
    const regions = new Set<string>();
    for (const [, plans] of Object.entries(grouped)) {
      regions.add(getRegion(plans[0].countryCode ?? ''));
    }
    const regionIcons: Record<string,string> = {
      'Europe':'🇪🇺', 'Middle East & North Africa':'🕌', 'Asia':'🌏',
      'North America':'🌎', 'Latin America':'🌎', 'Africa':'🌍', 'Oceania':'🦘', 'Global':'🌐',
    };
    const buttons = [...regions].sort().map((r) => [
      Markup.button.callback(`${regionIcons[r]??'🌍'} ${r}`, `esim_r_${r}`),
    ]);
    buttons.push([Markup.button.callback('🔙 Back', 'esim_back')]);
    await ctx.reply('🗺️ *Select a Region:*', { parse_mode:'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action(/^esim_r_(.+)$/, async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  const region = ctx.match[1];
  await ctx.answerCbQuery('⏳ Loading...');
  try {
    const grouped  = await fetchEsimGrouped(session);
    const filtered = Object.entries(grouped).filter(([, plans]) => getRegion(plans[0].countryCode ?? '') === region);
    if (!filtered.length) { await ctx.reply(`🗺️ No eSIM plans for ${region} yet.`); return; }
    const sorted = filtered.sort(([a],[b]) => a.localeCompare(b));
    const rows: any[][] = [];
    for (let i = 0; i < sorted.length; i += 2) {
      const [c1,p1] = sorted[i];
      const btn1    = Markup.button.callback(`${flag(p1[0].countryCode?.toLowerCase())} ${c1}`, `esim_c_${c1}`);
      if (sorted[i+1]) {
        const [c2,p2] = sorted[i+1];
        rows.push([btn1, Markup.button.callback(`${flag(p2[0].countryCode?.toLowerCase())} ${c2}`, `esim_c_${c2}`)]);
      } else { rows.push([btn1]); }
    }
    rows.push([Markup.button.callback('🔙 Back', 'esim_tab_regions')]);
    await ctx.reply(`🗺️ *${region}*\n\nSelect a country:`, { parse_mode:'Markdown', ...Markup.inlineKeyboard(rows) });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ── Country → Plans ───────────────────────────────────────────
bot.action(/^esim_c_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  const country = ctx.match[1];
  await ctx.answerCbQuery('⏳ Loading plans...');
  try {
    const grouped = await fetchEsimGrouped(session);
    const plans   = grouped[country] ?? [];
    if (!plans.length) { await ctx.reply(`❌ No plans for ${country}.`); return; }

    const f      = flag(plans[0].countryCode?.toLowerCase() ?? '');
    const sorted = [...plans].sort((a,b) => a.price - b.price);

    const buttons = sorted.map((p: any) => {
      const priceUsd = p.price / 100;
      const gb       = parseFloat(p.gb) || 0;
      const ppg      = pricePerGb(priceUsd, gb);
      const stock    = p.stock > 0;
      const label    = stock
        ? `${p.gb}GB · ${p.days}d · $${priceUsd % 1 === 0 ? priceUsd : priceUsd.toFixed(2)}${ppg ? ` (${ppg})` : ''}`
        : `${p.gb}GB · ${p.days}d · ❌ Sold out`;
      return [Markup.button.callback(label, stock ? `esim_b_${p.id}` : 'esim_soldout')];
    });
    buttons.push([Markup.button.callback('🔙 Back', 'esim_tab_countries')]);

    await ctx.reply(
      `${f} *${country} — eSIM Plans*\n\n` +
      `✅ eSIM compatible · 🌐 Internet only\n` +
      `⚡ Instant activation · 📶 No calls\n\n` +
      `Choose your plan:`,
      { parse_mode:'Markdown', ...Markup.inlineKeyboard(buttons) },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('esim_soldout', async (ctx) => { await ctx.answerCbQuery('❌ Sold out — choose another plan'); });
bot.action('esim_back', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (session) await showEsimProducts(ctx, session);
  await ctx.answerCbQuery();
});

// ── Buy eSIM plan ─────────────────────────────────────────────
bot.action(/^esim_b_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }
  await ctx.answerCbQuery('⏳ Processing...');
  try {
    const res   = await makeApi(session.token).post(`/esim/purchase/${ctx.match[1]}`);
    const order = unwrap(res);
    const qr    = order.inventory?.qrCodeData ?? '';
    const act   = order.inventory?.activationCode ?? '';
    const f     = flag(order.product?.countryCode?.toLowerCase());
    const priceUsd = (order.product?.price ?? 0) / 100;
    const gb    = parseFloat(order.product?.gb) || 0;
    const ppg   = pricePerGb(priceUsd, gb);
    await ctx.reply(
      `✅ *eSIM Purchased!*\n\n` +
      `${f} *${order.product?.country}*\n` +
      `📦 ${order.product?.gb}GB · ${order.product?.days} days\n` +
      `💵 $${priceUsd % 1 === 0 ? priceUsd : priceUsd.toFixed(2)}${ppg ? ` (${ppg})` : ''}\n\n` +
      `📱 *Activation Data:*\n\`\`\`\n${qr}\n\`\`\`` +
      (act ? `\n\n🔑 Code: \`${act}\`` : '') +
      `\n\n*📲 How to activate:*\n1. Settings → Cellular → Add eSIM\n2. Scan QR code\n3. Enable data roaming\n\n` +
      `_⚠️ Screenshot this! You need it to activate._`,
      { parse_mode:'Markdown' },
    );
    await rewardReferrer(chatId, session);
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ── My eSIM Orders ────────────────────────────────────────────
bot.action('esim_orders', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  try {
    const res    = await makeApi(session.token).get('/esim/orders');
    const orders: any[] = unwrap(res) ?? [];
    if (!orders.length) { await ctx.reply('📡 No eSIM orders yet.\n\nTap 📡 eSIM to browse plans!'); return; }
    const lines = orders.slice(0,5).map((o: any,i: number) => {
      const priceUsd = (o.product?.price ?? 0) / 100;
      const gb       = parseFloat(o.product?.gb) || 0;
      const ppg      = pricePerGb(priceUsd, gb);
      return (
        `${i+1}. ${flag(o.product?.countryCode?.toLowerCase())} *${o.product?.country}*\n` +
        `   📦 ${o.product?.gb}GB · ${o.product?.days}d · $${priceUsd % 1 === 0 ? priceUsd : priceUsd.toFixed(2)}${ppg ? ` (${ppg})` : ''}\n` +
        `   📅 ${new Date(o.createdAt).toLocaleDateString()}`
      );
    }).join('\n\n');
    await ctx.reply(`📡 *My eSIM Orders:*\n\n${lines}`, { parse_mode:'Markdown' });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ════════════════════════════════════════════════════════════════
// COUPON
// ════════════════════════════════════════════════════════════════
async function showRedeemCoupon(ctx: any) {
  pending.set(ctx.chat?.id, { state:'redeem_coupon', data:{} });
  await ctx.reply('🎟️ *Redeem Coupon*\n\nEnter your coupon code:', { parse_mode:'Markdown' });
}

// ════════════════════════════════════════════════════════════════
// REFERRAL
// ════════════════════════════════════════════════════════════════
async function showReferral(ctx: any) {
  const chatId = ctx.chat?.id;
  const link   = `https://t.me/${botUsername}?start=ref_${chatId}`;
  await ctx.reply(
    `👥 *Referral Program*\n\nInvite friends & earn *${REFERRAL_BONUS} credits* each!\n\n🔗 Your link:\n\`${link}\``,
    { parse_mode:'Markdown' },
  );
}

// ════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ════════════════════════════════════════════════════════════════
bot.hears('⚙️ Admin Panel', async (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session || session.role !== 'ADMIN') return;
  await ctx.reply('🔧 *Admin Panel*', {
    parse_mode:'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📊 Statistics',     'adm_stats')],
      [Markup.button.callback('👥 Users List',     'adm_users')],
      [Markup.button.callback('💰 Add Balance',    'adm_addbal')],
      [Markup.button.callback('🎟️ Create Coupon',  'adm_coupon')],
      [Markup.button.callback('📢 Broadcast',      'adm_broadcast')],
      [Markup.button.callback('💳 SMSPool Balance','adm_smsbal')],
      [Markup.button.callback('📡 eSIM Manager',   'adm_esim')],
    ]),
  });
});

// ── eSIM Manager ──────────────────────────────────────────────
bot.action('adm_esim', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  try {
    const res      = await makeApi(session.token).get('/admin/esim/products');
    const products: any[] = unwrap(res) ?? [];

    if (!products.length) {
      await ctx.reply(
        `📡 *eSIM Manager*\n\n_No products yet._`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Add Product', 'adm_esim_add')],
            [Markup.button.callback('🔙 Back',        'adm_esim_back')],
          ]),
        },
      );
      return;
    }

    // Show product list with manage buttons
    await ctx.reply(`📡 *eSIM Manager* — ${products.length} products\n\nSelect a product to manage:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...products.map((p: any) => {
          const priceUsd = (p.price/100).toFixed(2);
          const stock    = p.stock ?? 0;
          return [Markup.button.callback(
            `${flag(p.countryCode?.toLowerCase())} ${p.country} ${p.gb}GB/${p.days}d · $${priceUsd} · 📦${stock}`,
            `adm_ep_${p.id}`,
          )];
        }),
        [
          Markup.button.callback('➕ Add Product', 'adm_esim_add'),
          Markup.button.callback('📋 Add QR',     'adm_esim_qr'),
        ],
        [Markup.button.callback('🔙 Back', 'adm_esim_back')],
      ]),
    });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ── Manage single product ─────────────────────────────────────
bot.action(/^adm_ep_(?!price_|size_|del_|delconfirm_)(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  const productId = ctx.match[1] ?? ctx.match[0].replace('adm_ep_','');
  await ctx.answerCbQuery();
  try {
    const res      = await makeApi(session.token).get('/admin/esim/products');
    const products: any[] = unwrap(res) ?? [];
    const p        = products.find((x:any) => x.id === productId);
    if (!p) { await ctx.reply('❌ Product not found.'); return; }
    const priceUsd = (p.price/100).toFixed(2);
    const ppg      = pricePerGb(p.price/100, parseFloat(p.gb)||0);

    await ctx.reply(
      `📡 *${p.country} — ${p.gb}GB / ${p.days}d*\n\n` +
      `${flag(p.countryCode?.toLowerCase())} ${p.countryCode?.toUpperCase()}\n` +
      `💰 Price: *$${priceUsd}*${ppg ? ` (${ppg})` : ''}\n` +
      `📦 Stock: *${p.stock ?? 0}* QR codes\n` +
      `🆔 ID: \`${p.id.slice(0,12)}\`\n\n` +
      `What do you want to do?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Edit Price',  `adm_ep_price_${productId}`)],
          [Markup.button.callback('📦 Edit GB/Days',`adm_ep_size_${productId}`)],
          [Markup.button.callback('📋 Add QR Code', `adm_esim_qrsel_${productId}`)],
          [Markup.button.callback('🗑️ Delete Product','adm_ep_del_'+productId)],
          [Markup.button.callback('🔙 Back',        'adm_esim')],
        ]),
      },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// Edit Price
bot.action(/^adm_ep_price_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_ep_edit_price', data: { productId: ctx.match[1] } });
  await ctx.reply('💰 New price in cents (USD):\n_Example: 1500 = $15.00_', { parse_mode:'Markdown' });
  await ctx.answerCbQuery();
});

// Edit GB/Days
bot.action(/^adm_ep_size_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_ep_edit_gb', data: { productId: ctx.match[1] } });
  await ctx.reply('📦 New GB size?\n_Example: 10_', { parse_mode:'Markdown' });
  await ctx.answerCbQuery();
});

// Delete product
bot.action(/^adm_ep_del_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  const productId = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(
    `⚠️ *Delete this product?*\n\nAll stock (QR codes) will be lost!`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🗑️ Yes, Delete', `adm_ep_delconfirm_${productId}`),
          Markup.button.callback('❌ Cancel',       `adm_ep_${productId}`),
        ],
      ]),
    },
  );
});

bot.action(/^adm_ep_delconfirm_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery('⏳ Deleting...');
  try {
    await makeApi(session.token).delete(`/admin/esim/products/${ctx.match[1]}`);
    await ctx.reply('✅ Product deleted!');
    // Refresh eSIM manager
    const res      = await makeApi(session.token).get('/admin/esim/products');
    const products: any[] = unwrap(res) ?? [];
    if (products.length) {
      await ctx.reply(`📡 *eSIM Manager* — ${products.length} products remaining`, {
        parse_mode:'Markdown',
        ...Markup.inlineKeyboard([
          ...products.map((p:any) => [Markup.button.callback(
            `${flag(p.countryCode?.toLowerCase())} ${p.country} ${p.gb}GB · $${(p.price/100).toFixed(2)} · 📦${p.stock??0}`,
            `adm_ep_${p.id}`,
          )]),
          [Markup.button.callback('➕ Add Product','adm_esim_add')],
          [Markup.button.callback('🔙 Back','adm_esim_back')],
        ]),
      });
    } else {
      await ctx.reply('📡 No products left.', Markup.inlineKeyboard([[Markup.button.callback('➕ Add Product','adm_esim_add')]]));
    }
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('adm_esim_back', async (ctx) => {
  await ctx.answerCbQuery();
  const session = sessions.get(ctx.chat!.id);
  if (!session) return;
  await ctx.reply('🔧 *Admin Panel*', {
    parse_mode:'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📊 Statistics',     'adm_stats')],
      [Markup.button.callback('👥 Users List',     'adm_users')],
      [Markup.button.callback('💰 Add Balance',    'adm_addbal')],
      [Markup.button.callback('📡 eSIM Manager',   'adm_esim')],
    ]),
  });
});

bot.action('adm_esim_add', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_esim_name', data: {} });
  await ctx.reply(
    `📡 *Add eSIM Product*\n\n` +
    `Step 1/5: Enter product name\n_Example: Morocco 10GB 30 Days_`,
    { parse_mode: 'Markdown' },
  );
  await ctx.answerCbQuery();
});

bot.action('adm_esim_qr', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();

  try {
    const res      = await makeApi(session.token).get('/admin/esim/products');
    const products: any[] = unwrap(res) ?? [];
    if (!products.length) { await ctx.reply('❌ No products yet. Add a product first.'); return; }

    const buttons = products.map((p: any) => [
      Markup.button.callback(
        `${flag(p.countryCode?.toLowerCase())} ${p.country} ${p.gb}GB — Stock: ${p.stock ?? 0}`,
        `adm_esim_qrsel_${p.id}`,
      ),
    ]);
    await ctx.reply('📋 *Select product to add QR code:*', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action(/^adm_esim_qrsel_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_esim_qrdata', data: { productId: ctx.match[1] } });
  await ctx.reply(
    `📋 *Add QR Code*\n\nPaste the QR code data / activation code below:\n\n_Example:_ \`LPA:1$smdp.example.com$ABCDEF123\``,
    { parse_mode: 'Markdown' },
  );
  await ctx.answerCbQuery();
});

bot.action('adm_stats', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  try {
    const res = await makeApi(session.token).get('/admin/stats');
    const s   = unwrap(res);
    await ctx.reply(
      `📊 *Platform Statistics*\n\n` +
      `👥 Users: *${s.totalUsers??0}*\n📋 Orders: *${s.totalOrders??0}*\n✅ Completed: *${s.receivedOrders??0}*\n` +
      `💰 Revenue: *${s.totalRevenue??0}* credits\n\n` +
      `🎟️ Coupons: *${coupons.size}*\n👥 Referrals: *${referrals.size}*\n` +
      `📱 SMS Orders (session): *${smsOrders.size}*\n🔔 Polling: *${activePolls.size}*`,
      { parse_mode:'Markdown' },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('adm_smsbal', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  try {
    const res = await smsPost('/request/balance');
    const bal = res.data?.balance ?? res.data;
    await ctx.reply(`💳 *SMSPool Balance*\n\n$${parseFloat(bal).toFixed(2)} USD`, { parse_mode:'Markdown' });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('adm_users', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  try {
    const res   = await makeApi(session.token).get('/admin/users?limit=10');
    const data  = unwrap(res);
    const users: any[] = data?.users ?? (Array.isArray(data) ? data : []);
    if (!users.length) { await ctx.reply('No users.'); return; }
    const lines = users.map((u: any, i: number) =>
      `${i+1}. \`${u.email}\`\n   💰 ${u.balance} cr | ${u.role}`
    ).join('\n\n');
    await ctx.reply(`👥 *Users:*\n\n${lines}`, { parse_mode:'Markdown' });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('adm_addbal', async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state:'adm_addbal_email', data:{} });
  await ctx.reply('📧 Enter user email:');
  await ctx.answerCbQuery();
});

bot.action('adm_addbal_yes', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  const state   = pending.get(chatId);
  if (!session || !state) { await ctx.answerCbQuery(); return; }
  pending.delete(chatId); await ctx.answerCbQuery();
  try {
    const amount = parseInt(state.data.amount);
    await makeApi(session.token).post('/admin/balance/adjust', { userId:state.data.userId, amount, reason:'Telegram admin' });
    await ctx.reply(`✅ *${Math.abs(amount)} credits* ${amount>0?'added to':'deducted from'} \`${state.data.email}\``, { parse_mode:'Markdown' });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('adm_addbal_no', async (ctx) => { pending.delete(ctx.chat!.id); await ctx.reply('Canceled.'); await ctx.answerCbQuery(); });

bot.action('adm_coupon', async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state:'adm_coupon_code', data:{} });
  await ctx.reply('🎟️ Enter coupon code (e.g. PROMO50):');
  await ctx.answerCbQuery();
});

bot.action('adm_broadcast', async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state:'adm_broadcast_msg', data:{} });
  await ctx.reply('📢 Enter broadcast message:');
  await ctx.answerCbQuery();
});

// ════════════════════════════════════════════════════════════════
// /admin — Pending recharge requests (Telegram-ID gated)
// ════════════════════════════════════════════════════════════════
const ADMIN_TG_IDS = (process.env.ADMIN_TELEGRAM_IDS ?? '')
  .split(',').map(s => parseInt(s.trim())).filter(Boolean);

function isTgAdmin(id: number) { return ADMIN_TG_IDS.includes(id); }

async function showAdminRecharges(ctx: any) {
  if (!isTgAdmin(ctx.from!.id)) {
    await ctx.reply('❌ Unauthorized.');
    return;
  }
  if (!botAdminToken) {
    await ctx.reply('❌ Admin token not ready. Try again in a moment.');
    return;
  }
  try {
    const res  = await makeApi(botAdminToken).get('/recharge/admin', { params: { status: 'PENDING' } });
    const list: any[] = Array.isArray(res.data?.data) ? res.data.data : (Array.isArray(res.data) ? res.data : []);
    if (!list.length) {
      await ctx.reply('✅ No pending recharge requests.');
      return;
    }
    for (const r of list.slice(0, 10)) {
      const amt     = (r.amount / 100).toFixed(2);
      const email   = r.user?.email ?? 'unknown';
      const method  = r.method ?? '?';
      const txid    = r.txid  ?? 'N/A';
      const created = r.createdAt ? new Date(r.createdAt).toLocaleString() : '';
      await ctx.reply(
        `📥 *Recharge Request*\n\n` +
        `🆔 \`${r.id}\`\n` +
        `👤 ${email}\n` +
        `💰 $${amt} — ${method}\n` +
        `📎 TxID: \`${txid}\`\n` +
        `🕐 ${created}`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback('✅ Approve', `rch_approve_${r.id}`),
              Markup.button.callback('❌ Reject',  `rch_reject_${r.id}`),
            ],
          ]),
        }
      );
    }
    if (list.length > 10) await ctx.reply(`_… and ${list.length - 10} more._`, { parse_mode: 'Markdown' });
  } catch (err: any) {
    await ctx.reply(`❌ Error: ${err?.response?.data?.message || err.message}`);
  }
}

bot.command('admin', (ctx) => showAdminRecharges(ctx));

bot.action(/^rch_approve_(.+)$/, async (ctx) => {
  if (!isTgAdmin(ctx.from!.id)) { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const id = ctx.match[1];
  try {
    await makeApi(botAdminToken!).patch(`/recharge/admin/${id}/review`, { status: 'APPROVED' });
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    await ctx.answerCbQuery('✅ Approved');
    await ctx.reply(`✅ Recharge \`${id}\` approved.`, { parse_mode: 'Markdown' });
  } catch (err: any) {
    await ctx.answerCbQuery('❌ Error');
    await ctx.reply(`❌ ${err?.response?.data?.message || err.message}`);
  }
});

bot.action(/^rch_reject_(.+)$/, async (ctx) => {
  if (!isTgAdmin(ctx.from!.id)) { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const id = ctx.match[1];
  pending.set(ctx.chat!.id, { state: 'adm_rch_reject', data: { id } });
  await ctx.answerCbQuery();
  await ctx.reply(`Enter rejection reason for \`${id}\` (or send "none"):`, { parse_mode: 'Markdown' });
});

// ════════════════════════════════════════════════════════════════
// TEXT HANDLER — State machine
// ════════════════════════════════════════════════════════════════
bot.on('text', async (ctx) => {
  const chatId  = ctx.chat.id;
  const text    = ctx.message.text.trim();
  const session = sessions.get(chatId);
  const state   = pending.get(chatId);

  // Keyboard shortcuts
  if (session && !state) {
    if (text === '💰 Balance')        return showBalance(ctx, session);
    if (text === '💳 Deposit')        return showDeposit(ctx);
    if (text === '📋 My Orders')      return showOrders(ctx, session);
    if (text === '📱 Buy Number')     return showCountries(ctx);
    if (text === '📡 eSIM')           return showEsimProducts(ctx, session);
    if (text === '🎟️ Redeem Coupon')  return showRedeemCoupon(ctx);
    if (text === '👥 Referral')       return showReferral(ctx);
    if (text === '🚪 Logout') {
      sessions.delete(chatId);
      await ctx.reply('👋 Logged out. See you soon!', Markup.removeKeyboard());
    }
    return;
  }

  if (!state) return;
  const { data } = state;

  // ── LOGIN ──
  if (state.state === 'login_email')    { data.email = text; pending.set(chatId,{state:'login_password',data}); await ctx.reply('🔒 Enter password:'); return; }
  if (state.state === 'login_password') {
    pending.delete(chatId);
    try {
      const res    = await makeApi().post('/auth/login', { email:data.email, password:text });
      const result = unwrap(res);
      const role   = result.user?.role ?? 'USER';
      let userId   = result.user?.id ?? '';
      if (!userId) {
        try { const me = await makeApi(result.accessToken).get('/auth/me'); userId = unwrap(me)?.id ?? ''; } catch {}
      }
      sessions.set(chatId, { token:result.accessToken, email:data.email, role, userId });
      if (role === 'ADMIN') botAdminToken = result.accessToken;
      // Link Telegram ID to this account so Mini App uses same wallet
      const tgId = String(ctx.from?.id ?? '');
      if (tgId) {
        try { await makeApi(result.accessToken).patch('/auth/link-telegram', { telegramId: tgId }); } catch {}
      }
      await ctx.reply(`✅ *Welcome back, ${data.email}!*`, { parse_mode:'Markdown', ...getKeyboard(role) });
    } catch (err) { await ctx.reply(`❌ ${errMsg(err)}\n\nTry again: /start`); }
    return;
  }

  // ── REGISTER ──
  if (state.state === 'register_email')    { data.email = text; pending.set(chatId,{state:'register_password',data}); await ctx.reply('🔒 Choose a password (min 8 chars):'); return; }
  if (state.state === 'register_password') {
    pending.delete(chatId);
    try {
      await makeApi().post('/auth/register', { email:data.email, password:text });
      await ctx.reply('✅ *Account Created!*\n\nVerify your email, then /start to login.', { parse_mode:'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${errMsg(err)}\n\nTry again: /start`); }
    return;
  }

  // ── REDEEM COUPON ──
  if (state.state === 'redeem_coupon') {
    pending.delete(chatId);
    const code   = text.toUpperCase().trim();
    const coupon = coupons.get(code);
    if (!coupon)                    { await ctx.reply('❌ Invalid coupon code.'); return; }
    if (coupon.usesLeft <= 0)       { await ctx.reply('❌ Coupon fully redeemed.'); return; }
    if (coupon.usedBy.has(chatId))  { await ctx.reply('❌ You already used this coupon.'); return; }
    if (!session)                   { await ctx.reply('❌ Please login first: /start'); return; }
    if (!botAdminToken)             { await ctx.reply('❌ Contact admin to activate coupons.'); return; }
    try {
      await makeApi(botAdminToken).post('/admin/balance/adjust', { userId:session.userId, amount:coupon.amount, reason:`Coupon: ${code}` });
      coupon.usedBy.add(chatId); coupon.usesLeft--;
      await ctx.reply(`✅ *Coupon Redeemed!*\n\n🎟️ \`${code}\`\n💰 *+${coupon.amount} credits* added!`, { parse_mode:'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
    return;
  }

  // ── ADMIN: Add Balance ──
  if (state.state === 'adm_addbal_email') {
    data.email = text;
    try {
      const res    = await makeApi(session?.token).get(`/admin/users?search=${encodeURIComponent(text)}&limit=1`);
      const result = unwrap(res);
      const users: any[] = result?.users ?? (Array.isArray(result) ? result : []);
      const user   = users.find((u: any) => u.email === text) ?? users[0];
      if (!user) { pending.delete(chatId); await ctx.reply(`❌ User not found: \`${text}\``, { parse_mode:'Markdown' }); return; }
      data.userId = user.id;
      pending.set(chatId, { state:'adm_addbal_amount', data });
      await ctx.reply(`✅ Found: \`${user.email}\`\n💰 Balance: *${user.balance} credits*\n\nEnter amount (negative to deduct):`, { parse_mode:'Markdown' });
    } catch (err) { pending.delete(chatId); await ctx.reply(`❌ ${errMsg(err)}`); }
    return;
  }
  if (state.state === 'adm_addbal_amount') {
    const amount = parseInt(text);
    if (isNaN(amount) || amount === 0) { await ctx.reply('❌ Enter a valid number:'); return; }
    data.amount = String(amount);
    pending.set(chatId, { state:'adm_addbal_confirm', data });
    await ctx.reply(`Confirm: *${amount>0?'Add':'Deduct'} ${Math.abs(amount)} credits* ${amount>0?'to':'from'} \`${data.email}\`?`, {
      parse_mode:'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm','adm_addbal_yes'),(Markup.button.callback('❌ Cancel','adm_addbal_no'))]]),
    });
    return;
  }

  // ── ADMIN: Create Coupon ──
  if (state.state === 'adm_coupon_code')   { data.code = text.toUpperCase().trim(); pending.set(chatId,{state:'adm_coupon_amount',data}); await ctx.reply('💰 Credits value (e.g. 500):'); return; }
  if (state.state === 'adm_coupon_amount') {
    const amount = parseInt(text);
    if (isNaN(amount)||amount<=0) { await ctx.reply('❌ Enter positive number:'); return; }
    data.amount = String(amount); pending.set(chatId,{state:'adm_coupon_uses',data});
    await ctx.reply('🔢 Max uses (e.g. 1 = single use, 100 = 100 people):');
    return;
  }
  if (state.state === 'adm_coupon_uses') {
    const maxUses = parseInt(text);
    if (isNaN(maxUses)||maxUses<=0) { await ctx.reply('❌ Enter positive number:'); return; }
    pending.delete(chatId);
    coupons.set(data.code, { amount:parseInt(data.amount), maxUses, usesLeft:maxUses, usedBy:new Set() });
    await ctx.reply(`✅ *Coupon Created!*\n\n🎟️ Code: \`${data.code}\`\n💰 Value: *${data.amount} credits*\n🔢 Max uses: *${maxUses}*`, { parse_mode:'Markdown' });
    return;
  }

  // ── ADMIN: eSIM — Edit Price ──
  if (state.state === 'adm_ep_edit_price') {
    const price = parseInt(text);
    if (isNaN(price) || price <= 0) { await ctx.reply('❌ Enter price in cents (ex: 1500 = $15):'); return; }
    pending.delete(chatId);
    try {
      await makeApi(session?.token).patch(`/admin/esim/products/${data.productId}`, { price });
      await ctx.reply(`✅ *Price updated to $${(price/100).toFixed(2)}!*`, { parse_mode:'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
    return;
  }

  // ── ADMIN: eSIM — Edit GB ──
  if (state.state === 'adm_ep_edit_gb') {
    const gb = parseFloat(text);
    if (isNaN(gb) || gb <= 0) { await ctx.reply('❌ Enter valid GB (ex: 10):'); return; }
    data.gb = String(gb);
    pending.set(chatId, { state: 'adm_ep_edit_days', data });
    await ctx.reply('📅 New validity in days?\n_Example: 30_', { parse_mode:'Markdown' });
    return;
  }
  if (state.state === 'adm_ep_edit_days') {
    const days = parseInt(text);
    if (isNaN(days) || days <= 0) { await ctx.reply('❌ Enter valid days (ex: 30):'); return; }
    pending.delete(chatId);
    try {
      await makeApi(session?.token).patch(`/admin/esim/products/${data.productId}`, {
        gb: parseFloat(data.gb), days,
      });
      await ctx.reply(`✅ *Updated: ${data.gb}GB / ${days} days!*`, { parse_mode:'Markdown' });
    } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
    return;
  }

  // ── ADMIN: eSIM — Add Product ──
  if (state.state === 'adm_esim_name') {
    data.name = text;
    pending.set(chatId, { state: 'adm_esim_country', data });
    await ctx.reply('Step 2/5: Country name?\n_Example: Morocco_', { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_esim_country') {
    data.country = text;
    pending.set(chatId, { state: 'adm_esim_code', data });
    await ctx.reply('Step 3/5: Country code (2 letters)?\n_Example: MA for Morocco, US for USA_', { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_esim_code') {
    data.countryCode = text.toUpperCase().slice(0, 2);
    pending.set(chatId, { state: 'adm_esim_gb', data });
    await ctx.reply('Step 4/5: Data size in GB?\n_Example: 10_', { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_esim_gb') {
    const gb = parseFloat(text);
    if (isNaN(gb) || gb <= 0) { await ctx.reply('❌ Enter a valid number (e.g. 10):'); return; }
    data.gb = String(gb);
    pending.set(chatId, { state: 'adm_esim_days', data });
    await ctx.reply('Step 5/5: Validity in days?\n_Example: 30_', { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_esim_days') {
    const days = parseInt(text);
    if (isNaN(days) || days <= 0) { await ctx.reply('❌ Enter a valid number (e.g. 30):'); return; }
    data.days = String(days);
    pending.set(chatId, { state: 'adm_esim_price', data });
    await ctx.reply('💰 Price in cents (USD)?\n_Example: 1500 = $15.00_', { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_esim_price') {
    const price = parseInt(text);
    if (isNaN(price) || price <= 0) { await ctx.reply('❌ Enter price in cents (e.g. 1500 for $15):'); return; }
    pending.delete(chatId);
    try {
      await makeApi(session?.token).post('/admin/esim/products', {
        name: data.name,
        country: data.country,
        countryCode: data.countryCode,
        gb: parseFloat(data.gb),
        days: parseInt(data.days),
        price,
      });
      await ctx.reply(
        `✅ *eSIM Product Created!*\n\n` +
        `${flag(data.countryCode.toLowerCase())} *${data.country}* — ${data.gb}GB / ${data.days} days\n` +
        `💰 Price: $${(price/100).toFixed(2)}\n\n` +
        `Now add QR codes via ⚙️ Admin Panel → 📡 eSIM Manager → 📋 Add QR Code`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
    return;
  }

  // ── ADMIN: eSIM — Add QR Code ──
  if (state.state === 'adm_esim_qrdata') {
    const qrCodeData = text.trim();
    pending.set(chatId, { state: 'adm_esim_actcode', data: { ...data, qrCodeData } });
    await ctx.reply('🔑 Activation code? (optional — press /skip if none)', { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_esim_actcode') {
    const activationCode = text === '/skip' ? '' : text.trim();
    pending.delete(chatId);
    try {
      await makeApi(session?.token).post(`/admin/esim/products/${data.productId}/inventory`, {
        qrCodeData: data.qrCodeData,
        activationCode: activationCode || undefined,
      });
      await ctx.reply(
        `✅ *QR Code Added!*\n\nThe eSIM is now available for purchase.\n\n_Stock updated automatically._`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
    return;
  }

  // ── MANUAL RECHARGE: Method selection ──
  if (state.state === 'recharge_method') {
    const methodMap: Record<string, string> = {
      '💛 Binance ID': 'BINANCE',
      '💚 USDT TRC20': 'USDT',
      '🏦 IBAN': 'IBAN',
      '🏧 CIH Bank': 'CIH',
    };
    if (text === '❌ Cancel') {
      pending.delete(chatId);
      const kb = session ? getKeyboard(session.role) : Markup.removeKeyboard();
      await ctx.reply('❌ Cancelled.', kb);
      return;
    }
    const method = methodMap[text];
    if (!method) { await ctx.reply('Please select a method from the keyboard:'); return; }
    pending.set(chatId, { state: 'recharge_amount', data: { method } });
    await ctx.reply(
      `✅ Method: *${text}*\n\nEnter the amount in USD (e.g. 10):`,
      { parse_mode: 'Markdown', ...Markup.keyboard([['❌ Cancel']]).resize() }
    );
    return;
  }

  // ── MANUAL RECHARGE: Amount ──
  if (state.state === 'recharge_amount') {
    if (text === '❌ Cancel') {
      pending.delete(chatId);
      const kb = session ? getKeyboard(session.role) : Markup.removeKeyboard();
      await ctx.reply('❌ Cancelled.', kb);
      return;
    }
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 1) { await ctx.reply('❌ Please enter a valid amount (minimum $1):'); return; }
    pending.set(chatId, { state: 'recharge_txid', data: { ...data, amount: String(amount) } });
    await ctx.reply(
      `✅ Amount: *$${amount}*\n\nEnter your transaction ID or reference number:`,
      { parse_mode: 'Markdown', ...Markup.keyboard([['❌ Cancel']]).resize() }
    );
    return;
  }

  // ── MANUAL RECHARGE: TxID & submit ──
  if (state.state === 'recharge_txid') {
    if (text === '❌ Cancel') {
      pending.delete(chatId);
      const kb = session ? getKeyboard(session.role) : Markup.removeKeyboard();
      await ctx.reply('❌ Cancelled.', kb);
      return;
    }
    pending.delete(chatId);
    if (!session) { await ctx.reply('❌ Please login first.'); return; }
    const methodDisplay: Record<string, string> = {
      BINANCE: '💛 Binance ID', USDT: '💚 USDT TRC20', IBAN: '🏦 IBAN', CIH: '🏧 CIH Bank',
    };
    try {
      await makeApi(session.token).post('/recharge', {
        method: data.method,
        amountUsd: parseFloat(data.amount),
        txid: text,
      });
      await ctx.reply(
        `✅ *Recharge Request Submitted!*\n\n` +
        `Method: ${methodDisplay[data.method] || data.method}\n` +
        `Amount: *$${data.amount}*\n` +
        `TxID: \`${text}\`\n` +
        `Status: *PENDING* ⏳\n\n` +
        `Our team will review and approve within 24h.`,
        { parse_mode: 'Markdown', ...getKeyboard(session.role) }
      );
    } catch (err: any) {
      const msg = err?.response?.data?.message || err.message || 'Unknown error';
      await ctx.reply(`❌ Error: ${msg}`, getKeyboard(session.role));
    }
    return;
  }

  // ── DEPOSIT: Custom Amount ──
  if (state.state === 'deposit_custom') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 1 || amount > 500) {
      await ctx.reply('❌ Enter a valid amount between $1 and $500:');
      return;
    }
    pending.delete(chatId);
    if (!session) { await ctx.reply('❌ Please login first.'); return; }
    await processDeposit(ctx, session, amount);
    return;
  }

  // ── ADMIN: Broadcast ──
  if (state.state === 'adm_broadcast_msg') {
    pending.delete(chatId);
    const chatIds = [...sessions.keys()];
    await ctx.reply(`📢 Sending to ${chatIds.length} users...`);
    let sent = 0, failed = 0;
    for (const id of chatIds) {
      try { await bot.telegram.sendMessage(id, `📢 *Announcement*\n\n${text}`, { parse_mode:'Markdown' }); sent++; } catch { failed++; }
    }
    await ctx.reply(`✅ Done! ✉️ Sent: ${sent} | ❌ Failed: ${failed}`);
    return;
  }

  // ── ADMIN: Reject recharge reason ──
  if (state.state === 'adm_rch_reject') {
    pending.delete(chatId);
    const reason = text === 'none' ? 'Rejected by admin' : text;
    try {
      await makeApi(botAdminToken!).patch(`/recharge/admin/${data.id}/review`, {
        status: 'REJECTED',
        adminNote: reason,
      });
      await ctx.reply(`❌ Recharge \`${data.id}\` rejected.\nReason: ${reason}`, { parse_mode: 'Markdown' });
    } catch (err: any) {
      await ctx.reply(`❌ Error: ${err?.response?.data?.message || err.message}`);
    }
    return;
  }
});

// ════════════════════════════════════════════════════════════════
// LAUNCH — Express server (Mini App + Telegraf webhook)
// ════════════════════════════════════════════════════════════════
const PORT           = parseInt(process.env.PORT ?? '3000');
const WEBHOOK_DOMAIN = (process.env.WEBHOOK_DOMAIN ?? '').replace(/\/$/, '');
// BOT_PUBLIC_URL = public HTTPS URL of this bot server (same as WEBHOOK_DOMAIN on Railway)
const BOT_PUBLIC_URL = (process.env.BOT_PUBLIC_URL ?? WEBHOOK_DOMAIN).replace(/\/$/, '');
// BACKEND_URL = NestJS API root (no /api/v1)
const BACKEND_URL    = (process.env.API_URL ?? '').replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');

async function bootstrap() {
  // Fetch bot username
  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username ?? botUsername;
    console.log(`🤖 Bot: @${botUsername}`);
  } catch {}

  // Auto admin login
  tryAutoAdminLogin();

  const expressApp = express();
  expressApp.use(express.json());

  // ── Mini App ──────────────────────────────────────────────────
  const publicDir  = path.join(__dirname, 'public');
  const htmlSource = path.join(publicDir, 'index.html');

  // Serve index.html with runtime template variables injected
  expressApp.get('/app', (_req, res) => {
    try {
      let html = fs.readFileSync(htmlSource, 'utf8');
      html = html.replace(/__BACKEND_URL__/g,   BACKEND_URL || 'http://localhost:3001');
      html = html.replace(/__BOT_USERNAME__/g,  botUsername);
      html = html.replace(/__BINANCE_ID__/g,    process.env.PAYMENT_BINANCE_ID    || '');
      html = html.replace(/__USDT_ADDRESS__/g,  process.env.PAYMENT_USDT_ADDRESS  || '');
      html = html.replace(/__IBAN__/g,          process.env.PAYMENT_IBAN          || '');
      html = html.replace(/__CIH_BANK__/g,      process.env.PAYMENT_CIH_BANK      || '');
      res.type('html').send(html);
    } catch { res.status(500).send('App unavailable'); }
  });
  expressApp.use('/app', express.static(publicDir));

  // ── Health ────────────────────────────────────────────────────
  expressApp.get('/health', (_req, res) => res.json({ status: 'ok', bot: `@${botUsername}` }));

  if (WEBHOOK_DOMAIN) {
    // ── Webhook mode (Railway) ────────────────────────────────
    const webhookPath = `/webhook/${BOT_TOKEN.replace(':', '_')}`;
    // Mount WITHOUT path prefix — Express strips the prefix so Telegraf sees '/' not the full path
    expressApp.use(bot.webhookCallback(webhookPath));

    expressApp.listen(PORT, () =>
      console.log(`🚀 Server on :${PORT} | Mini App: ${BOT_PUBLIC_URL}/app`),
    );

    await bot.telegram.setWebhook(`${WEBHOOK_DOMAIN}${webhookPath}`, {
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(`🔗 Webhook: ${WEBHOOK_DOMAIN}${webhookPath}`);
  } else {
    // ── Long-polling mode (local dev) ─────────────────────────
    expressApp.listen(PORT, () =>
      console.log(`🌐 Local server: http://localhost:${PORT}/app`),
    );
    await bot.launch({ allowedUpdates: ['message', 'callback_query'] });
    console.log('🤖 Bot started (long-polling)');
  }

  process.once('SIGINT',  () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

bootstrap().catch(console.error);
