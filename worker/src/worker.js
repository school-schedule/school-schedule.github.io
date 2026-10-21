/*
 * המערכת שלי — сервер (Cloudflare Worker)
 *
 * Что делает:
 *  1. Хранит расписание (GET /data — прочитать, POST /data — сохранить из редактора).
 *  2. Хранит подписки на уведомления (POST /subscribe, POST /unsubscribe).
 *  3. Когда редактор сохраняет новую отмену / смену кабинета / контрольную,
 *     отправляет push-уведомление только тем ученикам, кого это касается.
 *
 * Настройки в Cloudflare (Settings):
 *  - KV namespace с именем переменной  DB
 *  - Secret  EDITOR_CODE  = код редактора
 *  - (необязательно) Variable  CONTACT  = mailto:твоя@почта
 *  - (необязательно) Variable  SHAHAF_URL = адрес сайта שחף школы
 *    (по умолчанию https://kfaryarok.shahaf.site). Cron Trigger: каждые 15 минут
 *    — сервер сам забирает оттуда отмены, смену кабинетов и контрольные.
 *  - (для бесплатного тарифа) Queue с именем переменной  PUSHQ,
 *    и этот же Worker как consumer этой очереди (Batch size = 1).
 *    Без очереди уведомления отправляются сразу (подходит для платного тарифа).
 *  - Durable Object  LIMITER  (класс Limiter, SQLite) — счётчики попыток входа,
 *    подписок и отметок счётчика по адресам; описан в wrangler.toml.
 *  - Durable Object  STATS  (класс Stats, SQLite) — анонимный счётчик устройств
 *    (POST /ping от сайта, GET /stats — для редактора).
 */

import { DurableObject } from "cloudflare:workers";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Editor-Code",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  // автозапуск по расписанию (Cron Trigger): синхронизация с שחף
  async scheduled(event, env, ctx) {
    const min = new Date(event.scheduledTime || Date.now()).getUTCMinutes();
    // раз в час — контрольные, в остальное время — отмены и кабинеты
    // (по отдельности, чтобы уложиться в 10 мс процессора бесплатного тарифа)
    try {
      await syncShahaf(env, ctx, min < 15 ? { exams: true } : { changes: true });
    } catch (e) {
      // ошибку сохраняем, чтобы её было видно по адресу /shahaf
      await env.DB.put("shahaf:last", JSON.stringify({ status: "error", error: String((e && e.message) || e), at: new Date().toISOString() }));
    }
  },

  // очередь: уведомления отправляются маленькими порциями,
  // чтобы уложиться в 10 мс процессора бесплатного тарифа
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const m = msg.body;
        if (m.t === "plan") await planPushes(env, m.ds);
        else if (m.t === "push") await sendJobs(env, m.jobs);
      } catch (e) {}
      msg.ack();
    }
  },

  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/data" && req.method === "GET") {
        const s = await env.DB.get("state");
        if (!s) return json({ error: "empty" }, 404);
        if (s.includes('"codeHash"')) return json(stripSecret(JSON.parse(s)));
        return new Response(s, { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (path === "/data" && req.method === "POST") return await saveData(req, env, ctx);
      if (path === "/backups" || path === "/restore") {
        const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
        if (auth.status !== 200) return json(auth.body, auth.status);
        if (path === "/backups") return json({ backups: await listBackups(env) });
        if (req.method === "POST") { const b = await req.json().catch(() => ({})); return await restoreBackup(env, b.id); }
      }
      if (path === "/login" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const r = await checkCode(req, env, b && b.code);
        return json(r.body || { ok: true }, r.status);
      }
      if (path === "/vapid") return json({ key: (await getVapid(env)).publicKey });
      if (path === "/subscribe" && req.method === "POST") return await subscribe(req, env);
      if (path === "/unsubscribe" && req.method === "POST") return await unsubscribe(req, env);
      if (path === "/ping" && req.method === "POST") return await ping(req, env);
      if (path === "/stats") {
        const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
        if (auth.status !== 200) return json(auth.body, auth.status);
        return json(await statsObj(env).summary(israelDate(0)));
      }
      if (path === "/shahaf") return json((await env.DB.get("shahaf:last", "json")) || { status: "never" });
      if (path === "/shahaf/run" && req.method === "POST") {
        const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
        if (auth.status !== 200) return json(auth.body, auth.status);
        return json(await syncShahaf(env, ctx, { changes: true, exams: true }));
      }
      if (path === "/") return json({ ok: true, app: "hamaarechet-shelli" });
      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server", message: String((e && e.message) || e) }, 500);
    }
  },
};

/* ---------------- защита кода редактора ---------------- */
// После 5 неверных попыток с одного адреса — блокировка на 15 минут.
// Счётчики живут в Durable Object (Limiter), а не в KV: KV на бесплатном тарифе даёт
// всего 1000 записей в день (их можно «выжечь» неверными попытками и сломать публикацию)
// и обновляется с задержкой до минуты (параллельные попытки обходили бы счётчик).
const MAX_TRIES = 5, LOCK_SEC = 900;
// /subscribe: не больше 60 запросов с одного адреса в час (в школе у всех общий Wi-Fi)
const SUB_MAX = 60, SUB_WINDOW_SEC = 3600;
function clientIp(req) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  // IPv6: у одного устройства обычно целая сеть /64 — считаем её одним адресом
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const a = head ? head.split(":") : [], b = tail ? tail.split(":") : [];
  const full = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b];
  return full.slice(0, 4).map((x) => parseInt(x || "0", 16).toString(16)).join(":") + "::/64";
}
function limiter(env, kind, req) {
  return env.LIMITER.get(env.LIMITER.idFromName(kind + ":" + clientIp(req)));
}
async function checkCode(req, env, code) {
  if (!env.EDITOR_CODE) return { status: 500, body: { error: "no_code_configured" } };
  const ok = typeof code === "string" && code.length > 0 && safeEqual(code, env.EDITOR_CODE);
  let r;
  // если счётчик недоступен — не пускаем: иначе подбор кода был бы без ограничений
  try { r = await limiter(env, "login", req).login(ok); }
  catch (e) { return { status: 503, body: { error: "try_later" } }; }
  if (r.locked) return { status: 429, body: { error: "locked", retryAfter: r.retryAfter } };
  if (ok) return { status: 200 };
  return { status: 401, body: { error: "bad_code", left: r.left } };
}

