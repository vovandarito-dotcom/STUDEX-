// STUDEX: серверная часть. Одна функция принимает действия от Mini App.
// Секреты (BOT_TOKEN) хранятся только в Supabase. SUPABASE_URL и SERVICE_ROLE_KEY подставляются автоматически.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const BOT = Deno.env.get("BOT_TOKEN") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-init-data, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

class Err extends Error {
  constructor(public code: string, public status = 400) {
    super(code);
  }
}
// deno-lint-ignore no-explicit-any
type Any = any;
type U = { id: string; number: number; tg_id: number; role: string; blocked: boolean };

const CATS = ["Рефераты и доклады", "Конспекты", "Чертежи и схемы", "Курсовые", "Контрольные и тесты", "Презентации"];
const TYPES = ["Объяснить тему", "Проверить и дать замечания", "Консультация", "Образец для ознакомления", "Помощь с оформлением"];
const TERMS = ["Сегодня", "3 дня", "Неделя", "Месяц"];
const CONTACT = /(\+?\d[\d\s\-()]{8,})|@\w{3,}|t\.me|https?:\/\//i;
const STN = [
  "Согласование суммы", "Сумма предложена", "Ожидает оплаты", "Оплата сообщена", "В работе",
  "На проверке у администратора", "Одобрено · ждёт покупателя", "Выполнен", "Отменён",
];
const MOVES: Record<string, number[][]> = {
  buyer: [[0, 8], [1, 2], [1, 8], [2, 3], [2, 8], [6, 7]],
  seller: [[3, 4], [4, 5]],
  admin: [[5, 6], [5, 4]],
};
const fee = (a: number) => Math.round(a * 20) / 100;
const isAdmin = (u: U) => u.role === "admin" || u.role === "director";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- Проверка данных Telegram (initData) ----------
async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw", typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
async function verifyInitData(initData: string): Promise<{ id: number } | null> {
  if (!initData || !BOT) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const check = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac("WebAppData", BOT);
  const sig = hex(await hmac(secret, check));
  let diff = sig.length ^ hash.length;
  for (let i = 0; i < Math.min(sig.length, hash.length); i++) diff |= sig.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  try {
    const user = JSON.parse(p.get("user") ?? "null");
    return user && typeof user.id === "number" ? user : null;
  } catch {
    return null;
  }
}
async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(d));
}

