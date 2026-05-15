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
import { t } from './i18n';
import {
  loadState, saveUserLang, saveDigitalProducts, saveCoupons,
  saveReferrals, saveUserOrders, saveBannedUsers,
  saveScheduledBroadcast, saveFlashSale, saveBroadcastOptOut,
} from './store';

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
const SUPPORT_USERNAME   = process.env.SUPPORT_USERNAME ?? 'toopsellerr';
const SHOP_NAME          = process.env.SHOP_NAME ?? 'toopseller';
const WELCOME_IMAGE_URL  = process.env.WELCOME_IMAGE_URL ?? '';

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
  chatId:      number;
  userId:      string;
  status:      'pending' | 'received' | 'canceled' | 'expired';
  smsCode?:    string;
  smsText?:    string;
  charged:     boolean;
}

interface SMSCountry { ID: string; name: string; short_name: string; }
interface SMSService  { ID: string; name: string; short_name: string; }

interface DigitalItem    { id: string; credentials: string; soldTo?: number; soldAt?: Date; }
interface DigitalProduct { id: string; category: string; name: string; description: string; price: number; stock: DigitalItem[]; imageUrl?: string; }
interface SupportTicket  { id: string; chatId: number; email: string; subject: string; messages: { from: 'user'|'admin'; text: string; at: string }[]; status: 'open'|'closed'; createdAt: string; }
interface DigitalPurchase { productId: string; productName: string; credentials: string; price: number; purchasedAt: string; }

// ── Storage ───────────────────────────────────────────────────
const sessions    = new Map<number, UserSession>();
let userLang      = new Map<number, string>();
const pending     = new Map<number, PendingState>();
let coupons       = new Map<string, Coupon>();
let referrals     = new Map<number, number>();
let referred      = new Set<number>();
const activePolls    = new Map<string, NodeJS.Timeout>();
const smsOrders      = new Map<string, SMSLocalOrder>();
let userOrders       = new Map<number, string[]>();
const paymentPolls   = new Map<string, NodeJS.Timeout>();
const pendingDeposits= new Map<string, { chatId: number; amountUsd: number; credits: number }>();
const creditingUuids = new Set<string>(); // prevents double-credit on concurrent deposit confirms
let digitalProducts  = new Map<string, DigitalProduct>();
let bannedUsers         = new Set<number>();
let broadcastOptOut     = new Set<number>();
let flashSale: { percent: number; endsAt: string } | null = null;
const errorAlertTimers  = new Map<string, number>();
const supportTickets    = new Map<string, SupportTicket>();
const digitalPurchases  = new Map<number, DigitalPurchase[]>(); // chatId → purchases
const rechargeChatIds   = new Map<string, number>();           // rechargeId → chatId (for user notifications)

let scheduledBroadcast: {
  message: string; photoUrl?: string;
  intervalMs: number; timer: NodeJS.Timeout;
} | null = null;

async function runBroadcast(message: string, photoUrl?: string) {
  const chatIds = [...sessions.keys()].filter(id => !broadcastOptOut.has(id));
  let sent = 0, failed = 0;
  for (const id of chatIds) {
    try {
      if (photoUrl) {
        await bot.telegram.sendPhoto(id, photoUrl, { caption: message, parse_mode: 'Markdown' });
      } else {
        await bot.telegram.sendMessage(id, message, { parse_mode: 'Markdown' });
      }
      sent++;
    } catch { failed++; }
  }
  return { sent, failed };
}

async function notifyAdminError(label: string, err: any) {
  const now = Date.now();
  if ((now - (errorAlertTimers.get(label) ?? 0)) < 10 * 60_000) return;
  errorAlertTimers.set(label, now);
  const ids = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
  for (const id of ids) {
    try { await bot.telegram.sendMessage(id, `🚨 *Error: ${label}*\n\n\`${errMsg(err).slice(0, 300)}\``, { parse_mode: 'Markdown' }); } catch {}
  }
}

function getLang(chatId: number): string { return userLang.get(chatId) ?? 'en'; }

let botAdminToken: string | null  = null;
let adminChatId:   number | null  = null;
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
  const data = err?.response?.data;
  if (data) {
    const msg = data.message ?? data.error ?? data.info ?? data.msg;
    if (Array.isArray(msg))          return msg.join(', ');
    if (typeof msg === 'string')     return msg;
    if (typeof data === 'string')    return data;
    return JSON.stringify(data);
  }
  return err?.message ?? 'Unknown error';
}

function logApiError(label: string, err: any) {
  console.error(
    `[${label}] status=${err?.response?.status ?? 'N/A'}`,
    `body=`, err?.response?.data ?? err?.message,
  );
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
          clearInterval(t); paymentPolls.delete(uuid);
          // Guard: skip if already credited (e.g. user pressed Check Payment at same time)
          if (creditingUuids.has(uuid)) return;
          creditingUuids.add(uuid);
          pendingDeposits.delete(uuid);
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

// ── Digital Store categories ──────────────────────────────────
const DIGITAL_CATEGORIES = [
  { id: 'email',       emoji: '📩', label: 'Email Accounts' },
  { id: 'social',      emoji: '📲', label: 'Social Media' },
  { id: 'streaming',   emoji: '🍿', label: 'Streaming' },
  { id: 'gaming',      emoji: '🎮', label: 'Gaming' },
  { id: 'software',    emoji: '💿', label: 'Software Licenses' },
  { id: 'vpn',         emoji: '🛡️', label: 'VPN' },
  { id: 'office',      emoji: '🪟', label: 'Office 365' },
  { id: 'iptv',        emoji: '📡', label: 'IPTV' },
  { id: 'gemini',      emoji: '💠', label: 'Gemini PRO' },
  { id: 'higgsfield',  emoji: '🎞️', label: 'Higgsfield' },
  { id: 'adobe',       emoji: '🔴', label: 'Adobe' },
  { id: 'supergrok',   emoji: '⚡', label: 'Super Grok' },
  { id: 'capcut',      emoji: '✂️', label: 'CapCut Pro' },
  { id: 'elevenlabs',  emoji: '🔊', label: 'ElevenLabs' },
  { id: 'googleads',   emoji: '🔍', label: 'Google Ads' },
  { id: 'facebookads', emoji: '📘', label: 'Facebook Ads' },
  { id: 'tiktokads',   emoji: '🎵', label: 'TikTok Ads' },
] as const;

function availableStock(p: DigitalProduct): DigitalItem[] {
  return p.stock.filter(i => !i.soldTo);
}

// ── Keyboards ─────────────────────────────────────────────────
function getKeyboard(chatId: number, role: string) {
  const lang   = getLang(chatId);
  const appUrl = process.env.BOT_PUBLIC_URL
    ? `${process.env.BOT_PUBLIC_URL.replace(/\/$/, '')}/app`
    : null;

  const rows: any[] = [
    [t(lang, 'btn_balance'),       t(lang, 'btn_deposit')],
    [t(lang, 'btn_buy'),           t(lang, 'btn_esim')],
    [t(lang, 'btn_digital_store'), t(lang, 'btn_orders')],
    [t(lang, 'btn_coupon'),        t(lang, 'btn_support')],
    [t(lang, 'btn_referral'),      t(lang, 'btn_profile')],
    ['🌍 Language',                t(lang, 'btn_logout')],
    role === 'ADMIN'
      ? [t(lang, 'btn_admin')]
      : [],
  ].filter(r => r.length > 0);

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
async function showAuthMenu(ctx: any) {
  const chatId  = ctx.chat?.id ?? ctx.chat!.id;
  const lang    = getLang(chatId);
  const caption = t(lang, 'welcome', { shop: SHOP_NAME });
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, 'btn_login'),    'do_login')],
    [Markup.button.callback(t(lang, 'btn_register'), 'do_register')],
  ]);
  if (WELCOME_IMAGE_URL) {
    try {
      await ctx.replyWithPhoto(WELCOME_IMAGE_URL, { caption, parse_mode: 'Markdown', ...keyboard });
      return;
    } catch { /* bad URL — fall through to text reply */ }
  }
  await ctx.reply(caption, { parse_mode: 'Markdown', ...keyboard });
}

bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  pending.delete(chatId);

  const payload = ctx.startPayload;
  if (payload?.startsWith('ref_')) {
    const ref = parseInt(payload.replace('ref_', ''));
    if (ref && ref !== chatId && !referrals.has(chatId)) { referrals.set(chatId, ref); saveReferrals(referrals, referred); }
  }

  const session = sessions.get(chatId);
  if (session) {
    const lang    = getLang(chatId);
    const caption = t(lang, 'welcome_back', { email: session.email });
    const kb      = getKeyboard(chatId, session.role);
    if (WELCOME_IMAGE_URL) {
      try {
        await ctx.replyWithPhoto(WELCOME_IMAGE_URL, { caption, parse_mode: 'Markdown', ...kb });
      } catch {
        await ctx.reply(caption, { parse_mode: 'Markdown', ...kb });
      }
    } else {
      await ctx.reply(caption, { parse_mode: 'Markdown', ...kb });
    }
    const appUrl = process.env.BOT_PUBLIC_URL
      ? `${process.env.BOT_PUBLIC_URL.replace(/\/$/, '')}/app`
      : null;
    if (appUrl) {
      await ctx.reply(
        t(lang, 'open_dashboard'),
        Markup.inlineKeyboard([[Markup.button.webApp('🌐 Open Dashboard', appUrl)]]),
      );
    }
    return;
  }

  // If language already chosen, show auth menu directly
  if (userLang.has(chatId)) {
    await showAuthMenu(ctx);
    return;
  }

  // Language selection — shown in all 4 languages so first-time users understand
  await ctx.reply(
    '🌐 *Choose your language*\nاختر لغتك\nChoisissez votre langue\nPilih bahasa Anda',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('English 🇬🇧',    'lang_en'),
          Markup.button.callback('عربي 🇸🇦',        'lang_ar'),
        ],
        [
          Markup.button.callback('Français 🇫🇷',   'lang_fr'),
          Markup.button.callback('Indonesia 🇮🇩',  'lang_id'),
        ],
      ]),
    },
  );
});

// ── Language selection handlers ───────────────────────────────
const LANG_LABELS: Record<string, string> = {
  lang_en: 'English 🇬🇧',
  lang_ar: 'عربي 🇸🇦',
  lang_fr: 'Français 🇫🇷',
  lang_id: 'Indonesia 🇮🇩',
};
for (const [action, label] of Object.entries(LANG_LABELS)) {
  const code = action.replace('lang_', '');
  bot.action(action, async (ctx) => {
    const chatId = ctx.chat!.id;
    userLang.set(chatId, code);
    saveUserLang(userLang);
    await ctx.answerCbQuery(label);
    await ctx.deleteMessage().catch(() => {});
    await showAuthMenu(ctx);
  });
}

bot.command('help', async (ctx) => {
  await ctx.reply(
    `❓ *FAQ — Frequently Asked Questions*\n\n` +
    `━━━━━━━━━━━━━━━━━\n\n` +
    `💰 *Kifash ndeposi / nrecharge?*\n` +
    `➜ Gles 💳 Deposit wla 💳 Recharge — khtar method (Binance, USDT, IBAN, CIH) w sifet l proof.\n\n` +
    `📱 *Kifash nshri number dyal SMS?*\n` +
    `➜ Gles 📱 Buy Number — khtar service (WhatsApp, Telegram...) w country — bot ghadi yb3at lik number w code automatique.\n\n` +
    `🛒 *Kifash nshri product digital?*\n` +
    `➜ Gles 🛒 Digital Store — khtar category — khtar product — gles Buy Now.\n\n` +
    `⏳ *Ch7al kaytakhad recharge?*\n` +
    `➜ 3adatan bin 5 d9aye9 w 24 sa3a — 7asab l wa9t.\n\n` +
    `🔐 *SMS code ma jatch?*\n` +
    `➜ Sber — bot kaycheck automatique kol 5 secondes hta 17 d9i9a. Ida ma jatch, makaynach charge.\n\n` +
    `💳 *Kifash n3ref ch7al 3andi f balance?*\n` +
    `➜ Gles 💰 Balance men keyboard.\n\n` +
    `🎟️ *Kifash nstamle coupon?*\n` +
    `➜ Gles 🎟️ Redeem Coupon w kteb code.\n\n` +
    `🆘 *Kayn mochkil?*\n` +
    `➜ Gles 🎧 Support w ftah ticket — admin ghadi yredek.\n\n` +
    `━━━━━━━━━━━━━━━━━`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎧 Open Support Ticket', 'btn_support')],
      ]),
    },
  );
});

// ── Auth ──────────────────────────────────────────────────────
bot.action('do_login',    async (ctx) => { const id = ctx.chat!.id; pending.set(id, {state:'login_email',    data:{}}); await ctx.reply(t(getLang(id), 'enter_email'));  await ctx.answerCbQuery(); });
bot.action('do_register', async (ctx) => { const id = ctx.chat!.id; pending.set(id, {state:'register_email', data:{}}); await ctx.reply(t(getLang(id), 'enter_email')); await ctx.answerCbQuery(); });

