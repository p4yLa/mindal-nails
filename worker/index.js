/* =========================================================
   Cloudflare Worker «Миндаль»: свободные окна, запись, сообщение мастеру в Telegram.

   GET  /slots?services=mani_gel,ex_design  -> свободные окна на 21 день
   POST /  { type: 'booking', ... }          -> сохранить запись (D1) + сообщение в Telegram,
                                                в ответе — точный адрес (только тому, кто записался)

   Секреты (в коде и в репозитории их нет):
     npx wrangler secret put BOT_TOKEN      токен бота от @BotFather
     npx wrangler secret put CHAT_ID        чат мастера, куда приходят записи
     npx wrangler secret put ADDRESS        «Москва, ул. ..., д. ..., кв. ...»
     npx wrangler secret put ADDRESS_NOTE   «Подъезд 3, этаж 9, домофон 112, затем «Вызов»»
   База: env.DB (см. wrangler.toml, schema.sql)

   Правила расписания (часы, перерыв, выходные, услуги) — в ../js/schedule.js,
   тот же файл использует сайт. Wrangler сам соберёт его вместе с воркером.
   ========================================================= */
import Schedule from '../js/schedule.js';

// Откуда разрешено обращаться к функции (CORS)
const ALLOWED_ORIGINS = [
  'https://p4yla.github.io',
  'http://localhost:8766',
  'http://127.0.0.1:5500' // Live Server в VS Code
];

const MASTER_PHONE = '+7 (999) 555-01-23';

/* ---------- Форматирование ---------- */
const { fmtTime, SERVICES } = Schedule;
function fmtDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d))
    .toLocaleDateString('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long', weekday: 'short' });
}
const rub = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
function fmtDur(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? h + ' ч' + (m ? ' ' + m + ' мин' : '') : m + ' мин';
}

/* ---------- База ---------- */
// Текущее московское время + все действующие записи на период записи
async function loadContext(env) {
  const now = Schedule.moscowNow();
  const days = Schedule.nextDays(now.key);
  const { results } = await env.DB.prepare(
    "SELECT date, start_min, dur FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status != 'cancelled'"
  ).bind(days[0], days[days.length - 1]).all();
  return { todayKey: now.key, nowMin: now.min, days, bookings: results || [] };
}

/* ---------- HTTP-утилиты ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
function json(data, status, origin, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin), ...(extra || {}) }
  });
}

// Не больше 5 заявок с одного IP за 10 минут (память у каждого экземпляра своя — защита «примерная»)
const hits = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

async function telegram(env, text) {
  if (!env.BOT_TOKEN || !env.CHAT_ID) return false;
  const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  return r.ok;
}
const phoneLink = (phone) => '<a href="tel:' + phone.replace(/[^\d+]/g, '') + '">' + esc(phone) + '</a>';
const CONTACT_WAYS = { telegram: 'Telegram', whatsapp: 'WhatsApp', call: 'звонок' };

/* ---------- GET /slots ---------- */
async function handleSlots(url, env, origin) {
  const svc = Schedule.parseServices(url.searchParams.get('services'));
  if (svc.error) return json({ ok: false, error: svc.error }, 400, origin);
  const ctx = await loadContext(env);
  const days = Schedule.buildDays(svc.dur, ctx.bookings, ctx);
  // Без кэша: после чужой записи браузер должен сразу увидеть свежее расписание
  return json({ ok: true, dur: svc.dur, total: svc.total, days }, 200, origin, { 'Cache-Control': 'no-store' });
}