// ---------- Помощники ----------
async function getUser(tg: number): Promise<U | null> {
  const { data } = await db.from("users").select("*").eq("tg_id", tg).maybeSingle();
  return data as U | null;
}
async function register(tg: number, code?: string): Promise<U> {
  let hash: string | null = null;
  if (code) {
    const c = String(code).trim().toUpperCase();
    if (![25, 50, 75].includes(c.length) || !/^[A-Z2-9]+$/.test(c)) throw new Err("bad_code");
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await db.from("code_attempts").select("*", { count: "exact", head: true })
      .eq("tg_id", tg).gte("created_at", since);
    if ((count ?? 0) >= 10) throw new Err("rate_limited", 429);
    await db.from("code_attempts").insert({ tg_id: tg });
    hash = await sha256hex(c);
  }
  const { data, error } = await db.rpc("register_user", { p_tg: tg, p_hash: hash });
  if (error) {
    if (String(error.message).includes("bad_code")) throw new Err("bad_code");
    throw error;
  }
  return data as U;
}
async function audit(actor: U, action: string, details = "") {
  await db.from("audit_log").insert({ actor_id: actor.id, action, details });
}
async function notify(ids: string[], text: string) {
  if (!ids.length) return;
  await db.from("notifications").insert(ids.map((id) => ({ user_id: id, body: text })));
  const { data } = await db.from("users").select("tg_id").in("id", ids);
  if (!BOT) return;
  await Promise.allSettled((data ?? []).map((r: Any) =>
    fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: r.tg_id, text: `STUDEX: ${text}` }),
    })
  ));
}
async function adminIds(): Promise<string[]> {
  const { data } = await db.from("users").select("id").in("role", ["admin", "director"]).eq("blocked", false);
  return (data ?? []).map((x: Any) => x.id);
}
async function sysMsg(order_id: number, body: string) {
  await db.from("messages").insert({ order_id, kind: "system", body });
}
async function getOrder(id: number): Promise<Any> {
  const { data } = await db.from("orders").select("*").eq("id", Number(id)).maybeSingle();
  if (!data) throw new Err("not_found", 404);
  return data;
}
const sum = (r: Any, f = "amount") => (r.data ?? []).reduce((x: number, y: Any) => x + Number(y[f]), 0);
async function debtOf(sellerId: string) {
  const a = await db.from("ledger").select("amount").eq("user_id", sellerId).eq("kind", "commission");
  const b = await db.from("cash_payments").select("amount").eq("seller_id", sellerId);
  return sum(a) - sum(b);
}
async function createOrder(o: { title: string; category: string; buyer_id: string; seller_id: string }) {
  const { data, error } = await db.from("orders").insert(o).select().single();
  if (error) throw error;
  await db.from("order_status_history").insert({ order_id: data.id, status: 0, actor_id: o.buyer_id });
  await sysMsg(data.id, "Заказ создан. Продавец назовёт сумму.");
  await notify([o.seller_id], `Новый заказ №${data.id}`);
  return data;
}
async function complete(o: Any) {
  const amount = Number(o.amount);
  await db.from("ledger").upsert([
    { order_id: o.id, kind: "buyer_spent", user_id: o.buyer_id, amount },
    { order_id: o.id, kind: "seller_earned", user_id: o.seller_id, amount: amount - fee(amount) },
    { order_id: o.id, kind: "commission", user_id: o.seller_id, amount: fee(amount) },
  ], { onConflict: "order_id,kind", ignoreDuplicates: true });
  const { data: s } = await db.from("users").select("number").eq("id", o.seller_id).single();
  const debt = await debtOf(o.seller_id);
  await notify(
    await adminIds(),
    `Заказ №${o.id} выполнен. Продавец №${s?.number} должен платформе ${fee(amount)} BYN за этот заказ. Общий долг продавца: ${Math.max(debt, 0)} BYN`,
  );
}
async function move(o: Any, to: number, actor: U) {
  const { data } = await db.from("orders")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", o.id).eq("status", o.status).select().maybeSingle();
  if (!data) throw new Err("conflict", 409);
  await db.from("order_status_history").insert({ order_id: o.id, status: to, actor_id: actor.id });
  await sysMsg(o.id, STN[to]);
  if (to === 7) await complete(data);
  const n = `по заказу №${o.id}`;
  if (to === 2) await notify([o.seller_id], `Покупатель принял сумму ${n}`);
  if (to === 3) await notify([o.seller_id], `Покупатель сообщил об оплате ${n}`);
  if (to === 4 && o.status === 3) await notify([o.buyer_id], `Продавец подтвердил получение перевода ${n}`);
  if (to === 4 && o.status === 5) await notify([o.seller_id], `Заказ №${o.id} возвращён на доработку`);
  if (to === 5) await notify(await adminIds(), `Заказ №${o.id} ждёт проверки`);
  if (to === 6) {
    await notify([o.buyer_id], `Администратор одобрил заказ №${o.id}. Подтвердите получение`);
    await notify([o.seller_id], `Заказ №${o.id} одобрен, ждём подтверждения покупателя`);
  }
  if (to === 8) await notify([o.buyer_id, o.seller_id], `Заказ №${o.id} отменён`);
}
function text(v: unknown, min: number, max: number, field: string) {
  const s = String(v ?? "").trim();
  if (s.length < min || s.length > max) throw new Err("bad_" + field);
  if (CONTACT.test(s)) throw new Err("contacts");
  return s;
}