// ════════════════════════════════════════════════════════════════
// BALANCE
// ════════════════════════════════════════════════════════════════
async function showBalance(ctx: any, session: UserSession) {
  const lang = getLang(ctx.chat?.id ?? ctx.chat!.id);
  try {
    const res = await makeApi(session.token).get('/wallet/balance');
    const { balance } = unwrap(res);
    await ctx.reply(
      t(lang, 'balance_display', { balance, usd: (balance / CREDITS_PER_USD).toFixed(2) }),
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
    notifyAdminError('Backend API /wallet/balance', err);
  }
}

// ════════════════════════════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════════════════════════════
async function showProfile(ctx: any, session: UserSession) {
  const chatId = ctx.chat?.id ?? ctx.chat!.id;
  const lang   = getLang(chatId);
  try {
    const res        = await makeApi(session.token).get('/wallet/balance');
    const { balance } = unwrap(res);
    const orderCount  = userOrders.get(chatId)?.length ?? 0;
    const refLink     = `https://t.me/${botUsername}?start=ref_${chatId}`;
    const isOptedOut   = broadcastOptOut.has(chatId);
    const optOutLabel  = isOptedOut ? '🔔 Enable Broadcasts' : '📵 Opt-out Broadcasts';
    await ctx.reply(
      `👤 *Profile*\n\n` +
      `📧 Email: \`${session.email}\`\n` +
      `💰 Balance: *${balance} credits* (≈ $${(balance / CREDITS_PER_USD).toFixed(2)})\n` +
      `📋 Orders this session: *${orderCount}*\n` +
      `🔑 Role: *${session.role}*\n` +
      `📢 Broadcasts: *${isOptedOut ? 'Off 🔕' : 'On 🔔'}*\n\n` +
      `👥 *Referral Link:*\n\`${refLink}\``,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(optOutLabel, 'toggle_broadcast')],
          [Markup.button.callback('🚪 Logout', 'do_logout')],
        ]),
      },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
}

bot.action('do_logout', async (ctx) => {
  const chatId = ctx.chat!.id;
  const lang   = getLang(chatId);
  sessions.delete(chatId);
  await ctx.answerCbQuery();
  await ctx.reply(t(lang, 'logged_out'), Markup.removeKeyboard());
});

bot.action('change_lang', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '🌍 *Choose your language*\nاختر لغتك\nChoisissez votre langue',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('English 🇬🇧', 'lang_en'), Markup.button.callback('Français 🇫🇷', 'lang_fr')],
        [Markup.button.callback('عربي 🇸🇦', 'lang_ar'),   Markup.button.callback('Indonesia 🇮🇩', 'lang_id')],
      ]),
    },
  );
});

bot.action('toggle_broadcast', async (ctx) => {
  const chatId = ctx.chat!.id;
  if (broadcastOptOut.has(chatId)) {
    broadcastOptOut.delete(chatId);
    await ctx.answerCbQuery('🔔 Broadcasts enabled');
  } else {
    broadcastOptOut.add(chatId);
    await ctx.answerCbQuery('📵 Broadcasts disabled');
  }
  saveBroadcastOptOut(broadcastOptOut);
  await ctx.deleteMessage().catch(() => {});
  const session = sessions.get(chatId);
  if (session) await showProfile(ctx, session);
});