// Один объект на каждый адрес и вид проверки ("login:<ip>", "sub:<ip>").
// Когда окно закончилось, будильник (alarm) стирает запись, чтобы не копились данные.
export class Limiter extends DurableObject {
  async login(ok) {
    const now = Date.now();
    const rec = (await this.ctx.storage.get("r")) || { n: 0, until: 0 };
    if (rec.until > now) return { locked: true, retryAfter: Math.ceil((rec.until - now) / 1000) };
    if (ok) {
      // верный код сбрасывает счётчик (запись тратится, только если он был)
      if (rec.n) await this.ctx.storage.deleteAll();
      return { locked: false };
    }
    rec.n += 1;
    if (rec.n >= MAX_TRIES) { rec.until = now + LOCK_SEC * 1000; rec.n = 0; }
    await this.ctx.storage.put("r", rec);
    // неверные попытки забываются через 15 минут после последней
    await this.ctx.storage.setAlarm(rec.until || now + LOCK_SEC * 1000);
    if (rec.until) return { locked: true, retryAfter: LOCK_SEC };
    return { locked: false, left: MAX_TRIES - rec.n };
  }
  async hit(max, windowSec) {
    const now = Date.now();
    const rec = await this.ctx.storage.get("r");
    if (!rec || rec.start + windowSec * 1000 <= now) {
      await this.ctx.storage.put("r", { n: 1, start: now });
      await this.ctx.storage.setAlarm(now + windowSec * 1000);
      return { ok: true };
    }
    // отклонённые запросы ничего не записывают
    if (rec.n >= max) return { ok: false, retryAfter: Math.ceil((rec.start + windowSec * 1000 - now) / 1000) };
    rec.n += 1;
    await this.ctx.storage.put("r", rec);
    return { ok: true };
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
// сравнение без «подсказок» по времени ответа
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
function stripSecret(st) {
  delete st.codeHash; // отпечаток кода больше не хранится в открытых данных
  return st;
}

/* ---------------- резервные копии ---------------- */
// Перед каждым изменением сохраняется предыдущая версия (храним последние 10).
// Изменения из שחף копируем не чаще раза в час, чтобы не тратить лимит записей.
const KEEP_BACKUPS = 10;
async function backup(env, raw, by) {
  if (!raw) return;
  const page = await env.DB.list({ prefix: "bak:" });
  const names = page.keys.map((k) => k.name).sort(); // имя: bak:<время>:<кто>
  if (by === "shahaf" && names.length && Date.now() - Date.parse(names[names.length - 1].slice(4, 28)) < 3600e3) return;
  const at = new Date().toISOString();
  const name = "bak:" + at + ":" + by;
  await env.DB.put(name, raw, { metadata: { at, by } });
  names.push(name);
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) await env.DB.delete(old);
}
async function listBackups(env) {
  const page = await env.DB.list({ prefix: "bak:" });
  return page.keys.map((k) => ({ id: k.name, at: (k.metadata && k.metadata.at) || k.name.slice(4, 28), by: (k.metadata && k.metadata.by) || "" })).sort((a, b) => b.at.localeCompare(a.at));
}
async function restoreBackup(env, id) {
  if (typeof id !== "string" || !id.startsWith("bak:")) return json({ error: "bad_id" }, 400);
  const raw = await env.DB.get(id);
  if (!raw) return json({ error: "not_found" }, 404);
  const cur = await env.DB.get("state");
  await backup(env, cur, "restore");
  const st = stripSecret(JSON.parse(raw));
  st.updatedAt = new Date().toISOString();
  await env.DB.put("state", JSON.stringify(st));
  return json({ ok: true, updatedAt: st.updatedAt });
}

/* ---------------- расписание ---------------- */

async function saveData(req, env, ctx) {
  const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
  if (auth.status !== 200) return json(auth.body, auth.status);
  const body = await req.json();
  const next = body && body.state;
  if (!next || !Array.isArray(next.lessons) || !Array.isArray(next.changes)) return json({ error: "bad_data" }, 400);

  const prevRaw = await env.DB.get("state");
  const prev = prevRaw ? JSON.parse(prevRaw) : null;
  // кто-то другой успел сохранить раньше
  if (prev && body.base && prev.updatedAt !== body.base) return json({ error: "conflict", updatedAt: prev.updatedAt }, 409);

  stripSecret(next);
  next.updatedAt = new Date().toISOString();
  await backup(env, prevRaw, "editor");
  await env.DB.put("state", JSON.stringify(next));

  const fresh = prev ? newChanges(prev, next) : [];
  if (fresh.length) ctx.waitUntil(notifyAll(env, fresh.map((c) => describe(next, c)).filter(Boolean)));
  return json({ ok: true, updatedAt: next.updatedAt, changes: fresh.length });
}

// новые или изменённые отметки на сегодня и дальше
function newChanges(prev, next) {
  const today = israelDate(0);
  const old = new Map(prev.changes.map((c) => [c.id, sig(c)]));
  return next.changes.filter((c) => c.date >= today && old.get(c.id) !== sig(c));
}
function sig(c) {
  return [c.date, c.lessonId, c.type, c.room || "", c.note || ""].join("|");
}

/* ---------------- подписки ---------------- */

// принимаем подписки только от настоящих сервисов уведомлений
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
function validSubscription(s) {
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 800 || !s.keys) return false;
  let u;
  try { u = new URL(s.endpoint); } catch (e) { return false; }
  if (u.protocol !== "https:" || !PUSH_HOSTS.some((re) => re.test(u.hostname))) return false;
  try {
    const p = b64d(String(s.keys.p256dh)), a = b64d(String(s.keys.auth));
    return p.length === 65 && p[0] === 4 && a.length === 16;
  } catch (e) { return false; }
}
async function subscribe(req, env) {
  let lim;
  // счётчик недоступен — пропускаем: подписка важнее, а запись в KV и так только при изменениях
  try { lim = await limiter(env, "sub", req).hit(SUB_MAX, SUB_WINDOW_SEC); } catch (e) { lim = { ok: true }; }
  if (!lim.ok) return json({ error: "too_many_subscribes", message: "Too many subscribe requests from this address. Try again later.", retryAfter: lim.retryAfter }, 429);
  const raw = await req.text();
  if (raw.length > 4000) return json({ error: "too_big" }, 413);
  let b;
  try { b = JSON.parse(raw); } catch (e) { return json({ error: "bad_json" }, 400); }
  const s = b && b.subscription;
  if (!validSubscription(s)) return json({ error: "bad_subscription" }, 400);
  const classes = /^c\d{1,2}$/;
  if (b.classId && !classes.test(String(b.classId))) return json({ error: "bad_class" }, 400);
  const id = await sha256(s.endpoint);
  const rec = {
    s: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
    c: String(b.classId || ""),
    g: (Array.isArray(b.groups) ? b.groups : []).map(String).slice(0, 60),
    l: ["he", "en", "ru"].includes(b.lang) ? b.lang : "he",
  };
  rec.g = rec.g.filter((x) => /^[\w-]{1,40}$/.test(x));
  const txt = JSON.stringify(rec);
  // если ничего не поменялось — не тратим запись
  const old = await env.DB.getWithMetadata("sub:" + id);
  if (old && old.metadata && JSON.stringify(old.metadata) === txt) return json({ ok: true, same: true });
  // запись лежит в "метаданных" ключа, чтобы при рассылке не читать каждого отдельно
  if (txt.length <= 1000) await env.DB.put("sub:" + id, "1", { metadata: rec });
  else await env.DB.put("sub:" + id, txt, { metadata: { v: 1 } });
  return json({ ok: true });
}

