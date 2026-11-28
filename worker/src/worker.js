/*
 * Skedy (раньше «המערכת שלי») — сервер (Cloudflare Worker)
 *
 * Что делает:
 *  1. Хранит расписание (GET /data — прочитать, POST /data — сохранить из редактора).
 *     Расписание всей школы для Skedy Admin (/admin/): GET /tt, POST /tt (по коду редактора),
 *     прошлые версии: GET /tt/backups, POST /tt/restore (по коду редактора);
 *     изменения на даты для уроков всей школы: GET /ttch, POST /ttch (+ уведомления учителям);
 *     сообщения всем учителям: GET /tmsg, POST /tmsg, POST /tmsg/delete (+ уведомление).
 *  2. Хранит подписки на уведомления (POST /subscribe, POST /unsubscribe).
 *  3. Когда редактор сохраняет новую отмену / смену кабинета / контрольную,
 *     отправляет push-уведомление только тем ученикам, кого это касается.
 *
 * Настройки в Cloudflare (Settings):
 *  - KV namespace с именем переменной  DB
 *  - Secret  EDITOR_CODE  = код редактора
 *  - Workers AI (binding AI в wrangler.toml) — бесплатный помощник в Skedy Admin (POST /ai);
 *  - (необязательно) Secret  ANTHROPIC_API_KEY = ключ Claude API: если задан, помощник работает на Claude
 *  - (необязательно) Variable  CONTACT  = mailto:твоя@почта
 *  - (необязательно) Variable  SHAHAF_URL = адрес сайта שחף школы
 *    (по умолчанию https://kfaryarok.shahaf.site). Cron Trigger: каждые 5 минут
 *    — сервер сам забирает оттуда отмены, смену кабинетов и контрольные,
 *    а раз в сутки — события (выходные и праздники) с вкладки «אירועים».
 *  - (необязательно) Variable  SHAHAF_EVENTS_TAB = имя вкладки событий в адресе (?tab=…),
 *    по умолчанию events.
 *  - (для бесплатного тарифа) Queue с именем переменной  PUSHQ,
 *    и этот же Worker как consumer этой очереди (Batch size = 1).
 *    Без очереди уведомления отправляются сразу (подходит для платного тарифа).
 *  - Durable Object  LIMITER  (класс Limiter, SQLite) — счётчики попыток входа,
 *    подписок и отметок счётчика по адресам; описан в wrangler.toml.
 *  - Durable Object  STATS  (класс Stats, SQLite) — анонимный счётчик устройств
 *    (POST /ping от сайта, GET /stats — для редактора) и сообщения об ошибках
 *    (POST /report от учеников, GET /reports и POST /reports/delete — для редактора),
 *    коды друзей (POST /pal, GET /pal/<код>, POST /pal/delete, POST /pal/link|inbox — взаимное добавление, POST /pal/unlink — взаимное удаление), «кто сейчас свободен» (GET /crowd)
 *    и чат поддержки (POST /chat, POST /chat/get — ученик; GET /chats, POST /chats/open|reply|delete — редактор).
 */

import { DurableObject } from "cloudflare:workers";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Editor-Code,X-Pm-Key,X-T-Name,X-T-Key",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const ALIAS = { "/hi": "/ping", "/devices": "/stats", "/note": "/report", "/notes": "/reports", "/notes/delete": "/reports/delete" };