// ════════════════════════════════════════════════════════════════
// DEPOSIT — Cryptomus crypto payments
// ════════════════════════════════════════════════════════════════
async function showDeposit(ctx: any) {
  const chatId = ctx.chat.id;
  const lang   = getLang(chatId);
  if (!CRYPTOMUS_MERCHANT || !CRYPTOMUS_KEY) {
    pending.set(chatId, { state: 'recharge_method', data: {} });
    await ctx.reply(
      t(lang, 'recharge_select_method'),
      {
        parse_mode: 'Markdown',
        ...Markup.keyboard([
          ['💛 Binance ID', '💚 USDT TRC20'],
          ['🏦 IBAN', '🏧 CIH Bank'],
          [t(lang, 'btn_cancel')],
        ]).resize(),
      }
    );
    return;
  }
  await ctx.reply(
    t(lang, 'deposit_crypto', { rate: CREDITS_PER_USD }),
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
      // Guard: skip if polling loop already credited this uuid
      if (creditingUuids.has(uuid)) {
        await ctx.reply('✅ Payment already confirmed and credits added!');
        return;
      }
      creditingUuids.add(uuid);
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
    console.log('[ssms] SMSPool price response:', JSON.stringify(priceData));

    if (!priceData || priceData.success === 0) {
      const reason = priceData?.message ?? priceData?.error ?? JSON.stringify(priceData) ?? 'unavailable';
      console.error(`[ssms] Price check failed for country=${countryId} service=${serviceId}:`, reason);
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
  } catch (err: any) {
    logApiError('ssms price', err);
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// Confirmed — purchase from SMSPool
bot.action(/^cbuy_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }

  const [, countryId, serviceId, creditsStr] = ctx.match;
  const claimedCredits = parseInt(creditsStr);

  await ctx.answerCbQuery('⏳ Processing...');

  try {
    // 1. Re-verify price from SMSPool (prevent callback data tampering)
    const priceRes  = await smsPost('/request/price', { country: countryId, service: serviceId });
    const priceData = priceRes.data;
    const usdPrice  = parseFloat(priceData?.price ?? priceData?.cost ?? '0');
    const realCredits = usdPrice > 0 ? toCredits(usdPrice) : claimedCredits;
    // Reject if claimed price is more than 20% below real price
    if (claimedCredits < Math.floor(realCredits * 0.8)) {
      await ctx.reply('❌ Price mismatch. Please reopen the service and try again.');
      return;
    }
    const credits = realCredits; // always use server-verified price

    // 2. Check balance
    const balRes   = await makeApi(session.token).get('/wallet/balance');
    const { balance } = unwrap(balRes);
    if (balance < credits) {
      await ctx.reply(`❌ Insufficient balance!\n\nYou need *${credits} credits* but only have *${balance}*.`, { parse_mode:'Markdown' });
      return;
    }

    // 3. Purchase from SMSPool
    const [countries, services] = await Promise.all([getSMSCountries(), getSMSServices()]);
    const country = countries.find((c) => String(c.ID) === String(countryId));
    const service = services.find((s) => String(s.ID) === String(serviceId));

    const purchaseRes  = await smsPost('/purchase/sms', {
      country: countryId,
      service: serviceId,
      pricing_option: '1', // highest success rate
    });
    const purchase = purchaseRes.data;
    console.log('[cbuy] SMSPool response:', JSON.stringify(purchase));

    if (!purchase || purchase.success === 0 || purchase.success === '0') {
      const reason = purchase?.message ?? purchase?.error ?? JSON.stringify(purchase) ?? 'No numbers available.';
      console.error(`[cbuy] Purchase failed for country=${countryId} service=${serviceId}:`, reason);
      await ctx.reply(`❌ Purchase failed: ${reason}`);
      notifyAdminError('SMSPool purchase failed', new Error(reason));
      return;
    }

    const orderId     = purchase.order_code ?? purchase.orderid ?? String(purchase.number);
    const phoneNumber = purchase.phonenumber ?? purchase.number ?? 'N/A';

    // 3. Store order locally — balance deducted only after SMS arrives
    const order: SMSLocalOrder = {
      orderId, phoneNumber,
      service: service?.name ?? serviceId,
      country: country?.name ?? countryId,
      credits, chatId, userId: session.userId,
      status: 'pending', charged: false,
    };
    smsOrders.set(orderId, order);
    const existing = userOrders.get(chatId) ?? [];
    userOrders.set(chatId, [orderId, ...existing].slice(0, 10));
    saveUserOrders(userOrders);

    // 4. Reply immediately with the number
    await ctx.reply(
      `✅ *Number Assigned!*\n\n` +
      `📱 Number: \`${phoneNumber}\`\n` +
      `📲 Service: ${service?.name ?? serviceId}\n` +
      `🌍 Country: ${flag(country?.short_name ?? '')} ${country?.name ?? countryId}\n` +
      `💳 Cost: ${credits} credits _(charged on SMS receipt)_\n\n` +
      `🔔 *Waiting for SMS — I'll notify you instantly!*\n_(checking every 5 seconds, up to 17 min)_`,
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

  } catch (err: any) {
    logApiError('cbuy', err);
    await ctx.reply(`❌ Order failed: ${errMsg(err)}`);
  }
});

// ════════════════════════════════════════════════════════════════
// AUTO SMS POLLING — via SMSPool check
// ════════════════════════════════════════════════════════════════
const POLL_INTERVAL_MS = 5_000;   // 5 seconds
const POLL_MAX_ATTEMPTS = 204;    // 204 × 5s = 1020 seconds (~17 min)

async function chargeForSms(order: SMSLocalOrder): Promise<void> {
  if (order.charged || !botAdminToken) return;
  order.charged = true;
  try {
    await makeApi(botAdminToken).post('/admin/balance/adjust', {
      userId: order.userId,
      amount: -order.credits,
      reason: `SMS order: ${order.service} (${order.phoneNumber})`,
    });
  } catch (e) {
    console.error('[charge] Balance deduct failed:', errMsg(e));
    order.charged = false; // allow retry
  }
}

function startAutoPolling(chatId: number, orderId: string, session: UserSession) {
  if (activePolls.has(orderId)) return;
  let attempts = 0;

  const t = setInterval(async () => {
    attempts++;
    if (attempts > POLL_MAX_ATTEMPTS) {
      clearInterval(t); activePolls.delete(orderId);
      const order = smsOrders.get(orderId);
      if (order) order.status = 'expired';
      try {
        await bot.telegram.sendMessage(chatId,
          `⏰ *Order Timed Out*\n\nNo SMS received after 17 minutes.\n📱 Number: \`${smsOrders.get(orderId)?.phoneNumber}\`\n_No charge applied._`,
          { parse_mode: 'Markdown' });
      } catch {}
      return;
    }

    try {
      const res  = await smsPost('/sms/check', { orderid: orderId });
      const data = res.data;

      // Detect SMS received — handle both array and flat response formats
      const smsArr  = Array.isArray(data.sms) ? data.sms : null;
      const hasCode = smsArr ? smsArr.length > 0 : (data.status === 3 && (data.sms || data.full_sms || data.code));
      if (hasCode) {
        clearInterval(t); activePolls.delete(orderId);
        const smsItem = smsArr ? smsArr[0] : data;
        const code    = smsItem.code ?? smsItem.sms ?? data.code ?? '';
        const full    = smsItem.full_code ?? smsItem.full_sms ?? smsItem.sms ?? code;
        const order   = smsOrders.get(orderId);
        if (order) { order.status = 'received'; order.smsCode = code; order.smsText = full; }

        // Deduct balance now that SMS is confirmed
        if (order) await chargeForSms(order);

        await bot.telegram.sendMessage(chatId,
          `🔔 *SMS Code Arrived\\!*\n` +
          `━━━━━━━━━━━━━━━\n\n` +
          `📱 Number: \`${order?.phoneNumber}\`\n` +
          `🌐 Service: *${order?.service ?? '—'}*\n\n` +
          `🔑 *Your Code:*\n` +
          `\`\`\`\n${code}\n\`\`\`\n` +
          `📄 _${full}_\n\n` +
          `━━━━━━━━━━━━━━━\n` +
          `💳 ${order?.credits} credits deducted`,
          {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('📋 Copy Code', `copy_code_${orderId}`), Markup.button.callback('🔄 Order Again', `reagain_${order?.service ?? ''}_${order?.country ?? ''}`)],
            ]),
          },
        );

        // Notify admin
        const notifyIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
        for (const adminId of notifyIds) {
          try {
            await bot.telegram.sendMessage(adminId,
              `✅ *SMS Order Done!*\n\n` +
              `👤 ${sessions.get(order!.chatId)?.email ?? String(order!.chatId)}\n` +
              `📱 \`${order?.phoneNumber}\`\n` +
              `🔐 Code: \`${code}\``,
              { parse_mode: 'Markdown' },
            );
          } catch {}
        }
        return;
      }

      // Expired on SMSPool side
      if (data.status === 2 || data.status === 'expired') {
        clearInterval(t); activePolls.delete(orderId);
        const order = smsOrders.get(orderId);
        if (order) order.status = 'expired';
        await bot.telegram.sendMessage(chatId, `⏰ Order expired on provider side. No SMS received. _No charge applied._`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      console.error(`[poll] check failed for ${orderId}:`, errMsg(e));
    }
  }, POLL_INTERVAL_MS);

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
    const smsArr  = Array.isArray(data.sms) ? data.sms : null;
    const hasCode = smsArr ? smsArr.length > 0 : (data.status === 3 && (data.sms || data.full_sms || data.code));
    if (hasCode) {
      const smsItem = smsArr ? smsArr[0] : data;
      const code    = smsItem.code ?? smsItem.sms ?? data.code ?? '';
      const full    = smsItem.full_code ?? smsItem.full_sms ?? smsItem.sms ?? code;
      const order   = smsOrders.get(orderId);
      if (order && order.status !== 'received') {
        order.status = 'received'; order.smsCode = code; order.smsText = full;
        await chargeForSms(order);
      }
      await ctx.reply(
        `🔔 *SMS Code Arrived\\!*\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `📱 Number: \`${order?.phoneNumber ?? '—'}\`\n` +
        `🌐 Service: *${order?.service ?? '—'}*\n\n` +
        `🔑 *Your Code:*\n` +
        `\`\`\`\n${code}\n\`\`\`\n` +
        `📄 _${full}_\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `💳 ${order?.credits ?? '?'} credits deducted`,
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📋 Copy Code', `copy_code_${orderId}`), Markup.button.callback('🔄 Order Again', `reagain_${order?.service ?? ''}_${order?.country ?? ''}`)],
          ]),
        },
      );
    } else if (data.status === 2 || data.status === 'expired') {
      await ctx.reply('⏰ This order has expired.');
    } else {
      await ctx.reply('⏳ No SMS yet — auto-checking every 5 seconds!',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Check Again', `poll_${orderId}`)]]));
      startAutoPolling(chatId, orderId, session);
    }
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// Copy code — resends code as plain text for easy long-press copy
bot.action(/^copy_code_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('📋 Code sent!');
  const orderId = ctx.match[1];
  const order   = smsOrders.get(orderId);
  const code    = order?.smsCode ?? '—';
  await ctx.reply(code);
});

// Copy payment details (Binance ID / USDT / IBAN / CIH)
bot.action(/^copy_pay_(BINANCE|USDT|IBAN|CIH)$/, async (ctx) => {
  await ctx.answerCbQuery('📋 Copied!');
  const method = ctx.match[1];
  const values: Record<string, string> = {
    BINANCE: process.env.PAYMENT_BINANCE_ID   ?? '',
    USDT:    process.env.PAYMENT_USDT_ADDRESS ?? '',
    IBAN:    process.env.PAYMENT_IBAN         ?? '',
    CIH:     process.env.PAYMENT_CIH_BANK     ?? '',
  };
  const val = values[method];
  if (val) await ctx.reply(val);
});

// Order Again — restart order flow for same service/country
bot.action(/^reagain_(.+)_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  await ctx.answerCbQuery();
  if (!session) return;
  const service = ctx.match[1];
  const country = ctx.match[2];
  if (!service || !country) { await ctx.reply('❌ Service info missing.'); return; }
  pending.set(chatId, { state: 'sms_confirm_reorder', data: { service, country } });
  await ctx.reply(
    `🔄 *Order Again*\n\n🌐 Service: *${service}*\n🌍 Country: *${country}*\n\nConfirm?`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yes, order', `reorder_${service}_${country}`), Markup.button.callback('❌ Cancel', 'menu_main')]]) },
  );
});

bot.action(/^reorder_(.+)_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  await ctx.answerCbQuery('⏳ Ordering...');
  if (!session) return;
  pending.delete(chatId);
  const service = ctx.match[1];
  const country = ctx.match[2];
  try {
    const res    = await smsPost('/request/number', { service, country, pricing_category: 'virtual_reg' });
    const data   = res.data;
    const number = data.number ?? data.phonenumber;
    const orderId = String(data.order_id ?? data.id ?? Date.now());
    if (!number) throw new Error(data.message ?? 'No number returned');
    const credits = data.cost ? toCredits(parseFloat(data.cost)) : 10;
    const order: SMSLocalOrder = { orderId, phoneNumber: number, service, country, credits, chatId, userId: session.userId, status: 'pending', charged: false };
    smsOrders.set(orderId, order);
    await ctx.reply(
      `✅ *New Number Ready\\!*\n\n📱 \`${number}\`\n🌐 *${service}*\n\n⏳ Waiting for SMS\\.\\.\\.`,
      { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Check Now', `poll_${orderId}`), Markup.button.callback('❌ Cancel', `cancel_${orderId}`)]]) },
    );
    startAutoPolling(chatId, orderId, session);
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

    // No refund needed — balance is only charged after SMS is received
    await ctx.reply('✅ Order canceled. No charge was applied.');
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ════════════════════════════════════════════════════════════════
// MY ORDERS — from local SMS storage
// ════════════════════════════════════════════════════════════════
async function showOrders(ctx: any, _session: UserSession) {
  const chatId   = ctx.chat?.id;
  const orderIds = userOrders.get(chatId) ?? [];

  if (!orderIds.length) {
    await ctx.reply(t(getLang(chatId), 'no_orders'), { parse_mode:'Markdown' });
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
  const chatId = ctx.chat?.id;
  pending.set(chatId, { state:'redeem_coupon', data:{} });
  await ctx.reply(t(getLang(chatId), 'coupon_prompt'), { parse_mode:'Markdown' });
}

// ════════════════════════════════════════════════════════════════
// REFERRAL
// ════════════════════════════════════════════════════════════════
async function showReferral(ctx: any) {
  const chatId = ctx.chat?.id;
  const link   = `https://t.me/${botUsername}?start=ref_${chatId}`;
  await ctx.reply(
    t(getLang(chatId), 'referral_msg', { bonus: REFERRAL_BONUS, link }),
    { parse_mode:'Markdown' },
  );
}

// ════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ════════════════════════════════════════════════════════════════

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
    // Fetch platform stats + recharge list in parallel
    const [statsRes, rchRes] = await Promise.allSettled([
      makeApi(session.token).get('/admin/stats'),
      makeApi(botAdminToken ?? session.token).get('/recharge/admin', { params: { status: 'PENDING', limit: 100 } }),
    ]);

    const s = statsRes.status === 'fulfilled' ? unwrap(statsRes.value) : {};

    // Pending recharges count
    const rchData = rchRes.status === 'fulfilled' ? rchRes.value.data?.data ?? rchRes.value.data ?? [] : [];
    const pendingRecharges: number = Array.isArray(rchData) ? rchData.length : 0;

    // Digital store stats
    const allProducts = [...digitalProducts.values()];
    const totalProducts   = allProducts.length;
    const totalStockItems = allProducts.reduce((n, p) => n + p.stock.length, 0);
    const soldItems       = allProducts.reduce((n, p) => n + p.stock.filter(i => i.soldTo).length, 0);
    const availableItems  = totalStockItems - soldItems;

    // Active subscriptions = sold VPN / IPTV / Office 365 items
    const subCatIds = ['vpn', 'office365', 'iptv', 'streaming'];
    const activeSubs = allProducts
      .filter(p => subCatIds.includes(p.category))
      .reduce((n, p) => n + p.stock.filter(i => i.soldTo).length, 0);

    // Support tickets
    const openTickets   = [...supportTickets.values()].filter(t => t.status === 'open').length;
    const closedTickets = [...supportTickets.values()].filter(t => t.status === 'closed').length;

    // Revenue in USD
    const totalRevenueCents: number = s.totalRevenue ?? 0;
    const revenueUsd = (totalRevenueCents / CREDITS_PER_USD).toFixed(2);

    const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Casablanca', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });

    await ctx.reply(
      `📊 *Admin Dashboard*\n` +
      `🕐 _${now}_\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `👥 *Users*\n` +
      `   Total registered: *${s.totalUsers ?? 0}*\n\n` +
      `📋 *Orders*\n` +
      `   Total SMS orders: *${s.totalOrders ?? 0}*\n` +
      `   Pending SMS: *${s.pendingOrders ?? 0}*\n\n` +
      `💳 *Recharges*\n` +
      `   Awaiting approval: *${pendingRecharges}*\n\n` +
      `💰 *Revenue*\n` +
      `   Total: *${totalRevenueCents} credits* (~$${revenueUsd})\n\n` +
      `🛒 *Digital Store*\n` +
      `   Products: *${totalProducts}* | Stock: *${availableItems}* available / *${soldItems}* sold\n` +
      `   📅 Active subscriptions: *${activeSubs}* _(VPN / IPTV / Office)_\n\n` +
      `🎫 *Support Tickets*\n` +
      `   Open: *${openTickets}* | Closed: *${closedTickets}*`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📋 Review Recharges', 'adm_review'), Markup.button.callback('🎫 Tickets', 'adm_tickets')],
          [Markup.button.callback('📅 Subscriptions', 'adm_subscriptions'), Markup.button.callback('🔍 Search User', 'adm_search_user')],
          [Markup.button.callback('🔄 Refresh', 'adm_stats')],
        ]),
      },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('adm_rch_stats', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  try {
    const [approved, rejected, pending_] = await Promise.all([
      makeApi(botAdminToken!).get('/recharge/admin', { params: { status: 'APPROVED', limit: 100 } }),
      makeApi(botAdminToken!).get('/recharge/admin', { params: { status: 'REJECTED', limit: 100 } }),
      makeApi(botAdminToken!).get('/recharge/admin', { params: { status: 'PENDING',  limit: 100 } }),
    ]);
    const weekAgo = Date.now() - 7 * 24 * 3_600_000;
    const toList  = (res: any): any[] => Array.isArray(res.data?.data) ? res.data.data : (Array.isArray(res.data) ? res.data : []);
    const thisWeek= (list: any[]) => list.filter(r => new Date(r.createdAt).getTime() > weekAgo);

    const apList  = thisWeek(toList(approved));
    const rjList  = thisWeek(toList(rejected));
    const pdList  = toList(pending_);

    const apTotal = apList.reduce((s: number, r: any) => s + (r.amountUsd ?? (r.amount ?? 0) / 100), 0);

    await ctx.reply(
      `💳 *Recharge Stats — This Week*\n\n` +
      `✅ Approved: *${apList.length}* ($${apTotal.toFixed(2)} USD)\n` +
      `❌ Rejected: *${rjList.length}*\n` +
      `⏳ Pending:  *${pdList.length}*\n\n` +
      `_Tap 📋 Review Recharges to process pending._`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('📋 Review Pending', 'adm_review')]]) },
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

// ── ADMIN: Users List (paginated) ──
bot.action(/^adm_users(?:_p_(\d+))?$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match?.[1] ?? '1') || 1;
  try {
    const res    = await makeApi(session.token).get(`/admin/users?page=${page}&limit=8`);
    const resp   = unwrap(res);
    const users: any[] = resp?.users ?? (Array.isArray(resp) ? resp : []);
    const meta   = resp?.meta ?? { page: 1, totalPages: 1, total: users.length };
    if (!users.length) { await ctx.reply('👥 No users found.'); return; }

    const lines = users.map((u: any, i: number) =>
      `${(page - 1) * 8 + i + 1}. \`${u.email}\`\n   💰 ${u.balance ?? 0} cr · 📦 ${u._count?.orders ?? 0} orders`
    ).join('\n\n');

    const userBtns = users.map((u: any) =>
      [Markup.button.callback(`👤 ${u.email.split('@')[0]}`, `adm_usr_${u.id}`)]
    );
    const navRow: any[] = [];
    if (page > 1)               navRow.push(Markup.button.callback('⬅️ Prev', `adm_users_p_${page - 1}`));
    if (page < meta.totalPages) navRow.push(Markup.button.callback('➡️ Next', `adm_users_p_${page + 1}`));

    await ctx.reply(
      `👥 *Users* — Page ${meta.page}/${meta.totalPages} (${meta.total} total)\n\n${lines}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          ...userBtns,
          ...(navRow.length ? [navRow] : []),
        ]),
      },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ── ADMIN: User detail view ──
bot.action(/^adm_usr_([0-9a-f-]{36})$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  await ctx.answerCbQuery();
  const userId = ctx.match[1];
  try {
    const res = await makeApi(session.token).get(`/admin/users/${userId}`);
    const u   = unwrap(res);
    const bal     = u.balance ?? 0;
    const joined  = new Date(u.createdAt).toLocaleDateString('en-GB');
    const orders  = u.orders?.length ?? 0;

    let userChatId: number | null = null;
    for (const [cid, s] of sessions.entries()) {
      if (s.userId === userId) { userChatId = cid; break; }
    }
    const isBanned  = userChatId !== null && bannedUsers.has(userChatId);
    const botStatus = userChatId ? (isBanned ? '🚫 Banned' : '🟢 Active') : '⚫ Not in bot';

    await ctx.reply(
      `👤 *User Details*\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📧 \`${u.email}\`\n` +
      `💰 Balance: *${bal} credits*\n` +
      `📦 Recent orders: ${orders}\n` +
      `👤 Role: *${u.role}*\n` +
      `📅 Joined: ${joined}\n` +
      `🤖 Bot: ${botStatus}\n` +
      `━━━━━━━━━━━━━━━`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('➕ Add Credits',    `adm_usr_addcr_${userId}`),
            Markup.button.callback('➖ Remove Credits', `adm_usr_rmcr_${userId}`),
          ],
          [
            userChatId
              ? Markup.button.callback(isBanned ? '✅ Unban User' : '🚫 Ban User', `adm_usr_ban_${userId}`)
              : Markup.button.callback('⚫ Not in Bot', 'adm_usr_nobot'),
          ],
          [Markup.button.callback('🔙 Back to Users', 'adm_users')],
        ]),
      },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// ── ADMIN: Start add credits flow ──
bot.action(/^adm_usr_addcr_([0-9a-f-]+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  pending.set(chatId, { state: 'adm_usr_cr_amt', data: { userId: ctx.match[1], mode: 'add' } });
  await ctx.reply('➕ Enter credits to *add* (e.g. 500):', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

// ── ADMIN: Start remove credits flow ──
bot.action(/^adm_usr_rmcr_([0-9a-f-]+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  pending.set(chatId, { state: 'adm_usr_cr_amt', data: { userId: ctx.match[1], mode: 'remove' } });
  await ctx.reply('➖ Enter credits to *remove* (e.g. 50):', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

// ── ADMIN: Ban / Unban user ──
bot.action(/^adm_usr_ban_([0-9a-f-]+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const userId = ctx.match[1];
  let userChatId: number | null = null;
  for (const [cid, s] of sessions.entries()) {
    if (s.userId === userId) { userChatId = cid; break; }
  }
  if (!userChatId) { await ctx.answerCbQuery('⚫ User has no bot session'); return; }

  if (bannedUsers.has(userChatId)) {
    bannedUsers.delete(userChatId);
    saveBannedUsers(bannedUsers);
    await ctx.answerCbQuery('✅ User unbanned!');
    await ctx.reply(`✅ User *${userId.slice(0, 8)}…* has been *unbanned*.`, { parse_mode: 'Markdown' });
  } else {
    bannedUsers.add(userChatId);
    saveBannedUsers(bannedUsers);
    sessions.delete(userChatId);
    await ctx.answerCbQuery('🚫 User banned!');
    await ctx.reply(`🚫 User *${userId.slice(0, 8)}…* has been *banned*.`, { parse_mode: 'Markdown' });
    try { await bot.telegram.sendMessage(userChatId, '🚫 Your account has been banned. Contact support.'); } catch {}
  }
});

bot.action('adm_usr_nobot', async (ctx) => { await ctx.answerCbQuery('⚫ User has not used the bot yet'); });

// ── ADMIN: Confirm credit adjustment ──
bot.action('adm_usr_cr_yes', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  const state   = pending.get(chatId);
  if (!session || !state) { await ctx.answerCbQuery(); return; }
  pending.delete(chatId);
  await ctx.answerCbQuery();
  try {
    const { userId, mode } = state.data;
    const amount  = parseInt(state.data.amount);
    const credits = parseInt(state.data.credits);
    await makeApi(session.token).post('/admin/balance/adjust', { userId, amount, reason: 'Telegram admin' });
    await ctx.reply(
      `✅ *${mode === 'add' ? `+${credits}` : `-${credits}`} credits* ${mode === 'add' ? 'added' : 'removed'} successfully.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('adm_usr_cr_no', async (ctx) => {
  pending.delete(ctx.chat!.id);
  await ctx.reply('❌ Cancelled.');
  await ctx.answerCbQuery();
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
// SCHEDULED BROADCAST
// ════════════════════════════════════════════════════════════════
bot.action('adm_sched', async (ctx) => {
  const chatId = ctx.chat!.id;
  if (!isTgAdmin(ctx.from!.id) && sessions.get(chatId)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  await ctx.answerCbQuery();
  const status = scheduledBroadcast
    ? `✅ *Active* — every ${scheduledBroadcast.intervalMs / 3_600_000}h\n📝 "${scheduledBroadcast.message.slice(0, 60)}..."`
    : '⏸️ *No active scheduled post.*';
  await ctx.reply(
    `⏰ *Scheduled Post*\n\n${status}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Set New Schedule', 'adm_sched_new')],
        ...(scheduledBroadcast ? [[Markup.button.callback('🛑 Stop Schedule', 'adm_sched_stop')]] : []),
        [Markup.button.callback('📤 Send Once Now',    'adm_sched_now')],
      ]),
    },
  );
});

bot.action('adm_sched_stop', async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  await ctx.answerCbQuery('Stopped');
  if (scheduledBroadcast) {
    clearInterval(scheduledBroadcast.timer);
    scheduledBroadcast = null;
  }
  await ctx.reply('🛑 Scheduled broadcast stopped.');
});

bot.action('adm_sched_now', async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  await ctx.answerCbQuery('Sending...');
  if (!scheduledBroadcast) { await ctx.reply('❌ No scheduled post set. Create one first.'); return; }
  await ctx.reply('📤 Sending...');
  const { sent, failed } = await runBroadcast(scheduledBroadcast.message, scheduledBroadcast.photoUrl);
  await ctx.reply(`✅ Done! Sent: ${sent} | Failed: ${failed}`);
});

bot.action('adm_sched_new', async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  await ctx.answerCbQuery();
  await ctx.reply(
    '⏰ *New Scheduled Post*\n\nChoose send interval:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Every 1h',  'adm_sched_iv_1')],
        [Markup.button.callback('Every 6h',  'adm_sched_iv_6')],
        [Markup.button.callback('Every 12h', 'adm_sched_iv_12')],
        [Markup.button.callback('Every 24h', 'adm_sched_iv_24')],
        [Markup.button.callback('Every 48h', 'adm_sched_iv_48')],
      ]),
    },
  );
});

