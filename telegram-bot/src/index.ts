// ============================================================
// SMS Shop — Telegram Bot (Full-Featured, English)
// Features: Auth, Balance, Buy SMS Number, eSIM,
//           Auto-polling, Coupons, Referrals, Admin Panel,
//           Broadcast, 30+ Countries
// ============================================================

import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';

// ── Config ────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN!;
const API_URL        = (process.env.API_URL ?? 'http://localhost:3001')
                         .replace(/\/$/, '') + '/api/v1';
const REFERRAL_BONUS = parseInt(process.env.REFERRAL_BONUS ?? '100');
const POLL_INTERVAL  = 30_000;   // 30 seconds
const POLL_MAX       = 20;       // 10 minutes max

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
console.log(`🤖 API: ${API_URL}`);

// ── Types ─────────────────────────────────────────────────────
interface UserSession {
  token:  string;
  email:  string;
  role:   string;
  userId: string;
}

interface PendingState {
  state: string;
  data:  Record<string, string>;
}

interface Coupon {
  amount:    number;
  maxUses:   number;
  usesLeft:  number;
  usedBy:    Set<number>;
  createdAt: Date;
}

// ── In-memory storage ─────────────────────────────────────────
const sessions    = new Map<number, UserSession>();
const pending     = new Map<number, PendingState>();
const coupons     = new Map<string, Coupon>();
const referrals   = new Map<number, number>();   // newChatId → referrerChatId
const referred    = new Set<number>();           // chatIds already rewarded
const activePolls = new Map<string, NodeJS.Timeout>();

let botAdminToken: string | null = null;
let botUsername                  = 'smsshopbot';

