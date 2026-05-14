// Persistent storage via Redis
// All bot state is saved here so it survives redeployments.

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? '';

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!REDIS_URL) return null;
  if (!redis) {
    redis = new Redis(REDIS_URL, {
      tls: REDIS_URL.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    redis.on('error', (e) => console.error('[Redis]', e.message));
  }
  return redis;
}

async function rget(key: string): Promise<string | null> {
  try { return await getRedis()?.get(key) ?? null; } catch { return null; }
}
async function rset(key: string, val: string): Promise<void> {
  try { await getRedis()?.set(key, val); } catch {}
}

// ── Serialization helpers ──────────────────────────────────────

function mapToObj<V>(m: Map<any, V>): Record<string, V> {
  const o: Record<string, V> = {};
  for (const [k, v] of m) o[String(k)] = v;
  return o;
}
function objToMap<V>(o: Record<string, V>, parseKey: (k: string) => any = (k) => k): Map<any, V> {
  const m = new Map<any, V>();
  for (const [k, v] of Object.entries(o)) m.set(parseKey(k), v);
  return m;
}

// ── Save functions (call after every mutation) ─────────────────

export async function saveUserLang(userLang: Map<number, string>) {
  await rset('bot:userLang', JSON.stringify(mapToObj(userLang)));
}

export async function saveDigitalProducts(digitalProducts: Map<string, any>) {
  const obj = mapToObj(digitalProducts);
  // Convert Set fields if any
  await rset('bot:digitalProducts', JSON.stringify(obj));
}

export async function saveCoupons(coupons: Map<string, any>) {
  const obj: Record<string, any> = {};
  for (const [k, v] of coupons) {
    obj[k] = { ...v, usedBy: [...v.usedBy] };
  }
  await rset('bot:coupons', JSON.stringify(obj));
}

export async function saveReferrals(referrals: Map<number, number>, referred: Set<number>) {
  await rset('bot:referrals', JSON.stringify(mapToObj(referrals)));
  await rset('bot:referred',  JSON.stringify([...referred]));
}

export async function saveUserOrders(userOrders: Map<number, string[]>) {
  await rset('bot:userOrders', JSON.stringify(mapToObj(userOrders)));
}

export async function saveBannedUsers(bannedUsers: Set<number>) {
  await rset('bot:bannedUsers', JSON.stringify([...bannedUsers]));
}

export async function saveScheduledBroadcast(sb: { message: string; photoUrl?: string; intervalMs: number } | null) {
  await rset('bot:scheduledBroadcast', JSON.stringify(sb ?? null));
}

export async function saveFlashSale(fs: { percent: number; endsAt: string } | null) {
  await rset('bot:flashSale', JSON.stringify(fs ?? null));
}

// ── Load all on startup ────────────────────────────────────────

export interface BotState {
  userLang:          Map<number, string>;
  digitalProducts:   Map<string, any>;
  coupons:           Map<string, any>;
  referrals:         Map<number, number>;
  referred:          Set<number>;
  userOrders:        Map<number, string[]>;
  bannedUsers:       Set<number>;
  scheduledBroadcast: { message: string; photoUrl?: string; intervalMs: number } | null;
  flashSale:         { percent: number; endsAt: string } | null;
}

export async function loadState(): Promise<BotState> {
  const [ulRaw, dpRaw, cpRaw, rfRaw, rdRaw, uoRaw, buRaw, sbRaw, fsRaw] = await Promise.all([
    rget('bot:userLang'),
    rget('bot:digitalProducts'),
    rget('bot:coupons'),
    rget('bot:referrals'),
    rget('bot:referred'),
    rget('bot:userOrders'),
    rget('bot:bannedUsers'),
    rget('bot:scheduledBroadcast'),
    rget('bot:flashSale'),
  ]);

  const userLang = ulRaw
    ? objToMap<string>(JSON.parse(ulRaw), Number)
    : new Map<number, string>();

  const digitalProducts = dpRaw
    ? objToMap<any>(JSON.parse(dpRaw))
    : new Map<string, any>();

  const coupons = new Map<string, any>();
  if (cpRaw) {
    const raw = JSON.parse(cpRaw) as Record<string, any>;
    for (const [k, v] of Object.entries(raw)) {
      coupons.set(k, { ...v, usedBy: new Set<number>(v.usedBy ?? []) });
    }
  }

  const referrals = rfRaw
    ? objToMap<number>(JSON.parse(rfRaw), Number)
    : new Map<number, number>();

  const referred = rdRaw
    ? new Set<number>(JSON.parse(rdRaw) as number[])
    : new Set<number>();

  const userOrders = uoRaw
    ? objToMap<string[]>(JSON.parse(uoRaw), Number)
    : new Map<number, string[]>();

  const bannedUsers = buRaw
    ? new Set<number>(JSON.parse(buRaw) as number[])
    : new Set<number>();

  const scheduledBroadcast = sbRaw ? JSON.parse(sbRaw) : null;
  const flashSale          = fsRaw ? JSON.parse(fsRaw) : null;

  return { userLang, digitalProducts, coupons, referrals, referred, userOrders, bannedUsers, scheduledBroadcast, flashSale };
}