bot.action(/^adm_sched_iv_(\d+)$/, async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const hours  = parseInt(ctx.match[1]);
  const chatId = ctx.chat!.id;
  await ctx.answerCbQuery(`Every ${hours}h selected`);
  pending.set(chatId, { state: 'adm_sched_msg', data: { intervalMs: String(hours * 3_600_000) } });
  await ctx.reply('📝 Enter the message to broadcast:\n_(Markdown supported)_', { parse_mode: 'Markdown' });
});

// ════════════════════════════════════════════════════════════════
// DIGITAL STORE — User flow
// ════════════════════════════════════════════════════════════════
async function showSupport(ctx: any) {
  const chatId = ctx.chat?.id;
  const lang   = getLang(chatId);
  const msg    = t(lang, 'support_msg', { shop: SHOP_NAME });
  if (SUPPORT_USERNAME) {
    await ctx.reply(msg, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[
        Markup.button.url(t(lang, 'support_btn_contact'), `https://t.me/${SUPPORT_USERNAME.replace('@', '')}`),
      ]]),
    });
  } else {
    await ctx.reply(msg + '\n\n' + t(lang, 'support_no_contact'), { parse_mode: 'Markdown' });
  }
}

async function showDigitalStore(ctx: any) {
  const chatId = ctx.chat?.id;
  const lang   = getLang(chatId);
  await ctx.reply(
    t(lang, 'digital_store_title'),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        ...DIGITAL_CATEGORIES.map(cat => [
          Markup.button.callback(`${cat.emoji} ${cat.label}`, `dcat_${cat.id}`),
        ]),
        [Markup.button.callback('🔍 Search Products', 'dstore_search')],
      ]),
    },
  );
}

bot.action('dstore_search', async (ctx) => {
  const chatId = ctx.chat!.id;
  pending.set(chatId, { state: 'digital_search', data: {} });
  await ctx.answerCbQuery();
  await ctx.reply('🔍 Type a product name or category to search:');
});

// Category → product list
bot.action(/^dcat_(.+)$/, async (ctx) => {
  const catId   = ctx.match[1];
  const chatId  = ctx.chat!.id;
  const lang    = getLang(chatId);
  await ctx.answerCbQuery();

  const cat      = DIGITAL_CATEGORIES.find(c => c.id === catId);
  const products = [...digitalProducts.values()].filter(p => p.category === catId);

  if (!products.length) {
    await ctx.reply(t(lang, 'digital_no_products'));
    return;
  }

  const buttons = products.map(p => {
    const qty  = availableStock(p).length;
    const icon = qty > 0 ? '🟢' : '🔴';
    return [Markup.button.callback(`${icon} ${p.name} — ${p.price} cr (${qty} left)`, `dprod_${p.id}`)];
  });

  await ctx.reply(
    `${cat?.emoji} *${cat?.label}*\n\n${t(lang, 'digital_select_prod')}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) },
  );
});

// Product → confirm purchase
bot.action(/^dprod_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const chatId    = ctx.chat!.id;
  const lang      = getLang(chatId);
  const session   = sessions.get(chatId);
  await ctx.answerCbQuery();

  if (!session) { await ctx.reply(t(lang, 'unauthorized')); return; }

  const product = digitalProducts.get(productId);
  if (!product) { await ctx.reply('❌ Product not found.'); return; }

  const qty = availableStock(product).length;
  if (qty === 0) { await ctx.reply(t(lang, 'digital_out_of_stock')); return; }

  // Apply flash sale discount
  const activeFlash = flashSale && new Date(flashSale.endsAt) > new Date() ? flashSale : null;
  const finalPrice  = activeFlash ? Math.ceil(product.price * (1 - activeFlash.percent / 100)) : product.price;
  const priceLabel  = activeFlash
    ? `~~${product.price}~~ *${finalPrice} credits* ⚡ -${activeFlash.percent}%`
    : `*${finalPrice} credits*`;

  try {
    const res     = await makeApi(session.token).get('/wallet/balance');
    const balance = unwrap(res).balance as number;

    if (balance < finalPrice) {
      await ctx.reply(
        t(lang, 'digital_no_balance', { price: finalPrice, balance }),
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const catEmoji = DIGITAL_CATEGORIES.find(c => c.id === product.category)?.emoji ?? '📦';
    const desc = product.description ? `_${product.description}_\n\n` : '';
    const caption = t(lang, 'digital_confirm', { name: `${catEmoji} ${product.name}`, desc, price: priceLabel, stock: qty, balance });
    const replyMarkup = Markup.inlineKeyboard([
      [
        Markup.button.callback(t(lang, 'digital_btn_buy'), `dbuy_${productId}`),
        Markup.button.callback('❌', 'digital_cancel'),
      ],
    ]);
    if (product.imageUrl) {
      try {
        await ctx.replyWithPhoto(product.imageUrl, { caption, parse_mode: 'Markdown', ...replyMarkup });
      } catch {
        await ctx.reply(caption, { parse_mode: 'Markdown', ...replyMarkup });
      }
    } else {
      await ctx.reply(caption, { parse_mode: 'Markdown', ...replyMarkup });
    }
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

// Confirm → deduct + deliver
bot.action(/^dbuy_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const chatId    = ctx.chat!.id;
  const lang      = getLang(chatId);
  const session   = sessions.get(chatId);
  await ctx.answerCbQuery('⏳ Processing...');

  if (!session) { await ctx.reply(t(lang, 'unauthorized')); return; }
  if (!botAdminToken) { await ctx.reply('❌ Try again in a moment.'); return; }

  const product = digitalProducts.get(productId);
  if (!product) { await ctx.reply('❌ Product not found.'); return; }

  const item = availableStock(product)[0];
  if (!item) { await ctx.reply(t(lang, 'digital_out_of_stock')); return; }

  const buyFlash  = flashSale && new Date(flashSale.endsAt) > new Date() ? flashSale : null;
  const buyPrice  = buyFlash ? Math.ceil(product.price * (1 - buyFlash.percent / 100)) : product.price;

  try {
    await makeApi(botAdminToken).post('/admin/balance/adjust', {
      userId: session.userId,
      amount: -buyPrice,
      reason: `Digital: ${product.name}${buyFlash ? ` (-${buyFlash.percent}% flash)` : ''}`,
    });
    item.soldTo = chatId;
    item.soldAt = new Date();
    saveDigitalProducts(digitalProducts);

    // Save to purchase history
    const purchaseRecord: DigitalPurchase = {
      productId: product.id, productName: product.name,
      credentials: item.credentials, price: buyPrice,
      purchasedAt: new Date().toISOString(),
    };
    const history = digitalPurchases.get(chatId) ?? [];
    history.push(purchaseRecord);
    digitalPurchases.set(chatId, history);

    // Low stock alert
    const remaining = availableStock(product).length;
    if (remaining < 3) {
      const alertIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
      for (const adminId of alertIds) {
        try {
          await bot.telegram.sendMessage(adminId,
            `⚠️ *Low Stock Alert!*\n\n📦 *${product.name}*\nOnly *${remaining}* left in stock.\n\n_Add more via Admin → Digital Manager_`,
            { parse_mode: 'Markdown' },
          );
        } catch {}
      }
    }

    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    const now = new Date().toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });
    await ctx.reply(
      t(lang, 'digital_success', { name: product.name, credentials: item.credentials }) +
      `\n\n🧾 *Receipt*\n📅 ${now} UTC\n💳 ${buyPrice} credits`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('digital_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelled');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
});

// ════════════════════════════════════════════════════════════════
// DIGITAL STORE — Admin management
// ════════════════════════════════════════════════════════════════
bot.action('adm_digital', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  await ctx.reply(
    '🛒 *Digital Store Manager*',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 List All Products', 'adm_dp_list')],
        [Markup.button.callback('➕ Add Product',       'adm_dp_add')],
        [Markup.button.callback('📦 Add Stock',         'adm_dp_stock')],
        [Markup.button.callback('✏️ Edit Product',      'adm_dp_edit')],
        [Markup.button.callback('🗑️ Delete Product',    'adm_dp_del')],
        [Markup.button.callback('📥 Bulk Import (CSV)', 'adm_dp_bulk')],
      ]),
    },
  );
});

// List all products
bot.action('adm_dp_list', async (ctx) => {
  await ctx.answerCbQuery();
  if (!digitalProducts.size) { await ctx.reply('📭 No products yet.'); return; }
  for (const cat of DIGITAL_CATEGORIES) {
    const products = [...digitalProducts.values()].filter(p => p.category === cat.id);
    if (!products.length) continue;
    let msg = `${cat.emoji} *${cat.label}*\n`;
    for (const p of products) {
      const qty = availableStock(p).length;
      msg += `\n• ${p.name} — ${p.price} cr | 📦 ${qty} in stock | ID: \`${p.id}\``;
    }
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  }
});

// Add product — step 1: choose category
bot.action('adm_dp_add', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '➕ *Add Product*\n\nSelect category:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(
        DIGITAL_CATEGORIES.map(c => [Markup.button.callback(`${c.emoji} ${c.label}`, `adm_dp_cat_${c.id}`)]),
      ),
    },
  );
});

// Add product — step 2: category chosen → ask name
bot.action(/^adm_dp_cat_(.+)$/, async (ctx) => {
  const catId  = ctx.match[1];
  const chatId = ctx.chat!.id;
  await ctx.answerCbQuery();
  pending.set(chatId, { state: 'adm_dp_name', data: { category: catId } });
  await ctx.reply(`📝 Product name?\n_Example: Netflix Premium, Gmail Aged_`, { parse_mode: 'Markdown' });
});

// Add stock — select product
bot.action('adm_dp_stock', async (ctx) => {
  await ctx.answerCbQuery();
  if (!digitalProducts.size) { await ctx.reply('📭 No products yet. Add a product first.'); return; }
  const buttons = [...digitalProducts.values()].map(p => [
    Markup.button.callback(`${p.name} (${availableStock(p).length} left)`, `adm_dp_addstock_${p.id}`),
  ]);
  await ctx.reply('📦 Select product to add stock to:', Markup.inlineKeyboard(buttons));
});

bot.action(/^adm_dp_addstock_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const chatId    = ctx.chat!.id;
  await ctx.answerCbQuery();
  const product = digitalProducts.get(productId);
  if (!product) { await ctx.reply('❌ Product not found.'); return; }
  pending.set(chatId, { state: 'adm_dp_creds', data: { productId } });
  await ctx.reply(
    `📦 *Add stock to: ${product.name}*\n\nPaste credentials — one per line:\n_Example:_\n\`user1@gmail.com:pass1\`\n\`user2@gmail.com:pass2\``,
    { parse_mode: 'Markdown' },
  );
});