// ---------- Действия ----------
const handlers: Record<string, (u: U, b: Any) => Promise<Any>> = {
  async offer_new(u, b) {
    if (u.role !== "seller") throw new Err("forbidden", 403);
    if (!CATS.includes(b.category)) throw new Err("bad_category");
    const { error } = await db.from("offers").insert({
      seller_id: u.id,
      title: text(b.title, 5, 120, "title"),
      category: b.category,
      description: text(b.description, 10, 2000, "description"),
      term: TERMS.includes(b.term) || /^\d+ д/.test(String(b.term)) ? String(b.term) : "1 день",
      format: ["Чат", "PDF", "DOCX", "Чат + файл", "PPTX"].includes(b.format) ? b.format : "Чат",
    });
    if (error) throw error;
  },
  async order_new(u, b) {
    if (u.role !== "buyer") throw new Err("forbidden", 403);
    const { data: of } = await db.from("offers").select("*").eq("id", Number(b.offer)).eq("hidden", false).maybeSingle();
    if (!of) throw new Err("not_found", 404);
    const { data: s } = await db.from("users").select("blocked").eq("id", of.seller_id).single();
    if (s?.blocked) throw new Err("not_found", 404);
    const o = await createOrder({ title: of.title, category: of.category, buyer_id: u.id, seller_id: of.seller_id });
    return { id: o.id };
  },
  async ad_new(u, b) {
    if (u.role !== "buyer") throw new Err("forbidden", 403);
    if (!CATS.includes(b.category) || !TYPES.includes(b.type) || !TERMS.includes(b.term)) throw new Err("bad_request");
    const { error } = await db.from("ads").insert({
      buyer_id: u.id,
      title: text(b.title, 5, 120, "title"),
      category: b.category,
      description: text(b.description, 20, 2000, "description"),
      term: b.term,
      type: b.type,
    });
    if (error) throw error;
  },
  async ad_respond(u, b) {
    if (u.role !== "seller") throw new Err("forbidden", 403);
    const { data: ad } = await db.from("ads").select("*").eq("id", Number(b.ad)).eq("status", "open").eq("hidden", false).maybeSingle();
    if (!ad) throw new Err("not_found", 404);
    await db.from("ad_responses").upsert({ ad_id: ad.id, seller_id: u.id }, { onConflict: "ad_id,seller_id", ignoreDuplicates: true });
    await notify([ad.buyer_id], "Новый отклик на ваше объявление");
  },
  async ad_pick(u, b) {
    if (u.role !== "buyer") throw new Err("forbidden", 403);
    const { data: ad } = await db.from("ads").select("*").eq("id", Number(b.ad)).eq("buyer_id", u.id).eq("status", "open").maybeSingle();
    if (!ad) throw new Err("not_found", 404);
    const { data: s } = await db.from("users").select("id").eq("number", Number(b.seller)).eq("role", "seller").eq("blocked", false).maybeSingle();
    if (!s) throw new Err("not_found", 404);
    const { data: r } = await db.from("ad_responses").select("ad_id").eq("ad_id", ad.id).eq("seller_id", s.id).maybeSingle();
    if (!r) throw new Err("forbidden", 403);
    const { data: closed } = await db.from("ads").update({ status: "closed" }).eq("id", ad.id).eq("status", "open").select().maybeSingle();
    if (!closed) throw new Err("conflict", 409);
    const o = await createOrder({ title: ad.title, category: ad.category, buyer_id: u.id, seller_id: s.id });
    return { id: o.id };
  },
  async propose(u, b) {
    const o = await getOrder(b.order);
    const amount = Number(b.amount);
    if (o.seller_id !== u.id || o.status !== 0 || o.amount_set) throw new Err("forbidden", 403);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Err("bad_amount");
    const { data } = await db.from("orders").update({ amount, amount_set: true, status: 1, updated_at: new Date().toISOString() })
      .eq("id", o.id).eq("status", 0).eq("amount_set", false).select().maybeSingle();
    if (!data) throw new Err("conflict", 409);
    await db.from("order_status_history").insert({ order_id: o.id, status: 1, actor_id: u.id });
    await sysMsg(o.id, "Продавец назвал сумму");
    await notify([o.buyer_id], `Продавец назвал сумму по заказу №${o.id}`);
  },
  async step(u, b) {
    const o = await getOrder(b.order);
    const to = Number(b.to);
    const kind = isAdmin(u) ? "admin" : o.buyer_id === u.id ? "buyer" : o.seller_id === u.id ? "seller" : null;
    if (!kind || !MOVES[kind].some(([f, t]) => f === o.status && t === to)) throw new Err("forbidden", 403);
    await move(o, to, u);
    if (kind === "admin") await audit(u, STN[to], `заказ №${o.id}`);
  },
  async rate(u, b) {
    const o = await getOrder(b.order);
    const r = Number(b.rating);
    if (o.buyer_id !== u.id || o.status !== 7 || o.rating || !(r >= 1 && r <= 5)) throw new Err("forbidden", 403);
    await db.from("orders").update({ rating: Math.round(r) }).eq("id", o.id).is("rating", null);
  },
  async send(u, b) {
    const o = await getOrder(b.order);
    if (o.buyer_id !== u.id && o.seller_id !== u.id) throw new Err("forbidden", 403);
    const body = text(b.text, 1, 2000, "message");
    await db.from("messages").insert({ order_id: o.id, sender_id: u.id, kind: "user", body });
    await notify([o.buyer_id === u.id ? o.seller_id : o.buyer_id], `Новое сообщение в заказе №${o.id}`);
  },
  async chat_open(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const o = await getOrder(b.order);
    await audit(u, "Просмотр переписки", `заказ №${o.id}, причина: проверка`);
    return { chat: o.id };
  },
  async complain(u, b) {
    const o = await getOrder(b.order);
    if (o.buyer_id !== u.id || o.status !== 6) throw new Err("forbidden", 403);
    const { data: ex } = await db.from("complaints").select("id").eq("order_id", o.id).eq("status", "open").maybeSingle();
    if (ex) return;
    await db.from("complaints").insert({ order_id: o.id, buyer_id: u.id });
    await notify(await adminIds(), `Новая жалоба по заказу №${o.id}`);
  },
  async decide(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const { data: c } = await db.from("complaints").select("*").eq("id", Number(b.id)).eq("status", "open").maybeSingle();
    if (!c) throw new Err("not_found", 404);
    const o = await getOrder(c.order_id);
    const r = String(b.r);
    if (!["b", "s", "x"].includes(r)) throw new Err("bad_request");
    if (r !== "x" && o.status === 6) await move(o, r === "b" ? 8 : 7, u);
    await db.from("complaints").update({ status: "closed", resolution: r }).eq("id", c.id);
    await audit(u, "Решение по жалобе", `заказ №${o.id}: ${r === "b" ? "в пользу покупателя" : r === "s" ? "в пользу продавца" : "закрыта"}`);
  },
  async cash(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) throw new Err("bad_amount");
    const { data: s } = await db.from("users").select("id,number").eq("number", Number(b.seller)).eq("role", "seller").maybeSingle();
    if (!s) throw new Err("not_found", 404);
    await db.from("cash_payments").insert({ seller_id: s.id, amount, admin_id: u.id });
    await audit(u, "Получено наличными", `${amount} BYN от продавца №${s.number}`);
  },
  async block(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const { data: t } = await db.from("users").select("*").eq("number", Number(b.number)).maybeSingle();
    if (!t || t.id === u.id || t.role === "director" || (t.role === "admin" && u.role !== "director")) throw new Err("forbidden", 403);
    await db.from("users").update({ blocked: !t.blocked }).eq("id", t.id);
    await audit(u, t.blocked ? "Разблокирован" : "Заблокирован", `пользователь №${t.number}`);
  },
  async hide(u, b) {
    if (!isAdmin(u)) throw new Err("forbidden", 403);
    const m = /^([oa])(\d+)$/.exec(String(b.key));
    if (!m) throw new Err("bad_request");
    const tbl = m[1] === "o" ? "offers" : "ads";
    const { data: r } = await db.from(tbl).select("hidden").eq("id", Number(m[2])).maybeSingle();
    if (!r) throw new Err("not_found", 404);
    await db.from(tbl).update({ hidden: !r.hidden }).eq("id", Number(m[2]));
    await audit(u, r.hidden ? "Показано" : "Скрыто", String(b.key));
  },
};

