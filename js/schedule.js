/* =========================================================
   «Миндаль» — правила расписания. ОДИН файл для сайта и сервера.

   Сайт подключает его обычным <script> (в демо-режиме свободные окна
   считаются прямо в браузере), Cloudflare Worker — через import
   (worker/index.js). Поэтому рабочие часы, перерыв, выходные и
   длительности услуг меняются в одном месте.

   Время внутри — минуты от полуночи по Москве: 10:00 -> 600.
   ========================================================= */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Worker, Node
  else root.Schedule = api;                                               // браузер
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- Настройки мастера ---------- */
  var WORK_DAYS = [2, 3, 4, 5, 6];      // дни недели: 0 — вс, 1 — пн ... Работаю вт–сб
  var OPEN_MIN = 10 * 60;               // первая клиентка в 10:00
  var CLOSE_MIN = 20 * 60;              // услуга должна закончиться до 20:00
  var BREAK = [14 * 60, 15 * 60];       // обед 14:00–15:00: в это время процедур нет
  var STEP_MIN = 30;                    // окна начинаются каждые 30 минут
  var BUFFER_MIN = 15;                  // после каждой клиентки 15 минут на дезинфекцию
  var DAYS_AHEAD = 21;                  // запись на 3 недели вперёд — как раз до следующей коррекции
  var MIN_LEAD_MIN = 120;               // на сегодня — не позже чем за 2 часа
  var DAYS_OFF = ['2026-11-04', '2026-12-31', '2027-01-01', '2027-01-02']; // праздники и отпуск
  var COMBO_DISCOUNT = 300;             // маникюр + педикюр в один визит

  /* Услуги. group: в группах mani и pedi можно выбрать только одну услугу,
     extra — дополнения, только вместе с маникюром или педикюром.
     Цены дублируют прайс на сайте (index.html, data-price). Тест сверяет их. */
  var SERVICES = {
    mani_clean:  { name: 'Маникюр без покрытия',        group: 'mani',  dur: 60,  price: 1500 },
    mani_gel:    { name: 'Маникюр с покрытием гель-лак', group: 'mani',  dur: 120, price: 2600 },
    mani_ext:    { name: 'Наращивание ногтей',          group: 'mani',  dur: 180, price: 3800 },
    pedi_clean:  { name: 'Педикюр без покрытия',        group: 'pedi',  dur: 60,  price: 2000 },
    pedi_gel:    { name: 'Педикюр с покрытием гель-лак', group: 'pedi',  dur: 90,  price: 2800 },
    ex_remove:   { name: 'Снятие покрытия другого мастера', group: 'extra', dur: 15, price: 300 },
    ex_design:   { name: 'Дизайн: френч, втирка, рисунок', group: 'extra', dur: 30, price: 500 },
    ex_strength: { name: 'Укрепление базой',            group: 'extra', dur: 15,  price: 400 }
  };

  /* ---------- Утилиты ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(min) { return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  function parseTime(s) {
    var m = /^(\d{2}):(\d{2})$/.exec(String(s || ''));
    return m ? +m[1] * 60 + +m[2] : -1;
  }
  // Пересекаются ли полуинтервалы [a1, a2) и [b1, b2)
  function overlaps(a1, a2, b1, b2) { return a1 < b2 && b1 < a2; }

  // FNV-1a: одинаковая строка -> одинаковое число (для демо-занятости)
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // Сейчас по Москве: { key: '2026-10-25', min: 754 }. now — для тестов.
  function moscowNow(now) {
    var p = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now || new Date()).forEach(function (x) { p[x.type] = x.value; });
    return { key: p.year + '-' + p.month + '-' + p.day, min: (+p.hour % 24) * 60 + +p.minute };
  }

  // Ключи дат на DAYS_AHEAD дней вперёд, начиная с сегодняшней московской
  function nextDays(todayKey) {
    var a = todayKey.split('-').map(Number), out = [];
    for (var i = 0; i < DAYS_AHEAD; i++) {
      var d = new Date(Date.UTC(a[0], a[1] - 1, a[2] + i));
      out.push(d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()));
    }
    return out;
  }
  function weekday(key) {
    var a = key.split('-').map(Number);
    return new Date(Date.UTC(a[0], a[1] - 1, a[2])).getUTCDay();
  }
  function isWorkingDay(key) {
    return WORK_DAYS.indexOf(weekday(key)) > -1 && DAYS_OFF.indexOf(key) === -1;
  }

  /* ---------- Услуги ---------- */
  // Разбирает список кодов. Ошибка — строка, иначе { ids, dur, sum, discount, total }
  function parseServices(list) {
    var raw = Array.isArray(list) ? list : String(list || '').split(',');
    var ids = [];
    raw.forEach(function (s) {
      s = String(s).trim();
      if (SERVICES[s] && ids.indexOf(s) === -1) ids.push(s);
    });
    var groups = ids.map(function (id) { return SERVICES[id].group; });
    var has = function (g) { return groups.indexOf(g) > -1; };
    var count = function (g) { return groups.filter(function (x) { return x === g; }).length; };
    if (!has('mani') && !has('pedi')) return { error: 'Выберите маникюр или педикюр' };
    if (count('mani') > 1 || count('pedi') > 1) return { error: 'Можно выбрать только один вид маникюра и один вид педикюра' };
    var dur = 0, sum = 0;
    ids.forEach(function (id) { dur += SERVICES[id].dur; sum += SERVICES[id].price; });
    var discount = has('mani') && has('pedi') ? COMBO_DISCOUNT : 0;
    return { ids: ids, dur: dur, sum: sum, discount: discount, total: sum - discount };
  }

  /* ---------- Демо-занятость ----------
     В новой базе записей нет, и пустой календарь выглядит неправдоподобно.
     Поэтому в каждый рабочий день «записаны» 1–3 вымышленные клиентки.
     Реальные записи ложатся поверх. Для настоящего мастера: DEMO_BUSY = false. */
  var DEMO_BUSY = true;
  function demoBookings(key) {
    if (!DEMO_BUSY || !isWorkingDay(key)) return [];
    var out = [], n = 1 + hash(key) % 3;
    for (var i = 0; i < 12 && out.length < n; i++) {
      var h = hash(key + '#' + i);
      var dur = [90, 120, 150][h % 3];
      var start = OPEN_MIN + (h >>> 4) % ((CLOSE_MIN - OPEN_MIN) / STEP_MIN) * STEP_MIN;
      if (fits(start, dur, out)) out.push({ start_min: start, dur: dur });
    }
    return out;
  }

  /* ---------- Главное: свободно ли окно ----------
     Процедура [start, start + dur) должна:
       - начаться не раньше открытия и закончиться не позже закрытия;
       - не задевать обеденный перерыв;
       - вместе с 15 минутами на дезинфекцию не пересекаться ни с одной записью
         (у записей тоже учитываем их 15 минут после). */
  function fits(start, dur, bookings) {
    if (start < OPEN_MIN || start + dur > CLOSE_MIN) return false;
    if (overlaps(start, start + dur, BREAK[0], BREAK[1])) return false;
    for (var i = 0; i < bookings.length; i++) {
      var b = bookings[i];
      if (overlaps(start, start + dur + BUFFER_MIN, b.start_min, b.start_min + b.dur + BUFFER_MIN)) return false;
    }
    return true;
  }

  // ctx: { todayKey, nowMin }. bookings — реальные записи этого дня из базы.
  function isFree(key, start, dur, bookings, ctx) {
    if (!isWorkingDay(key)) return false;
    if (start % STEP_MIN !== 0) return false;
    if (key === ctx.todayKey && start < ctx.nowMin + MIN_LEAD_MIN) return false;
    return fits(start, dur, demoBookings(key).concat(bookings || []));
  }

  // Все свободные начала в этот день: ['10:00', '10:30', ...]
  function freeTimes(key, dur, bookings, ctx) {
    var out = [];
    for (var t = OPEN_MIN; t + dur <= CLOSE_MIN; t += STEP_MIN) {
      if (isFree(key, t, dur, bookings, ctx)) out.push(fmtTime(t));
    }
    return out;
  }

  // Расписание на все дни: [{ date, off, free }]. allBookings — записи за весь период.
  function buildDays(dur, allBookings, ctx) {
    return nextDays(ctx.todayKey).map(function (key) {
      var mine = (allBookings || []).filter(function (b) { return b.date === key; });
      var off = !isWorkingDay(key);
      return { date: key, off: off, free: off ? [] : freeTimes(key, dur, mine, ctx) };
    });
  }

  return {
    WORK_DAYS: WORK_DAYS, OPEN_MIN: OPEN_MIN, CLOSE_MIN: CLOSE_MIN, BREAK: BREAK,
    STEP_MIN: STEP_MIN, BUFFER_MIN: BUFFER_MIN, DAYS_AHEAD: DAYS_AHEAD, MIN_LEAD_MIN: MIN_LEAD_MIN,
    DAYS_OFF: DAYS_OFF, COMBO_DISCOUNT: COMBO_DISCOUNT, SERVICES: SERVICES,
    pad: pad, fmtTime: fmtTime, parseTime: parseTime, overlaps: overlaps, hash: hash,
    moscowNow: moscowNow, nextDays: nextDays, weekday: weekday, isWorkingDay: isWorkingDay,
    parseServices: parseServices, demoBookings: demoBookings, fits: fits,
    isFree: isFree, freeTimes: freeTimes, buildDays: buildDays
  };
});