export default {
  // автозапуск по расписанию (Cron Trigger): синхронизация с שחף
  async scheduled(event, env, ctx) {
    const at = new Date(event.scheduledTime || Date.now());
    const min = at.getUTCMinutes();
    // cron каждые 5 минут: в :00 — контрольные (раз в час), в 3:15 UTC — события (раз в сутки),
    // в остальное время — отмены и кабинеты (по отдельности, чтобы уложиться в 10 мс процессора бесплатного тарифа)
    const opt = min < 5 ? { exams: true } : min >= 15 && min < 20 && at.getUTCHours() === 3 ? { events: true } : { changes: true };
    try {
      await syncShahaf(env, ctx, opt);
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
        else if (m.t === "bc") await planBroadcast(env, m);
        else if (m.t === "push") await sendJobs(env, m.jobs);
      } catch (e) {}
      msg.ack();
    }
  },

  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const path0 = new URL(req.url).pathname.replace(/\/+$/, "") || "/";
    // блокировщики рекламы режут адреса со словами stats/ping/report — сайт ходит по нейтральным именам
    const path = ALIAS[path0] || path0;
    try {
      if (path === "/data" && req.method === "GET") {
        const s = await env.DB.get("state");
        if (!s) return json({ error: "empty" }, 404);
        if (s.includes('"codeHash"')) return json(stripSecret(JSON.parse(s)));
        return new Response(s, { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (path === "/data" && req.method === "POST") return await saveData(req, env, ctx);
      // расписание всей школы (Skedy Admin, /admin/): читать может каждый, сохранять — по коду редактора
      if (path === "/tt" && req.method === "GET") {
        const s = await env.DB.get("tt");
        if (!s) return json({ error: "empty" }, 404);
        return new Response(s, { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (path === "/tt" && req.method === "POST") return await saveTT(req, env);
      // прошлые версии расписания всей школы: список и восстановление (по коду редактора)
      if (path === "/tt/backups" || path === "/tt/restore") {
        const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
        if (auth.status !== 200) return json(auth.body, auth.status);
        if (path === "/tt/backups") return json({ backups: await ttBackups(env) });
        if (req.method === "POST") { const b = await req.json().catch(() => ({})); return await ttRestore(env, b.id); }
      }
      // изменения на даты для уроков всей школы (Skedy Admin): отмена, другой кабинет, контрольная
      if (path === "/ttch" && req.method === "GET") {
        const s = await env.DB.get("ttch");
        if (!s) return json({ updatedAt: null, ch: [] });
        return new Response(s, { headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
      }
      if (path === "/ttch" && req.method === "POST") return await saveTTCh(req, env, ctx);
      // запись родителей на личные встречи (Skedy Parents → Skedy Admin / Skedy Teachers)
      if (path === "/pmb" || path.startsWith("/pmb/")) return await pmbRoute(req, env, path);
      // запрос родителя на разговор с учителем (уходит классному руководителю) и личные ссылки учителей
      if (path === "/preq" || path.startsWith("/preq/") || path === "/tkey") return await preqRoute(req, env, ctx, path);
      // разрешения родителей (экскурсии и т. п.): ответ родителя, списки — админу и классному руководителю
      if (path === "/apr" || path.startsWith("/apr/")) return await aprRoute(req, env, path);
      // сообщения всем учителям (Skedy Admin → Skedy Teachers): читать — всем, отправить/удалить — по коду
      if (path === "/tmsg" && req.method === "GET") return json((await env.DB.get("tmsg", "json")) || { msgs: [] });
      // помощник Skedy Admin: текст админа → предложенные изменения (их применяет и сохраняет сам админ)
      if (path === "/ai" && req.method === "POST") return await aiAsk(req, env);
      if ((path === "/tmsg" || path === "/tmsg/delete") && req.method === "POST") return await tmsgPost(req, env, ctx, path === "/tmsg/delete");
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
      // нет привязки STATS в Cloudflare (Settings → Bindings) — говорим об этом прямо
      if (path.startsWith("/cal/") && req.method === "GET") return await calFeed(env, path, new URL(req.url).searchParams.get("l"));
      if ((["/ping", "/stats", "/report", "/reports", "/reports/delete", "/pal", "/crowd"].includes(path) || path.startsWith("/pal/")) && !env.STATS) return json({ error: "no_stats_binding" }, 500);
      if (path === "/pal" && req.method === "POST") return await palSave(req, env);
      if (path === "/pal/delete" && req.method === "POST") return await palDelete(req, env);
      if (path === "/pal/link" && req.method === "POST") return await palLink(req, env);
      if (path === "/pal/inbox" && req.method === "POST") return await palInbox(req, env);
      if (path === "/pal/unlink" && req.method === "POST") return await palUnlink(req, env);
      if (path.startsWith("/pal/") && req.method === "GET") return await palGet(req, env, path.slice(5));
      if (path === "/crowd" && req.method === "GET") return json(await statsObj(env).crowd(israelDate(0)));
      if ((path === "/chat" || path === "/chat/get" || path.startsWith("/chats")) && !env.STATS) return json({ error: "no_stats_binding" }, 500);
      if (path === "/chat" && req.method === "POST") return await chatPost(req, env);
      if (path === "/chat/get" && req.method === "POST") return await chatGet(req, env);
      if (path === "/chats" || path.startsWith("/chats/")) {
        const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
        if (auth.status !== 200) return json(auth.body, auth.status);
        if (path === "/chats") return json({ threads: await statsObj(env).chatList() });
        if (req.method !== "POST") return json({ error: "not_found" }, 404);
        const b = await req.json().catch(() => ({}));
        const id = +b.id || 0;
        if (path === "/chats/open") return json(await statsObj(env).chatOpen(id));
        if (path === "/chats/delete") return json(await statsObj(env).chatDelete(id));
        if (path === "/chats/reply") {
          const text = String(b.text || "").trim().slice(0, 1000);
          if (!text) return json({ error: "too_short" }, 400);
          return json(await statsObj(env).chatReply(id, text, new Date().toISOString()));
        }
      }
      if (path === "/report" && req.method === "POST") return await report(req, env);
      if (path === "/reports" || path === "/reports/delete") {
        const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
        if (auth.status !== 200) return json(auth.body, auth.status);
        if (path === "/reports") return json({ reports: await statsObj(env).reports() });
        if (req.method === "POST") { const b = await req.json().catch(() => ({})); return json(await statsObj(env).delReport(+b.id || 0)); }
      }
      if (path === "/ping" && req.method === "POST") return await ping(req, env);
      if (path === "/stats") {
        const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
        if (auth.status !== 200) return json(auth.body, auth.status);
        return json(await statsObj(env).summary(israelDate(0)));
      }
      if (path === "/shahaf") return json((await env.DB.get("shahaf:last", "json")) || { status: "never" });
      if (path === "/shahaf/events") return json((await env.DB.get("shahaf:events", "json")) || { status: "never" });
      if (path === "/shahaf/run" && req.method === "POST") {
        const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
        if (auth.status !== 200) return json(auth.body, auth.status);
        // ?only=changes|exams|events — одна вкладка (быстрее, укладывается в лимит процессора)
        const only = new URL(req.url).searchParams.get("only");
        const opt = ["changes", "exams", "events"].includes(only) ? { [only]: true } : { changes: true, exams: true, events: true };
        return json(await syncShahaf(env, ctx, opt));
      }
      // проверка без кода: какие привязки подключены в Cloudflare
      if (path === "/") return json({ ok: true, app: "skedy", db: !!env.DB, limiter: !!env.LIMITER, stats: !!env.STATS, pushq: !!env.PUSHQ });
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
  // сайт кодирует код в заголовке (encodeURIComponent): браузеры не пускают в заголовки
  // буквы не латиницей (иврит, кириллица) — проверяем и как есть, и раскодированным
  const cands = [];
  if (typeof code === "string" && code.length > 0) {
    cands.push(code);
    try { const d = decodeURIComponent(code); if (d !== code) cands.push(d); } catch (e) {}
  }
  const ok = cands.some((c) => safeEqual(c, env.EDITOR_CODE));
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

/* ---------------- расписание всей школы (Skedy Admin) ---------------- */
// Ключ KV "tt": {updatedAt, cls:[{k,he,g,n}], s:[предметы], r:[кабинеты], t:[учителя],
//   l:[[день 0–4, урок, s, r, t, [ключи классов]]], ok:[ключи проблем «это нормально»], q:[нормы часов], th:{учитель: часов по договору}} — один урок у нескольких классов хранится один раз.
// Перед сохранением прошлая версия копируется в "ttbak:<время>" (последние 5).
// Каждое сохранение — 2–3 записи KV (бесплатно 1000 в день), поэтому сайт сохраняет пачкой, по кнопке.
const TT_MAX_BYTES = 2e6, TT_KEEP = 5;
function validTT(tt) {
  if (!tt || !Array.isArray(tt.cls) || !Array.isArray(tt.l) || tt.l.length > 20000) return false;
  const strs = (a) => Array.isArray(a) && a.length < 5000 && a.every((x) => typeof x === "string" && x.length <= 200);
  if (!strs(tt.s) || !strs(tt.r) || !strs(tt.t) || tt.cls.length > 500) return false;
  // ok — проблемы (учитель/кабинет заняты дважды), отмеченные в /admin/ как «это нормально»
  if (tt.ok != null && !(Array.isArray(tt.ok) && tt.ok.length <= 3000 && tt.ok.every((x) => typeof x === "string" && x.length <= 300))) return false;
  const keys = new Set();
  for (const c of tt.cls) {
    if (!c || typeof c.k !== "string" || !/^\d{1,2}-\d{1,2}$/.test(c.k) || typeof c.he !== "string") return false;
    keys.add(c.k);
  }
  const idx = (i, a) => Number.isInteger(i) && i >= 0 && i < a.length;
  // q — нормы часов (תקן): {id, s: предмет, t: учитель или "", c: [классы], h: часов в неделю 0–40,
  //   n?: примечание/уровень («שאלון E», «571»), r?: кабинет группы, k?: число учеников (только число),
  //   gn?: название группы («הקבצה א׳»), b?: אשכול — блок параллельных групп («אשכול ב׳»)}
  // th — часы учителей по договору (Новый год): {имя: часов в неделю 0–60}
  if (tt.th != null && !(tt.th && typeof tt.th === "object" && !Array.isArray(tt.th) && Object.keys(tt.th).length <= 3000 &&
    Object.keys(tt.th).every((k) => k.length > 0 && k.length <= 200 && Number.isInteger(tt.th[k]) && tt.th[k] >= 0 && tt.th[k] <= 60))) return false;
  if (tt.q != null && !(Array.isArray(tt.q) && tt.q.length <= 5000 && tt.q.every((q) => q && typeof q.id === "string" && q.id && q.id.length <= 40 &&
    typeof q.s === "string" && q.s && q.s.length <= 200 && typeof q.t === "string" && q.t.length <= 200 && Number.isInteger(q.h) && q.h >= 0 && q.h <= 40 &&
    (q.n == null || (typeof q.n === "string" && q.n.length <= 100)) && (q.r == null || (typeof q.r === "string" && q.r.length <= 200)) &&
    (q.k == null || (Number.isInteger(q.k) && q.k >= 0 && q.k <= 300)) &&
    (q.gn == null || (typeof q.gn === "string" && q.gn.length <= 100)) && (q.b == null || (typeof q.b === "string" && q.b.length <= 100)) &&
    Array.isArray(q.c) && q.c.length > 0 && q.c.length <= 100 && q.c.every((k) => keys.has(k))))) return false;
  if (tt.co != null && !validCo(tt.co, keys)) return false;
  if (tt.ro != null && !validRo(tt.ro, keys)) return false;
  return tt.l.every((x) => Array.isArray(x) && x.length === 6 && Number.isInteger(x[0]) && x[0] >= 0 && x[0] <= 4 &&
    Number.isInteger(x[1]) && x[1] >= 0 && x[1] <= 15 && idx(x[2], tt.s) && idx(x[3], tt.r) && idx(x[4], tt.t) &&
    Array.isArray(x[5]) && x[5].length > 0 && x[5].length <= 100 && x[5].every((k) => keys.has(k)));
}
// ro — роли учителей: {id, t: учитель, k: "hr" — מחנך/ת (классы c) | "gc" — רכז/ת שכבה (параллели g) |
//   "sc" — רכז/ת מקצוע (предмет s) | "team" — צוות (предмет s) | "x" — другое (название n), c?, g?, s?, n?}
const RO_KINDS = ["hr", "gc", "sc", "team", "x"];
function validRo(ro, keys) {
  if (!Array.isArray(ro) || ro.length > 3000) return false;
  const str = (x, n) => x == null || (typeof x === "string" && x.length <= n);
  return ro.every((o) => o && typeof o.id === "string" && o.id && o.id.length <= 40 && typeof o.t === "string" && o.t && o.t.length <= 200 &&
    RO_KINDS.includes(o.k) && str(o.s, 200) && str(o.n, 100) &&
    (o.c == null || (Array.isArray(o.c) && o.c.length <= 100 && o.c.every((k) => keys.has(k)))) &&
    (o.g == null || (Array.isArray(o.g) && o.g.length <= 6 && o.g.every((g) => Number.isInteger(g) && g >= 7 && g <= 12))) &&
    (o.k !== "hr" || (o.c && o.c.length)) && (o.k !== "gc" || (o.g && o.g.length)) && ((o.k !== "sc" && o.k !== "team") || o.s) && (o.k !== "x" || o.n));
}
// co — ограничения (אילוצים) для робота и проверок в /admin/, «Новый год»:
//   {id, type: "t" — учитель не может (t, d:[дни 0–4], from?/to? — уроки, иначе весь день),
//              "late" — не позже урока p (кому: c:[классы] и/или g:[параллели 7–12], s? — предмет; без c и g — вся школа),
//              "dbl" — уроки предмета s парами (два урока подряд), c? — только у этих классов,
//    n? — примечание}
const CO_TYPES = ["t", "late", "dbl"];
const CO_KEYS = ["id", "type", "t", "s", "c", "g", "d", "from", "to", "p", "n"];
function validCo(co, keys) {
  if (!Array.isArray(co) || co.length > 500) return false;
  const str = (x, n) => typeof x === "string" && x.length > 0 && x.length <= n;
  const ints = (a, lo, hi, max) => Array.isArray(a) && a.length > 0 && a.length <= max && a.every((x) => Number.isInteger(x) && x >= lo && x <= hi);
  const per = (x) => Number.isInteger(x) && x >= 0 && x <= 15;
  return co.every((o) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => CO_KEYS.includes(k)) &&
    str(o.id, 40) && CO_TYPES.includes(o.type) &&
    (o.t == null || str(o.t, 200)) && (o.s == null || str(o.s, 200)) && (o.n == null || (typeof o.n === "string" && o.n.length <= 100)) &&
    (o.c == null || (Array.isArray(o.c) && o.c.length > 0 && o.c.length <= 100 && o.c.every((k) => keys.has(k)))) &&
    (o.g == null || ints(o.g, 7, 12, 6)) && (o.d == null || ints(o.d, 0, 4, 5)) &&
    (o.from == null || per(o.from)) && (o.to == null || per(o.to)) && (o.p == null || per(o.p)) &&
    (o.from == null || o.to == null || o.from <= o.to) &&
    (o.type !== "t" || (o.t && o.d)) && (o.type !== "late" || o.p != null) && (o.type !== "dbl" || o.s));
}
async function saveTT(req, env) {
  const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
  if (auth.status !== 200) return json(auth.body, auth.status);
  const text = await req.text();
  if (text.length > TT_MAX_BYTES) return json({ error: "too_big" }, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: "bad_data" }, 400); }
  const tt = body && body.tt;
  if (!validTT(tt)) return json({ error: "bad_data" }, 400);
  const prevRaw = await env.DB.get("tt");
  const prevAt = prevRaw ? JSON.parse(prevRaw).updatedAt : null;
  // кто-то другой успел сохранить раньше (base — версия, с которой начинал этот редактор)
  if (prevRaw && (body.base || null) !== prevAt) return json({ error: "conflict", updatedAt: prevAt }, 409);
  const out = { updatedAt: new Date().toISOString(), cls: tt.cls.map((c) => ({ k: c.k, he: c.he, g: +c.g || 0, n: +c.n || 0 })), s: tt.s, r: tt.r, t: tt.t, l: tt.l, ok: tt.ok || [],
    q: (tt.q || []).map((q) => { const o = { id: q.id, s: q.s, t: q.t, c: q.c, h: q.h }; if (q.n) o.n = q.n; if (q.r) o.r = q.r; if (q.k != null) o.k = q.k; if (q.gn) o.gn = q.gn; if (q.b) o.b = q.b; return o; }), th: tt.th || {},
    co: (tt.co || []).map((o) => { const x = {}; for (const k of CO_KEYS) if (o[k] != null) x[k] = o[k]; return x; }),
    ro: (tt.ro || []).map((o) => { const x = { id: o.id, t: o.t, k: o.k }; for (const f of ["c", "g", "s", "n"]) if (o[f] != null && o[f].length) x[f] = o[f]; return x; }) };
  if (prevRaw) await ttBackup(env, prevRaw, prevAt);
  await env.DB.put("tt", JSON.stringify(out));
  return json({ ok: true, updatedAt: out.updatedAt, lessons: out.l.length });
}
// копия версии в "ttbak:<её updatedAt>", хранятся последние TT_KEEP
async function ttBackup(env, raw, at) {
  await env.DB.put("ttbak:" + at, raw);
  const page = await env.DB.list({ prefix: "ttbak:" });
  const names = page.keys.map((k) => k.name).sort();
  for (const old of names.slice(0, Math.max(0, names.length - TT_KEEP))) await env.DB.delete(old);
}
async function ttBackups(env) {
  const page = await env.DB.list({ prefix: "ttbak:" });
  return page.keys.map((k) => ({ id: k.name, at: k.name.slice(6) })).sort((a, b) => b.at.localeCompare(a.at));
}
// восстановить прошлую версию: текущая сначала уходит в копии, так что восстановление тоже можно отменить
async function ttRestore(env, id) {
  if (typeof id !== "string" || !id.startsWith("ttbak:")) return json({ error: "bad_id" }, 400);
  const raw = await env.DB.get(id);
  if (!raw) return json({ error: "not_found" }, 404);
  const curRaw = await env.DB.get("tt");
  if (curRaw) await ttBackup(env, curRaw, JSON.parse(curRaw).updatedAt);
  const tt = JSON.parse(raw);
  tt.updatedAt = new Date().toISOString();
  await env.DB.put("tt", JSON.stringify(tt));
  return json({ ok: true, updatedAt: tt.updatedAt });
}

/* ---------------- изменения на даты для всей школы (Skedy Admin) ---------------- */
// Ключ KV "ttch": {updatedAt, ch:[{id, date, p, s, t, c:[классы], type: cancel|room|test|sub, room?, sub?, note?}], off:[дни без учёбы],
//   pm:[родительские собрания]}.
// sub — замена: урок ведёт другой учитель (имя в sub; room — если и кабинет другой).
// Урок узнаём по дню (из даты), номеру урока, предмету, учителю и классам — так же, как в /tt.
// Старше 30 дней — выбрасываются. Новые и изменённые на сегодня и дальше — уведомления учителям этих уроков
// (у учеников Skedy свои изменения в "state", им эти не отправляются: aud.type "tt").
const CH_TYPES = ["cancel", "room", "test", "sub"];
// настоящая дата «ГГГГ-ММ-ДД» (не «2026-13-01»)
function isDate(x) {
  if (typeof x !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  const d = new Date(x + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === x;
}
function validCh(ch) {
  if (!Array.isArray(ch) || ch.length > 5000) return false;
  const str = (x, n) => typeof x === "string" && x.length <= n;
  return ch.every((c) => c && str(c.id, 40) && c.id && isDate(c.date) && Number.isInteger(c.p) && c.p >= 0 && c.p <= 15 &&
    str(c.s, 200) && c.s && str(c.t || "", 200) && CH_TYPES.includes(c.type) && str(c.room || "", 200) && str(c.note || "", 200) &&
    (c.type !== "room" || c.room) && (c.type !== "sub" || (str(c.sub, 200) && c.sub && c.sub !== c.t)) && Array.isArray(c.c) && c.c.length <= 100 && c.c.every((k) => typeof k === "string" && /^\d{1,2}-\d{1,2}$/.test(k)));
}
// дни без учёбы: {id, date, to?, text, g:[параллели 7–12; пусто — вся школа]}
function validOff(off) {
  if (!Array.isArray(off) || off.length > 500) return false;
  const d = isDate;
  return off.every((o) => o && typeof o.id === "string" && o.id && o.id.length <= 40 && d(o.date) && (o.to == null || (d(o.to) && o.to >= o.date)) &&
    typeof o.text === "string" && o.text.length <= 200 && Array.isArray(o.g) && o.g.length <= 6 && o.g.every((g) => Number.isInteger(g) && g >= 7 && g <= 12));
}
// родительские собрания (Skedy Parents): {id, date, from "ЧЧ:ММ", to?, title?, g:[параллели], c:[классы «10-2»], t?, room?, note?};
// g и c пустые — вся школа
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
function validPm(pm) {
  if (!Array.isArray(pm) || pm.length > 500) return false;
  const str = (x, n) => x == null || (typeof x === "string" && x.length <= n);
  return pm.every((o) => o && typeof o.id === "string" && o.id && o.id.length <= 40 && isDate(o.date) && typeof o.from === "string" && HM.test(o.from) &&
    (o.to == null || o.to === "" || (typeof o.to === "string" && HM.test(o.to) && o.to > o.from)) && str(o.title, 100) && str(o.t, 100) && str(o.room, 100) && str(o.note, 200) &&
    Array.isArray(o.g) && o.g.length <= 6 && o.g.every((g) => Number.isInteger(g) && g >= 7 && g <= 12) &&
    Array.isArray(o.c) && o.c.length <= 100 && o.c.every((k) => typeof k === "string" && /^\d{1,2}-\d{1,2}$/.test(k)) &&
    // slot — личные встречи: минут на встречу, нужны учитель и время до
    (o.slot == null || (Number.isInteger(o.slot) && o.slot >= 5 && o.slot <= 60 && !!o.t && !!o.to)));
}
// разрешения родителей (אישור הורים): {id, date, title, g:[параллели], c:[классы], due?: «ответить до», note?}
function validAp(ap) {
  if (!Array.isArray(ap) || ap.length > 300) return false;
  const str = (x, n) => x == null || (typeof x === "string" && x.length <= n);
  return ap.every((o) => o && typeof o.id === "string" && o.id && o.id.length <= 40 && isDate(o.date) && typeof o.title === "string" && o.title.trim() && o.title.length <= 100 &&
    (o.due == null || o.due === "" || (isDate(o.due) && o.due <= o.date)) && str(o.note, 200) &&
    Array.isArray(o.g) && o.g.length <= 6 && o.g.every((g) => Number.isInteger(g) && g >= 7 && g <= 12) &&
    Array.isArray(o.c) && o.c.length <= 100 && o.c.every((k) => typeof k === "string" && /^\d{1,2}-\d{1,2}$/.test(k)));
}
function apSig(o) { return [o.date, o.title, o.g.join(","), o.c.join(","), o.due || "", o.note || ""].join("|"); }
function pmSig(o) {
  return [o.date, o.from, o.to || "", o.title || "", o.g.join(","), o.c.join(","), o.t || "", o.room || "", o.note || "", o.slot || ""].join("|");
}
function chSig(c) {
  return [c.date, c.p, c.s, c.t || "", c.c.join(","), c.type, c.room || "", c.note || "", c.sub || ""].join("|");
}
async function saveTTCh(req, env, ctx) {
  const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
  if (auth.status !== 200) return json(auth.body, auth.status);
  const text = await req.text();
  if (text.length > TT_MAX_BYTES) return json({ error: "too_big" }, 413);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: "bad_data" }, 400); }
  if (!body || !validCh(body.ch) || (body.off != null && !validOff(body.off)) || (body.pm != null && !validPm(body.pm)) || (body.ap != null && !validAp(body.ap))) return json({ error: "bad_data" }, 400);
  const prevRaw = await env.DB.get("ttch");
  const prev = prevRaw ? JSON.parse(prevRaw) : { updatedAt: null, ch: [] };
  if ((body.base || null) !== (prev.updatedAt || null)) return json({ error: "conflict", updatedAt: prev.updatedAt }, 409);
  const oldest = israelDate(-30), today = israelDate(0);
  const ch = body.ch.filter((c) => c.date >= oldest).map((c) => {
    const o = { id: c.id, date: c.date, p: c.p, s: c.s, t: c.t || "", c: c.c, type: c.type };
    if (c.type === "room" || (c.type === "sub" && c.room)) o.room = c.room;
    if (c.type === "sub") o.sub = c.sub;
    if (c.note) o.note = c.note;
    return o;
  });
  const off = (body.off != null ? body.off : prev.off || []).filter((o) => (o.to || o.date) >= oldest)
    .map((o) => { const x = { id: o.id, date: o.date, text: o.text, g: o.g }; if (o.to && o.to !== o.date) x.to = o.to; return x; });
  // собрания: если не прислали — остаются прежние (старый сайт их не знает)
  const pm = (body.pm != null ? body.pm : prev.pm || []).filter((o) => o.date >= oldest).map((o) => {
    const x = { id: o.id, date: o.date, from: o.from, g: o.g, c: o.c };
    for (const f of ["to", "title", "t", "room", "note"]) if (o[f]) x[f] = String(o[f]).replace(/\s+/g, " ").trim();
    if (o.slot) x.slot = o.slot;
    return x;
  });
  const ap = (body.ap != null ? body.ap : prev.ap || []).filter((o) => o.date >= oldest).map((o) => {
    const x = { id: o.id, date: o.date, title: String(o.title).replace(/\s+/g, " ").trim(), g: o.g, c: o.c };
    if (o.due) x.due = o.due;
    if (o.note) x.note = String(o.note).replace(/\s+/g, " ").trim();
    return x;
  });
  const out = { updatedAt: new Date().toISOString(), ch, off, pm, ap };
  await env.DB.put("ttch", JSON.stringify(out));
  const old = new Map(prev.ch.map((c) => [c.id, chSig(c)]));
  const fresh = ch.filter((c) => c.date >= today && (c.t || c.sub) && old.get(c.id) !== chSig(c));
  // замена убрана или отдана другому учителю — прежнему заменяющему сообщаем, что её больше нет
  const now = new Map(ch.map((c) => [c.id, c]));
  const gone = prev.ch.filter((c) => c.type === "sub" && c.sub && c.date >= today &&
    (!now.has(c.id) || normName(now.get(c.id).type === "sub" ? now.get(c.id).sub : "") !== normName(c.sub)));
  if (fresh.length || gone.length) ctx.waitUntil(ttchNotify(env, fresh, gone));
  // новое или изменённое собрание на сегодня и дальше — уведомление родителям (Skedy Parents) детей из этих классов
  const oldPm = new Map((prev.pm || []).map((o) => [o.id, pmSig(o)]));
  const freshPm = pm.filter((o) => o.date >= today && oldPm.get(o.id) !== pmSig(o));
  if (freshPm.length) ctx.waitUntil(pmNotify(env, freshPm));
  // новое или изменённое разрешение — push родителям этих классов
  const oldAp = new Map((prev.ap || []).map((o) => [o.id, apSig(o)]));
  const freshAp = ap.filter((o) => o.date >= today && oldAp.get(o.id) !== apSig(o));
  if (freshAp.length) ctx.waitUntil(pmNotify(env, freshAp.map((o) => ({ ...o, from: "", ap: true }))));
  return json({ ok: true, updatedAt: out.updatedAt, changes: fresh.length });
}
// Урок י׳, который есть в Skedy (тот же день недели, номер урока и учитель), — уведомление как у изменений Skedy:
// и ученикам этого урока, и учителю. Остальные — только учителю (aud.type "tt").
// Замена (sub): заменяющий получает своё уведомление («Вы заменяете …»), прежний заменяющий — «замена отменена» (gone).
async function ttchNotify(env, fresh, gone = []) {
  const raw = await env.DB.get("state");
  const st = raw ? JSON.parse(raw) : null;
  const ds = [];
  const tt = (c, type, t, who) => ({ k: c.date + "|" + String(c.p).padStart(2, "0"), date: c.date, type, room: c.room || "", note: c.note || "",
    period: c.p, aud: { type: "tt" }, t: normName(t), name: { he: c.s, en: c.s, ru: c.s }, who: who || "", cls: clsLabel(c.c) });
  for (const c of fresh) {
    if (c.type === "sub") ds.push(tt(c, "subMe", c.sub, c.t));
    if (!c.t) continue;
    const les = st ? st.lessons.filter((l) => l.day === weekday(c.date) && l.period === c.p && normName(l.teacher) === normName(c.t)) : [];
    if (les.length) {
      for (const l of les) { const d = describe(st, { date: c.date, lessonId: l.id, type: c.type, room: c.room, note: c.note, sub: c.sub }); if (d) ds.push(d); }
      continue;
    }
    ds.push(tt(c, c.type, c.t, c.sub));
  }
  for (const c of gone) ds.push(tt(c, "subOff", c.sub, c.t));
  if (ds.length) await notifyAll(env, ds);
}
// ---------------- запись на личные встречи ----------------
// У собрания в ttch.pm есть slot (минут на встречу): время from–to режется на встречи. Родитель в Skedy Parents
// выбирает свободное время и пишет своё имя и имя ребёнка (на иврите) — это личные данные: хранятся в Stats
// (таблица pmb, SQLite — одно время нельзя занять дважды) и стираются на следующий день после собрания.
// Свободные времена видит каждый, имена — только по коду редактора или ключу учителя этого собрания
// (KV "pmkeys" = {id собрания: sha256 ключа}; ключ выдаёт Skedy Admin).
const HE_NAME = /^[\u05D0-\u05EA][\u05D0-\u05EA '"׳״-]{0,39}$/;
const PMB_MAX = 30, PMB_WINDOW_SEC = 3600, PMB_PER_DEVICE = 4;
function pmSlots(o) {
  if (!o || !o.slot || !o.to) return [];
  const m = (x) => +x.slice(0, 2) * 60 + +x.slice(3), hm = (x) => String(Math.floor(x / 60)).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0");
  const out = [];
  for (let x = m(o.from); x + o.slot <= m(o.to) && out.length < 200; x += o.slot) out.push(hm(x));
  return out;
}
function pmForClass(o, key) {
  const g = +key.split("-")[0];
  return (!o.g.length && !o.c.length) || o.g.includes(g) || o.c.includes(key);
}
async function pmMeeting(env, mid) {
  const t = await env.DB.get("ttch", "json");
  return (t && (t.pm || []).find((o) => o.id === mid)) || null;
}
// кто может видеть имена: редактор (X-Editor-Code) или учитель с ключом этого собрания (X-Pm-Key)
async function pmbCanSee(req, env, mid) {
  // личная ссылка учителя (X-T-Name + X-T-Key) — записи его собственных собраний
  if (req.headers.get("X-T-Key")) {
    const tn = await teacherAuth(req, env), o = tn && (await pmMeeting(env, mid));
    return !!o && normName(o.t) === tn;
  }
  const k = req.headers.get("X-Pm-Key");
  if (k) {
    let lim;
    try { lim = await limiter(env, "pmkey", req).hit(60, 3600); } catch (e) { return false; }
    if (!lim.ok) return false;
    const keys = (await env.DB.get("pmkeys", "json")) || {};
    return !!keys[mid] && safeEqual(await sha256(k), keys[mid]);
  }
  if (!req.headers.get("X-Editor-Code")) return false;
  return (await checkCode(req, env, req.headers.get("X-Editor-Code"))).status === 200;
}
async function pmbRoute(req, env, path) {
  if (!env.STATS) return json({ error: "no_stats_binding" }, 500);
  const db = statsObj(env), today = israelDate(0);
  // свободные времена собрания (без имён)
  if (req.method === "GET" && /^\/pmb\/[\w-]{1,40}$/.test(path)) {
    const mid = path.slice(5), o = await pmMeeting(env, mid);
    if (!o || !o.slot) return json({ error: "not_found" }, 404);
    return json({ slots: pmSlots(o), taken: await db.pmbTaken(mid, today) });
  }
  // записи с именами — учителю (ключ) и редактору
  if (req.method === "GET" && /^\/pmb\/list\/[\w-]{1,40}$/.test(path)) {
    const mid = path.slice(10);
    if (!(await pmbCanSee(req, env, mid))) return json({ error: "forbidden" }, 403);
    const o = await pmMeeting(env, mid);
    return json({ slots: pmSlots(o), b: await db.pmbList(mid, today) });
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.mid !== "string" || !/^[\w-]{1,40}$/.test(b.mid)) return json({ error: "bad_data" }, 400);
  // ключ учителя для собрания (новый ключ заменяет старый)
  if (path === "/pmb/key") {
    const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
    if (auth.status !== 200) return json(auth.body, auth.status);
    const key = b64u(crypto.getRandomValues(new Uint8Array(12)));
    const keys = (await env.DB.get("pmkeys", "json")) || {};
    keys[b.mid] = await sha256(key);
    const live = new Set((((await env.DB.get("ttch", "json")) || {}).pm || []).map((o) => o.id));
    for (const k of Object.keys(keys)) if (!live.has(k) && k !== b.mid) delete keys[k]; // ключи удалённых собраний
    await env.DB.put("pmkeys", JSON.stringify(keys));
    return json({ key });
  }
  // отменить: своё время (по секрету устройства) или любое — редактор
  if (path === "/pmb/cancel") {
    if (typeof b.at !== "string" || !HM.test(b.at)) return json({ error: "bad_data" }, 400);
    if (req.headers.get("X-Editor-Code")) {
      const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
      if (auth.status !== 200) return json(auth.body, auth.status);
      return json({ ok: await db.pmbCancel(b.mid, b.at, null) });
    }
    if (typeof b.tok !== "string" || !/^[0-9a-f]{32}$/.test(b.tok)) return json({ error: "bad_data" }, 400);
    return json({ ok: await db.pmbCancel(b.mid, b.at, await sha256(b.tok)) });
  }
  if (path !== "/pmb") return json({ error: "not_found" }, 404);
  let lim;
  try { lim = await limiter(env, "pmb", req).hit(PMB_MAX, PMB_WINDOW_SEC); } catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  const clean = (x) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const p = clean(b.p), k = clean(b.k);
  if (!HE_NAME.test(p) || !HE_NAME.test(k)) return json({ error: "bad_name" }, 400);
  if (typeof b.c !== "string" || !/^\d{1,2}-\d{1,2}$/.test(b.c) || typeof b.at !== "string" || !HM.test(b.at) ||
    typeof b.tok !== "string" || !/^[0-9a-f]{32}$/.test(b.tok)) return json({ error: "bad_data" }, 400);
  const o = await pmMeeting(env, b.mid);
  if (!o || !o.slot || o.date < today || !pmSlots(o).includes(b.at) || !pmForClass(o, b.c)) return json({ error: "not_found" }, 404);
  const r = await db.pmbBook(b.mid, b.at, o.date, p, k, b.c, await sha256(b.tok), today);
  return r.ok ? json({ ok: true }) : json({ error: r.error }, 409);
}
// ---------------- личные ссылки учителей и запросы родителей на разговор ----------------
// Личная ссылка учителя: Skedy Admin (POST /tkey {t}, код редактора) выдаёт ключ, в KV "tkeys" = {имя (normName): sha256 ключа}.
// Skedy Teachers шлёт X-T-Name (encodeURIComponent) и X-T-Key. По ней учитель видит записи своих личных встреч
// и запросы на разговор для классов, где он классный руководитель.
async function teacherAuth(req, env) {
  let name = req.headers.get("X-T-Name") || "", key = req.headers.get("X-T-Key") || "";
  try { name = decodeURIComponent(name); } catch (e) { return null; }
  name = normName(name);
  if (!name || !key || key.length > 60) return null;
  let lim;
  try { lim = await limiter(env, "tkey", req).hit(120, 3600); } catch (e) { return null; }
  if (!lim.ok) return null;
  const keys = (await env.DB.get("tkeys", "json")) || {};
  return keys[name] && safeEqual(await sha256(key), keys[name]) ? name : null;
}
// классные руководители по расписанию Skedy Admin (KV "tt"): ручные роли (ro, k "hr") главнее,
// иначе учитель урока «חינוך» класса — как roAll в /admin/. Возвращает {класс «10-2»: [имена normName]}.
const RO_HR = /^(חינוך|חינוך וחברה|שעת חינוך|שעת מחנך|מחנך|מחנכת)$/;
function homerooms(tt) {
  const out = {};
  if (!tt) return out;
  for (const o of tt.ro || []) if (o.k === "hr") for (const c of o.c || []) (out[c] = out[c] || []).push(normName(o.t));
  const man = new Set(Object.keys(out));
  for (const x of tt.l || []) {
    const sn = String(tt.s[x[2]] || "").trim(), tn = normName(tt.t[x[4]] || "");
    if (!tn || !RO_HR.test(sn) || x[5].length !== 1 || man.has(x[5][0])) continue;
    const a = out[x[5][0]] = out[x[5][0]] || [];
    if (!a.includes(tn)) a.push(tn);
  }
  return out;
}
const PREQ_MAX = 10, PREQ_WINDOW_SEC = 3600;
async function preqRoute(req, env, ctx, path) {
  if (!env.STATS) return json({ error: "no_stats_binding" }, 500);
  const db = statsObj(env), today = israelDate(0);
  const editor = async () => !!req.headers.get("X-Editor-Code") && (await checkCode(req, env, req.headers.get("X-Editor-Code"))).status === 200;
  // запросы: классному руководителю — его классов, редактору — все
  if (path === "/preq/list" && req.method === "GET") {
    if (req.headers.get("X-T-Key")) {
      const tn = await teacherAuth(req, env);
      if (!tn) return json({ error: "forbidden" }, 403);
      const hr = homerooms(await env.DB.get("tt", "json"));
      const mine = Object.keys(hr).filter((c) => hr[c].includes(tn));
      return json({ classes: mine, r: mine.length ? await db.preqList(mine, today) : [] });
    }
    if (!(await editor())) return json({ error: "forbidden" }, 403);
    const hr = homerooms(await env.DB.get("tt", "json"));
    return json({ r: (await db.preqList(null, today)).map((x) => ({ ...x, hr: hr[x.c] || [] })) });
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const b = await req.json().catch(() => null);
  if (!b) return json({ error: "bad_data" }, 400);
  // новая личная ссылка учителя (старая перестаёт работать)
  if (path === "/tkey") {
    const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
    if (auth.status !== 200) return json(auth.body, auth.status);
    const t = normName(b.t);
    if (!t || t.length > 200) return json({ error: "bad_data" }, 400);
    const key = b64u(crypto.getRandomValues(new Uint8Array(12)));
    const keys = (await env.DB.get("tkeys", "json")) || {};
    keys[t] = await sha256(key);
    await env.DB.put("tkeys", JSON.stringify(keys));
    return json({ key });
  }
  const tokOk = typeof b.tok === "string" && /^[0-9a-f]{32}$/.test(b.tok);
  // свои запросы родителя (по секрету устройства) — статус
  if (path === "/preq/mine") {
    if (!tokOk) return json({ error: "bad_data" }, 400);
    return json({ r: await db.preqMine(await sha256(b.tok), today) });
  }
  if (path === "/preq/cancel") {
    if (!tokOk || !Number.isInteger(b.id)) return json({ error: "bad_data" }, 400);
    return json({ ok: await db.preqDel(b.id, await sha256(b.tok), null) });
  }
  // классный руководитель (или редактор): «обработано» / вернуть / удалить
  if (path === "/preq/set") {
    if (!Number.isInteger(b.id) || !["new", "done", "del"].includes(b.st)) return json({ error: "bad_data" }, 400);
    let classes = null;
    if (req.headers.get("X-T-Key")) {
      const tn = await teacherAuth(req, env);
      if (!tn) return json({ error: "forbidden" }, 403);
      const hr = homerooms(await env.DB.get("tt", "json"));
      classes = Object.keys(hr).filter((c) => hr[c].includes(tn));
    } else if (!(await editor())) return json({ error: "forbidden" }, 403);
    return json({ ok: b.st === "del" ? await db.preqDel(b.id, null, classes) : await db.preqSet(b.id, b.st, classes) });
  }
  if (path !== "/preq") return json({ error: "not_found" }, 404);
  let lim;
  try { lim = await limiter(env, "preq", req).hit(PREQ_MAX, PREQ_WINDOW_SEC); } catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  const clean = (x) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const pn = clean(b.p), kn = clean(b.k), t = clean(b.t), topic = clean(b.topic).slice(0, 150);
  if (!HE_NAME.test(pn) || !HE_NAME.test(kn)) return json({ error: "bad_name" }, 400);
  if (!tokOk || !t || t.length > 200 || typeof b.c !== "string" || !/^\d{1,2}-\d{1,2}$/.test(b.c) || !isDate(b.date) ||
    b.date < today || b.date > israelDate(45) || !Number.isInteger(b.per) || b.per < 0 || b.per > 15) return json({ error: "bad_data" }, 400);
  const r = await db.preqAdd({ c: b.c, t, date: b.date, per: b.per, pn, kn, topic, tok: await sha256(b.tok), at: new Date().toISOString() }, today);
  if (r.error) return json(r, 409);
  // push классному руководителю (подписка Skedy Teachers на его имя)
  const hr = homerooms(await env.DB.get("tt", "json"))[b.c] || [];
  if (hr.length) {
    const cls = clsLabel([b.c]);
    ctx.waitUntil(notifyAll(env, hr.map((h) => ({ k: b.date + "|00|pr", date: b.date, type: "pr", period: b.per, aud: { type: "pr" }, t: h, cids: [],
      name: { he: t, en: t, ru: t }, room: "", note: topic, who: kn + " · " + cls }))));
  }
  return json({ ok: true, id: r.id, hr: hr.length > 0 });
}
// ---------------- разрешения родителей (ttch.ap) ----------------
// Ответ: POST /apr {aid, ans: yes|no, p, k, c, tok} — имена на иврите, класс должен подходить, «ответить до» не прошло.
// Хранится в Stats (таблица apr, один ответ на ребёнка с устройства — можно поменять), стирается на следующий день после события.
// GET /apr/list — с именами: редактору все, классному руководителю (личная ссылка) — его классы.
async function aprRoute(req, env, path) {
  if (!env.STATS) return json({ error: "no_stats_binding" }, 500);
  const db = statsObj(env), today = israelDate(0);
  if (path === "/apr/list" && req.method === "GET") {
    let classes = null;
    if (req.headers.get("X-T-Key")) {
      const tn = await teacherAuth(req, env);
      if (!tn) return json({ error: "forbidden" }, 403);
      const hr = homerooms(await env.DB.get("tt", "json"));
      classes = Object.keys(hr).filter((c) => hr[c].includes(tn));
    } else if (!req.headers.get("X-Editor-Code") || (await checkCode(req, env, req.headers.get("X-Editor-Code"))).status !== 200) return json({ error: "forbidden" }, 403);
    return json({ classes, r: await db.aprList(classes, today) });
  }
  if (req.method !== "POST") return json({ error: "not_found" }, 404);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.tok !== "string" || !/^[0-9a-f]{32}$/.test(b.tok)) return json({ error: "bad_data" }, 400);
  if (path === "/apr/mine") return json({ r: await db.aprMine(await sha256(b.tok), today) });
  if (path !== "/apr") return json({ error: "not_found" }, 404);
  let lim;
  try { lim = await limiter(env, "apr", req).hit(PMB_MAX, PMB_WINDOW_SEC); } catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  const clean = (x) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const pn = clean(b.p), kn = clean(b.k);
  if (!HE_NAME.test(pn) || !HE_NAME.test(kn)) return json({ error: "bad_name" }, 400);
  if (typeof b.aid !== "string" || !/^[\w-]{1,40}$/.test(b.aid) || !["yes", "no"].includes(b.ans) || typeof b.c !== "string" || !/^\d{1,2}-\d{1,2}$/.test(b.c)) return json({ error: "bad_data" }, 400);
  const t = await env.DB.get("ttch", "json"), o = t && (t.ap || []).find((x) => x.id === b.aid);
  if (!o || o.date < today || !pmForClass(o, b.c)) return json({ error: "not_found" }, 404);
  if (o.due && o.due < today) return json({ error: "late" }, 409);
  if (!(await db.aprSet(b.aid, await sha256(b.tok), kn, pn, b.c, b.ans, o.date, new Date().toISOString(), today))) return json({ error: "too_many" }, 429);
  return json({ ok: true });
}
// собрание → классы Skedy (id), к которым оно относится: уведомление только родителям детей из них
const LETTER_GRADE = { "ז": 7, "ח": 8, "ט": 9, "י": 10, "יא": 11, "י״א": 11, "יב": 12, "י״ב": 12 };
async function pmNotify(env, list) {
  const raw = await env.DB.get("state");
  const st = raw ? JSON.parse(raw) : null;
  if (!st) return;
  const ds = [];
  for (const o of list) {
    const cids = st.classes.filter((cl) => {
      const g = LETTER_GRADE[cl.letter];
      return (!o.g.length && !o.c.length) || o.g.includes(g) || o.c.includes(g + "-" + cl.num);
    }).map((cl) => cl.id);
    const ttl = o.title || "";
    // разрешение: только родителям, тип "ap", «ответить до» — в note
    if (o.ap) { if (cids.length) ds.push({ k: o.date + "|00|ap", date: o.date, type: "ap", period: 0, aud: { type: "pm" }, cids, time: "", name: { he: ttl, en: ttl, ru: ttl }, room: "", note: "", who: "", due: o.due || "" }); continue; }
    const base = { k: o.date + "|00|" + o.from, date: o.date, type: "pm", period: 0, aud: { type: "pm" }, time: o.from + (o.to ? "–" + o.to : ""),
      name: { he: ttl, en: ttl, ru: ttl }, room: o.room || "", note: o.note || "" };
    // родителям детей из этих классов (пока только י׳ — классы Skedy)
    if (cids.length) ds.push({ ...base, cids, who: o.t || "" });
    // учителю собрания (Skedy Teachers): вместо имени учителя — для кого собрание
    if (o.t) ds.push({ ...base, cids: [], t: normName(o.t),
      who: [...o.g.map((g) => "שכבת " + (GRADE_HE[g] || g)), clsLabel(o.c)].filter(Boolean).join(", ") || "כל בית הספר" });
  }
  if (ds.length) await notifyAll(env, ds);
}
// классы урока для текста уведомления: «10-2» → «י׳2»; больше трёх классов одной параллели — «שכבת י׳»
const GRADE_HE = { 7: "ז׳", 8: "ח׳", 9: "ט׳", 10: "י׳", 11: "י״א", 12: "י״ב" };
function clsLabel(cs) {
  const by = {};
  for (const k of cs || []) { const [g, n] = k.split("-"); (by[g] = by[g] || []).push(+n); }
  return Object.keys(by).sort((a, b) => a - b).map((g) => by[g].length > 3 ? "שכבת " + (GRADE_HE[g] || g)
    : by[g].sort((a, b) => a - b).map((n) => (GRADE_HE[g] || g) + n).join(", ")).join(", ");
}

/* ---------------- помощник Skedy Admin (Claude API) ---------------- */
// Админ пишет обычным текстом («завтра אורן הילית болеет»), Claude отвечает вызовами инструментов —
// это только предложения: сайт показывает их, админ добавляет в черновик и сам нажимает «Сохранить».
// Сервер ничего не меняет. Отправляется: текст админа, сегодняшняя дата и списки учителей, классов,
// кабинетов, предметов и уроков (без данных учеников). Лимит — AI_MAX запросов в час с одного адреса.
const AI_MAX = 60, AI_WINDOW_SEC = 3600, AI_MODEL = "claude-opus-5-5";
// бесплатно: Workers AI (10 000 «нейронов» в день на бесплатном тарифе; кончились — ошибка до завтра, без счёта)
const WAI_MODEL = "@cf/zai-org/glm-4.7-flash";
const nul = (t) => ({ anyOf: [t, { type: "null" }] });
const STR = { type: "string" }, INT = { type: "integer" }, DATE = { type: "string", format: "date" };
const WHO = (types) => ({ who_type: { type: "string", enum: types }, who: { type: "string", description: "Exact teacher name, class name (e.g. י״א2) or grade number (7-12) from the lists" } });
function aiTool(name, description, props) {
  return { name, description, strict: true, input_schema: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false } };
}
const AI_TOOLS = [
  aiTool("cancel_lessons", "Cancel lessons on a date: all lessons of a teacher (teacher is absent), of a class, or of a whole grade, in a period range.",
    { date: DATE, ...WHO(["teacher", "class", "grade"]), from_period: INT, to_period: INT, note: nul(STR) }),
  aiTool("room_change", "Move a teacher's or class's lesson on a date to another room.",
    { date: DATE, period: INT, ...WHO(["teacher", "class"]), room: STR, note: nul(STR) }),
  aiTool("add_test", "Mark a test (מבחן) on a date for lessons of a teacher or class in a period range, optionally only of one subject.",
    { date: DATE, ...WHO(["teacher", "class"]), from_period: INT, to_period: INT, subject: nul(STR), note: nul(STR) }),
  aiTool("clear_changes", "Remove cancellations, room changes and tests on a date (undo), for a teacher, class or grade in a period range.",
    { date: DATE, ...WHO(["teacher", "class", "grade"]), from_period: INT, to_period: INT }),
  aiTool("move_lesson", "Permanently move a lesson in the regular weekly timetable (every week), e.g. from Tuesday period 3 to Wednesday period 5. Days: 0=Sunday … 4=Thursday.",
    { ...WHO(["teacher", "class"]), subject: nul(STR), from_day: INT, from_period: INT, to_day: INT, to_period: INT }),
  aiTool("add_day_off", "Add a day (or days) without school: holiday, trip, exam day. grades empty = whole school.",
    { date: DATE, to: nul(DATE), text: STR, grades: { type: "array", items: INT } }),
  aiTool("message_teachers", "Prepare a short message to all teachers (the admin reviews and sends it).", { text: STR }),
];
const AI_RULES = [
  "You help the timetable editor of a school (Israel, school days Sunday–Thursday) inside Skedy Admin.",
  "The editor writes a request, usually in Hebrew, sometimes in Russian or English. Turn it into tool calls, one call per change; several calls are fine.",
  "Use only exact names from the lists below (teachers, classes, rooms, subjects). If a name in the request is close to one in the list, use the list one. If you cannot tell which one is meant, do not guess: ask a short question instead of calling a tool.",
  "Dates: use the calendar in the request. \"Tomorrow\" after Thursday means Sunday. Periods are numbers 1–N from the periods list; \"the whole day\" means from period 1 to the last period.",
  "Your tool calls are only suggestions: the editor reviews them and saves. Never claim that something was already changed.",
  "After the tool calls, write one short sentence in the editor's language saying what you prepared. If the request is not about the timetable, say briefly that you can only help with the timetable.",
].join("\n");
async function aiAsk(req, env) {
  const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
  if (auth.status !== 200) return json(auth.body, auth.status);
  if (!env.ANTHROPIC_API_KEY && !env.AI) return json({ error: "no_ai_key" }, 503);
  let lim;
  try { lim = await limiter(env, "ai", req).hit(AI_MAX, AI_WINDOW_SEC); } catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "limit", retryAfter: lim.retryAfter }, 429);
  const text = await req.text();
  if (text.length > 300000) return json({ error: "too_big" }, 413);
  let b;
  try { b = JSON.parse(text); } catch (e) { return json({ error: "bad_data" }, 400); }
  const ask = typeof b.text === "string" ? b.text.trim() : "";
  const ctx = b.ctx || {};
  const list = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === "string" && v.length <= 200).slice(0, 3000) : []);
  if (!ask || ask.length > 1000 || !isDate(b.today)) return json({ error: "bad_data" }, 400);
  // списки — в system и в кэше (одинаковы от запроса к запросу); дата и текст — в сообщении
  const lists = "Teachers:\n" + list(ctx.teachers).join("\n") + "\n\nClasses:\n" + list(ctx.classes).join("\n") +
    "\n\nRooms:\n" + list(ctx.rooms).join("\n") + "\n\nSubjects:\n" + list(ctx.subjects).join("\n") +
    "\n\nPeriods:\n" + list(ctx.periods).join("\n");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], cal = [];
  for (let i = 0; i < 21; i++) { const d = new Date(Date.parse(b.today + "T12:00:00Z") + i * 864e5); cal.push(d.toISOString().slice(0, 10) + " " + days[d.getUTCDay()]); }
  const userText = "Today: " + cal[0] + "\nCalendar:\n" + cal.join("\n") + "\n\nRequest:\n" + ask;
  if (!env.ANTHROPIC_API_KEY) return await aiWorkers(env, lists, userText);
  const body = {
    model: AI_MODEL, max_tokens: 16000,
    output_config: { effort: "medium" },
    fallbacks: "default", // если модель откажется по правилам безопасности — ответит запасная (beta server-side-fallback)
    system: [{ type: "text", text: AI_RULES }, { type: "text", text: lists, cache_control: { type: "ephemeral" } }],
    tools: AI_TOOLS, tool_choice: { type: "auto" },
    messages: [{ role: "user", content: userText }],
  };
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01" },
      body: JSON.stringify(body),
    });
  } catch (e) { return json({ error: "ai_unreachable" }, 502); }
  const out = await r.json().catch(() => null);
  if (!r.ok || !out) return json({ error: "ai_error", status: r.status, type: out && out.error && out.error.type }, 502);
  if (out.stop_reason === "refusal") return json({ error: "refusal" }, 200);
  const blocks = Array.isArray(out.content) ? out.content : [];
  return json({
    text: blocks.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim(),
    actions: blocks.filter((x) => x.type === "tool_use").map((x) => ({ name: x.name, input: x.input })),
    stop: out.stop_reason, model: out.model,
  });
}