// Delete product — select product
bot.action('adm_dp_del', async (ctx) => {
  await ctx.answerCbQuery();
  if (!digitalProducts.size) { await ctx.reply('📭 No products yet.'); return; }
  const buttons = [...digitalProducts.values()].map(p => [
    Markup.button.callback(`🗑️ ${p.name}`, `adm_dp_delconfirm_${p.id}`),
  ]);
  await ctx.reply('🗑️ Select product to delete:', Markup.inlineKeyboard(buttons));
});

bot.action(/^adm_dp_delconfirm_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  await ctx.answerCbQuery();
  const product = digitalProducts.get(productId);
  if (!product) { await ctx.reply('❌ Not found.'); return; }
  await ctx.reply(
    `🗑️ Delete *${product.name}*?\n\n⚠️ ${product.stock.length} stock items will be lost.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('✅ Yes, Delete', `adm_dp_dodel_${productId}`),
        Markup.button.callback('❌ Cancel', 'adm_dp_list'),
      ]]),
    },
  );
});

bot.action(/^adm_dp_dodel_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  await ctx.answerCbQuery();
  const product = digitalProducts.get(productId);
  if (product) { digitalProducts.delete(productId); saveDigitalProducts(digitalProducts); await ctx.reply(`✅ *${product.name}* deleted.`, { parse_mode: 'Markdown' }); }
  else { await ctx.reply('❌ Not found.'); }
});

// Edit product — select product
bot.action('adm_dp_bulk', async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_dp_bulk_wait', data: {} });
  await ctx.answerCbQuery();
  await ctx.reply(
    `📥 *Bulk Import*\n\n` +
    `Send a *.txt* file. Each line = one credential:\n\n` +
    `\`category|Product Name|Description|Price|credential\`\n\n` +
    `*Example:*\n` +
    `\`email|Gmail Account|Fresh 2024|500|user@gmail.com:pass123\`\n` +
    `\`social|Instagram|Aged account|300|insta_user:insta_pass\`\n\n` +
    `_Lines with same category+name+price are grouped into one product._`,
    { parse_mode: 'Markdown' },
  );
});

// ── Purchase History ──────────────────────────────────────────
async function showPurchaseHistory(ctx: any, chatId: number) {
  const purchases = digitalPurchases.get(chatId) ?? [];
  if (!purchases.length) {
    await ctx.reply('📊 *My Purchases*\n\n_No digital purchases yet._', { parse_mode: 'Markdown' });
    return;
  }
  let msg = `📊 *My Purchases* (${purchases.length} total)\n\n`;
  for (const p of purchases.slice(-10).reverse()) {
    const date = new Date(p.purchasedAt).toLocaleDateString();
    msg += `• *${p.productName}* — ${p.price} cr\n  📅 ${date}\n  🔑 \`${p.credentials}\`\n\n`;
  }
  await ctx.reply(msg, { parse_mode: 'Markdown' });
}

// ── Support Tickets ───────────────────────────────────────────
async function showSupportTickets(ctx: any) {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) return;
  const myTickets = [...supportTickets.values()].filter(t => t.chatId === chatId);
  const buttons = [
    [Markup.button.callback('➕ New Ticket', 'tkt_new')],
    ...myTickets.slice(-5).map(t => [
      Markup.button.callback(`${t.status === 'open' ? '🟢' : '⚫'} #${t.id} — ${t.subject.slice(0, 25)}`, `tkt_view_${t.id}`)
    ]),
  ];
  await ctx.reply('🎫 *Support Tickets*\n\nOpen a ticket and our team will reply here.', { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
}

bot.action('tkt_new', async (ctx) => {
  await ctx.answerCbQuery();
  pending.set(ctx.chat!.id, { state: 'ticket_subject', data: {} });
  await ctx.reply('🎫 *New Support Ticket*\n\nEnter the subject of your issue:', { parse_mode: 'Markdown' });
});

bot.action(/^tkt_view_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ticket = supportTickets.get(ctx.match[1]);
  if (!ticket) { await ctx.reply('❌ Ticket not found.'); return; }
  let msg = `🎫 *Ticket #${ticket.id}*\n📌 ${ticket.subject}\n📅 ${new Date(ticket.createdAt).toLocaleDateString()}\nStatus: ${ticket.status === 'open' ? '🟢 Open' : '⚫ Closed'}\n\n`;
  for (const m of ticket.messages) {
    msg += `${m.from === 'user' ? '👤' : '🛠️'} ${m.text}\n`;
  }
  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💬 Reply', `tkt_reply_user_${ticket.id}`)]]) });
});

bot.action(/^tkt_reply_user_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat!.id;
  pending.set(chatId, { state: 'ticket_msg', data: { ticketId: ctx.match[1] } });
  await ctx.reply('💬 Type your message:');
});

bot.action(/^tkt_reply_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') return;
  pending.set(chatId, { state: 'adm_ticket_reply', data: { ticketId: ctx.match[1] } });
  await ctx.reply(`💬 Type reply for ticket *#${ctx.match[1]}*:`, { parse_mode: 'Markdown' });
});

bot.action('adm_tickets', async (ctx) => {
  await ctx.answerCbQuery();
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') return;
  const open = [...supportTickets.values()].filter(t => t.status === 'open');
  if (!open.length) { await ctx.reply('🎫 No open tickets.'); return; }
  const buttons = open.map(t => [Markup.button.callback(`🟢 #${t.id} — ${t.subject.slice(0, 30)} (${t.email})`, `tkt_adm_${t.id}`)]);
  await ctx.reply(`🎫 *Open Tickets* (${open.length})`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^tkt_adm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ticket = supportTickets.get(ctx.match[1]);
  if (!ticket) { await ctx.reply('❌ Not found.'); return; }
  let msg = `🎫 *Ticket #${ticket.id}*\n👤 ${ticket.email} (\`${ticket.chatId}\`)\n📌 ${ticket.subject}\n\n`;
  for (const m of ticket.messages) { msg += `${m.from === 'user' ? '👤' : '🛠️'} ${m.text}\n`; }
  await ctx.reply(msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    [Markup.button.callback(`💬 Reply`, `tkt_reply_${ticket.id}`)],
    [Markup.button.callback(`✅ Close`, `tkt_close_${ticket.id}`)],
  ]) });
});

bot.action(/^tkt_close_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ticket = supportTickets.get(ctx.match[1]);
  if (!ticket) return;
  ticket.status = 'closed';
  await ctx.reply(`✅ Ticket #${ticket.id} closed.`);
  try { await bot.telegram.sendMessage(ticket.chatId, `🎫 Your ticket *#${ticket.id}* has been closed.\n\nThank you for contacting support!`, { parse_mode: 'Markdown' }); } catch {}
});

// ── Admin: Search User ────────────────────────────────────────
bot.action('adm_search_user', async (ctx) => {
  await ctx.answerCbQuery();
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') return;
  pending.set(ctx.chat!.id, { state: 'adm_search_user', data: {} });
  await ctx.reply('🔍 *Search User*\n\nEnter email or Telegram ID:', { parse_mode: 'Markdown' });
});

// ── Admin: Subscriptions tracker ──────────────────────────────
bot.action('adm_subscriptions', async (ctx) => {
  await ctx.answerCbQuery();
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') return;
  const subCats = ['vpn', 'office', 'iptv', 'streaming'];
  const sold: { product: DigitalProduct; item: DigitalItem }[] = [];
  for (const product of digitalProducts.values()) {
    if (!subCats.includes(product.category)) continue;
    for (const item of product.stock) {
      if (item.soldTo) sold.push({ product, item });
    }
  }
  if (!sold.length) { await ctx.reply('📅 No subscriptions sold yet.'); return; }
  let msg = `📅 *Active Subscriptions* (${sold.length} total)\n\n`;
  for (const { product, item } of sold.slice(0, 20)) {
    const date = item.soldAt ? new Date(item.soldAt).toLocaleDateString() : '—';
    msg += `• *${product.name}*\n  🆔 User: \`${item.soldTo}\` | 📅 ${date}\n  🔑 \`${item.credentials}\`\n\n`;
  }
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// Document handler for bulk import
bot.on('document', async (ctx) => {
  const chatId  = ctx.chat.id;
  const session = sessions.get(chatId);
  const state   = pending.get(chatId);
  if (!session || session.role !== 'ADMIN' || state?.state !== 'adm_dp_bulk_wait') return;
  pending.delete(chatId);

  try {
    const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
    const res      = await axios.get(fileLink.href, { responseType: 'text' });
    const lines    = (res.data as string).split('\n').map((l: string) => l.trim()).filter(Boolean);

    let created = 0, added = 0, errors = 0;
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 5) { errors++; continue; }
      const [category, name, description, priceStr, credential] = parts;
      const price = parseInt(priceStr);
      if (isNaN(price)) { errors++; continue; }

      // Find existing product with same key or create new
      const key     = `${category.trim()}|${name.trim()}|${price}`;
      let   product = [...digitalProducts.values()].find(p =>
        p.category === category.trim() && p.name === name.trim() && p.price === price,
      );
      if (!product) {
        const id = `dp_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
        product  = { id, category: category.trim(), name: name.trim(), description: description.trim(), price, stock: [] };
        digitalProducts.set(id, product);
        created++;
      }
      product.stock.push({ id: `di_${Date.now()}_${Math.random().toString(36).slice(2)}`, credentials: credential.trim() });
      added++;
    }
    saveDigitalProducts(digitalProducts);
    await ctx.reply(
      `✅ *Bulk Import Done!*\n\n📦 Products created: *${created}*\n🔑 Credentials added: *${added}*\n❌ Skipped (bad format): *${errors}*`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) { await ctx.reply(`❌ Import failed: ${errMsg(err)}`); }
});

bot.action('adm_dp_edit', async (ctx) => {
  await ctx.answerCbQuery();
  if (!digitalProducts.size) { await ctx.reply('📭 No products yet.'); return; }
  const buttons = [...digitalProducts.values()].map(p => [
    Markup.button.callback(`✏️ ${p.name} (${p.price} cr)`, `adm_dp_editsel_${p.id}`),
  ]);
  await ctx.reply('✏️ Select product to edit:', Markup.inlineKeyboard(buttons));
});

bot.action(/^adm_dp_editsel_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  await ctx.answerCbQuery();
  const product = digitalProducts.get(productId);
  if (!product) { await ctx.reply('❌ Not found.'); return; }
  await ctx.reply(
    `✏️ *Edit: ${product.name}*\n\nCurrent:\n• Name: ${product.name}\n• Price: ${product.price} cr\n• Desc: ${product.description || '—'}`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Edit Name',        `adm_dp_ename_${productId}`)],
        [Markup.button.callback('💰 Edit Price',       `adm_dp_eprice_${productId}`)],
        [Markup.button.callback('📄 Edit Description', `adm_dp_edesc_${productId}`)],
        [Markup.button.callback('🖼️ Edit Image',       `adm_dp_eimg_${productId}`)],
        [Markup.button.callback('📦 View Stock',       `adm_dp_vstock_${productId}`)],
      ]),
    },
  );
});

bot.action(/^adm_dp_ename_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const chatId = ctx.chat!.id;
  await ctx.answerCbQuery();
  pending.set(chatId, { state: 'adm_dp_edit_name', data: { productId } });
  await ctx.reply('📝 Enter new name:');
});

bot.action(/^adm_dp_eprice_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const chatId = ctx.chat!.id;
  await ctx.answerCbQuery();
  pending.set(chatId, { state: 'adm_dp_edit_price', data: { productId } });
  await ctx.reply('💰 Enter new price in credits (e.g. 500):');
});

bot.action(/^adm_dp_edesc_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const chatId = ctx.chat!.id;
  await ctx.answerCbQuery();
  pending.set(chatId, { state: 'adm_dp_edit_desc', data: { productId } });
  await ctx.reply('📄 Enter new description (or /skip to clear):');
});

bot.action(/^adm_dp_eimg_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  const chatId = ctx.chat!.id;
  await ctx.answerCbQuery();
  pending.set(chatId, { state: 'adm_dp_edit_img', data: { productId } });
  await ctx.reply('🖼️ Send the image URL for this product (must start with https://):\n\nOr send /skip to remove the image.');
});

bot.action(/^adm_dp_vstock_(.+)$/, async (ctx) => {
  const productId = ctx.match[1];
  await ctx.answerCbQuery();
  const product = digitalProducts.get(productId);
  if (!product) { await ctx.reply('❌ Not found.'); return; }
  const stock: DigitalItem[] = product.stock ?? [];
  const available = stock.filter((s: DigitalItem) => !s.soldTo);
  if (!stock.length) {
    await ctx.reply(`📦 *${product.name}* — Stock: *0 items*\n\n_No credentials yet._`, { parse_mode: 'Markdown' });
    return;
  }
  const list = stock.map((s: DigitalItem, i: number) => `${i + 1}. \`${s.credentials}\`${s.soldTo ? ' ✅sold' : ''}`).join('\n');
  const chunks = [];
  let chunk = `📦 *${product.name}* — Total: *${stock.length}* | Available: *${available.length}*\n\n`;
  for (const line of list.split('\n')) {
    if ((chunk + line + '\n').length > 3800) { chunks.push(chunk); chunk = ''; }
    chunk += line + '\n';
  }
  if (chunk) chunks.push(chunk);
  for (const c of chunks) await ctx.reply(c, { parse_mode: 'Markdown' });
});

// ════════════════════════════════════════════════════════════════
// /admin — Pending recharge requests (Telegram-ID gated)
// ════════════════════════════════════════════════════════════════
const ADMIN_TG_IDS = (process.env.ADMIN_TELEGRAM_IDS ?? '')
  .split(',').map(s => parseInt(s.trim())).filter(Boolean);

function isTgAdmin(id: number) { return ADMIN_TG_IDS.includes(id); }

async function showAdminRecharges(ctx: any) {
  const isAdmin = isTgAdmin(ctx.from!.id) || sessions.get(ctx.chat!.id)?.role === 'ADMIN';
  if (!isAdmin) {
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

bot.command('admin',   (ctx) => showAdminRecharges(ctx));
bot.action('adm_review', async (ctx) => { await ctx.answerCbQuery(); await showAdminRecharges(ctx); });

// ── Extra slash commands (shown in bot menu) ──────────────────
bot.command('balance', async (ctx) => {
  const chatId  = ctx.chat.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.reply(t(getLang(chatId), 'unauthorized')); return; }
  return showBalance(ctx, session);
});

bot.command('buy', async (ctx) => {
  const chatId  = ctx.chat.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.reply(t(getLang(chatId), 'unauthorized')); return; }
  return showCountries(ctx);
});

bot.command('orders', async (ctx) => {
  const chatId  = ctx.chat.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.reply(t(getLang(chatId), 'unauthorized')); return; }
  return showOrders(ctx, session);
});

bot.command('deposit', async (ctx) => {
  const chatId  = ctx.chat.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.reply(t(getLang(chatId), 'unauthorized')); return; }
  return showDeposit(ctx);
});