// ---------- Снимок данных для пользователя ----------
async function snapshot(u: U, chatOrder?: number) {
  const adm = isAdmin(u);
  const hhmm = (s: string) => s;
  const { data: us } = await db.from("users").select("id,number,role,blocked");
  const users: Any[] = us ?? [];
  const num = new Map<string, number>(users.map((x) => [x.id, x.number]));
  const blocked = new Set(users.filter((x) => x.blocked).map((x) => x.id));

  let oq = db.from("orders").select("*").order("id", { ascending: false });
  if (!adm) oq = u.role === "seller" ? oq.eq("seller_id", u.id) : oq.eq("buyer_id", u.id);
  const { data: orders } = await oq;
  const myOrders: Any[] = orders ?? [];

  const { data: dn } = await db.from("orders").select("seller_id,rating").eq("status", 7);
  const stat = new Map<string, { k: number; rs: number; rc: number }>();
  for (const x of dn ?? []) {
    const s = stat.get(x.seller_id) ?? { k: 0, rs: 0, rc: 0 };
    s.k++;
    if (x.rating) { s.rs += x.rating; s.rc++; }
    stat.set(x.seller_id, s);
  }
  const avg = (id: string) => {
    const s = stat.get(id);
    return s && s.rc ? Math.round((s.rs / s.rc) * 10) / 10 : null;
  };

  let fq = db.from("offers").select("*").order("id", { ascending: false });
  if (!adm) fq = fq.eq("hidden", false);
  const { data: offs } = await fq;
  const offers = (offs ?? []).filter((o: Any) => adm || !blocked.has(o.seller_id)).map((o: Any) => ({
    id: o.id, t: o.title, c: o.category, d: o.description, tm: o.term, f: o.format,
    s: num.get(o.seller_id), r: avg(o.seller_id) ?? "—", n: stat.get(o.seller_id)?.k ?? 0,
  }));

  let aq = db.from("ads").select("*").eq("status", "open").order("id", { ascending: false });
  if (!adm) aq = aq.eq("hidden", false);
  const { data: ads } = await aq;
  const { data: resp } = await db.from("ad_responses").select("ad_id,seller_id");
  const adsOut = (ads ?? []).filter((a: Any) => adm || a.buyer_id === u.id || !blocked.has(a.buyer_id)).map((a: Any) => ({
    id: a.id, t: a.title, c: a.category, d: a.description, tm: a.term, ty: a.type, b: num.get(a.buyer_id),
    rs: (resp ?? []).filter((r: Any) => r.ad_id === a.id).map((r: Any) => num.get(r.seller_id)),
  }));

  const msgs: Record<number, Any[]> = {};
  const ids = adm ? (chatOrder ? [chatOrder] : []) : myOrders.map((o) => o.id);
  if (ids.length) {
    const { data: ms } = await db.from("messages").select("*").in("order_id", ids).order("id");
    const byId = new Map<number, Any>();
    for (const o of adm ? [await getOrder(chatOrder!)] : myOrders) byId.set(o.id, o);
    for (const m of ms ?? []) {
      const o = byId.get(m.order_id);
      (msgs[m.order_id] ??= []).push({
        w: m.kind === "system" ? "x" : m.sender_id === o.buyer_id ? "b" : "s", t: m.body, at: m.created_at,
      });
    }
  }

  const { data: lg } = await db.from("ledger").select("*").eq("user_id", u.id);
  const titles = new Map<number, string>(myOrders.map((o) => [o.id, o.title]));
  const led = (lg ?? []).filter((l: Any) => l.kind !== "commission").map((l: Any) => ({
    o: l.order_id, w: l.kind === "buyer_spent" ? "b" : "s", s: u.number, a: Number(l.amount), t: titles.get(l.order_id) ?? "",
  }));

  const cs: Record<number, number> = {};
  const { data: cp } = await db.from("cash_payments").select("seller_id,amount");
  for (const c of cp ?? []) {
    if (adm || c.seller_id === u.id) cs[num.get(c.seller_id)!] = (cs[num.get(c.seller_id)!] ?? 0) + Number(c.amount);
  }

  let cmp: Any[] = [], audit: Any[] = [];
  if (adm) {
    const { data: cm } = await db.from("complaints").select("id,order_id").eq("status", "open");
    cmp = (cm ?? []).map((c: Any) => ({ id: c.id, o: c.order_id, open: true }));
    const { data: al } = await db.from("audit_log").select("action,details,created_at").order("id", { ascending: false }).limit(100);
    audit = (al ?? []).map((a: Any) => ({ t: a.details ? `${a.action}: ${a.details}` : a.action, at: a.created_at }));
  }
  const hid: string[] = [];
  if (adm) {
    for (const o of offs ?? []) if (o.hidden) hid.push("o" + o.id);
    for (const a of ads ?? []) if (a.hidden) hid.push("a" + a.id);
  }
  const { data: nt } = await db.from("notifications").select("body,created_at").eq("user_id", u.id).order("id", { ascending: false }).limit(50);

  const mine = myOrders.filter((o) => o.status === 7);
  const rated = myOrders.filter((o) => o.seller_id === u.id && o.status === 7 && o.rating);
  const stats = {
    buys: mine.filter((o) => o.buyer_id === u.id).length,
    sales: mine.filter((o) => o.seller_id === u.id).length,
    avg: rated.length ? Math.round((rated.reduce((a, o) => a + o.rating, 0) / rated.length) * 10) / 10 : null,
  };
  void hhmm;
  return {
    me: { number: u.number, role: u.role },
    users: adm ? users.map((x) => ({ n: x.number, r: x.role, bl: x.blocked })) : [],
    admins: u.role === "director" ? users.filter((x) => x.role === "admin").map((x) => ({ n: x.number, bl: x.blocked })) : [],
    offers, ads: adsOut,
    orders: myOrders.map((o) => ({
      id: o.id, t: o.title, c: o.category, b: num.get(o.buyer_id), s: num.get(o.seller_id), st: o.status,
      amt: o.amount === null ? null : Number(o.amount), set: o.amount_set, rv: o.rating ?? 0,
    })),
    msgs, led, cs, cmp, audit, hid, stats,
    nt: (nt ?? []).map((x: Any) => ({ t: x.body, at: x.created_at })),
  };
}

// ---------- Вход ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    const tg = await verifyInitData(req.headers.get("x-init-data") ?? "");
    if (!tg) throw new Err("auth", 401);
    let u = await getUser(tg.id);
    if (body.action === "register") u = await register(tg.id, body.code);
    if (!u) {
      if (body.action !== "state") throw new Err("not_registered", 401);
      return json({ state: { me: null } });
    }
    if (u.blocked) throw new Err("blocked", 403);
    let extra: Any = {};
    if (body.action !== "state" && body.action !== "register") {
      const h = handlers[body.action];
      if (!h) throw new Err("unknown");
      extra = (await h(u, body)) ?? {};
    }
    const chat = body.action === "state" && isAdmin(u) ? Number(body.chat) || undefined : extra.chat;
    return json({ ...extra, state: await snapshot(u, chat) });
  } catch (e) {
    if (e instanceof Err) return json({ error: e.code }, e.status);
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