// Workers AI: те же правила и инструменты в формате «chat completions»; ответ разбираем осторожно —
// вызовы бывают в choices[0].message.tool_calls (arguments — строка JSON) или в tool_calls (arguments — объект).
async function aiWorkers(env, lists, userText) {
  const tools = AI_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  let r;
  try {
    r = await env.AI.run(WAI_MODEL, {
      messages: [{ role: "system", content: AI_RULES + "\n\n" + lists }, { role: "user", content: userText }],
      tools, tool_choice: "auto", max_completion_tokens: 4096, temperature: 0.2,
    });
  } catch (e) {
    const m = String((e && e.message) || e);
    return json({ error: /neuron|4006|daily|quota|allocation/i.test(m) ? "ai_quota" : "ai_error", message: m.slice(0, 200) }, /neuron|4006|daily|quota|allocation/i.test(m) ? 429 : 502);
  }
  const msg = (r && r.choices && r.choices[0] && r.choices[0].message) || {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : Array.isArray(r && r.tool_calls) ? r.tool_calls : [];
  const names = new Set(AI_TOOLS.map((t) => t.name));
  const actions = calls.map((c) => {
    const f = c.function || c;
    let a = f.arguments;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch (e) { a = null; } }
    return { name: f.name, input: a };
  }).filter((x) => names.has(x.name) && x.input && typeof x.input === "object");
  const text = typeof msg.content === "string" ? msg.content : typeof (r && r.response) === "string" ? r.response : "";
  return json({ text: text.trim(), actions, model: WAI_MODEL });
}