bot.action(/^rch_approve_(.+)$/, async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const id = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(
    `✅ *Confirm Approve?*\n\nRecharge ID: \`${id}\``,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, Approve', `rch_apc_${id}`), Markup.button.callback('❌ Cancel', 'adm_review')],
    ]) },
  );
});

bot.action(/^rch_apc_(.+)$/, async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const id = ctx.match[1];
  try {
    const res = await makeApi(botAdminToken!).patch(`/recharge/admin/${id}/review`, { status: 'APPROVED' });
    const amount = res.data?.amount ?? res.data?.data?.amount;
    const credits = amount ? Math.round(amount) : null;
    await ctx.answerCbQuery('✅ Approved!');
    await ctx.editMessageText(`✅ *Recharge Approved!*\n\nID: \`${id}\``, { parse_mode: 'Markdown' });
    // Notify user
    const userChatId = rechargeChatIds.get(String(id));
    if (userChatId) {
      try {
        await bot.telegram.sendMessage(userChatId,
          `✅ *Recharge Approved!*\n\n` +
          `💰 ${credits ? `*+${credits} credits*` : 'Credits'} added to your balance!\n\n` +
          `🛒 Happy shopping!`,
          { parse_mode: 'Markdown' },
        );
        rechargeChatIds.delete(String(id));
      } catch {}
    }
  } catch (err: any) {
    await ctx.answerCbQuery('❌ Error');
    await ctx.reply(`❌ ${err?.response?.data?.message || err.message}`);
  }
});

bot.action(/^rch_reject_(.+)$/, async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const id = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(
    `❌ *Rejection Reason*\n\nID: \`${id}\`\n\nKhtar sabab:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('🔴 TxID غير صحيح',      `rch_rej_r_${id}_txid`)],
      [Markup.button.callback('🔴 Screenshot mzawr',   `rch_rej_r_${id}_fake`)],
      [Markup.button.callback('🔴 Montant incorrect',  `rch_rej_r_${id}_amount`)],
      [Markup.button.callback('🔴 Déjà traité',        `rch_rej_r_${id}_dup`)],
      [Markup.button.callback('✏️ Sabab akhor',        `rch_rej_custom_${id}`)],
    ]) },
  );
});

bot.action(/^rch_rej_r_(.+)_(txid|fake|amount|dup)$/, async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const id     = ctx.match[1];
  const code   = ctx.match[2];
  const reasons: Record<string, string> = {
    txid:   'TxID غير صحيح',
    fake:   'Screenshot mzawr / غير صحيح',
    amount: 'Montant incorrect',
    dup:    'Demande déjà traitée',
  };
  const reason = reasons[code] ?? 'Rejected by admin';
  try {
    await makeApi(botAdminToken!).patch(`/recharge/admin/${id}/review`, { status: 'REJECTED', adminNote: reason });
    await ctx.answerCbQuery('❌ Rejected');
    await ctx.editMessageText(`❌ *Recharge Rejected*\n\nID: \`${id}\`\nReason: ${reason}`, { parse_mode: 'Markdown' });
    // Notify user
    const userChatId = rechargeChatIds.get(String(id));
    if (userChatId) {
      try {
        await bot.telegram.sendMessage(userChatId,
          `❌ *Recharge Rejected*\n\n` +
          `📋 Reason: _${reason}_\n\n` +
          `💬 Questions? Open a support ticket.`,
          { parse_mode: 'Markdown' },
        );
        rechargeChatIds.delete(String(id));
      } catch {}
    }
  } catch (err: any) {
    await ctx.answerCbQuery('❌ Error');
    await ctx.reply(`❌ ${err?.response?.data?.message || err.message}`);
  }
});

bot.action(/^rch_rej_custom_(.+)$/, async (ctx) => {
  if (!isTgAdmin(ctx.from!.id) && sessions.get(ctx.chat!.id)?.role !== 'ADMIN') { await ctx.answerCbQuery('❌ Unauthorized'); return; }
  const id = ctx.match[1];
  pending.set(ctx.chat!.id, { state: 'adm_rch_reject', data: { id } });
  await ctx.answerCbQuery();
  await ctx.reply(`✏️ Kteb sabab d reject:`, { parse_mode: 'Markdown' });
});

// ── Ban user ──────────────────────────────────────────────────
bot.action('adm_ban', async (ctx) => {
  const chatId = ctx.chat!.id;
  if (!sessions.get(chatId) || sessions.get(chatId)!.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_ban_id', data: {} });
  await ctx.answerCbQuery();
  await ctx.reply('🚫 *Ban User*\n\nEnter the Telegram Chat ID to ban:', { parse_mode: 'Markdown' });
});

// ── Targeted broadcast ────────────────────────────────────────
bot.action('adm_broadcast_target', async (ctx) => {
  const chatId = ctx.chat!.id;
  if (!sessions.get(chatId) || sessions.get(chatId)!.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  await ctx.reply('🎯 *Targeted Broadcast*\n\nChoose language group:', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🇬🇧 English only', 'adm_bcast_lang_en'), Markup.button.callback('🇸🇦 Arabic only', 'adm_bcast_lang_ar')],
      [Markup.button.callback('🇫🇷 French only',  'adm_bcast_lang_fr'), Markup.button.callback('🇮🇩 Indonesian', 'adm_bcast_lang_id')],
    ]),
  });
});

for (const lang of ['en','ar','fr','id']) {
  bot.action(`adm_bcast_lang_${lang}`, async (ctx) => {
    const chatId = ctx.chat!.id;
    pending.set(chatId, { state: 'adm_bcast_target_msg', data: { lang } });
    await ctx.answerCbQuery();
    await ctx.reply(`✍️ Write your message to send to *${lang.toUpperCase()}* users:`, { parse_mode: 'Markdown' });
  });
}

// ── Flash sale ────────────────────────────────────────────────
bot.action('adm_flash', async (ctx) => {
  const chatId = ctx.chat!.id;
  if (!sessions.get(chatId) || sessions.get(chatId)!.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  if (flashSale) {
    const endsAt = new Date(flashSale.endsAt);
    const left   = Math.max(0, Math.round((endsAt.getTime() - Date.now()) / 60000));
    await ctx.reply(
      `⚡ *Active Flash Sale*\n\n🎯 Discount: *${flashSale.percent}%*\n⏳ Ends in: *${left} min*\n\nStop it?`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🛑 Stop Flash Sale', 'adm_flash_stop')]]) },
    );
  } else {
    pending.set(chatId, { state: 'adm_flash_percent', data: {} });
    await ctx.reply('⚡ *Flash Sale*\n\nDiscount % to apply on all digital products?\n_Example: 20 (for 20% off)_', { parse_mode: 'Markdown' });
  }
});

bot.action('adm_flash_stop', async (ctx) => {
  flashSale = null;
  saveFlashSale(null);
  await ctx.answerCbQuery('Flash sale stopped');
  await ctx.reply('🛑 Flash sale stopped.');
});

// ════════════════════════════════════════════════════════════════
// TEXT HANDLER — State machine
// ════════════════════════════════════════════════════════════════
// ── Photo handler (payment proof + broadcast photo) ───────────
bot.on('photo', async (ctx) => {
  const chatId = ctx.chat.id;
  if (bannedUsers.has(chatId)) return;
  const state = pending.get(chatId);
  const session = sessions.get(chatId);
  if (!state) return;

  // Payment proof
  if (state.state === 'recharge_proof') {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const { data } = state;
    pending.set(chatId, { state: 'recharge_proof', data: { ...data, proofFileId: fileId } });
    // Trigger the same flow as if user sent /skip (reuse text handler logic via direct call)
    const lang = getLang(chatId);
    if (!session) { await ctx.reply('❌ Not logged in.'); return; }
    pending.delete(chatId);
    const methodDisplay: Record<string, string> = {
      BINANCE: '💛 Binance ID', USDT: '💚 USDT TRC20', IBAN: '🏦 IBAN', CIH: '🏧 CIH Bank',
    };
    const txid = data.txid;
    try {
      const rchRes = await makeApi(session.token).post('/recharge', { method: data.method, amountUsd: parseFloat(data.amount), txid });
      const rchId  = rchRes.data?.id ?? rchRes.data?.data?.id;
      if (rchId) rechargeChatIds.set(String(rchId), chatId);
      await ctx.reply(t(lang, 'recharge_submitted', { method: methodDisplay[data.method] || data.method, amount: data.amount, txid }), { parse_mode: 'Markdown', ...getKeyboard(chatId, session.role) });
      const notifMsg = `💳 *New Recharge Request!*\n\n👤 Email: *${session.email}*\n🆔 Telegram ID: \`${chatId}\`\n🏦 Method: ${methodDisplay[data.method] || data.method}\n💰 Amount: *$${data.amount} USD*\n🔖 TxID: \`${txid}\`\n📸 *Proof attached*`;
      const notifMarkup = Markup.inlineKeyboard([[Markup.button.callback('📋 Review Recharges', 'adm_review')]]);
      const notifyIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
      for (const adminId of notifyIds) {
        try { await bot.telegram.sendPhoto(adminId, fileId, { caption: notifMsg, parse_mode: 'Markdown', ...notifMarkup }); } catch {}
      }
    } catch (err: any) {
      await ctx.reply(`❌ ${err?.response?.data?.message || err.message}`, getKeyboard(chatId, session.role));
    }
    return;
  }

  // Support ticket photo attachment
  if (state.state === 'ticket_msg') {
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const ticket = supportTickets.get(state.data.ticketId);
    if (!ticket || !session) return;
    pending.delete(chatId);
    ticket.messages.push({ from: 'user', text: `[photo:${fileId}]`, at: new Date().toISOString() });
    await ctx.reply('📸 Photo sent to support.', getKeyboard(chatId, session.role));
    const adminIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
    for (const adminId of adminIds) {
      try {
        await bot.telegram.sendPhoto(adminId, fileId, { caption: `🎫 Ticket *#${ticket.id}* — ${session.email}`, parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`💬 Reply #${ticket.id}`, `tkt_reply_${ticket.id}`)]]) });
      } catch {}
    }
    return;
  }
});

