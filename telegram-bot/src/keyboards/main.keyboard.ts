import { Markup } from 'telegraf';

export const mainKeyboard = Markup.keyboard([
  ['💰 Balance', '📱 New Order'],
  ['📋 My Orders', '💳 Recharge'],
  ['🎧 Support', '👤 Profile'],
]).resize();

export const adminKeyboard = Markup.keyboard([
  ['💰 Balance', '📱 New Order'],
  ['📋 My Orders', '💳 Recharge'],
  ['🎧 Support', '👤 Profile'],
  ['⚙️ Admin Panel'],
]).resize();

export const cancelKeyboard = Markup.keyboard([
  ['❌ Cancel'],
]).resize();

export const rechargeMethodKeyboard = Markup.keyboard([
  ['💛 Binance ID', '💚 USDT TRC20'],
  ['🏦 IBAN', '🏧 CIH Bank'],
  ['❌ Cancel'],
]).resize();