/* ---------------- сообщения всем учителям (Skedy Admin) ---------------- */
// Ключ KV "tmsg": {msgs:[{id, at, text}]} — последние 20, не старше 30 дней. Новое сообщение — push всем
// подписчикам-учителям (rec.t) через очередь. Сообщения видит каждый, кто открывает Skedy Teachers: без личных данных.
const TMSG_MAX = 300, TMSG_KEEP = 20;
const TB = { he: "הודעה מבית הספר", en: "Message from school", ru: "Сообщение от школы" };
async function tmsgPost(req, env, ctx, del) {
  const auth = await checkCode(req, env, req.headers.get("X-Editor-Code"));
  if (auth.status !== 200) return json(auth.body, auth.status);
  const b = await req.json().catch(() => ({}));
  const cur = (await env.DB.get("tmsg", "json")) || { msgs: [] };
  const old = Date.now() - 30 * 864e5;
  let msgs = cur.msgs.filter((m) => Date.parse(m.at) > old);
  if (del) {
    msgs = msgs.filter((m) => m.id !== b.id);
    await env.DB.put("tmsg", JSON.stringify({ msgs }));
    return json({ ok: true, msgs });
  }
  const text = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length > TMSG_MAX) return json({ error: "bad_text" }, 400);
  const m = { id: "m" + Date.now().toString(36), at: new Date().toISOString(), text };
  msgs = [m].concat(msgs).slice(0, TMSG_KEEP);
  await env.DB.put("tmsg", JSON.stringify({ msgs }));
  if (env.PUSHQ) ctx.waitUntil(env.PUSHQ.send({ t: "bc", text, id: m.id }));
  else ctx.waitUntil(planBroadcast(env, { text, id: m.id }));
  return json({ ok: true, msgs });
}
async function planBroadcast(env, m) {
  const jobs = [];
  for await (const { key, rec } of allSubs(env)) {
    if (!rec.t) continue; // только учителя
    const L = T[rec.l] || T.he;
    jobs.push({ key, s: rec.s, p: { title: TB[rec.l] || TB.he, body: m.text, tag: "msg-" + m.id, dir: L.dir, lang: rec.l } });
  }
  if (!jobs.length) return;
  if (!env.PUSHQ) return sendJobs(env, jobs);
  const msgs = [];
  for (let i = 0; i < jobs.length; i += PER_MESSAGE) msgs.push({ body: { t: "push", jobs: jobs.slice(i, i + PER_MESSAGE) } });
  for (let i = 0; i < msgs.length; i += 100) await env.PUSHQ.sendBatch(msgs.slice(i, i + 100));
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
  if (raw.length > 12000) return json({ error: "too_big" }, 413); // у родителей до 6 детей с группами
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
  // Skedy для учителей: вместо класса и групп — имя учителя (уведомления о его уроках)
  const teacher = typeof b.teacher === "string" ? b.teacher.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (teacher) { rec.t = teacher; rec.c = ""; rec.g = []; }
  // Skedy Parents: вместо одного класса — дети (до 6): класс, группы и название класса для текста уведомления (без имён)
  else if (Array.isArray(b.kids)) {
    rec.c = ""; rec.g = [];
    rec.k = b.kids.slice(0, 6).filter((k) => k && classes.test(String(k.c || ""))).map((k) => ({
      c: String(k.c),
      g: (Array.isArray(k.g) ? k.g : []).map(String).filter((x) => /^[\w-]{1,40}$/.test(x)).slice(0, 60),
      n: typeof k.n === "string" ? k.n.replace(/\s+/g, " ").trim().slice(0, 12) : "",
    }));
  }
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
  if (raw.length > 1500) return json({ error: "too_big" }, 413);
  let b;
  try { b = JSON.parse(raw); } catch (e) { return json({ error: "bad_json" }, 400); }
  const dev = b && b.id;
  if (typeof dev !== "string" || !/^[0-9a-f]{32}$/.test(dev)) return json({ error: "bad_id" }, 400);
  const cls = b.classId ? String(b.classId) : "";
  // @t — устройство Skedy Teachers, @p — Skedy Parents (без имён, просто отдельная строка в статистике)
  if (cls && !/^(c\d{1,2}|@t|@p)$/.test(cls)) return json({ error: "bad_class" }, 400);
  // день считает сервер (по времени Израиля), дате с телефона не доверяем
  await statsObj(env).ping(israelDate(0), dev, cls, cleanGroups(b.groups));
  return json({ ok: true });
}
// выбранные группы: только id групп, не больше 40
function cleanGroups(g) {
  return (Array.isArray(g) ? g : []).map(String).filter((x) => /^[\w-]{1,40}$/.test(x)).slice(0, 40).sort().join(",");
}