// ── API helpers ───────────────────────────────────────────────
function makeApi(token?: string) {
  return axios.create({
    baseURL: API_URL,
    timeout: 15_000,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function unwrap(res: any): any {
  if (res.data?.success === true && 'data' in res.data) return res.data.data;
  return res.data;
}

function errMsg(err: any): string {
  const msg = err?.response?.data?.message;
  if (Array.isArray(msg)) return msg.join(', ');
  return typeof msg === 'string' ? msg : (err?.message ?? 'Unknown error');
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

const getKeyboard = (role: string) =>
  role === 'ADMIN' ? adminKeyboard : userKeyboard;

// ── Flags & Countries ─────────────────────────────────────────
const FLAGS: Record<string, string> = {
  us: '🇺🇸', gb: '🇬🇧', ru: '🇷🇺', ua: '🇺🇦', pl: '🇵🇱',
  de: '🇩🇪', fr: '🇫🇷', in: '🇮🇳', br: '🇧🇷', ph: '🇵🇭',
  id: '🇮🇩', vn: '🇻🇳', ng: '🇳🇬', pk: '🇵🇰', tr: '🇹🇷',
  es: '🇪🇸', it: '🇮🇹', nl: '🇳🇱', se: '🇸🇪', ro: '🇷🇴',
  mx: '🇲🇽', co: '🇨🇴', ca: '🇨🇦', au: '🇦🇺', za: '🇿🇦',
  ae: '🇦🇪', sa: '🇸🇦', ma: '🇲🇦', eg: '🇪🇬', tn: '🇹🇳',
  ar: '🇦🇷', pt: '🇵🇹', gr: '🇬🇷', cz: '🇨🇿', hu: '🇭🇺',
  bd: '🇧🇩', ke: '🇰🇪', cn: '🇨🇳', jp: '🇯🇵', kr: '🇰🇷',
};
const flag = (code: string) => FLAGS[code?.toLowerCase()] ?? '🌍';

const COUNTRIES = [
  { label: '🇺🇸 USA',          code: 'us' },
  { label: '🇬🇧 UK',           code: 'gb' },
  { label: '🇷🇺 Russia',       code: 'ru' },
  { label: '🇺🇦 Ukraine',      code: 'ua' },
  { label: '🇵🇱 Poland',       code: 'pl' },
  { label: '🇩🇪 Germany',      code: 'de' },
  { label: '🇫🇷 France',       code: 'fr' },
  { label: '🇮🇳 India',        code: 'in' },
  { label: '🇧🇷 Brazil',       code: 'br' },
  { label: '🇵🇭 Philippines',  code: 'ph' },
  { label: '🇮🇩 Indonesia',    code: 'id' },
  { label: '🇻🇳 Vietnam',      code: 'vn' },
  { label: '🇳🇬 Nigeria',      code: 'ng' },
  { label: '🇵🇰 Pakistan',     code: 'pk' },
  { label: '🇹🇷 Turkey',       code: 'tr' },
  { label: '🇪🇸 Spain',        code: 'es' },
  { label: '🇮🇹 Italy',        code: 'it' },
  { label: '🇳🇱 Netherlands',  code: 'nl' },
  { label: '🇸🇪 Sweden',       code: 'se' },
  { label: '🇷🇴 Romania',      code: 'ro' },
  { label: '🇲🇽 Mexico',       code: 'mx' },
  { label: '🇨🇴 Colombia',     code: 'co' },
  { label: '🇨🇦 Canada',       code: 'ca' },
  { label: '🇦🇺 Australia',    code: 'au' },
  { label: '🇿🇦 South Africa', code: 'za' },
  { label: '🇦🇪 UAE',          code: 'ae' },
  { label: '🇸🇦 Saudi Arabia', code: 'sa' },
  { label: '🇲🇦 Morocco',      code: 'ma' },
  { label: '🇪🇬 Egypt',        code: 'eg' },
  { label: '🇰🇪 Kenya',        code: 'ke' },
  { label: '🇦🇷 Argentina',    code: 'ar' },
  { label: '🇨🇳 China',        code: 'cn' },
  { label: '🇯🇵 Japan',        code: 'jp' },
  { label: '🇰🇷 South Korea',  code: 'kr' },
  { label: '🇧🇩 Bangladesh',   code: 'bd' },
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

  // Referral deep link
  const payload = ctx.startPayload;
  if (payload?.startsWith('ref_')) {
    const referrerId = parseInt(payload.replace('ref_', ''));
    if (referrerId && referrerId !== chatId && !referrals.has(chatId)) {
      referrals.set(chatId, referrerId);
    }
  }

  const session = sessions.get(chatId);
  if (session) {
    await ctx.reply(`👋 Welcome back, *${session.email}*!`, {
      parse_mode: 'Markdown',
      ...getKeyboard(session.role),
    });
    return;
  }

  await ctx.reply(
    `🎉 *Welcome to SMS Shop!*\n\n` +
    `📲 Buy virtual phone numbers to verify any app.\n` +
    `📡 eSIM data plans for travelers worldwide.\n` +
    `⚡ Instant delivery at the best prices.\n\n` +
    `Choose an option to get started:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Login',          'do_login')],
        [Markup.button.callback('✨ Create Account',  'do_register')],
      ]),
    },
  );
});

// ── /help ─────────────────────────────────────────────────────
bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *SMS Shop — Help*\n\n` +
    `*How to buy a number:*\n` +
    `1. Tap 📱 Buy Number\n` +
    `2. Select a country\n` +
    `3. Select the app/service\n` +
    `4. Get your number instantly\n` +
    `5. I'll notify you when the SMS arrives! 🔔\n\n` +
    `*Features:*\n` +
    `💰 Balance — Check your credits\n` +
    `📋 My Orders — View recent orders\n` +
    `📡 eSIM — Buy data plans for travel\n` +
    `🎟️ Redeem Coupon — Enter a code for free credits\n` +
    `👥 Referral — Earn ${REFERRAL_BONUS} credits per friend\n\n` +
    `*Credits:* 100 credits = $1.00 USD\n\n` +
    `_Contact admin for top-up or support._`,
    { parse_mode: 'Markdown' },
  );
});

// ════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════
bot.action('do_login', async (ctx) => {
  pending.set(ctx.chat!.id, { state: 'login_email', data: {} });
  await ctx.reply('📧 Enter your email address:');
  await ctx.answerCbQuery();
});

bot.action('do_register', async (ctx) => {
  pending.set(ctx.chat!.id, { state: 'register_email', data: {} });
  await ctx.reply('📧 Enter your email address:');
  await ctx.answerCbQuery();
});

// ════════════════════════════════════════════════════════════════
// BALANCE
// ════════════════════════════════════════════════════════════════
async function showBalance(ctx: any, session: UserSession) {
  try {
    const res = await makeApi(session.token).get('/wallet/balance');
    const { balance } = unwrap(res);
    await ctx.reply(
      `💰 *Your Balance*\n\n` +
      `*${balance}* credits\n` +
      `≈ $${(balance / 100).toFixed(2)} USD\n\n` +
      `_Contact admin to top up your balance._`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
}

// ════════════════════════════════════════════════════════════════
// AUTO SMS POLLING
// ════════════════════════════════════════════════════════════════
function startAutoPolling(chatId: number, orderId: string, session: UserSession) {
  if (activePolls.has(orderId)) return; // already polling

  let attempts = 0;

  const intervalId = setInterval(async () => {
    attempts++;

    if (attempts > POLL_MAX) {
      clearInterval(intervalId);
      activePolls.delete(orderId);
      try {
        await bot.telegram.sendMessage(
          chatId,
          `⏰ *Order Timed Out*\n\nNo SMS received after 10 minutes.\nYour balance has been refunded automatically.`,
          { parse_mode: 'Markdown' },
        );
      } catch {}
      return;
    }

    try {
      const res = await makeApi(session.token).get(`/orders/${orderId}`);
      const order = unwrap(res);

      if (order.smsCode) {
        clearInterval(intervalId);
        activePolls.delete(orderId);

        await bot.telegram.sendMessage(
          chatId,
          `🎉 *SMS Received!*\n\n` +
          `📱 Number: \`${order.phoneNumber}\`\n` +
          `🔐 Code: \`${order.smsCode}\`\n\n` +
          `📄 _${order.smsFullText ?? order.smsCode}_`,
          { parse_mode: 'Markdown' },
        );

        await rewardReferrer(chatId, session);

      } else if (order.status === 'EXPIRED' || order.status === 'CANCELED') {
        clearInterval(intervalId);
        activePolls.delete(orderId);
        await bot.telegram.sendMessage(chatId, `❌ Order ${order.status.toLowerCase()}. Balance refunded.`);
      }
    } catch {
      // keep trying
    }
  }, POLL_INTERVAL);

  activePolls.set(orderId, intervalId);
}

// ════════════════════════════════════════════════════════════════
// REFERRAL REWARD
// ════════════════════════════════════════════════════════════════
async function rewardReferrer(newUserChatId: number, newUserSession: UserSession) {
  if (referred.has(newUserChatId)) return;
  const referrerId = referrals.get(newUserChatId);
  if (!referrerId) return;

  const referrerSession = sessions.get(referrerId);
  if (!referrerSession) return;

  const adminToken = botAdminToken ?? null;
  if (!adminToken) return;

  try {
    await makeApi(adminToken).post('/admin/balance/adjust', {
      userId: referrerSession.userId,
      amount: REFERRAL_BONUS,
      reason: `Referral bonus — ${newUserSession.email}`,
    });

    referred.add(newUserChatId);

    await bot.telegram.sendMessage(
      referrerId,
      `🎉 *Referral Bonus Earned!*\n\n` +
      `Your friend *${newUserSession.email}* just made their first purchase!\n` +
      `You received *+${REFERRAL_BONUS} credits* 🎁`,
      { parse_mode: 'Markdown' },
    );
  } catch {
    // silently fail if admin token expired
  }
}

// ════════════════════════════════════════════════════════════════
// MY ORDERS
// ════════════════════════════════════════════════════════════════
async function showOrders(ctx: any, session: UserSession) {
  try {
    const res = await makeApi(session.token).get('/orders?limit=5');
    const data = unwrap(res);
    const orders: any[] = Array.isArray(data) ? data : (data?.orders ?? data?.data ?? []);

    if (!orders.length) {
      await ctx.reply(
        '📋 You have no orders yet.\n\nTap *📱 Buy Number* to get started!',
        { parse_mode: 'Markdown' },
      );
      return;
    }

    for (const o of orders) {
      const statusIcon: Record<string, string> = {
        PENDING: '⏳', RECEIVED: '✅', CANCELED: '❌', EXPIRED: '⏰',
      };
      const text =
        `${statusIcon[o.status] ?? '❓'} *${o.service}* — ${o.country}\n` +
        `📱 \`${o.phoneNumber}\`\n` +
        (o.smsCode
          ? `🔐 Code: \`${o.smsCode}\`\n📄 _${o.smsFullText ?? ''}_`
          : '⏳ Waiting for SMS...');

      const buttons: any[] = [];
      if (o.status === 'PENDING') {
        buttons.push([
          Markup.button.callback('🔄 Check SMS',  `poll_${o.id}`),
          Markup.button.callback('❌ Cancel',      `cancel_${o.id}`),
        ]);
      }

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        ...(buttons.length ? Markup.inlineKeyboard(buttons) : {}),
      });
    }
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
}

// ════════════════════════════════════════════════════════════════
// BUY NUMBER — Country picker
// ════════════════════════════════════════════════════════════════
async function showCountries(ctx: any) {
  // Two columns
  const rows: any[][] = [];
  for (let i = 0; i < COUNTRIES.length; i += 2) {
    const row = [Markup.button.callback(COUNTRIES[i].label, `country_${COUNTRIES[i].code}`)];
    if (COUNTRIES[i + 1]) {
      row.push(Markup.button.callback(COUNTRIES[i + 1].label, `country_${COUNTRIES[i + 1].code}`));
    }
    rows.push(row);
  }
  await ctx.reply('🌍 *Select a country:*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard(rows),
  });
}

bot.action(/^country_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }

  const country = ctx.match[1];
  await ctx.answerCbQuery('⏳ Loading services...');

  try {
    const res = await makeApi(session.token).get(`/providers/services?country=${country}`);
    const data = unwrap(res);
    const services: any[] = Array.isArray(data) ? data : (data?.services ?? []);

    if (!services.length) {
      await ctx.reply('❌ No services available for this country. Try another one!');
      return;
    }

    const countryInfo = COUNTRIES.find((c) => c.code === country);
    const buttons = services.slice(0, 12).map((s: any) => {
      const price = s.price ?? s.cost ?? '?';
      const label = `${s.service} — ${price} cr`;
      const cb    = `buy_${s.service}_${country}_${s.provider ?? 'auto'}`.substring(0, 64);
      return [Markup.button.callback(label, cb)];
    });

    await ctx.reply(
      `${countryInfo?.label ?? country.toUpperCase()} — *Select a service:*`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ── Create order ──────────────────────────────────────────────
bot.action(/^buy_([^_]+)_([^_]+)_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }

  const [, service, country, provider] = ctx.match;
  await ctx.answerCbQuery('⏳ Getting your number...');

  try {
    const body: any = { service, country };
    if (provider !== 'auto') body.provider = provider;

    const res   = await makeApi(session.token).post('/orders', body);
    const order = unwrap(res);

    await ctx.reply(
      `✅ *Number Assigned!*\n\n` +
      `📱 Number: \`${order.phoneNumber}\`\n` +
      `🔑 Service: ${order.service}\n` +
      `🌍 Country: ${order.country}\n\n` +
      `🔔 *I'll notify you automatically when the SMS arrives!*\n` +
      `_(checking every 30 seconds, up to 10 minutes)_`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🔄 Check Now', `poll_${order.id}`),
          Markup.button.callback('❌ Cancel',    `cancel_${order.id}`),
        ]]),
      },
    );

    // Background auto-polling
    startAutoPolling(chatId, order.id, session);

  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ── Manual poll ───────────────────────────────────────────────
bot.action(/^poll_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }

  const orderId = ctx.match[1];
  await ctx.answerCbQuery('⏳ Checking...');

  try {
    const res   = await makeApi(session.token).get(`/orders/${orderId}`);
    const order = unwrap(res);

    if (order.smsCode) {
      await ctx.reply(
        `✅ *SMS Received!*\n\n🔐 Code: \`${order.smsCode}\`\n\n📄 _${order.smsFullText ?? ''}_`,
        { parse_mode: 'Markdown' },
      );
    } else if (order.status === 'EXPIRED') {
      await ctx.reply('⏰ This order has expired.');
    } else if (order.status === 'CANCELED') {
      await ctx.reply('❌ This order was canceled.');
    } else {
      await ctx.reply(
        '⏳ No SMS yet.\n\n_Auto-checking every 30 seconds — I\'ll notify you when it arrives!_',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[
            Markup.button.callback('🔄 Check Again', `poll_${orderId}`),
          ]]),
        },
      );
      startAutoPolling(chatId, orderId, session);
    }
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ── Cancel order ──────────────────────────────────────────────
bot.action(/^cancel_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }

  const orderId = ctx.match[1];
  await ctx.answerCbQuery('⏳ Canceling...');

  // Stop background polling
  const t = activePolls.get(orderId);
  if (t) { clearInterval(t); activePolls.delete(orderId); }

  try {
    await makeApi(session.token).delete(`/orders/${orderId}`);
    await ctx.reply('✅ Order canceled. Your balance has been refunded.');
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ════════════════════════════════════════════════════════════════
// eSIM
// ════════════════════════════════════════════════════════════════
async function showEsimProducts(ctx: any, session: UserSession) {
  try {
    const res      = await makeApi(session.token).get('/esim/products');
    const products: any[] = unwrap(res) ?? [];

    if (!products.length) {
      await ctx.reply('📡 No eSIM plans available at the moment. Check back soon!');
      return;
    }

    const grouped: Record<string, any[]> = {};
    for (const p of products) {
      if (!grouped[p.country]) grouped[p.country] = [];
      grouped[p.country].push(p);
    }

    const buttons = Object.entries(grouped).map(([country, plans]) => {
      const code   = plans[0].countryCode?.toLowerCase() ?? '';
      const inStock = plans.filter((p: any) => p.stock > 0).length;
      return [Markup.button.callback(
        `${flag(code)} ${country} (${inStock}/${plans.length} plans)`,
        `esim_country_${country}`,
      )];
    });

    buttons.push([Markup.button.callback('📋 My eSIM Orders', 'esim_orders')]);

    await ctx.reply('📡 *eSIM Store*\n\nSelect a country to view plans:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
}

bot.action(/^esim_country_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }

  const country = ctx.match[1];
  await ctx.answerCbQuery();

  try {
    const res   = await makeApi(session.token).get('/esim/products');
    const all: any[] = unwrap(res) ?? [];
    const plans = all.filter((p: any) => p.country === country);

    const buttons = plans.map((p: any) => {
      const stock = p.stock > 0 ? `✅ ${p.stock} left` : '❌ Sold out';
      const label = `${p.gb}GB / ${p.days}d — $${(p.price / 100).toFixed(2)} (${stock})`;
      return [Markup.button.callback(label, p.stock > 0 ? `esim_buy_${p.id}` : 'esim_soldout')];
    });
    buttons.push([Markup.button.callback('🔙 Back', 'esim_back')]);

    const f = flag(plans[0]?.countryCode?.toLowerCase() ?? '');
    await ctx.reply(
      `${f} *${country} — eSIM Plans*\n\nChoose a plan to purchase:`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('esim_soldout', async (ctx) => {
  await ctx.answerCbQuery('❌ This plan is sold out');
});

bot.action('esim_back', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (session) await showEsimProducts(ctx, session);
  await ctx.answerCbQuery();
});

bot.action(/^esim_buy_(.+)$/, async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('Please login first'); return; }

  const productId = ctx.match[1];
  await ctx.answerCbQuery('⏳ Processing purchase...');

  try {
    const res   = await makeApi(session.token).post(`/esim/purchase/${productId}`);
    const order = unwrap(res);
    const qr    = order.inventory?.qrCodeData ?? '';
    const act   = order.inventory?.activationCode ?? '';
    const f     = flag(order.product?.countryCode?.toLowerCase());

    await ctx.reply(
      `✅ *eSIM Purchased!*\n\n` +
      `${f} *${order.product?.country}* — ${order.product?.gb}GB / ${order.product?.days} days\n\n` +
      `📱 *Activation Data:*\n\`\`\`\n${qr}\n\`\`\`` +
      (act ? `\n\n🔑 Manual Code: \`${act}\`` : '') +
      `\n\n*📲 How to activate:*\n` +
      `1. Settings → Mobile / Cellular\n` +
      `2. Add eSIM / Add Data Plan\n` +
      `3. Scan QR code or enter code manually\n` +
      `4. Follow on-screen instructions`,
      { parse_mode: 'Markdown' },
    );

    await rewardReferrer(chatId, session);
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('esim_orders', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();

  try {
    const res    = await makeApi(session.token).get('/esim/orders');
    const orders: any[] = unwrap(res) ?? [];

    if (!orders.length) {
      await ctx.reply('📡 No eSIM purchases yet.\n\nTap 📡 eSIM to browse plans!');
      return;
    }

    const lines = orders.slice(0, 5).map((o: any, i: number) =>
      `${i + 1}. ${flag(o.product?.countryCode?.toLowerCase())} *${o.product?.country}* — ${o.product?.gb}GB\n` +
      `   📅 ${new Date(o.createdAt).toLocaleDateString()} · $${(o.price / 100).toFixed(2)}`,
    ).join('\n\n');

    await ctx.reply(`📡 *My eSIM Orders:*\n\n${lines}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ════════════════════════════════════════════════════════════════
// COUPON — Redeem
// ════════════════════════════════════════════════════════════════
async function showRedeemCoupon(ctx: any) {
  const chatId = ctx.chat?.id;
  pending.set(chatId, { state: 'redeem_coupon', data: {} });
  await ctx.reply(
    '🎟️ *Redeem Coupon*\n\nEnter your coupon code below:',
    { parse_mode: 'Markdown' },
  );
}

// ════════════════════════════════════════════════════════════════
// REFERRAL
// ════════════════════════════════════════════════════════════════
async function showReferral(ctx: any, _session: UserSession) {
  const chatId = ctx.chat?.id;
  const link   = `https://t.me/${botUsername}?start=ref_${chatId}`;
  await ctx.reply(
    `👥 *Referral Program*\n\n` +
    `Invite friends and earn *${REFERRAL_BONUS} credits* each time one of them makes their first purchase!\n\n` +
    `🔗 *Your referral link:*\n\`${link}\`\n\n` +
    `_When your friend signs up through your link and completes their first order, you get ${REFERRAL_BONUS} credits automatically!_`,
    { parse_mode: 'Markdown' },
  );
}

// ════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ════════════════════════════════════════════════════════════════
bot.hears('⚙️ Admin Panel', async (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session || session.role !== 'ADMIN') return;

  await ctx.reply('🔧 *Admin Panel*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📊 Statistics',    'adm_stats')],
      [Markup.button.callback('👥 Users List',    'adm_users')],
      [Markup.button.callback('💰 Add Balance',   'adm_addbal')],
      [Markup.button.callback('🎟️ Create Coupon', 'adm_coupon')],
      [Markup.button.callback('📢 Broadcast',     'adm_broadcast')],
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
      `👥 Total Users: *${s.totalUsers ?? 0}*\n` +
      `📋 Total Orders: *${s.totalOrders ?? 0}*\n` +
      `✅ Completed: *${s.receivedOrders ?? 0}*\n` +
      `💰 Revenue: *${s.totalRevenue ?? 0}* credits\n\n` +
      `─────────────────\n` +
      `🎟️ Active Coupons: *${coupons.size}*\n` +
      `👥 Referrals Tracked: *${referrals.size}*\n` +
      `🔔 Auto-polls Running: *${activePolls.size}*\n` +
      `👤 Online Sessions: *${sessions.size}*`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('adm_users', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();

  try {
    const res   = await makeApi(session.token).get('/admin/users?limit=10');
    const data  = unwrap(res);
    const users: any[] = data?.users ?? (Array.isArray(data) ? data : []);

    if (!users.length) { await ctx.reply('No users found.'); return; }

    const lines = users.slice(0, 10).map((u: any, i: number) =>
      `${i + 1}. \`${u.email}\`\n   💰 ${u.balance} cr | ${u.role}`,
    ).join('\n\n');

    await ctx.reply(`👥 *Latest Users:*\n\n${lines}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('adm_addbal', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_addbal_email', data: {} });
  await ctx.reply('📧 Enter user email to adjust balance:');
  await ctx.answerCbQuery();
});

bot.action('adm_addbal_yes', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  const state   = pending.get(chatId);
  if (!session || !state) { await ctx.answerCbQuery(); return; }

  pending.delete(chatId);
  await ctx.answerCbQuery();

  try {
    const amount = parseInt(state.data.amount);
    await makeApi(session.token).post('/admin/balance/adjust', {
      userId: state.data.userId,
      amount,
      reason: 'Telegram admin adjustment',
    });
    await ctx.reply(
      `✅ *Done!*\n\n${amount > 0 ? 'Added' : 'Deducted'} *${Math.abs(amount)} credits* ${amount > 0 ? 'to' : 'from'} ${state.data.email}`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('adm_addbal_no', async (ctx) => {
  pending.delete(ctx.chat!.id);
  await ctx.reply('Canceled.');
  await ctx.answerCbQuery();
});

bot.action('adm_coupon', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_coupon_code', data: {} });
  await ctx.reply('🎟️ *Create Coupon*\n\nStep 1: Enter coupon code (e.g. SUMMER100):', { parse_mode: 'Markdown' });
  await ctx.answerCbQuery();
});

bot.action('adm_broadcast', async (ctx) => {
  const chatId  = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  pending.set(chatId, { state: 'adm_broadcast_msg', data: {} });
  await ctx.reply('📢 *Broadcast*\n\nEnter the message to send to all active users:', { parse_mode: 'Markdown' });
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

  // ── Keyboard shortcuts (logged-in, no pending state) ──
  if (session && !state) {
    if (text === '💰 Balance')        return showBalance(ctx, session);
    if (text === '📋 My Orders')      return showOrders(ctx, session);
    if (text === '📱 Buy Number')     return showCountries(ctx);
    if (text === '📡 eSIM')           return showEsimProducts(ctx, session);
    if (text === '🎟️ Redeem Coupon')  return showRedeemCoupon(ctx);
    if (text === '👥 Referral')       return showReferral(ctx, session);
    if (text === '🚪 Logout') {
      sessions.delete(chatId);
      await ctx.reply('👋 Logged out. See you next time!', Markup.removeKeyboard());
    }
    return;
  }

  if (!state) return;
  const { data } = state;

  // ════════════════════════════════
  // LOGIN
  // ════════════════════════════════
  if (state.state === 'login_email') {
    data.email = text;
    pending.set(chatId, { state: 'login_password', data });
    await ctx.reply('🔒 Enter your password:');
    return;
  }

  if (state.state === 'login_password') {
    pending.delete(chatId);
    try {
      const res    = await makeApi().post('/auth/login', { email: data.email, password: text });
      const result = unwrap(res);
      const role   = result.user?.role ?? 'USER';

      // Get userId
      let userId = result.user?.id ?? '';
      if (!userId) {
        try {
          const meRes = await makeApi(result.accessToken).get('/auth/me');
          userId = unwrap(meRes)?.id ?? '';
        } catch {}
      }

      sessions.set(chatId, { token: result.accessToken, email: data.email, role, userId });
      if (role === 'ADMIN') botAdminToken = result.accessToken;

      await ctx.reply(`✅ *Welcome back, ${data.email}!*`, {
        parse_mode: 'Markdown',
        ...getKeyboard(role),
      });
    } catch (err) {
      await ctx.reply(`❌ ${errMsg(err)}\n\nTry again: /start`);
    }
    return;
  }

  // ════════════════════════════════
  // REGISTER
  // ════════════════════════════════
  if (state.state === 'register_email') {
    data.email = text;
    pending.set(chatId, { state: 'register_password', data });
    await ctx.reply('🔒 Choose a password (minimum 8 characters):');
    return;
  }

  if (state.state === 'register_password') {
    pending.delete(chatId);
    try {
      await makeApi().post('/auth/register', { email: data.email, password: text });
      await ctx.reply(
        '✅ *Account Created!*\n\nCheck your email to verify your account, then tap /start to login.',
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      await ctx.reply(`❌ ${errMsg(err)}\n\nTry again: /start`);
    }
    return;
  }

  // ════════════════════════════════
  // REDEEM COUPON
  // ════════════════════════════════
  if (state.state === 'redeem_coupon') {
    pending.delete(chatId);
    const code   = text.toUpperCase().trim();
    const coupon = coupons.get(code);

    if (!coupon) {
      await ctx.reply('❌ Invalid coupon code. Please double-check and try again.');
      return;
    }
    if (coupon.usesLeft <= 0) {
      await ctx.reply('❌ This coupon is fully redeemed and no longer available.');
      return;
    }
    if (coupon.usedBy.has(chatId)) {
      await ctx.reply('❌ You have already used this coupon.');
      return;
    }
    if (!session) {
      await ctx.reply('❌ Please login first: /start');
      return;
    }
    if (!botAdminToken) {
      await ctx.reply('❌ Coupon system temporarily unavailable. Contact admin.');
      return;
    }

    try {
      await makeApi(botAdminToken).post('/admin/balance/adjust', {
        userId: session.userId,
        amount: coupon.amount,
        reason: `Coupon: ${code}`,
      });

      coupon.usedBy.add(chatId);
      coupon.usesLeft--;

      await ctx.reply(
        `✅ *Coupon Redeemed!*\n\n` +
        `🎟️ Code: \`${code}\`\n` +
        `💰 Credited: *+${coupon.amount} credits*\n\n` +
        `Your new balance will reflect shortly. Enjoy! 🎉`,
        { parse_mode: 'Markdown' },
      );
    } catch (err) {
      await ctx.reply(`❌ ${errMsg(err)}`);
    }
    return;
  }

  // ════════════════════════════════
  // ADMIN — Add Balance
  // ════════════════════════════════
  if (state.state === 'adm_addbal_email') {
    data.email = text;
    try {
      const res    = await makeApi(session?.token).get(`/admin/users?search=${encodeURIComponent(text)}&limit=1`);
      const result = unwrap(res);
      const users: any[] = result?.users ?? (Array.isArray(result) ? result : []);
      const user   = users.find((u: any) => u.email === text) ?? users[0];

      if (!user) {
        pending.delete(chatId);
        await ctx.reply(`❌ User not found: \`${text}\``, { parse_mode: 'Markdown' });
        return;
      }

      data.userId = user.id;
      pending.set(chatId, { state: 'adm_addbal_amount', data });
      await ctx.reply(`✅ Found: \`${user.email}\`\n💰 Current balance: *${user.balance} credits*\n\nEnter amount (use negative to deduct):`, { parse_mode: 'Markdown' });
    } catch (err) {
      pending.delete(chatId);
      await ctx.reply(`❌ ${errMsg(err)}`);
    }
    return;
  }

  if (state.state === 'adm_addbal_amount') {
    const amount = parseInt(text);
    if (isNaN(amount) || amount === 0) {
      await ctx.reply('❌ Enter a valid non-zero number:');
      return;
    }
    data.amount = String(amount);
    pending.set(chatId, { state: 'adm_addbal_confirm', data });
    await ctx.reply(
      `Confirm: *${amount > 0 ? 'Add' : 'Deduct'} ${Math.abs(amount)} credits* ${amount > 0 ? 'to' : 'from'} \`${data.email}\`?`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Confirm', 'adm_addbal_yes')],
          [Markup.button.callback('❌ Cancel',  'adm_addbal_no')],
        ]),
      },
    );
    return;
  }

  // ════════════════════════════════
  // ADMIN — Create Coupon
  // ════════════════════════════════
  if (state.state === 'adm_coupon_code') {
    data.code = text.toUpperCase().trim();
    pending.set(chatId, { state: 'adm_coupon_amount', data });
    await ctx.reply('💰 Step 2: How many credits does this coupon give? (e.g. 500):');
    return;
  }

  if (state.state === 'adm_coupon_amount') {
    const amount = parseInt(text);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❌ Enter a positive number:');
      return;
    }
    data.amount = String(amount);
    pending.set(chatId, { state: 'adm_coupon_uses', data });
    await ctx.reply('🔢 Step 3: Max number of uses? (e.g. 1 = single use, 100 = 100 users):');
    return;
  }

  if (state.state === 'adm_coupon_uses') {
    const maxUses = parseInt(text);
    if (isNaN(maxUses) || maxUses <= 0) {
      await ctx.reply('❌ Enter a positive number:');
      return;
    }
    pending.delete(chatId);

    coupons.set(data.code, {
      amount:    parseInt(data.amount),
      maxUses,
      usesLeft:  maxUses,
      usedBy:    new Set(),
      createdAt: new Date(),
    });

    await ctx.reply(
      `✅ *Coupon Created!*\n\n` +
      `🎟️ Code: \`${data.code}\`\n` +
      `💰 Value: *${data.amount} credits*\n` +
      `🔢 Max uses: *${maxUses}*\n\n` +
      `Share the code with your users!`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // ════════════════════════════════
  // ADMIN — Broadcast
  // ════════════════════════════════
  if (state.state === 'adm_broadcast_msg') {
    pending.delete(chatId);
    const message = text;
    const chatIds = [...sessions.keys()];

    await ctx.reply(`📢 Sending to ${chatIds.length} active sessions...`);

    let sent = 0;
    let failed = 0;
    for (const id of chatIds) {
      try {
        await bot.telegram.sendMessage(
          id,
          `📢 *Announcement*\n\n${message}`,
          { parse_mode: 'Markdown' },
        );
        sent++;
      } catch {
        failed++;
      }
    }

    await ctx.reply(
      `✅ *Broadcast Complete!*\n\n✉️ Sent: ${sent}\n❌ Failed: ${failed}`,
      { parse_mode: 'Markdown' },
    );
    return;
  }
});

// ════════════════════════════════════════════════════════════════
// LAUNCH
// ════════════════════════════════════════════════════════════════
const PORT           = parseInt(process.env.PORT ?? '3000');
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;

if (WEBHOOK_DOMAIN) {
  bot.launch({
    webhook: { domain: WEBHOOK_DOMAIN, port: PORT },
    allowedUpdates: ['message', 'callback_query'],
  }).then(() => console.log(`🤖 Bot running in webhook mode — port ${PORT}`));
} else {
  bot.launch({ allowedUpdates: ['message', 'callback_query'] });
  console.log('🤖 Bot running in polling mode');
}

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