async function unsubscribe(req, env) {
  const b = await req.json().catch(() => ({}));
  if (b && typeof b.endpoint === "string" && b.endpoint.length <= 800) await env.DB.delete("sub:" + (await sha256(b.endpoint)));
  return json({ ok: true });
}

/* ---------------- счётчик пользователей ---------------- */
// Сайт раз в день присылает случайный id устройства и выбранный класс — больше ничего:
// ни имён, ни адресов. IP нужен только лимиту ниже (объект Limiter "ping:<ip>"
// сам стирается через час) и в счётчиках не хранится.
// Счётчики — в Durable Object (Stats), а не в KV: у KV мало записей на бесплатном тарифе.
// Не больше 300 отметок с одного адреса в час: в школе у многих общий Wi-Fi,
// но один адрес не накрутит тысячи «устройств».
const PING_MAX = 300, PING_WINDOW_SEC = 3600;
async function ping(req, env) {
  let lim;
  // счётчик лимитов недоступен — не считаем: иначе накрутка была бы без ограничений
  try { lim = await limiter(env, "ping", req).hit(PING_MAX, PING_WINDOW_SEC); }
  catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many_pings", retryAfter: lim.retryAfter }, 429);
  const raw = await req.text();
  if (raw.length > 300) return json({ error: "too_big" }, 413);
  let b;
  try { b = JSON.parse(raw); } catch (e) { return json({ error: "bad_json" }, 400); }
  const dev = b && b.id;
  if (typeof dev !== "string" || !/^[0-9a-f]{32}$/.test(dev)) return json({ error: "bad_id" }, 400);
  const cls = b.classId ? String(b.classId) : "";
  if (cls && !/^c\d{1,2}$/.test(cls)) return json({ error: "bad_class" }, 400);
  // день считает сервер (по времени Израиля), дате с телефона не доверяем
  await statsObj(env).ping(israelDate(0), dev, cls);
  return json({ ok: true });
}
function statsObj(env) {
  return env.STATS.get(env.STATS.idFromName("all"));
}
function shiftDay(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Один объект на всё приложение. Таблицы:
//  seen    — кто открывал приложение в какой день (хранится 30 дней);
//  devices — все устройства за всё время и их последний класс (для «всего»).
// Повторная отметка за тот же день ничего не записывает, если класс не менялся.
export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS seen (day TEXT NOT NULL, dev TEXT NOT NULL, cls TEXT NOT NULL, PRIMARY KEY (day, dev)) WITHOUT ROWID");
    this.sql.exec("CREATE TABLE IF NOT EXISTS devices (dev TEXT PRIMARY KEY, cls TEXT NOT NULL) WITHOUT ROWID");
  }
  ping(day, dev, cls) {
    this.sql.exec("INSERT INTO seen (day, dev, cls) VALUES (?, ?, ?) ON CONFLICT (day, dev) DO UPDATE SET cls = excluded.cls WHERE cls <> excluded.cls", day, dev, cls);
    this.sql.exec("INSERT INTO devices (dev, cls) VALUES (?, ?) ON CONFLICT (dev) DO UPDATE SET cls = excluded.cls WHERE cls <> excluded.cls", dev, cls);
    // старые дни стираем раз в сутки (пока объект в памяти)
    if (this.cleaned !== day) {
      this.cleaned = day;
      this.sql.exec("DELETE FROM seen WHERE day < ?", shiftDay(day, -29));
    }
    return { ok: true };
  }
  summary(day) {
    // за период каждое устройство считается один раз — по классу в последний его день
    const since = (from) => this.sql.exec("SELECT cls, COUNT(*) AS n FROM (SELECT dev, cls, MAX(day) FROM seen WHERE day >= ? GROUP BY dev) GROUP BY cls", from).toArray();
    const pack = (rows) => {
      const byClass = {};
      let total = 0;
      for (const r of rows) { byClass[r.cls] = r.n; total += r.n; }
      return { total, byClass };
    };
    return {
      day,
      today: pack(since(day)),
      week: pack(since(shiftDay(day, -6))),
      month: pack(since(shiftDay(day, -29))),
      all: pack(this.sql.exec("SELECT cls, COUNT(*) AS n FROM devices GROUP BY cls").toArray()),
    };
  }
}