/* ---------------- календарь контрольных ---------------- */
// GET /cal/<код друга>.ics?l=he|en|ru — подписка на календарь (iPhone: webcal://, Android: через Google Календарь).
// Контрольные и экзамены ученика по его выбору (класс + группы, как у кода друга), 30 дней назад и 120 вперёд.
// Календарь сам обновляется: телефон заново забирает этот адрес раз в несколько часов.
const CAL_T = {
  he: { name: "Skedy · מבחנים", periods: "שיעורים", period: "שיעור" },
  en: { name: "Skedy · Tests", periods: "Periods", period: "Period" },
  ru: { name: "Skedy · Контрольные", periods: "Уроки", period: "Урок" },
};
// местное время Иерусалима → UTC (с учётом летнего времени)
function jlmOffsetMin(ms) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000) / 60000;
}
function jlmToUtc(date, hm) {
  const [y, m, d] = date.split("-").map(Number), [h, mi] = String(hm).split(":").map(Number);
  const local = Date.UTC(y, m - 1, d, h, mi);
  let t = local - jlmOffsetMin(local) * 60000;
  t = local - jlmOffsetMin(t) * 60000;
  return t;
}
function icsTime(ms) { return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
function icsText(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
// строки ics не длиннее 75 байт (иврит и русский — по 2 байта на букву)
function icsFold(line) {
  const out = []; let cur = "", n = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (n + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; n = 0; }
    cur += ch; n += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}
async function calFeed(env, path, lang) {
  const m = /^\/cal\/([1-9]\d{2})(?:\.ics)?$/.exec(path);
  if (!m) return json({ error: "bad_code" }, 400);
  if (!env.STATS) return json({ error: "no_stats_binding" }, 500);
  const sel = await statsObj(env).palGet(m[1]);
  if (!sel) return json({ error: "not_found" }, 404);
  const raw = await env.DB.get("state");
  if (!raw) return json({ error: "empty" }, 404);
  const st = JSON.parse(raw);
  return calResponse(st, sel, m[1], CAL_T[lang] ? lang : "he");
}
function calEvents(st, sel, lang) {
  const L = T[lang], groups = new Map(st.groups.map((g) => [g.id, g]));
  const openSubj = new Set(st.subjects.filter((s) => s.open).map((s) => s.id));
  const classSubj = new Set(st.groups.filter((g) => groupFitsClass(g, sel.classId)).map((g) => g.subjectId));
  const mine = new Set(sel.groups.filter((id) => {
    const g = groups.get(id);
    return g && (openSubj.has(g.subjectId) ? classSubj.has(g.subjectId) : groupFitsClass(g, sel.classId));
  }));
  const lessons = new Map(st.lessons.map((l) => [l.id, l]));
  const from = israelDate(-30), to = israelDate(120);
  const items = [];
  for (const c of st.changes || []) {
    if ((c.type !== "test" && c.type !== "exam") || c.date < from || c.date > to) continue;
    const l = lessons.get(c.lessonId);
    if (!l || (l.aud.type === "class" ? l.aud.id !== sel.classId : !mine.has(l.aud.id))) continue;
    items.push({ c, l });
  }
  items.sort((a, b) => (a.c.date + String(a.l.period).padStart(2, "0")).localeCompare(b.c.date + String(b.l.period).padStart(2, "0")));
  const ev = [];
  for (const x of items) {
    const b = ev[ev.length - 1];
    if (b && b.date === x.c.date && b.type === x.c.type && b.subjectId === x.l.subjectId && x.l.period >= b.to && x.l.period <= b.to + 1) { b.to = x.l.period; continue; }
    ev.push({ date: x.c.date, type: x.c.type, subjectId: x.l.subjectId, from: x.l.period, to: x.l.period, note: x.c.note || "", teacher: x.l.teacher || "", room: x.l.room || "" });
  }
  const per = new Map(st.periods.map((p) => [p.n, p]));
  return ev.filter((e) => per.get(e.from) && per.get(e.to)).map((e) => {
    const sub = byId(st.subjects, e.subjectId) || {};
    const name = sub[lang] || sub.he || "";
    const C = CAL_T[lang];
    return {
      uid: "skedy-" + e.date + "-" + e.subjectId + "-" + e.from + "-" + e.type,
      start: jlmToUtc(e.date, per.get(e.from).start),
      end: jlmToUtc(e.date, per.get(e.to).end),
      summary: (e.type === "test" ? L.test : L.exam) + ": " + name + (e.note ? " (" + e.note + ")" : ""),
      location: e.room,
      description: (e.from === e.to ? C.period + " " + e.from : C.periods + " " + e.from + "–" + e.to) + (e.teacher ? "\n" + e.teacher : "") + "\nSkedy",
    };
  });
}
function calResponse(st, sel, code, lang) {
  if (!T[lang]) lang = "he";
  const now = icsTime(Date.now());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Skedy//Tests//" + lang.toUpperCase(), "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:" + icsText(CAL_T[lang].name), "X-WR-TIMEZONE:Asia/Jerusalem", "REFRESH-INTERVAL;VALUE=DURATION:PT3H", "X-PUBLISHED-TTL:PT3H"];
  for (const e of calEvents(st, sel, lang)) {
    lines.push("BEGIN:VEVENT", "UID:" + e.uid + "-" + code + "@skedy", "DTSTAMP:" + now, "DTSTART:" + icsTime(e.start), "DTEND:" + icsTime(e.end),
      "SUMMARY:" + icsText(e.summary), "DESCRIPTION:" + icsText(e.description));
    if (e.location) lines.push("LOCATION:" + icsText(e.location));
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.map(icsFold).join("\r\n") + "\r\n", {
    headers: { ...CORS, "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "max-age=900", "Content-Disposition": 'inline; filename="skedy-tests.ics"' },
  });
}

/* ---------------- друзья ---------------- */
// Код друга — случайное трёхзначное число (100–999), по нему можно узнать только класс и группы (без имени).
// Имя друга хранит у себя в телефоне тот, кто его добавил. Один код на устройство,
// при смене групп код остаётся прежним, а данные обновляются.
const PAL_MAX = 30, PAL_WINDOW_SEC = 3600, PALGET_MAX = 200;
async function palSave(req, env) {
  let lim;
  try { lim = await limiter(env, "pal", req).hit(PAL_MAX, PAL_WINDOW_SEC); }
  catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id)) return json({ error: "bad_id" }, 400);
  if (!/^c\d{1,2}$/.test(b.classId || "")) return json({ error: "bad_class" }, 400);
  return json(await statsObj(env).palSave(b.id, b.classId, cleanGroups(b.groups), new Date().toISOString()));
}
async function palGet(req, env, code) {
  code = String(code || "");
  if (!/^[1-9]\d{2}$/.test(code)) return json({ error: "bad_code" }, 400);
  let lim;
  try { lim = await limiter(env, "palget", req).hit(PALGET_MAX, PAL_WINDOW_SEC); }
  catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  const r = await statsObj(env).palGet(code);
  return r ? json(r) : json({ error: "not_found" }, 404);
}
async function palDelete(req, env) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id)) return json({ error: "bad_id" }, 400);
  return json(await statsObj(env).palDelete(b.id));
}
// взаимное добавление: A добавил код B — B при следующем открытии получит A в свой список
async function palLink(req, env) {
  let lim;
  try { lim = await limiter(env, "pal", req).hit(PAL_MAX, PAL_WINDOW_SEC); }
  catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id)) return json({ error: "bad_id" }, 400);
  if (!/^[1-9]\d{2}$/.test(String(b.to || ""))) return json({ error: "bad_code" }, 400);
  return json(await statsObj(env).palLink(b.id, String(b.to), new Date().toISOString()));
}
// взаимное удаление: A убрал B из друзей — B при следующем открытии тоже уберёт A
async function palUnlink(req, env) {
  let lim;
  try { lim = await limiter(env, "pal", req).hit(PAL_MAX, PAL_WINDOW_SEC); }
  catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  const b = await req.json().catch(() => null);
  if (!b || typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id)) return json({ error: "bad_id" }, 400);
  if (!/^[1-9]\d{2}$/.test(String(b.to || ""))) return json({ error: "bad_code" }, 400);
  return json(await statsObj(env).palUnlink(b.id, String(b.to), new Date().toISOString()));
}
async function palInbox(req, env) {
  const b = await req.json().catch(() => null);
  if (!b || typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id)) return json({ error: "bad_id" }, 400);
  return json(await statsObj(env).palInbox(b.id));
}
/* ---------------- сообщения об ошибках ---------------- */
// Ученик пишет, что в расписании не так. Сохраняются только текст, класс, дата и урок —
// ни имени, ни id устройства, ни адреса (IP нужен только лимиту и сам стирается через час).
// Не больше 10 сообщений с одного адреса в час. Хранятся последние 300 — в том же объекте Stats.
const REPORT_MAX = 10, REPORT_WINDOW_SEC = 3600;
async function report(req, env) {
  const raw = await req.text();
  if (raw.length > 3000) return json({ error: "too_big" }, 413);
  let b;
  try { b = JSON.parse(raw); } catch (e) { return json({ error: "bad_json" }, 400); }
  if (!b || typeof b !== "object") return json({ error: "bad_json" }, 400);
  const text = String((b && b.text) || "").trim().slice(0, 500);
  if (text.length < 3) return json({ error: "too_short" }, 400);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : "";
  const period = Number.isInteger(b.period) && b.period >= 0 && b.period <= 20 ? b.period : 0;
  const lesson = /^[\w-]{1,40}$/.test(b.lessonId || "") ? b.lessonId : "";
  const cls = /^c\d{1,2}$/.test(b.classId || "") ? b.classId : "";
  let lim;
  try { lim = await limiter(env, "report", req).hit(REPORT_MAX, REPORT_WINDOW_SEC); }
  catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  await statsObj(env).addReport({ at: new Date().toISOString(), date, period, lesson, cls, text });
  return json({ ok: true });
}