bot.on('text', async (ctx) => {
  const chatId  = ctx.chat.id;
  if (bannedUsers.has(chatId)) return;   // banned
  const text    = ctx.message.text.trim();
  const session = sessions.get(chatId);
  const state   = pending.get(chatId);

  // Keyboard shortcuts (labels are language-aware)
  if (session && !state) {
    const lang = getLang(chatId);
    if (text === t(lang, 'btn_balance'))       return showBalance(ctx, session);
    if (text === t(lang, 'btn_deposit'))       return showDeposit(ctx);
    if (text === t(lang, 'btn_digital_store')) return showDigitalStore(ctx);
    if (text === t(lang, 'btn_support'))       return showSupportTickets(ctx);
    if (text === t(lang, 'btn_orders'))   return showOrders(ctx, session);
    if (text === t(lang, 'btn_buy'))      return showCountries(ctx);
    if (text === t(lang, 'btn_esim'))     return showEsimProducts(ctx, session);
    if (text === t(lang, 'btn_coupon'))   return showRedeemCoupon(ctx);
    if (text === t(lang, 'btn_referral')) return showReferral(ctx);
    if (text === t(lang, 'btn_profile'))  return showProfile(ctx, session);
    if (text === '🌍 Language') {
      return ctx.reply(
        '🌍 *Choose your language*\nاختر لغتك\nChoisissez votre langue',
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
          [Markup.button.callback('English 🇬🇧', 'lang_en'), Markup.button.callback('Français 🇫🇷', 'lang_fr')],
          [Markup.button.callback('عربي 🇸🇦', 'lang_ar'),   Markup.button.callback('Indonesia 🇮🇩', 'lang_id')],
        ]) },
      );
    }
    if (text === '📊 My Purchases')       return showPurchaseHistory(ctx, chatId);
    if (text === t(lang, 'btn_admin') && session.role === 'ADMIN') {
      await ctx.reply('🔧 *Admin Panel*', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📊 Statistics',       'adm_stats')],
          [Markup.button.callback('📋 Review Recharges','adm_review')],
          [Markup.button.callback('💳 Recharge Stats',  'adm_rch_stats')],
          [Markup.button.callback('👥 Users List',       'adm_users')],
          [Markup.button.callback('💰 Add Balance',      'adm_addbal')],
          [Markup.button.callback('🎟️ Create Coupon',   'adm_coupon')],
          [Markup.button.callback('📢 Broadcast Now',    'adm_broadcast')],
          [Markup.button.callback('🎯 Targeted Broadcast','adm_broadcast_target')],
          [Markup.button.callback('⏰ Scheduled Post',   'adm_sched')],
          [Markup.button.callback('⚡ Flash Sale',        'adm_flash')],
          [Markup.button.callback('🚫 Ban User',          'adm_ban')],
          [Markup.button.callback('🎫 Support Tickets',  'adm_tickets')],
          [Markup.button.callback('🔍 Search User',      'adm_search_user')],
          [Markup.button.callback('📅 Subscriptions',    'adm_subscriptions')],
          [Markup.button.callback('💳 SMSPool Balance',  'adm_smsbal')],
          [Markup.button.callback('📡 eSIM Manager',     'adm_esim')],
          [Markup.button.callback('🛒 Digital Manager',  'adm_digital')],
        ]),
      });
      return;
    }
    if (text === t(lang, 'btn_logout')) {
      sessions.delete(chatId);
      await ctx.reply(t(lang, 'logged_out'), Markup.removeKeyboard());
    }
    return;
  }

  if (!state) return;
  const { data } = state;

  // ── LOGIN ──
  if (state.state === 'login_email')    { data.email = text; pending.set(chatId,{state:'login_password',data}); await ctx.reply(t(getLang(chatId), 'enter_password')); return; }
  if (state.state === 'login_password') {
    const lang = getLang(chatId);
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
      if (role === 'ADMIN') { botAdminToken = result.accessToken; adminChatId = chatId; }
      // Link Telegram ID to this account so Mini App uses same wallet
      const tgId = String(ctx.from?.id ?? '');
      if (tgId) {
        try { await makeApi(result.accessToken).patch('/auth/link-telegram', { telegramId: tgId }); } catch {}
      }
      await ctx.reply(t(lang, 'login_success', { email: data.email }), { parse_mode:'Markdown', ...getKeyboard(chatId, role) });
    } catch (err) { await ctx.reply(t(getLang(chatId), 'login_error', { msg: errMsg(err) }), { parse_mode:'Markdown' }); }
    return;
  }

  // ── REGISTER ──
  if (state.state === 'register_email')    { data.email = text; pending.set(chatId,{state:'register_password',data}); await ctx.reply(t(getLang(chatId), 'choose_password')); return; }
  if (state.state === 'register_password') {
    const lang = getLang(chatId);
    pending.delete(chatId);
    try {
      await makeApi().post('/auth/register', { email:data.email, password:text });
      await ctx.reply(t(lang, 'register_success'), { parse_mode:'Markdown' });

      // Notify admin of new registration
      const regNotifyIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
      for (const adminId of regNotifyIds) {
        try {
          await bot.telegram.sendMessage(adminId,
            `👤 *New User Registered!*\n\n📧 ${data.email}\n🌐 Lang: ${getLang(chatId).toUpperCase()}`,
            { parse_mode: 'Markdown' },
          );
        } catch {}
      }

      // Credit referral bonus to whoever shared the link
      const referrerId = referrals.get(chatId);
      if (referrerId && !referred.has(chatId) && botAdminToken) {
        const referrerSession = sessions.get(referrerId);
        if (referrerSession) {
          try {
            await makeApi(botAdminToken).post('/admin/balance/adjust', {
              userId: referrerSession.userId,
              amount: REFERRAL_BONUS,
              reason: `Referral bonus — ${data.email} registered`,
            });
            referred.add(chatId);
            saveReferrals(referrals, referred);
            await bot.telegram.sendMessage(referrerId,
              `🎉 *Referral Bonus!*\n\n` +
              `Your friend joined ${SHOP_NAME}!\n` +
              `💰 *+${REFERRAL_BONUS} credits* added to your balance! 🎁`,
              { parse_mode: 'Markdown' },
            );
          } catch (e) { console.error('Referral bonus failed:', errMsg(e)); }
        }
      }
    } catch (err) { await ctx.reply(t(lang, 'register_error', { msg: errMsg(err) }), { parse_mode:'Markdown' }); }
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
      saveCoupons(coupons);
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

  // ── ADMIN: Credit adjustment amount ──
  if (state.state === 'adm_usr_cr_amt') {
    const credits = parseInt(text.trim());
    if (isNaN(credits) || credits <= 0) { await ctx.reply('❌ Enter a positive number:'); return; }
    const { userId, mode } = data;
    const amount = mode === 'add' ? credits : -credits;
    pending.set(chatId, { state: 'adm_usr_cr_confirm', data: { ...data, amount: String(amount), credits: String(credits) } });
    await ctx.reply(
      `${mode === 'add' ? '➕' : '➖'} *${mode === 'add' ? 'Add' : 'Remove'} ${credits} credits* ${mode === 'add' ? 'to' : 'from'} user \`${userId.slice(0, 8)}…\`?\n\nConfirm?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('✅ Confirm', 'adm_usr_cr_yes'),
          Markup.button.callback('❌ Cancel',  'adm_usr_cr_no'),
        ]]),
      },
    );
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
    saveCoupons(coupons);
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
    const lang = getLang(chatId);
    const methodMap: Record<string, string> = {
      '💛 Binance ID': 'BINANCE',
      '💚 USDT TRC20': 'USDT',
      '🏦 IBAN': 'IBAN',
      '🏧 CIH Bank': 'CIH',
    };
    if (text === t(lang, 'btn_cancel')) {
      pending.delete(chatId);
      const kb = session ? getKeyboard(chatId, session.role) : Markup.removeKeyboard();
      await ctx.reply(t(lang, 'cancelled'), kb);
      return;
    }
    const method = methodMap[text];
    if (!method) { await ctx.reply(t(lang, 'recharge_select_prompt')); return; }
    pending.set(chatId, { state: 'recharge_amount', data: { method } });

    // Show the payment details for the chosen method
    const cancelKb = Markup.keyboard([[t(lang, 'btn_cancel')]]).resize();
    const binanceId    = process.env.PAYMENT_BINANCE_ID    ?? '';
    const usdtAddress  = process.env.PAYMENT_USDT_ADDRESS  ?? '';
    const iban         = process.env.PAYMENT_IBAN          ?? '';
    const cihBank      = process.env.PAYMENT_CIH_BANK      ?? '';

    type PaymentInfo = { label: string; value: string; icon: string };
    let payment: PaymentInfo | null = null;

    if (method === 'BINANCE' && binanceId)
      payment = { label: 'Binance ID', value: binanceId, icon: '💛' };
    else if (method === 'USDT' && usdtAddress)
      payment = { label: 'USDT TRC20', value: usdtAddress, icon: '💚' };
    else if (method === 'IBAN' && iban)
      payment = { label: 'IBAN', value: iban, icon: '🏦' };
    else if (method === 'CIH' && cihBank)
      payment = { label: 'CIH Bank', value: cihBank, icon: '🏧' };

    if (!payment) {
      await ctx.reply(t(lang, 'payment_details_missing'), cancelKb);
      return;
    }

    await ctx.reply(
      `${payment.icon} *Send payment via ${payment.label}*\n\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📋 *${payment.label}:*\n` +
      `\`${payment.value}\`\n` +
      `━━━━━━━━━━━━━━━\n\n` +
      `*Steps:*\n` +
      `1️⃣ Copy the ${payment.label} above\n` +
      `2️⃣ Send the exact amount\n` +
      `3️⃣ Come back here and enter the amount in USD\n` +
      `4️⃣ Enter your TxID / reference number\n` +
      `5️⃣ Send payment screenshot\n\n` +
      `_Admin will approve within 15 min_ ⏳`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: `📋 Copy ${payment.label}`, copy_text: { text: payment.value } } as any],
          ],
        },
      },
    );
    await ctx.reply('💵 Enter the amount in USD you sent (e.g. 10):', cancelKb);
    return;
  }

  // ── MANUAL RECHARGE: Amount ──
  if (state.state === 'recharge_amount') {
    const lang = getLang(chatId);
    if (text === t(lang, 'btn_cancel')) {
      pending.delete(chatId);
      const kb = session ? getKeyboard(chatId, session.role) : Markup.removeKeyboard();
      await ctx.reply(t(lang, 'cancelled'), kb);
      return;
    }
    const amount = parseFloat(text);
    if (isNaN(amount) || amount < 1) { await ctx.reply(t(lang, 'recharge_invalid_amount')); return; }
    pending.set(chatId, { state: 'recharge_txid', data: { ...data, amount: String(amount) } });
    await ctx.reply(
      t(lang, 'recharge_amount_chosen', { amount }),
      { parse_mode: 'Markdown', ...Markup.keyboard([[t(lang, 'btn_cancel')]]).resize() }
    );
    return;
  }

  // ── MANUAL RECHARGE: TxID & submit ──
  if (state.state === 'recharge_txid') {
    const lang = getLang(chatId);
    if (text === t(lang, 'btn_cancel')) {
      pending.delete(chatId);
      const kb = session ? getKeyboard(chatId, session.role) : Markup.removeKeyboard();
      await ctx.reply(t(lang, 'cancelled'), kb);
      return;
    }
    if (!session) { await ctx.reply(t(lang, 'unauthorized')); return; }
    // Save TxID and ask for payment proof photo
    pending.set(chatId, { state: 'recharge_proof', data: { ...data, txid: text } });
    await ctx.reply(
      `📸 *Send payment proof*\n\nSend a screenshot of your payment.\nOr type /skip to submit without proof.`,
      { parse_mode: 'Markdown', ...Markup.keyboard([['⏭️ Skip proof']]).resize() }
    );
    return;
  }

  if (state.state === 'recharge_proof') {
    const lang = getLang(chatId);
    if (!session) { await ctx.reply(t(lang, 'unauthorized')); return; }
    pending.delete(chatId);
    const methodDisplay: Record<string, string> = {
      BINANCE: '💛 Binance ID', USDT: '💚 USDT TRC20', IBAN: '🏦 IBAN', CIH: '🏧 CIH Bank',
    };
    const txid = data.txid || text;
    try {
      await makeApi(session.token).post('/recharge', {
        method: data.method,
        amountUsd: parseFloat(data.amount),
        txid,
      });
      await ctx.reply(
        t(lang, 'recharge_submitted', {
          method: methodDisplay[data.method] || data.method,
          amount: data.amount,
          txid,
        }),
        { parse_mode: 'Markdown', ...getKeyboard(chatId, session.role) }
      );
      const notifMsg =
        `💳 *New Recharge Request!*\n\n` +
        `👤 Email: *${session.email}*\n` +
        `🆔 Telegram ID: \`${chatId}\`\n` +
        `🏦 Method: ${methodDisplay[data.method] || data.method}\n` +
        `💰 Amount: *$${data.amount} USD*\n` +
        `🔖 TxID: \`${txid}\``;
      const notifMarkup = Markup.inlineKeyboard([[Markup.button.callback('📋 Review Recharges', 'adm_review')]]);
      const notifyIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
      for (const adminId of notifyIds) {
        try {
          if (data.proofFileId) {
            await bot.telegram.sendPhoto(adminId, data.proofFileId, { caption: notifMsg, parse_mode: 'Markdown', ...notifMarkup });
          } else {
            await bot.telegram.sendMessage(adminId, notifMsg, { parse_mode: 'Markdown', ...notifMarkup });
          }
        } catch {}
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message || err.message || 'Unknown error';
      await ctx.reply(`❌ Error: ${msg}`, getKeyboard(chatId, session.role));
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

  // ── DIGITAL STORE: Search ──
  if (state.state === 'digital_search') {
    pending.delete(chatId);
    const query   = text.toLowerCase().trim();
    const results = [...digitalProducts.values()].filter(p =>
      p.name.toLowerCase().includes(query) ||
      p.category.toLowerCase().includes(query) ||
      p.description.toLowerCase().includes(query),
    );
    if (!results.length) { await ctx.reply(`🔍 No products found for "*${text}*"`, { parse_mode: 'Markdown' }); return; }
    const buttons = results.slice(0, 10).map(p => {
      const avail = availableStock(p).length;
      return [Markup.button.callback(`${p.name} — ${p.price}cr (${avail} left)`, `dprod_${p.id}`)];
    });
    await ctx.reply(`🔍 *Results for "${text}":*`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
    return;
  }

  // ── DIGITAL STORE ADMIN: Product name ──
  if (state.state === 'adm_dp_name') {
    data.name = text.trim();
    pending.set(chatId, { state: 'adm_dp_desc', data });
    await ctx.reply('📝 Short description? (optional — press /skip to leave blank)', { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_dp_desc') {
    data.description = text === '/skip' ? '' : text.trim();
    pending.set(chatId, { state: 'adm_dp_price', data });
    await ctx.reply('💰 Price in credits?\n_Example: 500 = $5_', { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_dp_price') {
    const price = parseInt(text);
    if (isNaN(price) || price <= 0) { await ctx.reply('❌ Enter a valid number (e.g. 500):'); return; }
    pending.delete(chatId);
    const id = `dp_${Date.now()}`;
    digitalProducts.set(id, { id, category: data.category, name: data.name, description: data.description, price, stock: [] });
    saveDigitalProducts(digitalProducts);
    await ctx.reply(
      `✅ *Product Created!*\n\n${data.name}\nCategory: ${data.category}\nPrice: *${price} credits*\n\nNow add stock via 🛒 Digital Manager → 📦 Add Stock`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // ── DIGITAL STORE ADMIN: Edit product ──
  if (state.state === 'adm_dp_edit_name') {
    pending.delete(chatId);
    const product = digitalProducts.get(data.productId);
    if (!product) { await ctx.reply('❌ Product not found.'); return; }
    const oldName  = product.name;
    product.name   = text.trim();
    saveDigitalProducts(digitalProducts);
    await ctx.reply(`✅ Name updated: *${oldName}* → *${product.name}*`, { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_dp_edit_price') {
    const price = parseInt(text);
    if (isNaN(price) || price <= 0) { await ctx.reply('❌ Enter a valid number (e.g. 500):'); return; }
    pending.delete(chatId);
    const product = digitalProducts.get(data.productId);
    if (!product) { await ctx.reply('❌ Product not found.'); return; }
    const oldPrice  = product.price;
    product.price   = price;
    saveDigitalProducts(digitalProducts);
    await ctx.reply(`✅ Price updated: *${oldPrice} cr* → *${price} cr*`, { parse_mode: 'Markdown' });
    return;
  }
  if (state.state === 'adm_dp_edit_desc') {
    pending.delete(chatId);
    const product = digitalProducts.get(data.productId);
    if (!product) { await ctx.reply('❌ Product not found.'); return; }
    product.description = text === '/skip' ? '' : text.trim();
    saveDigitalProducts(digitalProducts);
    await ctx.reply(`✅ Description updated for *${product.name}*`, { parse_mode: 'Markdown' });
    return;
  }

  if (state.state === 'adm_dp_edit_img') {
    pending.delete(chatId);
    const product = digitalProducts.get(data.productId);
    if (!product) { await ctx.reply('❌ Product not found.'); return; }
    product.imageUrl = text === '/skip' ? undefined : text.trim();
    saveDigitalProducts(digitalProducts);
    await ctx.reply(`✅ Image ${product.imageUrl ? 'updated' : 'removed'} for *${product.name}*`, { parse_mode: 'Markdown' });
    return;
  }

  // ── Support Ticket: new ticket subject ──
  if (state.state === 'ticket_subject') {
    if (!session) return;
    pending.set(chatId, { state: 'ticket_msg', data: { subject: text, isNew: 'true' } });
    await ctx.reply('💬 Describe your issue:');
    return;
  }

  // ── Support Ticket: user message ──
  if (state.state === 'ticket_msg') {
    if (!session) return;
    pending.delete(chatId);
    if (data.isNew) {
      const ticketId = `T${Date.now().toString(36).toUpperCase()}`;
      const ticket: SupportTicket = {
        id: ticketId, chatId, email: session.email,
        subject: data.subject, status: 'open',
        createdAt: new Date().toISOString(),
        messages: [{ from: 'user', text, at: new Date().toISOString() }],
      };
      supportTickets.set(ticketId, ticket);
      await ctx.reply(`✅ Ticket *#${ticketId}* created!\n\nWe'll reply here soon.`, { parse_mode: 'Markdown', ...getKeyboard(chatId, session.role) });
      const adminIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
      for (const adminId of adminIds) {
        try {
          await bot.telegram.sendMessage(adminId,
            `🎫 *New Ticket #${ticketId}*\n👤 ${session.email} (\`${chatId}\`)\n📌 ${data.subject}\n\n💬 ${text}`,
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`💬 Reply #${ticketId}`, `tkt_reply_${ticketId}`)],[Markup.button.callback(`✅ Close #${ticketId}`, `tkt_close_${ticketId}`)]])}
          );
        } catch {}
      }
    } else {
      const ticket = supportTickets.get(data.ticketId);
      if (ticket) {
        ticket.messages.push({ from: 'user', text, at: new Date().toISOString() });
        await ctx.reply('✅ Message sent to support.', getKeyboard(chatId, session.role));
        const adminIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
        for (const adminId of adminIds) {
          try {
            await bot.telegram.sendMessage(adminId,
              `🎫 *Ticket #${ticket.id}* — reply from ${session.email}\n\n💬 ${text}`,
              { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback(`💬 Reply`, `tkt_reply_${ticket.id}`)]])}
            );
          } catch {}
        }
      }
    }
    return;
  }

  // ── Admin: ticket reply ──
  if (state.state === 'adm_ticket_reply') {
    pending.delete(chatId);
    const ticket = supportTickets.get(data.ticketId);
    if (!ticket) { await ctx.reply('❌ Ticket not found.'); return; }
    ticket.messages.push({ from: 'admin', text, at: new Date().toISOString() });
    await ctx.reply(`✅ Reply sent for ticket #${ticket.id}.`);
    try {
      await bot.telegram.sendMessage(ticket.chatId,
        `🛠️ *Support reply for ticket #${ticket.id}*\n\n${text}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💬 Reply', `tkt_reply_user_${ticket.id}`)]])}
      );
    } catch {}
    return;
  }

  // ── Admin: search user ──
  if (state.state === 'adm_search_user') {
    pending.delete(chatId);
    if (!session || session.role !== 'ADMIN') return;
    try {
      const res = await makeApi(session.token).get(`/admin/users?search=${encodeURIComponent(text.trim())}`);
      const result = unwrap(res);
      const userList: any[] = result.users ?? (Array.isArray(result) ? result : [result]);
      const user = userList[0];
      if (!user) { await ctx.reply('❌ User not found.'); return; }
      const balanceCredits = user.balance ?? 0;
      const balanceUsd = (balanceCredits / 100).toFixed(2);
      await ctx.reply(
        `👤 *User Info*\n\n` +
        `📧 Email: \`${user.email}\`\n` +
        `💰 Balance: *${balanceCredits} credits* (≈ $${balanceUsd})\n` +
        `📋 Orders: *${user._count?.orders ?? 0}*\n` +
        `📅 Joined: ${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}\n` +
        `✉️ Verified: ${user.isEmailVerified ? '✅' : '❌'}`,
        { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('💰 Add Balance', `adm_addbal_user_${user.id}`)]]) }
      );
    } catch {
      await ctx.reply('❌ User not found or API error.');
    }
    return;
  }

  // ── DIGITAL STORE ADMIN: Add stock (credentials) ──
  if (state.state === 'adm_dp_creds') {
    pending.delete(chatId);
    const product = digitalProducts.get(data.productId);
    if (!product) { await ctx.reply('❌ Product not found.'); return; }
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    for (const creds of lines) {
      product.stock.push({ id: `di_${Date.now()}_${Math.random().toString(36).slice(2)}`, credentials: creds });
    }
    saveDigitalProducts(digitalProducts);
    await ctx.reply(
      `✅ *${lines.length} item(s) added to ${product.name}!*\n📦 Total stock: *${availableStock(product).length}* available`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // ── SCHEDULED BROADCAST: message text ──
  if (state.state === 'adm_sched_msg') {
    data.message = text;
    pending.set(chatId, { state: 'adm_sched_photo', data });
    await ctx.reply('🖼️ Send a photo URL for the broadcast? (or /skip for text only)');
    return;
  }
  if (state.state === 'adm_sched_photo') {
    pending.delete(chatId);
    const photoUrl    = text === '/skip' ? undefined : text.trim();
    const intervalMs  = parseInt(data.intervalMs);
    const message     = data.message;
    if (scheduledBroadcast) clearInterval(scheduledBroadcast.timer);
    const timer = setInterval(async () => { await runBroadcast(message, photoUrl); }, intervalMs);
    scheduledBroadcast = { message, photoUrl, intervalMs, timer };
    // Send first batch immediately
    await ctx.reply(`⏰ *Schedule set! Sending first batch now...*`, { parse_mode: 'Markdown' });
    const { sent, failed } = await runBroadcast(message, photoUrl);
    await ctx.reply(`✅ Done! Sent: ${sent} | Failed: ${failed}\n\n_Next auto-send in ${intervalMs / 3_600_000}h_`, { parse_mode: 'Markdown' });
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

  // ── ADMIN: Ban user ──
  if (state.state === 'adm_ban_id') {
    pending.delete(chatId);
    const targetId = parseInt(text.trim());
    if (isNaN(targetId)) { await ctx.reply('❌ Invalid ID. Must be a number.'); return; }
    if (bannedUsers.has(targetId)) {
      bannedUsers.delete(targetId);
      saveBannedUsers(bannedUsers);
      await ctx.reply(`✅ User *${targetId}* unbanned.`, { parse_mode: 'Markdown' });
    } else {
      bannedUsers.add(targetId);
      saveBannedUsers(bannedUsers);
      sessions.delete(targetId);
      await ctx.reply(`🚫 User *${targetId}* banned. They can no longer use the bot.`, { parse_mode: 'Markdown' });
      try { await bot.telegram.sendMessage(targetId, '🚫 Your account has been banned. Contact support.'); } catch {}
    }
    return;
  }

  // ── ADMIN: Targeted broadcast ──
  if (state.state === 'adm_bcast_target_msg') {
    pending.delete(chatId);
    const targetLang = data.lang;
    const targets = [...sessions.keys()].filter(id => userLang.get(id) === targetLang);
    await ctx.reply(`🎯 Sending to ${targets.length} ${targetLang.toUpperCase()} users...`);
    let sent = 0, failed = 0;
    for (const id of targets) {
      try { await bot.telegram.sendMessage(id, `📢 *Announcement*\n\n${text}`, { parse_mode: 'Markdown' }); sent++; } catch { failed++; }
    }
    await ctx.reply(`✅ Done! ✉️ Sent: ${sent} | ❌ Failed: ${failed}`);
    return;
  }

  // ── ADMIN: Flash sale ──
  if (state.state === 'adm_flash_percent') {
    const percent = parseInt(text);
    if (isNaN(percent) || percent < 1 || percent > 99) { await ctx.reply('❌ Enter a valid % between 1 and 99:'); return; }
    data.percent = String(percent);
    pending.set(chatId, { state: 'adm_flash_hours', data });
    await ctx.reply(`⏳ Duration in hours? (e.g. 2 = 2 hours):`);
    return;
  }
  if (state.state === 'adm_flash_hours') {
    const hours = parseFloat(text);
    if (isNaN(hours) || hours <= 0) { await ctx.reply('❌ Enter valid hours (e.g. 2):'); return; }
    pending.delete(chatId);
    const endsAt = new Date(Date.now() + hours * 3_600_000).toISOString();
    flashSale = { percent: parseInt(data.percent), endsAt };
    saveFlashSale(flashSale);
    // Auto-expire
    setTimeout(() => { flashSale = null; saveFlashSale(null); }, hours * 3_600_000);
    await ctx.reply(
      `⚡ *Flash Sale Started!*\n\n🎯 *${data.percent}% discount* on all digital products\n⏳ Duration: *${hours}h*\n\nAll prices are now reduced!`,
      { parse_mode: 'Markdown' },
    );
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
      // Notify user
      const userChatId = rechargeChatIds.get(String(data.id));
      if (userChatId) {
        try {
          await bot.telegram.sendMessage(userChatId,
            `❌ *Recharge Rejected*\n\n📋 Reason: _${reason}_\n\n💬 Questions? Open a support ticket.`,
            { parse_mode: 'Markdown' },
          );
          rechargeChatIds.delete(String(data.id));
        } catch {}
      }
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
  // Load persisted state from Redis
  try {
    const state = await loadState();
    userLang       = state.userLang;
    digitalProducts= state.digitalProducts;
    coupons        = state.coupons;
    referrals      = state.referrals;
    referred       = state.referred;
    userOrders     = state.userOrders;
    bannedUsers      = state.bannedUsers;
    broadcastOptOut  = state.broadcastOptOut;
    flashSale        = state.flashSale;

    // Restart scheduled broadcast timer if one was active
    if (state.scheduledBroadcast) {
      const { message, photoUrl, intervalMs } = state.scheduledBroadcast;
      const timer = setInterval(async () => { await runBroadcast(message, photoUrl); }, intervalMs);
      scheduledBroadcast = { message, photoUrl, intervalMs, timer };
      console.log(`⏰ Scheduled broadcast restored (every ${intervalMs / 3_600_000}h)`);
    }

    // Restore flash sale expiry timeout if still active
    if (flashSale) {
      const left = new Date(flashSale.endsAt).getTime() - Date.now();
      if (left > 0) setTimeout(() => { flashSale = null; saveFlashSale(null); }, left);
      else { flashSale = null; }
    }

    console.log(`✅ State loaded: ${userLang.size} langs, ${digitalProducts.size} products, ${coupons.size} coupons, ${bannedUsers.size} banned`);
  } catch (e) { console.error('⚠️ State load failed:', e); }

  // Fetch bot username
  try {
    const me = await bot.telegram.getMe();
    botUsername = me.username ?? botUsername;
    console.log(`🤖 Bot: @${botUsername}`);
  } catch {}

  // Daily revenue report (every 24h)
  setInterval(async () => {
    const notifyIds = adminChatId ? [adminChatId] : ADMIN_TG_IDS;
    if (!notifyIds.length) return;
    try {
      const session = adminChatId ? sessions.get(adminChatId) : null;
      const token   = session?.token ?? botAdminToken;
      if (!token) return;
      const res = await makeApi(token).get('/admin/stats');
      const s   = unwrap(res);
      for (const id of notifyIds) {
        try {
          await bot.telegram.sendMessage(id,
            `📊 *Daily Report — ${new Date().toLocaleDateString()}*\n\n` +
            `👥 Total Users: *${s.totalUsers ?? 0}*\n` +
            `📋 Total Orders: *${s.totalOrders ?? 0}*\n` +
            `💰 Revenue: *${s.totalRevenue ?? 0} credits* (≈ $${((s.totalRevenue ?? 0) / CREDITS_PER_USD).toFixed(2)} USD)\n` +
            `🛒 Digital Products: *${digitalProducts.size}*`,
            { parse_mode: 'Markdown' },
          );
        } catch {}
      }
    } catch {}
  }, 24 * 3_600_000);

  // Register bot menu commands (the persistent "/" menu in Telegram)
  try {
    await bot.telegram.setMyCommands([
      { command: 'start',   description: '🏠 Start / Restart' },
      { command: 'balance', description: '💰 Check your balance' },
      { command: 'buy',     description: '📱 Buy a phone number' },
      { command: 'orders',  description: '📋 My orders' },
      { command: 'deposit', description: '💳 Deposit credits' },
      { command: 'admin',   description: '⚙️ Admin panel' },
    ]);
    console.log('✅ Bot commands registered');
  } catch (err) {
    console.warn('⚠️ setMyCommands failed:', err);
  }

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