async function* allSubs(env) {
  let cursor;
  do {
    const page = await env.DB.list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      let rec = k.metadata;
      if (rec && rec.v) rec = JSON.parse(await env.DB.get(k.name));
      if (rec && rec.s) yield { key: k.name, rec };
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
}

/* ---------------- уведомления ---------------- */

const T = {
  he: { cancel: "השיעור בוטל", room: "חדר חדש", test: "מבחן", exam: "בחינה", period: "שיעור", today: "היום", tomorrow: "מחר", many: (n) => n + " שינויים במערכת", one: "שינוי במערכת", dir: "rtl" },
  en: { cancel: "Lesson cancelled", room: "New room", test: "Test", exam: "Exam", period: "Period", today: "Today", tomorrow: "Tomorrow", many: (n) => n + " schedule changes", one: "Schedule change", dir: "ltr" },
  ru: { cancel: "Урок отменён", room: "Новый кабинет", test: "Контрольная", exam: "Экзамен", period: "Урок", today: "Сегодня", tomorrow: "Завтра", many: (n) => "Изменений в расписании: " + n, one: "Изменение в расписании", dir: "ltr" },
};
const DAYS = {
  he: ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "שבת"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  ru: ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"],
};

function israelDate(addDays) {
  const d = new Date(Date.now() + addDays * 864e5);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function dayWord(date, lang) {
  if (date === israelDate(0)) return T[lang].today;
  if (date === israelDate(1)) return T[lang].tomorrow;
  const [y, m, d] = date.split("-").map(Number);
  return DAYS[lang][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function byId(list, id) {
  return list.find((x) => x.id === id);
}
// короткое описание изменения: всё, что нужно для текста уведомления
function describe(st, c) {
  const les = byId(st.lessons, c.lessonId);
  if (!les) return null;
  const sub = byId(st.subjects, les.subjectId) || {};
  return {
    k: c.date + "|" + String(les.period).padStart(2, "0"),
    date: c.date,
    type: c.type,
    room: c.room || "",
    note: c.note || "",
    period: les.period,
    aud: les.aud,
    name: { he: sub.he || "", en: sub.en || sub.he || "", ru: sub.ru || sub.he || "" },
  };
}
function line(d, lang) {
  const L = T[lang];
  let what = d.type === "cancel" ? L.cancel : d.type === "room" ? L.room + ": " + d.room : d.type === "test" ? L.test : L.exam;
  if (d.note) what += " (" + d.note + ")";
  return dayWord(d.date, lang) + ", " + L.period + " " + d.period + ", " + d.name[lang] + ": " + what;
}
function concerns(d, rec) {
  if (d.aud.type === "class") return d.aud.id === rec.c;
  return rec.g.includes(d.aud.id);
}

const PER_MESSAGE = 3; // уведомлений в одном сообщении очереди

async function notifyAll(env, ds) {
  if (!ds.length) return;
  if (env.PUSHQ) return env.PUSHQ.send({ t: "plan", ds }); // бесплатный тариф: через очередь
  await planPushes(env, ds); // без очереди: всё сразу
}

// решает, кому и что отправить
async function planPushes(env, ds) {
  const jobs = [];
  for await (const { key, rec } of allSubs(env)) {
    const mine = ds.filter((d) => concerns(d, rec)).sort((a, b) => a.k.localeCompare(b.k));
    if (!mine.length) continue;
    const L = T[rec.l];
    jobs.push({
      key,
      s: rec.s,
      p: {
        title: mine.length === 1 ? L.one : L.many(mine.length),
        body: mine.slice(0, 4).map((d) => line(d, rec.l)).join("\n"),
        tag: "chg-" + mine[0].date,
        dir: L.dir,
        lang: rec.l,
      },
    });
  }
  if (!jobs.length) return;
  if (!env.PUSHQ) return sendJobs(env, jobs);
  const msgs = [];
  for (let i = 0; i < jobs.length; i += PER_MESSAGE) msgs.push({ body: { t: "push", jobs: jobs.slice(i, i + PER_MESSAGE) } });
  for (let i = 0; i < msgs.length; i += 100) await env.PUSHQ.sendBatch(msgs.slice(i, i + 100));
}

// отправляет уведомления
async function sendJobs(env, jobs) {
  const vapid = await getVapid(env);
  for (let i = 0; i < jobs.length; i += 20) {
    await Promise.all(
      jobs.slice(i, i + 20).map(async (j) => {
        try {
          const status = await sendPush(env, vapid, j.s, j.p);
          if (status === 404 || status === 410) await env.DB.delete(j.key); // подписка больше не действует
        } catch (e) {}
      })
    );
  }
}



/* ---------------- разовые исправления данных (по сайту שחף, 09.10.2026) ---------------- */
// Применяются один раз: в расписании запоминается, что исправление уже сделано.
const MIGRATION_ID = "shahaf-fix-2026-10-09";
function applyMigrations(st) {
  st.migrations = st.migrations || [];
  let changed = false;
  if (!st.migrations.includes(MIGRATION_ID)) { migration1(st); st.migrations.push(MIGRATION_ID); changed = true; }
  if (!st.migrations.includes(MIGRATION2_ID)) { migration2(st); st.migrations.push(MIGRATION2_ID); changed = true; }
  if (!st.migrations.includes(MIGRATION3_ID)) { migration3(st); st.migrations.push(MIGRATION3_ID); changed = true; }
  if (!st.migrations.includes(MIGRATION4_ID)) { migration4(st); st.migrations.push(MIGRATION4_ID); changed = true; }
  if (!st.migrations.includes(MIGRATION5_ID)) { migration5(st); st.migrations.push(MIGRATION5_ID); changed = true; }
  if (!st.migrations.includes(MIGRATION6_ID)) { migration6(st); st.migrations.push(MIGRATION6_ID); changed = true; }
  if (!st.migrations.includes(MIGRATION7_ID)) { migration7(st); st.migrations.push(MIGRATION7_ID); changed = true; }
  return changed;
}
function migration1(st) {
  const ALL = st.classes.map((c) => c.id);
  const UNKNOWN = ["c1", "c6", "c7", "c8", "c9"]; // классы, чьи страницы мы ещё не сверяли
  const exceptAllBut = (allowed) => ALL.filter((c) => !allowed.includes(c));
  const sid = (he) => (st.subjects.find((x) => x.he === he) || {}).id;
  let n = st.lessons.reduce((m, l) => Math.max(m, +String(l.id).replace(/\D/g, "") || 0), 0);
  const addLesson = (day, period, subjectId, aud, teacher, room) => {
    const dup = st.lessons.some((l) => l.day === day && l.period === period && l.aud.type === aud.type && l.aud.id === aud.id);
    if (!dup) st.lessons.push({ id: "L" + ++n, day, period, subjectId, aud, teacher, room });
  };
  // 1. учителя, которых не было
  for (const [c, d, p, t] of [["c3", 3, 9, "אהרון טל"], ["c3", 4, 4, "אהרון טל"], ["c4", 4, 4, "הלל דור"], ["c4", 4, 5, "הלל דור"]]) {
    const l = st.lessons.find((x) => x.aud.type === "class" && x.aud.id === c && x.day === d && x.period === p);
    if (l && !l.teacher) l.teacher = t;
  }
  // 2. пропущенные уроки
  addLesson(3, 9, sid("זהירות בדרכים"), { type: "class", id: "c11" }, "שוקרון עמי", "זית 7 י11");
  for (const [g, s] of [["g_pe_c10_f", 'חנ"ג בנות'], ["g_pe_c10_m", 'חנ"ג בנים']]) {
    const G = st.groups.find((x) => x.id === g);
    if (G) addLesson(3, 9, sid(s), { type: "group", id: g }, G.teacher, "");
  }
  // 3. английский: какие группы у каких классов (по вкладкам מבחנים и מערכת שעות)
  const engAllowed = {
    "ארויו סרדור אנה": ["c2", "c7"],
    "ג'קינטו קתרין": ["c2", "c3", "c6", "c7", "c8", "c9", "c10", "c11"],
    "היגינס ריאן": ["c1", "c2", "c3", "c6", "c7", "c8", "c9", "c10", "c11", "c12"],
    "מיירנץ לינדזי": ["c2", "c3", "c6", "c7", "c8", "c9", "c10", "c11"],
  };
  for (const g of st.groups) if (g.subjectId === "cat_eng" && engAllowed[g.teacher]) g.exceptClasses = exceptAllBut(engAllowed[g.teacher]);
  const engLesson = (st.lessons.find((l) => l.aud.type === "group" && (st.groups.find((g) => g.id === l.aud.id) || {}).subjectId === "cat_eng") || {}).subjectId;
  const newEng = [
    ["g_en_erez", "ארז איילת", "זית 3 י3", ["c3"]],
    ["g_en_aram", "ארם גוני", "אלון 2 י8 שמע", ["c10"]],
    ["g_en_scarlet", "סקרלט קרן", "זית 5 י7", ["c10"]],
    ["g_en_kela", "קלע אגוזי עירית", "אלון 6 י6", ["c10"]],
    ["g_en_krilov", "קרילוב לילי", "זית 7 י11", ["c11"]],
    ["g_en_gilad", "גלעד יואב", "זית 4 י12", ["c12"]],
  ];
  for (const [id, t, room, seen] of newEng) {
    if (st.groups.some((g) => g.id === id || (g.subjectId === "cat_eng" && g.teacher === t))) continue;
    st.groups.push({ id, subjectId: "cat_eng", he: "קבוצה", en: "Group", ru: "Группа", teacher: t, exceptClasses: exceptAllBut(seen.concat(UNKNOWN)) });
    for (const [d, p] of [[0, 3], [0, 4], [1, 1], [1, 2]]) addLesson(d, p, engLesson, { type: "group", id }, t, room);
  }
  // 4. математика: группа Гохберг Иланы
  if (!st.groups.some((g) => g.subjectId === "cat_math" && g.teacher === "גוכברג אילנה")) {
    const mathLesson = (st.lessons.find((l) => (st.groups.find((g) => g.id === l.aud.id) || {}).subjectId === "cat_math") || {}).subjectId;
    st.groups.push({ id: "g_math_goch", subjectId: "cat_math", he: "קבוצה", en: "Group", ru: "Группа", teacher: "גוכברג אילנה", exceptClasses: ["c2", "c3", "c10", "c12"] });
    for (const [d, p] of [[0, 1], [0, 2], [2, 1], [2, 2], [4, 1], [4, 2], [4, 3]]) addLesson(d, p, mathLesson, { type: "group", id: "g_math_goch" }, "גוכברג אילנה", "גפן 32 הקבצה");
  }
  // группы одного предмета держим рядом
  const order = [];
  for (const g of st.groups) if (!order.includes(g.subjectId)) order.push(g.subjectId);
  st.groups = order.flatMap((sj) => st.groups.filter((g) => g.subjectId === sj));
}

// 7. полная сверка с שחף, неделя 18–22.10.2026
const MIGRATION7_ID = "shahaf-audit-2026-10-20";
function migration7(st) {
  let n = st.lessons.reduce((m, l) => Math.max(m, +String(l.id).replace(/\D/g, "") || 0), 0);
  const sid = (he) => (st.subjects.find((x) => x.he === he) || {}).id;
  const grp = (id) => st.groups.find((g) => g.id === id);
  const at = (gid, d, p) => st.lessons.find((l) => l.aud.type === "group" && l.aud.id === gid && l.day === d && l.period === p);
  const add = (gid, d, p, subjHe, teacher, room) => {
    if (at(gid, d, p)) return;
    const subjectId = sid(subjHe) || ((st.lessons.find((l) => l.aud.id === gid) || {}).subjectId);
    st.lessons.push({ id: "L" + ++n, day: d, period: p, subjectId, aud: { type: "group", id: gid }, teacher, room });
  };
  const drop = (pred) => {
    const gone = new Set(st.lessons.filter(pred).map((l) => l.id));
    st.lessons = st.lessons.filter((l) => !gone.has(l.id));
    st.changes = st.changes.filter((c) => !gone.has(c.lessonId));
  };
  const ensureSubject = (he, en, ru) => { if (!sid(he)) st.subjects.push({ id: "s_" + Math.random().toString(36).slice(2, 8), he, en, ru }); return sid(he); };
  // 1. имя учителя полностью, как в שחף (иначе не находятся изменения)
  for (const g of st.groups) if (g.teacher === "ליכט מ.") g.teacher = "ליכט מאיר";
  for (const l of st.lessons) if (l.teacher === "ליכט מ.") l.teacher = "ליכט מאיר";
  // 2. математика в четверг: זיו לי — 1-й урок, זידמן רננה — 3-й
  const zid = st.groups.find((g) => g.subjectId === "cat_math" && g.teacher === "זידמן רננה");
  const ziv = st.groups.find((g) => g.subjectId === "cat_math" && g.teacher === "זיו לי");
  if (zid) { const l = at(zid.id, 4, 1); if (l && !at(zid.id, 4, 3)) { l.period = 3; l.room = "זית 5 י7"; } }
  if (ziv) { const l = at(ziv.id, 4, 3); if (l && !at(ziv.id, 4, 1)) { l.period = 1; l.room = "אלון 2 י8 שמע"; } }
  // 3. מסלול הכטב"מ — новая группа в אשכול ב׳
  ensureSubject('מסלול הכטב"מ', "Drone track", "Курс беспилотников");
  if (!grp("g_b_drone")) {
    st.groups.push({ id: "g_b_drone", subjectId: "cat_b", he: 'מסלול הכטב"מ', en: "Drone track", ru: "Курс беспилотников", teacher: "שוקרון ורד" });
    for (const [d, p] of [[1, 10], [1, 11], [2, 9], [2, 10], [3, 8], [3, 9], [4, 9]]) add("g_b_drone", d, p, 'מסלול הכטב"מ', "שוקרון ורד", "ארז כטבמ");
  }
  // 4. музыка и искусство в четверг
  const ens = (teacher) => st.groups.find((g) => g.subjectId === "cat_b" && g.teacher === teacher && /הרכבים/.test(g.he));
  if (!st.groups.some((g) => g.subjectId === "cat_b" && g.teacher === "שחם ענבל")) {
    const tpl = ens("זוסמן אורן") || {};
    st.groups.push({ id: "g_b_shaham", subjectId: "cat_b", he: "הרכבים", en: tpl.en || "Ensembles", ru: tpl.ru || "Ансамбли", teacher: "שחם ענבל" });
  }
  for (const p of [6, 7, 10, 11]) add("g_b_shaham", 4, p, "הרכבים", "שחם ענבל", "ריושקה הרכבים");
  const zus = ens("זוסמן אורן");
  if (zus) for (const p of [6, 7]) add(zus.id, 4, p, "הרכבים", "זוסמן אורן", "ריושקה הרכבים");
  const weissLesson = st.lessons.find((l) => l.aud.type === "group" && l.teacher === "וייס אמיר" && l.day === 4 && l.period === 7);
  if (weissLesson) add(weissLesson.aud.id, 4, 6, "הרכבים", "וייס אמיר", "ריושקה הרכבים");
  const livne = st.groups.find((g) => g.teacher === "ליבנה תמר");
  if (livne) { const l6 = at(livne.id, 4, 6); if (l6 && !at(livne.id, 4, 8)) l6.period = 8; }
  const shv = st.groups.find((g) => g.subjectId === "cat_b" && g.teacher === "שוורץ שחר יוסף");
  if (shv) {
    drop((l) => l.aud.id === shv.id && l.day === 4 && (l.period === 7 || l.period === 8));
    add(shv.id, 4, 9, "קדם מגמת מוסיקה", "שוורץ שחר יוסף", "ריושקה הרכבים");
    if (/תגבור/.test(shv.he)) { shv.he = "תורת המוזיקה / פיתוח שמיעה / קדם מגמת מוסיקה / הרכבים"; }
  }
  ensureSubject("קדם מגמת מוסיקה", "Pre-music major", "Подготовка к музыкальной мегаме");
  if (shv) { const l9 = at(shv.id, 4, 9); if (l9) l9.subjectId = sid("קדם מגמת מוסיקה"); }
  // 5. групп, которых больше нет в שחף, убираем
  const goneGroups = new Set(st.groups.filter((g) => (g.subjectId === "cat_b" && ["בלבין קוסטיה", "מוסיקה חדשה", "נוימן מלי"].includes(g.teacher)) || g.id === "g_b_arad").map((g) => g.id));
  drop((l) => l.aud.type === "group" && goneGroups.has(l.aud.id));
  st.groups = st.groups.filter((g) => !goneGroups.has(g.id));
  const order = [];
  for (const g of st.groups) if (!order.includes(g.subjectId)) order.push(g.subjectId);
  st.groups = order.flatMap((sj) => st.groups.filter((g) => g.subjectId === sj));
}

// 6. исправление уровней математики (13.10.2026): זיו לי — 5, שחבר רותם — 4
const MIGRATION6_ID = "math-levels-2026-10-13";
function migration6(st) {
  const lv = { 5: { he: "5 יח״ל", en: "5 units", ru: "5 единиц" }, 4: { he: "4 יח״ל", en: "4 units", ru: "4 единицы" } };
  for (const g of st.groups) {
    if (g.subjectId !== "cat_math") continue;
    if (g.teacher === "זיו לי") Object.assign(g, lv[5]);
    if (g.teacher === "שחבר רותם") Object.assign(g, lv[4]);
  }
}

// 5. «מדע וטכנולוגיה בחברה»: у каждого дня своя группа — выбор по дню и учителю (13.10.2026)
const MIGRATION5_ID = "mt-days-2026-10-13";
function migration5(st) {
  const DAY = { he: ["ראשון", "שני", "שלישי", "רביעי", "חמישי"], en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"], ru: ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг"] };
  const label = (d, a, b) => ({ he: "יום " + DAY.he[d] + ", שיעורים " + a + "–" + b, en: DAY.en[d] + ", periods " + a + "–" + b, ru: DAY.ru[d] + ", уроки " + a + "–" + b });
  // [старая группа, новая группа, день, с урока, по урок]
  const plan = [
    ["g_mt_lahav", "g_mt_lahav", 0, 5, 7],
    ["g_mt_lahav", "g_mt_lahav_wed", 3, 6, 8],
    ["g_mt_oren", "g_mt_oren", 4, 6, 8],
    ["g_mt_oren", "g_mt_oren_late", 4, 9, 11],
  ];
  for (const [from, to, d, a, b] of plan) {
    const src = st.groups.find((g) => g.id === from);
    if (!src) continue;
    let g = st.groups.find((x) => x.id === to);
    if (!g) { g = { id: to, subjectId: "cat_mt", teacher: src.teacher }; st.groups.push(g); }
    Object.assign(g, label(d, a, b));
    for (const l of st.lessons) if (l.aud.type === "group" && l.aud.id === from && l.day === d && l.period >= a && l.period <= b) l.aud = { type: "group", id: to };
  }
  const order = [];
  for (const g of st.groups) if (!order.includes(g.subjectId)) order.push(g.subjectId);
  const rank = { g_mt_lahav: 1, g_mt_lahav_wed: 2, g_mt_oren: 3, g_mt_oren_late: 4 };
  st.groups = order.flatMap((sj) => st.groups.filter((g) => g.subjectId === sj).sort((x, y) => (sj === "cat_mt" ? (rank[x.id] || 9) - (rank[y.id] || 9) : 0)));
}

// 4. «מדע וטכנולוגיה בחברה» — отдельный шаг выбора (13.10.2026)
// Раньше этот предмет был склеен с группами אשכול ב׳; теперь у него свои группы.
const MIGRATION4_ID = "mt-step-2026-10-13";
function migration4(st) {
  const mt = st.subjects.find((x) => x.he === "מדע וטכנולוגיה בחברה");
  if (!mt || st.subjects.some((x) => x.id === "cat_mt")) return;
  const cat = { id: "cat_mt", he: mt.he, en: mt.en, ru: mt.ru, multi: false };
  const iB = st.subjects.findIndex((x) => x.id === "cat_b");
  st.subjects.splice(iB >= 0 ? iB + 1 : st.subjects.length, 0, cat);
  const sub = (id) => st.subjects.find((x) => x.id === id) || {};
  const moves = [["g51", "g_mt_lahav"], ["g42", "g_mt_oren"]];
  for (const [from, to] of moves) {
    const old = st.groups.find((g) => g.id === from);
    if (!old) continue;
    st.groups.push({ id: to, subjectId: "cat_mt", he: mt.he, en: mt.en, ru: mt.ru, teacher: old.teacher });
    for (const l of st.lessons) if (l.aud.type === "group" && l.aud.id === from && l.subjectId === mt.id) l.aud = { type: "group", id: to };
    // у старой группы остаётся только второй предмет
    const rest = st.lessons.find((l) => l.aud.type === "group" && l.aud.id === from);
    if (rest) { const s2 = sub(rest.subjectId); old.he = s2.he || old.he; old.en = s2.en || old.en; old.ru = s2.ru || old.ru; }
  }
  const order = [];
  for (const g of st.groups) if (!order.includes(g.subjectId)) order.push(g.subjectId);
  st.groups = order.flatMap((sj) => st.groups.filter((g) => g.subjectId === sj));
}

// 3. уровни групп, которые были неизвестны (11.10.2026)
const MIGRATION3_ID = "levels-2026-10-11";
function migration3(st) {
  const L5 = { he: "5 יח״ל", en: "5 units", ru: "5 единиц" };
  const L5p = { he: "5+ יח״ל", en: "5+ units", ru: "5+ единиц" };
  const set = (cat, teacher, lv) => {
    for (const g of st.groups) if (g.subjectId === cat && g.teacher === teacher) Object.assign(g, lv);
  };
  for (const t of ["ארז איילת", "ארם גוני", "סקרלט קרן", "קלע אגוזי עירית", "קרילוב לילי", "גלעד יואב", "כחלון שרה"]) set("cat_eng", t, L5);
  set("cat_math", "גוכברג אילנה", L5p);
  set("cat_math", "מרום משה", L5);
}

// 2-я сверка (10.10.2026): страницы י׳1, י׳2, י׳5–י׳9
const MIGRATION2_ID = "shahaf-fix-2026-10-10";
function migration2(st) {
  const ALL = st.classes.map((c) => c.id);
  const exceptAllBut = (allowed) => ALL.filter((c) => !allowed.includes(c));
  const sid = (he) => (st.subjects.find((x) => x.he === he) || {}).id;
  let n = st.lessons.reduce((m, l) => Math.max(m, +String(l.id).replace(/\D/g, "") || 0), 0);
  const addLesson = (day, period, subjectId, aud, teacher, room) => {
    const dup = st.lessons.some((l) => l.day === day && l.period === period && l.aud.type === aud.type && l.aud.id === aud.id);
    if (!dup) st.lessons.push({ id: "L" + ++n, day, period, subjectId, aud, teacher, room });
  };
  const classLesson = (c, d, p) => st.lessons.find((l) => l.aud.type === "class" && l.aud.id === c && l.day === d && l.period === p);
  const groupLessonSubject = (cat) => (st.lessons.find((l) => (st.groups.find((g) => g.id === l.aud.id) || {}).subjectId === cat) || {}).subjectId;
  // английский: точно, какие группы у каких классов
  const eng = {
    "היגינס ריאן": ["c1", "c2", "c3", "c6", "c7", "c8", "c9", "c10", "c11", "c12"],
    "ארויו סרדור אנה": ["c2", "c7"],
    "ג'קינטו קתרין": ["c2", "c3", "c6", "c7", "c8", "c9", "c10", "c11"],
    "מיירנץ לינדזי": ["c2", "c3", "c6", "c7", "c8", "c9", "c10", "c11"],
    "כחלון שרה": ["c1", "c7"],
    "ארז איילת": ["c3", "c7"],
    "ארם גוני": ["c8", "c10"],
    "סקרלט קרן": ["c9", "c10"],
    "קלע אגוזי עירית": ["c6", "c10"],
    "קרילוב לילי": ["c11"],
    "גלעד יואב": ["c12"],
  };
  if (!st.groups.some((g) => g.subjectId === "cat_eng" && g.teacher === "כחלון שרה")) {
    st.groups.push({ id: "g_en_kahlon", subjectId: "cat_eng", he: "קבוצה", en: "Group", ru: "Группа", teacher: "כחלון שרה" });
    for (const [d, p] of [[0, 3], [0, 4], [1, 1], [1, 2]]) addLesson(d, p, groupLessonSubject("cat_eng"), { type: "group", id: "g_en_kahlon" }, "כחלון שרה", "זית 1 י1 שמע");
  }
  for (const g of st.groups) if (g.subjectId === "cat_eng" && eng[g.teacher]) g.exceptClasses = exceptAllBut(eng[g.teacher]);
  // математика: Гохберг — у י׳4, 5, 7, 9, 11; группа Маром Моше — только у י׳9
  for (const g of st.groups) if (g.subjectId === "cat_math" && g.teacher === "גוכברג אילנה") g.exceptClasses = exceptAllBut(["c4", "c5", "c7", "c9", "c11"]);
  if (!st.groups.some((g) => g.subjectId === "cat_math" && g.teacher === "מרום משה")) {
    st.groups.push({ id: "g_math_marom", subjectId: "cat_math", he: "קבוצה", en: "Group", ru: "Группа", teacher: "מרום משה", classId: "c9" });
    for (const [d, p] of [[0, 1], [0, 2], [2, 1], [2, 2], [4, 1], [4, 2]]) addLesson(d, p, groupLessonSubject("cat_math"), { type: "group", id: "g_math_marom" }, "מרום משה", "אלון 1 י9");
  }
  // י׳1: вс 10 — חינוך וחברה, вс 11 — урока нет, пн 7–8 — אזרחות
  const s10 = classLesson("c1", 0, 10);
  if (s10) s10.subjectId = sid("חינוך וחברה");
  const s11 = classLesson("c1", 0, 11);
  if (s11) {
    st.lessons = st.lessons.filter((l) => l !== s11);
    st.changes = st.changes.filter((c) => c.lessonId !== s11.id);
  }
  const m7 = classLesson("c1", 1, 7);
  if (m7) m7.subjectId = sid("אזרחות");
  addLesson(1, 8, sid("אזרחות"), { type: "class", id: "c1" }, "שפיר ענת", "זית 1 י1 שמע");
  // י׳5: английский и в понедельник на 1–2
  const e5 = classLesson("c5", 0, 3);
  if (e5) for (const p of [1, 2]) addLesson(1, p, e5.subjectId, { type: "class", id: "c5" }, e5.teacher, e5.room);
  const order = [];
  for (const g of st.groups) if (!order.includes(g.subjectId)) order.push(g.subjectId);
  st.groups = order.flatMap((sj) => st.groups.filter((g) => g.subjectId === sj));
}

/* ---------------- синхронизация с שחף ---------------- */
// Сайт שחף школы открыт для всех: вкладки «שינויים» и «מבחנים» для каждого класса.
// Сервер читает их, находит уроки в нашем расписании и сохраняет изменения с id "sh:…".
// Ручные отметки редактора не трогаются.

function decodeHtml(s) {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function normName(s) {
  return String(s || "").replace(/[״"'׳`\-–]/g, " ").replace(/\s+/g, " ").trim();
}
function isoDate(d) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d);
  return m ? m[3] + "-" + m[2] + "-" + m[1] : null;
}
function weekday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// номера классов на сайте שחף: «י - 2» → 25
function parseClassOptions(html, letter) {
  const map = {};
  const re = /<option[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(html))) {
    const t = decodeHtml(m[2]).replace(/\s/g, "");
    const mm = /^(.+)-(\d+)$/.exec(t);
    if (mm && mm[1] === letter) map[+mm[2]] = m[1];
  }
  return map;
}
// cache: одинаковые строки повторяются на страницах всех классов — разбираем их один раз
function listItems(html, cache) {
  const out = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    let t = cache ? cache.get(m[1]) : undefined;
    if (t === undefined) {
      t = decodeHtml(m[1]);
      if (!/^\d{2}\.\d{2}\.\d{4},/.test(t)) t = null;
      if (cache) cache.set(m[1], t);
    }
    if (t) out.push(t);
  }
  return out;
}
// «11.10.2026, שיעור 7, סימין יבגני שי, שיעור חופשי»
function parseChange(t) {
  const m = /^(\d{2}\.\d{2}\.\d{4}),\s*שיעור\s*(\d+),\s*([^,]+),\s*(.*)$/.exec(t);
  if (!m) return null;
  const desc = m[4].trim();
  let type = null, room = "";
  const r = /חדר\s*:?\s*(.+)$/.exec(desc);
  if (/חופשי|ביטול|מבוטל/.test(desc)) type = "cancel";
  else if (r) { type = "room"; room = r[1].trim(); }
  if (!type) return { unknown: t };
  return { date: isoDate(m[1]), from: +m[2], to: +m[2], teacher: m[3].trim(), type, room, note: desc };
}
// «20.10.2026, מבדק במתמטיקה שיעור 1 לכיתות: … בקבוצה של נייטרמן אירנה, חדר: זית 2 י2»
function parseExam(t) {
  const m = /^(\d{2}\.\d{2}\.\d{4}),\s*(.+?)\s+(?:משיעור\s*(\d+)\s*עד\s*שיעור\s*(\d+)|שיעור\s*(\d+))\s+לכיתות:.*?בקבוצה של\s+([^,]+?)\s*(?:,\s*חדר:\s*(.+))?$/.exec(t);
  if (!m) return null;
  const from = +(m[3] || m[5]), to = +(m[4] || m[5]);
  const title = m[2].trim();
  return { date: isoDate(m[1]), from, to, teacher: m[6].trim(), type: /מבחן/.test(title) ? "exam" : "test", room: (m[7] || "").trim(), note: title };
}
function groupFitsClass(g, cid) {
  if (g.exceptClasses && g.exceptClasses.indexOf(cid) >= 0) return false;
  return !g.classId || g.classId === cid;
}
// урок в нашем расписании: класс, день, номер урока, учитель
function lessonIndex(st) {
  const groups = new Map(st.groups.map((g) => [g.id, g]));
  const byDP = new Map();
  for (const l of st.lessons) {
    const k = l.day + "|" + l.period;
    if (!byDP.has(k)) byDP.set(k, []);
    const g = l.aud.type === "group" ? groups.get(l.aud.id) : null;
    byDP.get(k).push({ l, g, t: normName(l.teacher), gt: g ? normName(g.teacher) : "" });
  }
  return byDP;
}
function findLessons(idx, cid, item) {
  if (!item.date) return [];
  const wd = weekday(item.date);
  const who = normName(item.teacher);
  const out = [];
  for (let p = item.from; p <= item.to; p++) {
    for (const x of idx.get(wd + "|" + p) || []) {
      if (x.l.aud.type === "class" ? x.l.aud.id !== cid : !x.g || !groupFitsClass(x.g, cid)) continue;
      if (x.t === who || x.gt === who) out.push(x.l);
    }
  }
  return out;
}

async function syncShahaf(env, ctx, opt) {
  const base = (env.SHAHAF_URL || "https://kfaryarok.shahaf.site").replace(/\/+$/, "");
  const raw = await env.DB.get("state");
  if (!raw) return { status: "no_state" };
  const st = JSON.parse(raw);
  const hadSecret = "codeHash" in st;
  stripSecret(st);
  const migrated = applyMigrations(st) || hadSecret;
  const today = israelDate(0);
  const letter = (st.classes[0] && st.classes[0].letter) || "י";
  const get = async (q) => {
    const r = await fetch(base + "/" + q, { headers: { "User-Agent": "hamaarechet-shelli (school schedule app)" } });
    if (!r.ok) throw new Error("shahaf " + r.status);
    return r.text();
  };
  const first = await get("?tab=changes");
  const ids = parseClassOptions(first, letter);
  const report = { at: new Date().toISOString(), classes: 0, items: 0, matched: 0, unmatched: [], unknown: [] };
  const found = new Map();
  const idx = lessonIndex(st);
  const rawCache = new Map(), parsed = new Map();
  const tabs = (opt.changes ? ["changes"] : []).concat(opt.exams ? ["exams"] : []);
  for (const c of st.classes) {
    const sid = ids[c.num];
    if (!sid) continue;
    report.classes++;
    for (const tab of tabs) {
      const html = await get("?cls=" + sid + "&tab=" + tab);
      for (const t of listItems(html, rawCache)) {
        let it = parsed.get(tab + t);
        if (it === undefined) { it = tab === "changes" ? parseChange(t) : parseExam(t); parsed.set(tab + t, it); }
        if (!it) continue;
        if (it.unknown) { if (report.unknown.length < 10) report.unknown.push(it.unknown); continue; }
        if (!it.date || it.date < today) continue;
        report.items++;
        const ls = findLessons(idx, c.id, it);
        if (!ls.length) { if (report.unmatched.length < 15) report.unmatched.push(c.he + ": " + t); continue; }
        report.matched++;
        for (const l of ls) {
          const id = "sh:" + it.date + ":" + l.id + ":" + it.type;
          const ch = { id, date: it.date, lessonId: l.id, type: it.type };
          if (it.room) ch.room = it.room;
          if (it.type !== "cancel" && it.type !== "room") ch.note = it.note;
          found.set(id, ch);
        }
      }
    }
  }
  // старые импортированные отметки на сегодня и дальше заменяем свежими
  // (заменяем только те виды, которые проверялись в этот раз)
  const keep = st.changes.filter((c) => {
    if (!String(c.id).startsWith("sh:") || c.date < today) return true;
    const isExam = c.type === "test" || c.type === "exam";
    return isExam ? !opt.exams : !opt.changes;
  });
  const next = keep.concat([...found.values()].filter((c) => !keep.some((k) => k.id === c.id)));
  const sigOf = (list) => list.filter((c) => String(c.id).startsWith("sh:")).map((c) => c.id + "|" + (c.room || "") + "|" + (c.note || "")).sort().join("\n");
  report.changed = sigOf(next) !== sigOf(st.changes) || migrated;
  const firstRun = !(await env.DB.get("shahaf:last"));
  if (report.changed) {
    const prev = { changes: st.changes };
    st.changes = next;
    st.updatedAt = new Date().toISOString();
    await backup(env, raw, "shahaf");
    await env.DB.put("state", JSON.stringify(st));
    const fresh = newChanges(prev, st);
    report.notified = firstRun ? 0 : fresh.length; // в первый раз ничего не рассылаем
    if (fresh.length && !firstRun) {
      const p = notifyAll(env, fresh.map((c) => describe(st, c)).filter(Boolean));
      if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
    }
  }
  report.status = "ok";
  // отчёт сохраняем при изменениях и раз в час (бережём лимит записей KV)
  if (report.changed || firstRun || opt.exams) await env.DB.put("shahaf:last", JSON.stringify(report));
  return report;
}

/* ---------------- Web Push (RFC 8291 + VAPID) ---------------- */

const JWTS = new Map(); // подпись VAPID переиспользуется 6 часов
async function sendPush(env, vapid, sub, payload) {
  const body = await encrypt(sub.keys.p256dh, sub.keys.auth, new TextEncoder().encode(JSON.stringify(payload)));
  const aud = new URL(sub.endpoint).origin;
  let c = JWTS.get(aud);
  if (!c || c.exp < Date.now()) { c = { jwt: await vapidJwt(env, vapid, aud), exp: Date.now() + 6 * 3600e3 }; JWTS.set(aud, c); }
  const jwt = c.jwt;
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + jwt + ", k=" + vapid.publicKey,
      TTL: "86400",
      Urgency: "high",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  return r.status;
}

// ключи VAPID создаются один раз и хранятся в KV
let VAPID = null;
async function getVapid(env) {
  if (VAPID) return VAPID;
  const saved = await env.DB.get("vapid", "json");
  if (saved) return (VAPID = saved);
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const v = { publicKey: b64u(pub), jwk };
  await env.DB.put("vapid", JSON.stringify(v));
  return v;
}

async function vapidJwt(env, vapid, aud) {
  const head = b64u(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(new TextEncoder().encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.CONTACT || "mailto:noreply@hamaarechet.app" })));
  const key = await crypto.subtle.importKey("jwk", vapid.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(head + "." + claims)));
  return head + "." + claims + "." + b64u(sig);
}

async function encrypt(p256dh, auth, plaintext) {
  const ua = b64d(p256dh);
  const authSecret = b64d(auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, cat(enc("WebPush: info\0"), ua, asPub, [1]));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc("Content-Encoding: nonce\0"), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(plaintext, [2])));
  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  return cat(header, ct);
}

/* ---------------- мелкие помощники ---------------- */

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
async function sha256(s) {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
function enc(s) {
  return new TextEncoder().encode(s);
}
function cat(...parts) {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function b64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64d(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