/* ---------------- чат поддержки ---------------- */
// У каждого телефона свой случайный ключ переписки (хранится только в телефоне), сервер хранит
// его отпечаток (sha256). Имён нет: редактор видит класс и сообщения. Ученик — 20 сообщений в час.
const CHAT_MAX = 20, CHAT_WINDOW_SEC = 3600;
const KEEP_DAYS = 30; // сколько дней хранить переписки чата и сообщения об ошибках
function chatCtx(c) {
  if (!c || typeof c !== "object") return "";
  const o = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(c.date)) o.date = c.date;
  if (Number.isInteger(c.period) && c.period > 0 && c.period <= 20) o.period = c.period;
  if (/^[\w-]{1,40}$/.test(c.lessonId || "")) o.lessonId = c.lessonId;
  return o.date ? JSON.stringify(o) : "";
}
async function chatKeyHash(b) {
  return b && typeof b.key === "string" && /^[0-9a-f]{32}$/.test(b.key) ? await sha256("chat:" + b.key) : null;
}
async function chatPost(req, env) {
  const raw = await req.text();
  if (raw.length > 12000) return json({ error: "too_big" }, 413); // у родителей до 6 детей с группами
  let b;
  try { b = JSON.parse(raw); } catch (e) { return json({ error: "bad_json" }, 400); }
  const tkey = await chatKeyHash(b);
  if (!tkey) return json({ error: "bad_key" }, 400);
  const text = String(b.text || "").trim().slice(0, 1000);
  if (!text) return json({ error: "too_short" }, 400);
  const cls = /^c\d{1,2}$/.test(b.classId || "") ? b.classId : "";
  let lim;
  try { lim = await limiter(env, "chat", req).hit(CHAT_MAX, CHAT_WINDOW_SEC); }
  catch (e) { return json({ error: "try_later" }, 503); }
  if (!lim.ok) return json({ error: "too_many", retryAfter: lim.retryAfter }, 429);
  return json(await statsObj(env).chatPost(tkey, cls, text, chatCtx(b.ctx), new Date().toISOString()));
}
async function chatGet(req, env) {
  const b = await req.json().catch(() => null);
  const tkey = await chatKeyHash(b);
  if (!tkey) return json({ error: "bad_key" }, 400);
  return json(await statsObj(env).chatGet(tkey, !!b.mark));
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
    this.sql.exec("CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, date TEXT NOT NULL, period INTEGER NOT NULL, lesson TEXT NOT NULL, cls TEXT NOT NULL, text TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS pals (code TEXT PRIMARY KEY, dev TEXT NOT NULL UNIQUE, cls TEXT NOT NULL, grp TEXT NOT NULL, at TEXT NOT NULL) WITHOUT ROWID");
    // кто кого добавил (ждёт, пока второй откроет приложение); строка удаляется после доставки
    this.sql.exec("CREATE TABLE IF NOT EXISTS pallinks (to_code TEXT NOT NULL, from_code TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (to_code, from_code)) WITHOUT ROWID");
    // кто кого удалил из друзей (второй тоже уберёт первого, когда откроет приложение); строка удаляется после доставки
    this.sql.exec("CREATE TABLE IF NOT EXISTS palunlinks (to_code TEXT NOT NULL, from_code TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (to_code, from_code)) WITHOUT ROWID");
    // группы устройства (для «кто сейчас свободен»); у старой таблицы колонки ещё нет
    const cols = this.sql.exec("PRAGMA table_info(devices)").toArray().map((c) => c.name);
    if (!cols.includes("grp")) this.sql.exec("ALTER TABLE devices ADD COLUMN grp TEXT NOT NULL DEFAULT ''");
  }
  palSave(dev, cls, grp, at) {
    const old = this.sql.exec("SELECT code FROM pals WHERE dev = ?", dev).toArray()[0];
    if (old) {
      this.sql.exec("UPDATE pals SET cls = ?, grp = ?, at = ? WHERE dev = ? AND (cls <> ? OR grp <> ?)", cls, grp, at, dev, cls, grp);
      return { code: old.code };
    }
    for (let i = 0; i < 40; i++) {
      const code = String(100 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900));
      if (this.sql.exec("SELECT 1 FROM pals WHERE code = ?", code).toArray().length) continue;
      this.sql.exec("INSERT INTO pals (code, dev, cls, grp, at) VALUES (?, ?, ?, ?, ?)", code, dev, cls, grp, at);
      return { code };
    }
    return { error: "busy" };
  }
  // запись на личные встречи: mid — собрание, at — «18:20», d — дата собрания, p/k — имена родителя и ребёнка,
  // c — класс «10-2», tok — sha256 секрета устройства (отменить может только тот, кто записался)
  // запросы родителей на разговор: c — класс, t — учитель, date/per — день и урок (0 — после уроков),
  // pn/kn — имена родителя и ребёнка, topic — тема, tok — sha256 секрета устройства, st — new|done
  // ответы на разрешения: aid — разрешение, tok — sha256 секрета устройства, kn/pn — имена, c — класс, ans — yes|no, d — дата события
  aprInit() {
    if (this.aprReady) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS apr (aid TEXT NOT NULL, tok TEXT NOT NULL, kn TEXT NOT NULL, pn TEXT NOT NULL, c TEXT NOT NULL, ans TEXT NOT NULL, d TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (aid, tok, kn)) WITHOUT ROWID");
    this.aprReady = true;
  }
  aprPrune(today) { this.aprInit(); this.sql.exec("DELETE FROM apr WHERE d < ?", today); }
  aprSet(aid, tok, kn, pn, c, ans, d, at, today) {
    this.aprPrune(today);
    if (this.sql.exec("SELECT COUNT(*) AS n FROM apr WHERE tok = ?", tok).one().n >= 40) return false;
    this.sql.exec("INSERT INTO apr (aid, tok, kn, pn, c, ans, d, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (aid, tok, kn) DO UPDATE SET ans = excluded.ans, pn = excluded.pn, c = excluded.c, at = excluded.at", aid, tok, kn, pn, c, ans, d, at);
    return true;
  }
  aprMine(tok, today) { this.aprPrune(today); return this.sql.exec("SELECT aid, kn, ans FROM apr WHERE tok = ?", tok).toArray(); }
  aprList(classes, today) {
    this.aprPrune(today);
    const rows = this.sql.exec("SELECT aid, kn, pn, c, ans, at FROM apr ORDER BY c, kn").toArray();
    return classes ? rows.filter((r) => classes.includes(r.c)) : rows;
  }
  preqInit() {
    if (this.preqReady) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS preq (id INTEGER PRIMARY KEY AUTOINCREMENT, c TEXT NOT NULL, t TEXT NOT NULL, date TEXT NOT NULL, per INTEGER NOT NULL, pn TEXT NOT NULL, kn TEXT NOT NULL, topic TEXT NOT NULL, tok TEXT NOT NULL, at TEXT NOT NULL, st TEXT NOT NULL DEFAULT 'new')");
    this.preqReady = true;
  }
  // на следующий день после выбранного дня запрос стирается
  preqPrune(today) { this.preqInit(); this.sql.exec("DELETE FROM preq WHERE date < ?", today); }
  preqAdd(x, today) {
    this.preqPrune(today);
    if (this.sql.exec("SELECT COUNT(*) AS n FROM preq WHERE tok = ?", x.tok).one().n >= 10) return { error: "too_many" };
    if (this.sql.exec("SELECT 1 FROM preq WHERE tok = ? AND t = ? AND date = ? AND kn = ?", x.tok, x.t, x.date, x.kn).toArray().length) return { error: "dup" };
    this.sql.exec("INSERT INTO preq (c, t, date, per, pn, kn, topic, tok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", x.c, x.t, x.date, x.per, x.pn, x.kn, x.topic, x.tok, x.at);
    return { id: this.sql.exec("SELECT last_insert_rowid() AS id").one().id };
  }
  preqList(classes, today) {
    this.preqPrune(today);
    const rows = this.sql.exec("SELECT id, c, t, date, per, pn, kn, topic, at, st FROM preq ORDER BY date, per, id").toArray();
    return classes ? rows.filter((r) => classes.includes(r.c)) : rows;
  }
  preqMine(tok, today) {
    this.preqPrune(today);
    return this.sql.exec("SELECT id, t, date, per, kn, st FROM preq WHERE tok = ? ORDER BY date, per", tok).toArray();
  }
  preqSet(id, st, classes) {
    this.preqInit();
    const r = this.sql.exec("SELECT c FROM preq WHERE id = ?", id).toArray()[0];
    if (!r || (classes && !classes.includes(r.c))) return false;
    this.sql.exec("UPDATE preq SET st = ? WHERE id = ?", st, id);
    return true;
  }
  preqDel(id, tok, classes) {
    this.preqInit();
    const r = this.sql.exec("SELECT c, tok FROM preq WHERE id = ?", id).toArray()[0];
    if (!r || (tok && r.tok !== tok) || (classes && !classes.includes(r.c))) return false;
    this.sql.exec("DELETE FROM preq WHERE id = ?", id);
    return true;
  }
  pmbInit() {
    if (this.pmbReady) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS pmb (mid TEXT NOT NULL, at TEXT NOT NULL, d TEXT NOT NULL, p TEXT NOT NULL, k TEXT NOT NULL, c TEXT NOT NULL, tok TEXT NOT NULL, PRIMARY KEY (mid, at)) WITHOUT ROWID");
    this.pmbReady = true;
  }
  // на следующий день после собрания записи стираются
  pmbPrune(today) {
    this.pmbInit();
    this.sql.exec("DELETE FROM pmb WHERE d < ?", today);
  }
  pmbTaken(mid, today) {
    this.pmbPrune(today);
    return this.sql.exec("SELECT at FROM pmb WHERE mid = ? ORDER BY at", mid).toArray().map((r) => r.at);
  }
  pmbList(mid, today) {
    this.pmbPrune(today);
    return this.sql.exec("SELECT at, p, k, c FROM pmb WHERE mid = ? ORDER BY at", mid).toArray();
  }
  pmbBook(mid, at, d, p, k, c, tok, today) {
    this.pmbPrune(today);
    if (this.sql.exec("SELECT 1 FROM pmb WHERE mid = ? AND tok = ? AND k = ?", mid, tok, k).toArray().length) return { error: "dup" };
    if (this.sql.exec("SELECT COUNT(*) AS n FROM pmb WHERE mid = ? AND tok = ?", mid, tok).one().n >= PMB_PER_DEVICE) return { error: "too_many" };
    if (this.sql.exec("SELECT 1 FROM pmb WHERE mid = ? AND at = ?", mid, at).toArray().length) return { error: "taken" };
    this.sql.exec("INSERT INTO pmb (mid, at, d, p, k, c, tok) VALUES (?, ?, ?, ?, ?, ?, ?)", mid, at, d, p, k, c, tok);
    return { ok: true };
  }
  pmbCancel(mid, at, tok) {
    this.pmbInit();
    if (tok) this.sql.exec("DELETE FROM pmb WHERE mid = ? AND at = ? AND tok = ?", mid, at, tok);
    else this.sql.exec("DELETE FROM pmb WHERE mid = ? AND at = ?", mid, at);
    return true;
  }
  palGet(code) {
    const r = this.sql.exec("SELECT cls, grp FROM pals WHERE code = ?", code).toArray()[0];
    return r ? { classId: r.cls, groups: r.grp ? r.grp.split(",") : [] } : null;
  }
  // чат: threads — переписки (ue/uu — непрочитанные у редактора/ученика), msgs — сообщения
  chatInit() {
    if (this.chatReady) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY AUTOINCREMENT, tkey TEXT NOT NULL UNIQUE, cls TEXT NOT NULL, last TEXT NOT NULL, ue INTEGER NOT NULL DEFAULT 0, uu INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, tid INTEGER NOT NULL, at TEXT NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL, ctx TEXT NOT NULL DEFAULT '')");
    this.sql.exec("CREATE INDEX IF NOT EXISTS msgs_tid ON msgs (tid, id)");
    this.chatReady = true;
  }
  chatMsgs(tid) {
    return this.sql.exec("SELECT id, at, who, text, ctx FROM msgs WHERE tid = ? ORDER BY id", tid).toArray();
  }
  chatPost(tkey, cls, text, ctx, at) {
    this.chatInit();
    this.sql.exec("INSERT INTO threads (tkey, cls, last, ue) VALUES (?, ?, ?, 1) ON CONFLICT (tkey) DO UPDATE SET cls = excluded.cls, last = excluded.last, ue = ue + 1", tkey, cls, at);
    const tid = this.sql.exec("SELECT id FROM threads WHERE tkey = ?", tkey).one().id;
    this.sql.exec("INSERT INTO msgs (tid, at, who, text, ctx) VALUES (?, ?, 'u', ?, ?)", tid, at, text, ctx);
    // храним последние 100 сообщений переписки и 500 переписок
    this.sql.exec("DELETE FROM msgs WHERE tid = ? AND id <= (SELECT MAX(id) FROM msgs WHERE tid = ?) - 100", tid, tid);
    const old = this.sql.exec("SELECT id FROM threads ORDER BY last DESC LIMIT -1 OFFSET 500").toArray();
    for (const o of old) this.chatDelete(o.id);
    this.chatPrune(at);
    return { ok: true };
  }
  chatGet(tkey, mark) {
    this.chatInit();
    const t = this.sql.exec("SELECT id, uu FROM threads WHERE tkey = ?", tkey).toArray()[0];
    if (!t) return { msgs: [], unread: 0 };
    if (mark && t.uu) this.sql.exec("UPDATE threads SET uu = 0 WHERE id = ?", t.id);
    return { msgs: this.chatMsgs(t.id), unread: mark ? 0 : t.uu };
  }
  // переписки и старые сообщения об ошибках живут 30 дней после последнего сообщения (в них пишут ученики)
  chatPrune(now) {
    this.chatInit();
    const cut = new Date(Date.parse(now) - KEEP_DAYS * 86400000).toISOString();
    for (const o of this.sql.exec("SELECT id FROM threads WHERE last < ?", cut).toArray()) this.chatDelete(o.id);
    this.sql.exec("DELETE FROM reports WHERE at < ?", cut);
  }
  chatList() {
    this.chatInit();
    this.chatPrune(new Date().toISOString());
    return this.sql.exec("SELECT t.id, t.cls, t.last, t.ue, (SELECT text FROM msgs WHERE tid = t.id ORDER BY id DESC LIMIT 1) AS lt, (SELECT who FROM msgs WHERE tid = t.id ORDER BY id DESC LIMIT 1) AS lw FROM threads t ORDER BY t.last DESC LIMIT 200").toArray();
  }
  chatOpen(id) {
    this.chatInit();
    const t = this.sql.exec("SELECT id, cls FROM threads WHERE id = ?", id).toArray()[0];
    if (!t) return { error: "not_found" };
    this.sql.exec("UPDATE threads SET ue = 0 WHERE id = ?", id);
    return { id, cls: t.cls, msgs: this.chatMsgs(id) };
  }
  chatReply(id, text, at) {
    this.chatInit();
    if (!this.sql.exec("SELECT 1 FROM threads WHERE id = ?", id).toArray().length) return { error: "not_found" };
    this.sql.exec("INSERT INTO msgs (tid, at, who, text) VALUES (?, ?, 'e', ?)", id, at, text);
    this.sql.exec("UPDATE threads SET last = ?, uu = uu + 1, ue = 0 WHERE id = ?", at, id);
    return { ok: true };
  }
  chatDelete(id) {
    this.chatInit();
    this.sql.exec("DELETE FROM msgs WHERE tid = ?", id);
    this.sql.exec("DELETE FROM threads WHERE id = ?", id);
    return { ok: true };
  }
  palLink(dev, to, at) {
    const me = this.sql.exec("SELECT code FROM pals WHERE dev = ?", dev).toArray()[0];
    if (!me) return { error: "no_code" };
    if (me.code === to || !this.sql.exec("SELECT 1 FROM pals WHERE code = ?", to).toArray().length) return { ok: false };
    this.sql.exec("INSERT OR IGNORE INTO pallinks (to_code, from_code, at) VALUES (?, ?, ?)", to, me.code, at);
    this.sql.exec("DELETE FROM palunlinks WHERE to_code = ? AND from_code = ?", to, me.code); // снова добавил — прежнее удаление не нужно
    return { ok: true };
  }
  palUnlink(dev, to, at) {
    const me = this.sql.exec("SELECT code FROM pals WHERE dev = ?", dev).toArray()[0];
    if (!me) return { error: "no_code" };
    if (me.code === to) return { ok: false };
    this.sql.exec("DELETE FROM pallinks WHERE to_code = ? AND from_code = ?", to, me.code); // недоставленное добавление больше не нужно
    this.sql.exec("INSERT OR REPLACE INTO palunlinks (to_code, from_code, at) VALUES (?, ?, ?)", to, me.code, at);
    return { ok: true };
  }
  palInbox(dev) {
    const me = this.sql.exec("SELECT code FROM pals WHERE dev = ?", dev).toArray()[0];
    if (!me) return { list: [] };
    const list = this.sql.exec("SELECT l.from_code AS code, p.cls, p.grp FROM pallinks l JOIN pals p ON p.code = l.from_code WHERE l.to_code = ?", me.code).toArray()
      .map((r) => ({ code: r.code, classId: r.cls, groups: r.grp ? r.grp.split(",") : [] }));
    this.sql.exec("DELETE FROM pallinks WHERE to_code = ?", me.code);
    const removed = this.sql.exec("SELECT from_code AS code FROM palunlinks WHERE to_code = ?", me.code).toArray().map((r) => r.code);
    this.sql.exec("DELETE FROM palunlinks WHERE to_code = ?", me.code);
    return { list, removed };
  }
  palDelete(dev) {
    this.sql.exec("DELETE FROM pals WHERE dev = ?", dev);
    return { ok: true };
  }
  // «кто сейчас свободен»: сколько устройств за неделю с каждым выбором (класс + группы), без id
  crowd(day) {
    const rows = this.sql.exec("SELECT cls, grp, COUNT(*) AS n FROM devices WHERE grp <> '' AND dev IN (SELECT DISTINCT dev FROM seen WHERE day >= ?) GROUP BY cls, grp", shiftDay(day, -6)).toArray();
    return { day, sel: rows.map((r) => ({ classId: r.cls, groups: r.grp.split(","), n: r.n })) };
  }
  addReport(r) {
    this.sql.exec("INSERT INTO reports (at, date, period, lesson, cls, text) VALUES (?, ?, ?, ?, ?, ?)", r.at, r.date, r.period, r.lesson, r.cls, r.text);
    this.sql.exec("DELETE FROM reports WHERE id <= (SELECT MAX(id) FROM reports) - 300");
    return { ok: true };
  }
  reports() {
    this.chatPrune(new Date().toISOString());
    return this.sql.exec("SELECT * FROM reports ORDER BY id DESC LIMIT 300").toArray();
  }
  delReport(id) {
    this.sql.exec("DELETE FROM reports WHERE id = ?", id);
    return { ok: true };
  }
  ping(day, dev, cls, grp = "") {
    this.sql.exec("INSERT INTO seen (day, dev, cls) VALUES (?, ?, ?) ON CONFLICT (day, dev) DO UPDATE SET cls = excluded.cls WHERE cls <> excluded.cls", day, dev, cls);
    this.sql.exec("INSERT INTO devices (dev, cls, grp) VALUES (?, ?, ?) ON CONFLICT (dev) DO UPDATE SET cls = excluded.cls, grp = excluded.grp WHERE cls <> excluded.cls OR grp <> excluded.grp", dev, cls, grp);
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
  he: { cancel: "השיעור בוטל", room: "חדר חדש", test: "מבחן", exam: "בחינה", period: "שיעור", periods: "שיעורים", today: "היום", tomorrow: "מחר", sub: "החלפה", subMe: "אתם מחליפים את", subOff: "ההחלפה בוטלה", pm: "אסיפת הורים", pr: "בקשה לשיחה", after: "אחרי השיעורים", ap: "נדרש אישור הורים", until: "עד", many: (n) => n + " שינויים במערכת", one: "שינוי במערכת", dir: "rtl" },
  en: { cancel: "Lesson cancelled", room: "New room", test: "Test", exam: "Exam", period: "Period", periods: "Periods", today: "Today", tomorrow: "Tomorrow", sub: "Substitute", subMe: "You are covering for", subOff: "Cover cancelled", pm: "Parent meeting", pr: "Request for a talk", after: "after lessons", ap: "Parent permission needed", until: "by", many: (n) => n + " schedule changes", one: "Schedule change", dir: "ltr" },
  ru: { cancel: "Урок отменён", room: "Новый кабинет", test: "Контрольная", exam: "Экзамен", period: "Урок", periods: "Уроки", today: "Сегодня", tomorrow: "Завтра", sub: "Замена", subMe: "Вы заменяете", subOff: "Замена отменена", pm: "Родительское собрание", pr: "Просьба о разговоре", after: "после уроков", ap: "Нужно разрешение родителей", until: "до", many: (n) => "Изменений в расписании: " + n, one: "Изменение в расписании", dir: "ltr" },
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
    t: normName(les.teacher),
    name: { he: sub.he || "", en: sub.en || sub.he || "", ru: sub.ru || sub.he || "" },
    who: c.sub || "",
  };
}
function line(d, lang) {
  const L = T[lang];
  // родительское собрание: «Завтра, 18:00–20:00, Родительское собрание · учитель · кабинет»
  // запрос родителя на разговор: «Завтра, урок 4, הורה של מיכל · י׳2 → כהן (тема)»
  if (d.type === "pr") return dayWord(d.date, lang) + ", " + (d.period ? L.period + " " + d.period : L.after) + ", " + d.who + " → " + d.name[lang] + (d.note ? " (" + d.note + ")" : "");
  if (d.type === "ap") return dayWord(d.date, lang) + ", " + d.name[lang] + (d.due ? " · " + L.until + " " + d.due.slice(8) + "." + d.due.slice(5, 7) : "");
  if (d.type === "pm") return dayWord(d.date, lang) + ", " + d.time + ", " + (d.name[lang] || L.pm) +
    (d.who ? " · " + d.who : "") + (d.room ? " · " + d.room : "") + (d.note ? " (" + d.note + ")" : "");
  let what = d.type === "cancel" ? L.cancel : d.type === "room" ? L.room + ": " + d.room : d.type === "test" ? L.test :
    d.type === "sub" ? L.sub + ": " + d.who + (d.room ? ", " + L.room + ": " + d.room : "") :
    d.type === "subMe" ? L.subMe + " " + (d.who || "—") + (d.cls ? " · " + d.cls : "") + (d.room ? " · " + d.room : "") :
    d.type === "subOff" ? L.subOff + (d.cls ? " · " + d.cls : "") : L.exam;
  if (d.note) what += " (" + d.note + ")";
  const p = d.to > d.period ? L.periods + " " + d.period + "–" + d.to : L.period + " " + d.period;
  return dayWord(d.date, lang) + ", " + p + ", " + d.name[lang] + ": " + what;
}
// контрольная одного предмета на несколько уроков подряд — одна строка «уроки 1–2», а не две
function mergeTests(list) {
  const out = [];
  for (const d of list) {
    const b = out[out.length - 1];
    if (b && (d.type === "test" || d.type === "exam") && b.type === d.type && b.date === d.date &&
        b.name.he === d.name.he && b.note === d.note && d.period >= (b.to || b.period) && d.period <= (b.to || b.period) + 1) {
      b.to = d.period;
      continue;
    }
    out.push(Object.assign({}, d));
  }
  return out;
}
function concerns(d, rec) {
  if (rec.t) return !!d.t && d.t === normName(rec.t); // учитель: изменения в его уроках
  if (d.aud.type === "tt") return false; // изменения из Skedy Admin (/ttch) — только учителям
  if (d.aud.type === "pm") return !!rec.k && rec.k.some((k) => d.cids.includes(k.c)); // собрание — только родителям
  if (d.aud.type === "pr") return false; // запрос на разговор — только классному руководителю (rec.t выше)
  if (rec.k) return rec.k.some((k) => concernsKid(d, k)); // родитель: урок хотя бы одного ребёнка
  if (d.aud.type === "class") return d.aud.id === rec.c;
  return rec.g.includes(d.aud.id);
}
function concernsKid(d, k) {
  if (d.aud.type === "pm") return d.cids.includes(k.c);
  return d.aud.type === "class" ? d.aud.id === k.c : k.g.includes(d.aud.id);
}
// у родителя с детьми из разных классов строка начинается с класса: «י׳2 · Сегодня, урок 3, …»
function kidsLabel(d, rec) {
  if (!rec.k || new Set(rec.k.map((k) => k.n)).size < 2) return "";
  const ns = [...new Set(rec.k.filter((k) => concernsKid(d, k)).map((k) => k.n).filter(Boolean))];
  return ns.length ? ns.join(", ") + " · " : "";
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
    // одинаковые строки (у учителя один урок сразу у нескольких классов) — один раз
    const seen = new Set();
    const mine = mergeTests(ds.filter((d) => concerns(d, rec)).sort((a, b) => a.k.localeCompare(b.k)))
      .filter((d) => { const k = [d.date, d.period, d.to || "", d.type, d.name.he, d.room, d.note, d.time || "", d.who || "", kidsLabel(d, rec)].join("|"); if (seen.has(k)) return false; seen.add(k); return true; });
    if (!mine.length) continue;
    const L = T[rec.l];
    jobs.push({
      key,
      s: rec.s,
      p: {
        title: mine.every((d) => d.type === "ap") ? L.ap : mine.every((d) => d.type === "pm") ? L.pm : mine.every((d) => d.type === "pr") ? L.pr : mine.length === 1 ? L.one : L.many(mine.length),
        body: mine.slice(0, 4).map((d) => kidsLabel(d, rec) + line(d, rec.l)).join("\n"),
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
  if (!st.migrations.includes(MIGRATION8_ID)) { migration8(st); st.migrations.push(MIGRATION8_ID); changed = true; }
  if (!st.migrations.includes(MIGRATION9_ID)) { migration9(st); st.migrations.push(MIGRATION9_ID); changed = true; }
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
// 8. Уровни групп по математике и английскому — по школьной системе (מערכת שעות, 25.10.2026).
// Группы ищем по предмету и учителю, id не меняются (у учеников сохранится выбор).
const MIGRATION8_ID = "levels-2026-10-25";
function migration8(st) {
  const lv = {
    3: { he: "3 יח״ל", en: "3 units", ru: "3 единицы" },
    4: { he: "4 יח״ל", en: "4 units", ru: "4 единицы" },
    5: { he: "5 יח״ל", en: "5 units", ru: "5 единиц" },
    native: { he: "דוברי אנגלית", en: "Native speakers", ru: "Носители языка" },
  };
  const plan = [
    ["cat_math", "צרוניצר כורם מיכל", lv[3]],
    ["cat_math", "יהל שחר", lv[4]],
    ["cat_math", "אבגיל שרון", lv[5]],
    ["cat_eng", "ג'קינטו קתרין", lv.native],
    ["cat_eng", "מיירנץ לינדזי", lv.native],
  ];
  for (const [sj, teacher, name] of plan) {
    const g = st.groups.find((x) => x.subjectId === sj && x.teacher === teacher);
    if (g) Object.assign(g, name);
  }
  // новый кабинет у группы שקולניק בוריס
  const g = st.groups.find((x) => x.subjectId === "cat_math" && x.teacher === "שקולניק בוריס");
  if (g) for (const l of st.lessons) if (l.aud.type === "group" && l.aud.id === g.id) l.room = "גפן 23";
}

// 9. Английский открыт: ученик любого класса с английским видит все группы (subject.open, 28.10.2026)
const MIGRATION9_ID = "eng-open-2026-10-28";
function migration9(st) {
  const s = st.subjects.find((x) => x.id === "cat_eng");
  if (s) s.open = true;
}

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
function listItems(html, cache, accept = /^\d{2}\.\d{2}\.\d{4},/) {
  const out = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    let t = cache ? cache.get(m[1]) : undefined;
    if (t === undefined) {
      t = decodeHtml(m[1]);
      if (!accept.test(t)) t = null;
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
// события, как на вкладке «אירועים»:
//  «01.12.2026, יום זכויות האדם משיעור 1 עד שיעור 4 לכיתות: י-1...י-12, …»
//  «02.12.2026, סמינר … משיעור 10 עד שיעור 12 לכיתות: … בקבוצה של ברגר שירה, חדר: אודיטוריום גדול»
// и на всякий случай простые: «24.12.2026, חופשת חנוכה», «24.12.2026 - 31.12.2026, חופשת חנוכה».
// Классы берём не из строки, а из того, на странице какого класса она стоит.
// Выходной — только если прямо написано, что учёбы нет; остальное — просто событие дня.
const EVENT_LINE = /^\d{1,2}[./]\d{1,2}[./]\d{4}/;
const OFF_WORDS = /חופש|אין לימודים|פגרה|יום חופשי|שבתון/;
function eventDate(d) {
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(d);
  return m ? m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0") : null;
}
function parseEvent(t) {
  // строки в формате вкладки «שינויים» — не события (если адрес вкладки неверный)
  if (/^[\d.]+,\s*שיעור\s*\d+,/.test(t)) return null;
  const p = /^(\d{1,2}[./]\d{1,2}[./]\d{4}),\s*(.+?)\s+(?:משיעור\s*(\d+)\s*עד\s*שיעור\s*(\d+)|שיעור\s*(\d+))\s+לכיתות:\s*(.*)$/.exec(t);
  if (p) {
    const day = eventDate(p[1]), text = p[2].trim().slice(0, 120);
    if (!day || !text) return null;
    const ev = { days: [day], text, from: +(p[3] || p[5]), to: +(p[4] || p[5]), off: OFF_WORDS.test(text) };
    const who = /בקבוצה של\s+([^,]+)/.exec(p[6]), room = /חדר:\s*(.+)$/.exec(p[6]);
    if (who) ev.teacher = who[1].trim();
    if (room) ev.room = room[1].trim().slice(0, 60);
    return ev;
  }
  const m = /^(\d{1,2}[./]\d{1,2}[./]\d{4})(?:\s*[-–]\s*(\d{1,2}[./]\d{1,2}[./]\d{4}))?\s*[,:\-–]?\s*(.+)$/.exec(t);
  if (!m || /לכיתות:/.test(t)) return null;
  const from = eventDate(m[1]), to = m[2] ? eventDate(m[2]) : from;
  const text = m[3].trim().slice(0, 120);
  if (!from || !to || to < from || !text) return null;
  const days = [];
  for (let d = from; d <= to && days.length < 31; d = shiftDay(d, 1)) days.push(d);
  return { days, text, off: OFF_WORDS.test(text) };
}
function groupFitsClass(g, cid) {
  if (g.exceptClasses && g.exceptClasses.indexOf(cid) >= 0) return false;
  return !g.classId || g.classId === cid;
}
// как на сайте: у открытого предмета (subject.open) группа подходит любому классу, где этот предмет вообще есть
function groupFits(idx, g, cid) {
  if (!idx.openSubj.has(g.subjectId)) return groupFitsClass(g, cid);
  return idx.classSubj.has(g.subjectId + "|" + cid);
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
  byDP.openSubj = new Set(st.subjects.filter((s) => s.open).map((s) => s.id));
  byDP.classSubj = new Set();
  for (const g of st.groups) for (const c of st.classes) if (groupFitsClass(g, c.id)) byDP.classSubj.add(g.subjectId + "|" + c.id);
  return byDP;
}
function findLessons(idx, cid, item) {
  if (!item.date) return [];
  const wd = weekday(item.date);
  const who = normName(item.teacher);
  const out = [];
  for (let p = item.from; p <= item.to; p++) {
    for (const x of idx.get(wd + "|" + p) || []) {
      if (x.l.aud.type === "class" ? x.l.aud.id !== cid : !x.g || !groupFits(idx, x.g, cid)) continue;
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
    const r = await fetch(base + "/" + q, { headers: { "User-Agent": "Skedy (school schedule app; https://school-schedule.github.io/)" } });
    if (!r.ok) throw new Error("shahaf " + r.status);
    return r.text();
  };
  const first = await get("?tab=changes");
  const ids = parseClassOptions(first, letter);
  const report = { at: new Date().toISOString(), classes: 0, items: 0, matched: 0, unmatched: [], unknown: [] };
  const found = new Map();
  const idx = lessonIndex(st);
  const rawCache = new Map(), parsed = new Map();
  const evTab = env.SHAHAF_EVENTS_TAB || "events";
  const tabs = (opt.changes ? ["changes"] : []).concat(opt.exams ? ["exams"] : [], opt.events ? [evTab] : []);
  const events = new Map(); // дата|текст → событие и список классов
  const evCache = new Map();
  if (opt.events) { report.events = 0; report.eventSamples = []; report.eventUnknown = []; }
  for (const c of st.classes) {
    const sid = ids[c.num];
    if (!sid) continue;
    report.classes++;
    for (const tab of tabs) {
      const html = await get("?cls=" + sid + "&tab=" + tab);
      if (tab === evTab) {
        for (const t of listItems(html, evCache, EVENT_LINE)) {
          // примеры строк — в отчёт /shahaf, чтобы было видно, как выглядит вкладка
          if (report.eventSamples.length < 8 && !report.eventSamples.includes(t)) report.eventSamples.push(t);
          const ev = parseEvent(t);
          if (!ev) { if (report.eventUnknown.length < 8 && !report.eventUnknown.includes(t)) report.eventUnknown.push(t); continue; }
          for (const day of ev.days) {
            if (day < today) continue;
            const k = [day, ev.text, ev.from || "", ev.to || "", ev.teacher || ""].join("|");
            if (!events.has(k)) {
              const e = { date: day, text: ev.text, off: ev.off, cls: [] };
              if (ev.from) { e.from = ev.from; e.to = ev.to; }
              if (ev.room) e.room = ev.room;
              if (ev.teacher) e.teacher = ev.teacher;
              events.set(k, e);
            }
            const e = events.get(k);
            if (!e.cls.includes(c.id)) e.cls.push(c.id);
          }
        }
        continue;
      }
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
  // события: заменяем целиком (только сегодня и дальше); если у события все классы — список классов не храним
  let nextEvents = st.events;
  if (opt.events) {
    nextEvents = [...events.values()].map((e) => {
      const ev = { ...e };
      if (e.cls.length < report.classes) ev.cls = e.cls.sort(); else delete ev.cls;
      return ev;
    }).sort((a, b) => a.date.localeCompare(b.date) || (a.from || 0) - (b.from || 0));
    report.events = nextEvents.length;
    if (JSON.stringify(nextEvents) !== JSON.stringify(st.events || [])) report.changed = true;
  }
  const firstRun = !(await env.DB.get("shahaf:last"));
  if (report.changed) {
    const prev = { changes: st.changes };
    st.changes = next;
    if (nextEvents) st.events = nextEvents;
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
  // отчёт о событиях — отдельно (раз в сутки), его видно по адресу /shahaf/events
  if (opt.events) await env.DB.put("shahaf:events", JSON.stringify(report));
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