/* ---------- POST: запись ---------- */
async function handleBooking(d, env, origin) {
  const svc = Schedule.parseServices(d.services);
  if (svc.error) return json({ ok: false, error: svc.error }, 422, origin);

  const ctx = await loadContext(env);
  const date = String(d.date || '');
  const start = Schedule.parseTime(d.time);
  if (!ctx.days.includes(date) || start < 0) {
    return json({ ok: false, error: 'Некорректные дата или время' }, 422, origin);
  }
  // Рабочий день, часы, перерыв, демо-занятость и уже известные записи
  const mine = ctx.bookings.filter((b) => b.date === date);
  if (!Schedule.isFree(date, start, svc.dur, mine, ctx)) return json({ ok: false, error: 'taken' }, 409, origin);

  const name = clip(d.name, 60), phone = clip(d.phone, 20), comment = clip(d.comment, 500);
  const contact = CONTACT_WAYS[d.contact] ? d.contact : 'telegram';

  // INSERT ... WHERE NOT EXISTS — одна атомарная операция. Если кто-то успел занять
  // пересекающееся время секундой раньше (с учётом 15 минут на дезинфекцию), вставки не будет.
  const B = Schedule.BUFFER_MIN;
  const res = await env.DB.prepare(
    `INSERT INTO bookings (date, start_min, dur, services, total, name, phone, contact, comment)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     WHERE NOT EXISTS (
       SELECT 1 FROM bookings
       WHERE date = ?1 AND status != 'cancelled'
         AND start_min < ?2 + ?3 + ?10 AND start_min + dur + ?10 > ?2
     )`
  ).bind(date, start, svc.dur, svc.ids.join(','), svc.total, name, phone, contact, comment, B).run();
  if (res.meta.changes !== 1) return json({ ok: false, error: 'taken' }, 409, origin);

  const id = res.meta.last_row_id;
  const lines = [
    '💅 <b>Новая запись #' + id + '</b>',
    '',
    esc(svc.ids.map((x) => SERVICES[x].name).join(', ')),
    '<b>' + esc(fmtDay(date)) + ', ' + fmtTime(start) + '–' + fmtTime(start + svc.dur) + '</b> (' + fmtDur(svc.dur) + ')',
    'Сумма: <b>' + rub(svc.total) + '</b>' + (svc.discount ? ' (скидка за комплекс ' + rub(svc.discount) + ')' : ''),
    '',
    esc(name) + ', ' + phoneLink(phone),
    'Удобнее: ' + CONTACT_WAYS[contact]
  ];
  if (comment) lines.push('', '💬 ' + esc(comment));
  // Запись уже в базе. Если Telegram не ответил — не пугаем клиентку ошибкой.
  await telegram(env, lines.join('\n')).catch(() => false);

  // Точный адрес отдаём только после записи: на сайте его нет, в репозитории тоже
  const address = env.ADDRESS
    ? { line: env.ADDRESS, note: env.ADDRESS_NOTE || '', map: 'https://yandex.ru/maps/?text=' + encodeURIComponent(env.ADDRESS) }
    : null;

  return json({
    ok: true, id, date, time: fmtTime(start), end: fmtTime(start + svc.dur),
    dur: svc.dur, total: svc.total, discount: svc.discount, address
  }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });

    try {
      if (request.method === 'GET' && url.pathname === '/slots') return await handleSlots(url, env, origin);
      if (request.method !== 'POST') return json({ ok: false, error: 'Not found' }, 404, origin);
      if (!ALLOWED_ORIGINS.includes(origin)) return json({ ok: false, error: 'Forbidden' }, 403, origin);

      let d;
      try { d = await request.json(); } catch { return json({ ok: false, error: 'Bad JSON' }, 400, origin); }

      // Поле-ловушка: человек его не видит, а спам-бот заполнит
      if (d.website) return json({ ok: true }, 200, origin);

      // Та же проверка, что на сайте: сервер не доверяет браузеру
      const digits = String(d.phone || '').replace(/\D/g, '');
      if (clip(d.name, 60).length < 2 || digits.length !== 11 || d.consent !== true) {
        return json({ ok: false, error: 'Проверьте имя, телефон и согласие' }, 422, origin);
      }
      if (tooMany(request.headers.get('CF-Connecting-IP') || 'unknown')) {
        return json({ ok: false, error: 'Слишком много заявок, напишите мастеру: ' + MASTER_PHONE }, 429, origin);
      }

      if (d.type === 'booking') return await handleBooking(d, env, origin);
      return json({ ok: false, error: 'Unknown type' }, 400, origin);
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: 'Server error' }, 500, origin);
    }
  }
};

