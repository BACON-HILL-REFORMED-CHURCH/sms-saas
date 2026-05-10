// ============================================================
// SMS Shop — Telegram Bot
// Direct SMSPool API integration (no backend for SMS orders)
// Backend used only for: Auth, Wallet, eSIM, Admin
// ============================================================

import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';

// ── Config ────────────────────────────────────────────────────
const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN!;
const API_URL         = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '') + '/api/v1';
const SMSPOOL_KEY     = process.env.SMSPOOL_API_KEY ?? '';
const MARKUP_PERCENT  = parseFloat(process.env.MARKUP_PERCENT ?? '50');
const CREDITS_PER_USD = 100;   // 100 credits = $1
const REFERRAL_BONUS  = parseInt(process.env.REFERRAL_BONUS ?? '100');
const POLL_INTERVAL   = 30_000;
const POLL_MAX        = 20;

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
console.log(`🤖 API: ${API_URL} | SMSPool: ${SMSPOOL_KEY ? '✅' : '❌ MISSING'}`);

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
const activePolls = new Map<string, NodeJS.Timeout>();
const smsOrders   = new Map<string, SMSLocalOrder>();
const userOrders  = new Map<number, string[]>();

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

// ── Keyboards ─────────────────────────────────────────────────
const userKeyboard = Markup.keyboard([
  ['💰 Balance',       '📱 Buy Number'],
  ['📋 My Orders',     '📡 eSIM'],
  ['🎟️ Redeem Coupon', '👥 Referral'],
  ['🚪 Logout'],
]).resize();

const adminKeyboard = Markup.keyboard([
  ['💰 Balance',       '📱 Buy Number'],
  ['📋 My Orders',     '📡 eSIM'],
  ['🎟️ Redeem Coupon', '👥 Referral'],
  ['⚙️ Admin Panel',   '🚪 Logout'],
]).resize();

const getKeyboard = (role: string) => role === 'ADMIN' ? adminKeyboard : userKeyboard;

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
    await ctx.reply(`👋 Welcome back, *${session.email}*!`, { parse_mode:'Markdown', ...getKeyboard(session.role) });
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
// eSIM — via backend
// ════════════════════════════════════════════════════════════════
async function showEsimProducts(ctx: any, session: UserSession) {
  try {
    const res  = await makeApi(session.token).get('/esim/products');
    const products: any[] = unwrap(res) ?? [];
    if (!products.length) { await ctx.reply('📡 No eSIM plans available. Check back soon!'); return; }

    const grouped: Record<string, any[]> = {};
    for (const p of products) { if (!grouped[p.country]) grouped[p.country] = []; grouped[p.country].push(p); }

    const buttons = [
      ...Object.entries(grouped).map(([country, plans]) => {
        const code = plans[0].countryCode?.toLowerCase() ?? '';
        const inStock = plans.filter((p: any) => p.stock > 0).length;
        return [Markup.button.callback(`${flag(code)} ${country} (${inStock} plans)`, `esim_c_${country}`)];
      }),
      [Markup.button.callback('📋 My eSIM Orders', 'esim_orders')],
    ];
    await ctx.reply('📡 *eSIM Store*\n\nSelect a country:', { parse_mode:'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
}

bot.action(/^esim_c_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }
  const country = ctx.match[1];
  await ctx.answerCbQuery();
  try {
    const res  = await makeApi(session.token).get('/esim/products');
    const all: any[] = unwrap(res) ?? [];
    const plans = all.filter((p: any) => p.country === country);
    const buttons = [
      ...plans.map((p: any) => {
        const stock = p.stock > 0 ? `✅ ${p.stock}` : '❌ Sold out';
        return [Markup.button.callback(`${p.gb}GB/${p.days}d — $${(p.price/100).toFixed(2)} (${stock})`, p.stock > 0 ? `esim_b_${p.id}` : 'esim_soldout')];
      }),
      [Markup.button.callback('🔙 Back', 'esim_back')],
    ];
    await ctx.reply(`${flag(plans[0]?.countryCode?.toLowerCase())} *${country} — eSIM Plans*`, { parse_mode:'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('esim_soldout', async (ctx) => { await ctx.answerCbQuery('❌ Sold out'); });
bot.action('esim_back', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (session) await showEsimProducts(ctx, session);
  await ctx.answerCbQuery();
});

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
    await ctx.reply(
      `✅ *eSIM Purchased!*\n\n${f} *${order.product?.country}* — ${order.product?.gb}GB / ${order.product?.days}d\n\n` +
      `📱 *Activation Data:*\n\`\`\`\n${qr}\n\`\`\`` + (act ? `\n\n🔑 Code: \`${act}\`` : '') +
      `\n\n*📲 How to activate:*\n1. Settings → Cellular\n2. Add eSIM\n3. Scan QR or enter code`,
      { parse_mode:'Markdown' },
    );
    await rewardReferrer(chatId, session);
  } catch (err) { await ctx.reply(`❌ ${errMsg(err)}`); }
});

bot.action('esim_orders', async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();
  try {
    const res    = await makeApi(session.token).get('/esim/orders');
    const orders: any[] = unwrap(res) ?? [];
    if (!orders.length) { await ctx.reply('📡 No eSIM orders yet.'); return; }
    const lines = orders.slice(0,5).map((o: any,i: number) =>
      `${i+1}. ${flag(o.product?.countryCode?.toLowerCase())} *${o.product?.country}* — ${o.product?.gb}GB\n   📅 ${new Date(o.createdAt).toLocaleDateString()}`
    ).join('\n\n');
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
      [Markup.button.callback('📊 Statistics',    'adm_stats')],
      [Markup.button.callback('👥 Users List',    'adm_users')],
      [Markup.button.callback('💰 Add Balance',   'adm_addbal')],
      [Markup.button.callback('🎟️ Create Coupon', 'adm_coupon')],
      [Markup.button.callback('📢 Broadcast',     'adm_broadcast')],
      [Markup.button.callback('💳 SMSPool Balance','adm_smsbal')],
    ]),
  });
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
});

// ════════════════════════════════════════════════════════════════
// LAUNCH
// ════════════════════════════════════════════════════════════════
const PORT           = parseInt(process.env.PORT ?? '3000');
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;

// Auto admin login on startup
tryAutoAdminLogin();

if (WEBHOOK_DOMAIN) {
  bot.launch({ webhook:{ domain:WEBHOOK_DOMAIN, port:PORT }, allowedUpdates:['message','callback_query'] })
    .then(() => console.log(`🤖 Webhook mode — port ${PORT}`));
} else {
  bot.launch({ allowedUpdates:['message','callback_query'] });
  console.log('🤖 Polling mode');
}

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
