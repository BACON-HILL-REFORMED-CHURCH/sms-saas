// ============================================================
// SMS Shop — Telegram Bot
// Routes: auth/login, auth/register, wallet/balance,
//         providers/services, orders (CRUD), admin/*
// ============================================================

import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';

// ── Config ───────────────────────────────────────────────────
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const API_URL = (process.env.API_URL ?? 'http://localhost:3001')
  .replace(/\/$/, '') + '/api/v1';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

console.log(`🤖 Connecting to API: ${API_URL}`);

// ── Types ─────────────────────────────────────────────────────
interface UserSession {
  token: string;
  email: string;
  role: string;
}

interface PendingState {
  state: string;
  data: Record<string, string>;
}

// ── In-memory storage ─────────────────────────────────────────
const sessions = new Map<number, UserSession>();
const pending  = new Map<number, PendingState>();

// ── API helper ────────────────────────────────────────────────
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
  return typeof msg === 'string' ? msg : (err?.message ?? 'خطأ غير معروف');
}

// ── Keyboards ─────────────────────────────────────────────────
const userKeyboard = Markup.keyboard([
  ['💰 رصيدي', '📱 شري رقم'],
  ['📋 طلبياتي', '📡 eSIM'],
  ['🚪 خروج'],
]).resize();

const adminKeyboard = Markup.keyboard([
  ['💰 رصيدي', '📱 شري رقم'],
  ['📋 طلبياتي', '📡 eSIM'],
  ['⚙️ ادمن', '🚪 خروج'],
]).resize();

const getKeyboard = (role: string) =>
  role === 'ADMIN' ? adminKeyboard : userKeyboard;

// ── Flag helper ───────────────────────────────────────────────
const FLAGS: Record<string, string> = {
  ae: '🇦🇪', us: '🇺🇸', gb: '🇬🇧', fr: '🇫🇷', de: '🇩🇪',
  sa: '🇸🇦', ma: '🇲🇦', eg: '🇪🇬', tn: '🇹🇳', tr: '🇹🇷',
  es: '🇪🇸', it: '🇮🇹', ru: '🇷🇺', in: '🇮🇳', br: '🇧🇷',
};
const flag = (code: string) => FLAGS[code?.toLowerCase()] ?? '🌍';

// ── Bot ───────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// /start
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  pending.delete(chatId);
  const session = sessions.get(chatId);

  if (session) {
    await ctx.reply(`👋 مرحبا ${session.email}!`, getKeyboard(session.role));
    return;
  }

  await ctx.reply(
    '🎉 *مرحبا في SMS Shop!*\n\nشري أرقام مؤقتة لتفعيل أي تطبيق بأرخص الأسعار.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 تسجيل دخول', 'do_login')],
        [Markup.button.callback('✨ إنشاء حساب جديد', 'do_register')],
      ]),
    },
  );
});

// ── Auth actions ──────────────────────────────────────────────
bot.action('do_login', async (ctx) => {
  pending.set(ctx.chat!.id, { state: 'login_email', data: {} });
  await ctx.reply('📧 أدخل البريد الإلكتروني:');
  await ctx.answerCbQuery();
});

bot.action('do_register', async (ctx) => {
  pending.set(ctx.chat!.id, { state: 'register_email', data: {} });
  await ctx.reply('📧 أدخل البريد الإلكتروني:');
  await ctx.answerCbQuery();
});

// ── Balance ───────────────────────────────────────────────────
async function showBalance(ctx: any, session: UserSession) {
  try {
    const res = await makeApi(session.token).get('/wallet/balance');
    const { balance } = unwrap(res);
    await ctx.reply(
      `💰 *رصيدك الحالي:* ${balance} نقطة`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
}

// ── Orders list ───────────────────────────────────────────────
async function showOrders(ctx: any, session: UserSession) {
  try {
    const res = await makeApi(session.token).get('/orders?limit=5');
    const data = unwrap(res);
    const orders: any[] = Array.isArray(data)
      ? data
      : (data?.orders ?? data?.data ?? []);

    if (!orders.length) {
      await ctx.reply('📋 ما عندكش طلبيات.');
      return;
    }

    for (const o of orders) {
      const emoji: Record<string, string> = {
        PENDING: '⏳', RECEIVED: '✅', CANCELED: '❌', EXPIRED: '⏰',
      };
      const statusIcon = emoji[o.status] ?? '❓';
      const text =
        `${statusIcon} *${o.service}* — ${o.country}\n` +
        `📱 \`${o.phoneNumber}\`\n` +
        (o.smsCode
          ? `✉️ الكود: \`${o.smsCode}\``
          : '⏳ انتظر وصول SMS...');

      const buttons: any[] = [];
      if (o.status === 'PENDING') {
        buttons.push([
          Markup.button.callback('🔄 تحديث', `poll_${o.id}`),
          Markup.button.callback('❌ إلغاء', `cancel_${o.id}`),
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

// ── Buy — country picker ──────────────────────────────────────
async function showCountries(ctx: any) {
  const countries = [
    { label: '🇺🇸 USA', code: 'us' },
    { label: '🇬🇧 UK', code: 'gb' },
    { label: '🇷🇺 Russia', code: 'ru' },
    { label: '🇺🇦 Ukraine', code: 'ua' },
    { label: '🇵🇱 Poland', code: 'pl' },
    { label: '🇩🇪 Germany', code: 'de' },
    { label: '🇫🇷 France', code: 'fr' },
    { label: '🇮🇳 India', code: 'in' },
    { label: '🇧🇷 Brazil', code: 'br' },
    { label: '🇵🇭 Philippines', code: 'ph' },
  ];
  await ctx.reply(
    '🌍 اختر البلد:',
    Markup.inlineKeyboard(
      countries.map((c) => [Markup.button.callback(c.label, `country_${c.code}`)]),
    ),
  );
}

bot.action(/^country_(.+)$/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('سجل الدخول أولا'); return; }

  const country = ctx.match[1];
  await ctx.answerCbQuery('⏳ جاري التحميل...');

  try {
    const res = await makeApi(session.token).get(
      `/providers/services?country=${country}`,
    );
    const data = unwrap(res);
    const services: any[] = Array.isArray(data)
      ? data
      : (data?.services ?? []);

    if (!services.length) {
      await ctx.reply('❌ ما كاينش خدمات لهاد البلد.');
      return;
    }

    const buttons = services.slice(0, 10).map((s: any) => {
      const label = `${s.service} — ${s.price ?? s.cost ?? '?'} نقطة`;
      // callback_data max 64 chars
      const cb = `buy_${s.service}_${country}_${s.provider ?? 'auto'}`.substring(0, 64);
      return [Markup.button.callback(label, cb)];
    });

    await ctx.reply(
      `📱 اختر الخدمة (${country.toUpperCase()}):`,
      Markup.inlineKeyboard(buttons),
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ── Buy — create order ────────────────────────────────────────
bot.action(/^buy_([^_]+)_([^_]+)_(.+)$/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('سجل الدخول أولا'); return; }

  const [, service, country, provider] = ctx.match;
  await ctx.answerCbQuery('⏳ جاري الطلب...');

  try {
    const body: any = { service, country };
    if (provider !== 'auto') body.provider = provider;

    const res = await makeApi(session.token).post('/orders', body);
    const order = unwrap(res);

    await ctx.reply(
      `✅ *تم الطلب بنجاح!*\n\n` +
      `📱 الرقم: \`${order.phoneNumber}\`\n` +
      `🔑 الخدمة: ${order.service}\n` +
      `🌍 البلد: ${order.country}\n\n` +
      `⏳ انتظر وصول SMS وضغط تحديث...`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🔄 تحقق من SMS', `poll_${order.id}`),
          Markup.button.callback('❌ إلغاء', `cancel_${order.id}`),
        ]]),
      },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ── Poll SMS ──────────────────────────────────────────────────
bot.action(/^poll_(.+)$/, async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery(); return; }

  const orderId = ctx.match[1];
  await ctx.answerCbQuery('⏳ جاري التحقق...');

  try {
    const res = await makeApi(session.token).get(`/orders/${orderId}`);
    const order = unwrap(res);

    if (order.smsCode) {
      await ctx.reply(
        `✅ *وصل الكود!*\n\n✉️ الكود: \`${order.smsCode}\`\n\n📄 ${order.smsFullText ?? ''}`,
        { parse_mode: 'Markdown' },
      );
    } else if (order.status === 'EXPIRED') {
      await ctx.reply('⏰ الطلب انتهت مدته.');
    } else {
      await ctx.reply(
        '⏳ SMS لم يصل بعد، حاول مجددا بعد لحظات.',
        Markup.inlineKeyboard([[
          Markup.button.callback('🔄 حاول مجددا', `poll_${orderId}`),
        ]]),
      );
    }
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ── Cancel order ──────────────────────────────────────────────
bot.action(/^cancel_(.+)$/, async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery(); return; }

  await ctx.answerCbQuery('⏳ جاري الإلغاء...');

  try {
    await makeApi(session.token).delete(`/orders/${ctx.match[1]}`);
    await ctx.reply('✅ تم إلغاء الطلب واسترجاع الرصيد.');
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ── eSIM ─────────────────────────────────────────────────────
async function showEsimProducts(ctx: any, session: UserSession) {
  try {
    const res = await makeApi(session.token).get('/esim/products');
    const products: any[] = unwrap(res);

    if (!products.length) {
      await ctx.reply('📡 ما كاينش خطط eSIM متاحة حالياً.');
      return;
    }

    // Group by country
    const grouped: Record<string, any[]> = {};
    for (const p of products) {
      if (!grouped[p.country]) grouped[p.country] = [];
      grouped[p.country].push(p);
    }

    await ctx.reply('📡 *خطط eSIM المتاحة*\n\nاختر البلد:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(
        Object.keys(grouped).map((country) => {
          const code = grouped[country][0].countryCode?.toLowerCase() ?? '';
          return [Markup.button.callback(
            `${flag(code)} ${country} (${grouped[country].length} خطط)`,
            `esim_country_${country}`,
          )];
        }),
      ),
    });
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
}

bot.action(/^esim_country_(.+)$/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery(); return; }

  const country = ctx.match[1];
  await ctx.answerCbQuery();

  try {
    const res = await makeApi(session.token).get('/esim/products');
    const all: any[] = unwrap(res);
    const plans = all.filter((p: any) => p.country === country);

    const buttons = plans.map((p: any) => {
      const stock = p.stock > 0 ? `✅ ${p.stock}` : '❌ نفد';
      const label = `${p.gb}GB / ${p.days}يوم — $${(p.price / 100).toFixed(2)} (${stock})`;
      return [Markup.button.callback(label, `esim_buy_${p.id}`)];
    });
    buttons.push([Markup.button.callback('🔙 رجوع', 'esim_back')]);

    const f = flag(plans[0]?.countryCode?.toLowerCase() ?? '');
    await ctx.reply(`${f} *${country}*\n\nاختر الخطة:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('esim_back', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (session) await showEsimProducts(ctx, session);
  await ctx.answerCbQuery();
});

bot.action(/^esim_buy_(.+)$/, async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session) { await ctx.answerCbQuery('سجل الدخول أولا'); return; }

  const productId = ctx.match[1];
  await ctx.answerCbQuery('⏳ جاري الشراء...');

  try {
    const res = await makeApi(session.token).post(`/esim/purchase/${productId}`);
    const order = unwrap(res);
    const qr = order.inventory?.qrCodeData ?? '';
    const act = order.inventory?.activationCode ?? '';

    await ctx.reply(
      `✅ *تم شراء eSIM بنجاح!*\n\n` +
      `${flag(order.product?.countryCode?.toLowerCase())} ${order.product?.country} — ` +
      `${order.product?.gb}GB / ${order.product?.days} يوم\n\n` +
      `📱 *بيانات التفعيل:*\n\`\`\`\n${qr}\n\`\`\`` +
      (act ? `\n\n🔑 كود التفعيل:\n\`${act}\`` : '') +
      `\n\n⚙️ *طريقة التفعيل:*\n1. الإعدادات → شبكة خلوية\n2. إضافة eSIM\n3. مسح QR أو إدخال يدوي`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('esim_orders', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session) { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();

  try {
    const res = await makeApi(session.token).get('/esim/orders');
    const orders: any[] = unwrap(res);

    if (!orders.length) {
      await ctx.reply('📡 ما عندكش طلبيات eSIM.');
      return;
    }

    const text = orders.slice(0, 5).map((o: any, i: number) =>
      `${i + 1}. ${flag(o.product?.countryCode?.toLowerCase())} ${o.product?.country} — ` +
      `${o.product?.gb}GB\n   📅 ${new Date(o.createdAt).toLocaleDateString()}`,
    ).join('\n\n');

    await ctx.reply(`📡 *طلبيات eSIM:*\n\n${text}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

// ── Admin panel ───────────────────────────────────────────────
bot.hears('⚙️ ادمن', async (ctx) => {
  const session = sessions.get(ctx.chat.id);
  if (!session || session.role !== 'ADMIN') return;

  await ctx.reply('🔧 *لوحة الادمن*', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📊 إحصائيات', 'adm_stats')],
      [Markup.button.callback('👥 المستخدمين', 'adm_users')],
      [Markup.button.callback('💰 إضافة رصيد', 'adm_addbal')],
    ]),
  });
});

bot.action('adm_stats', async (ctx) => {
  const session = sessions.get(ctx.chat!.id);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }
  await ctx.answerCbQuery();

  try {
    const res = await makeApi(session.token).get('/admin/stats');
    const s = unwrap(res);
    await ctx.reply(
      `📊 *إحصائيات المنصة*\n\n` +
      `👥 المستخدمين: ${s.totalUsers ?? 0}\n` +
      `📋 الطلبيات: ${s.totalOrders ?? 0}\n` +
      `✅ مستلمة: ${s.receivedOrders ?? 0}\n` +
      `💰 الإيرادات: ${s.totalRevenue ?? 0} نقطة`,
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
    const res = await makeApi(session.token).get('/admin/users?limit=10');
    const data = unwrap(res);
    const users: any[] = data?.users ?? (Array.isArray(data) ? data : []);

    if (!users.length) { await ctx.reply('ما كاينش مستخدمين.'); return; }

    const lines = users
      .slice(0, 10)
      .map((u: any, i: number) =>
        `${i + 1}. \`${u.email}\`\n   💰 ${u.balance} نقطة | ${u.role}`,
      )
      .join('\n\n');

    await ctx.reply(`👥 *المستخدمين:*\n\n${lines}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('adm_addbal', async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  if (!session || session.role !== 'ADMIN') { await ctx.answerCbQuery(); return; }

  pending.set(chatId, { state: 'adm_addbal_email', data: {} });
  await ctx.reply('📧 أدخل إيميل المستخدم:');
  await ctx.answerCbQuery();
});

bot.action('adm_addbal_yes', async (ctx) => {
  const chatId = ctx.chat!.id;
  const session = sessions.get(chatId);
  const state = pending.get(chatId);
  if (!session || !state) { await ctx.answerCbQuery(); return; }

  pending.delete(chatId);
  await ctx.answerCbQuery();

  try {
    await makeApi(session.token).post('/admin/balance/adjust', {
      userId: state.data.userId,
      amount: parseInt(state.data.amount),
      reason: 'Telegram admin top-up',
    });
    await ctx.reply(
      `✅ تمت إضافة ${state.data.amount} نقطة لـ ${state.data.email}`,
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMsg(err)}`);
  }
});

bot.action('adm_addbal_no', async (ctx) => {
  pending.delete(ctx.chat!.id);
  await ctx.reply('تم الإلغاء.');
  await ctx.answerCbQuery();
});

// ── Main text handler (state machine) ────────────────────────
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const session = sessions.get(chatId);
  const state = pending.get(chatId);

  // Keyboard shortcuts for logged-in users with no pending action
  if (session && !state) {
    if (text === '💰 رصيدي')  return showBalance(ctx, session);
    if (text === '📋 طلبياتي') return showOrders(ctx, session);
    if (text === '📱 شري رقم') return showCountries(ctx);
    if (text === '📡 eSIM')    return showEsimProducts(ctx, session);
    if (text === '🚪 خروج') {
      sessions.delete(chatId);
      await ctx.reply('👋 تم تسجيل الخروج.', Markup.removeKeyboard());
    }
    return;
  }

  if (!state) return;
  const { data } = state;

  // ── Login ──
  if (state.state === 'login_email') {
    data.email = text;
    pending.set(chatId, { state: 'login_password', data });
    await ctx.reply('🔒 أدخل كلمة المرور:');
    return;
  }

  if (state.state === 'login_password') {
    pending.delete(chatId);
    try {
      const res = await makeApi().post('/auth/login', {
        email: data.email,
        password: text,
      });
      const result = unwrap(res);
      const role = result.user?.role ?? 'USER';
      sessions.set(chatId, { token: result.accessToken, email: data.email, role });
      await ctx.reply(`✅ مرحبا ${data.email}!`, getKeyboard(role));
    } catch (err) {
      await ctx.reply(`❌ ${errMsg(err)}\n\nحاول مجددا: /start`);
    }
    return;
  }

  // ── Register ──
  if (state.state === 'register_email') {
    data.email = text;
    pending.set(chatId, { state: 'register_password', data });
    await ctx.reply('🔒 اختر كلمة مرور (8 أحرف على الأقل):');
    return;
  }

  if (state.state === 'register_password') {
    pending.delete(chatId);
    try {
      await makeApi().post('/auth/register', {
        email: data.email,
        password: text,
      });
      await ctx.reply(
        '✅ تم إنشاء الحساب بنجاح!\n\nادخل الآن: /start',
      );
    } catch (err) {
      await ctx.reply(`❌ ${errMsg(err)}\n\nحاول مجددا: /start`);
    }
    return;
  }

  // ── Admin add balance — search user by email ──
  if (state.state === 'adm_addbal_email') {
    data.email = text;
    pending.set(chatId, { state: 'adm_addbal_searching', data });

    try {
      const res = await makeApi(session?.token).get(
        `/admin/users?search=${encodeURIComponent(text)}&limit=1`,
      );
      const result = unwrap(res);
      const users: any[] = result?.users ?? (Array.isArray(result) ? result : []);
      const user = users.find((u: any) => u.email === text) ?? users[0];

      if (!user) {
        pending.delete(chatId);
        await ctx.reply(`❌ ما لقيناش مستخدم بهاد الإيميل.\n\nحاول مجددا: /start`);
        return;
      }

      data.userId = user.id;
      pending.set(chatId, { state: 'adm_addbal_amount', data });
      await ctx.reply(
        `✅ لقينا: ${user.email}\n💰 رصيده الحالي: ${user.balance} نقطة\n\nأدخل المبلغ المراد إضافته:`,
      );
    } catch (err) {
      pending.delete(chatId);
      await ctx.reply(`❌ ${errMsg(err)}`);
    }
    return;
  }

  if (state.state === 'adm_addbal_amount') {
    const amount = parseInt(text);
    if (isNaN(amount) || amount === 0) {
      await ctx.reply('❌ أدخل رقم صحيح (يمكن أن يكون سالبا للخصم):');
      return;
    }
    data.amount = String(amount);
    pending.set(chatId, { state: 'adm_addbal_confirm', data });
    await ctx.reply(
      `تأكيد: ${amount > 0 ? 'إضافة' : 'خصم'} *${Math.abs(amount)} نقطة* ${amount > 0 ? 'لـ' : 'من'} ${data.email}؟`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ تأكيد', 'adm_addbal_yes')],
          [Markup.button.callback('❌ إلغاء', 'adm_addbal_no')],
        ]),
      },
    );
    return;
  }
});

// ── Launch ────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000');
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN; // e.g. https://sms-saas-bot.up.railway.app

if (WEBHOOK_DOMAIN) {
  // Webhook mode — Railway production
  bot.launch({
    webhook: {
      domain: WEBHOOK_DOMAIN,
      port: PORT,
    },
    allowedUpdates: ['message', 'callback_query'],
  }).then(() => console.log(`🤖 Bot running in webhook mode on port ${PORT}`));
} else {
  // Polling mode — local dev
  bot.launch({ allowedUpdates: ['message', 'callback_query'] });
  console.log('🤖 Bot running in polling mode');
}

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
