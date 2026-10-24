/* =========================================================
   Ногтевой кабинет «Миндаль» — скрипты
   Без фреймворков. Каждый блок — отдельная функция init*().
   Правила расписания — в js/schedule.js (window.Schedule).
   ========================================================= */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var S = window.Schedule;

  // Адрес Cloudflare Worker (см. worker/): свободные окна из базы и запись с сообщением в Telegram.
  // Пустая строка — демо-режим: окна считаются в браузере, запись никуда не уходит.
  var LEAD_ENDPOINT = '';

  var MASTER_PHONE = '+7 (999) 555-01-23';

  /* Адрес для ДЕМО-режима. В рабочем режиме адрес приходит только с сервера
     в ответе на запись (секреты ADDRESS и ADDRESS_NOTE у воркера), поэтому его нет
     ни в коде сайта, ни в репозитории. При подключении воркера этот объект можно удалить. */
  var DEMO_ADDRESS = {
    line: 'Москва, ул. Миндальная, 7, кв. 112',
    note: 'Подъезд 3, этаж 9. Домофон: 112, затем «Вызов». Адрес вымышленный — это демо.',
    map: 'https://yandex.ru/maps/?text=%D0%BC%D0%B5%D1%82%D1%80%D0%BE%20%D0%9C%D0%B8%D1%82%D0%B8%D0%BD%D0%BE'
  };

  /* ---------- Утилиты форматирования ---------- */

  // 2600 -> «2 600 ₽» (неразрывные пробелы, чтобы цена не разрывалась)
  function rub(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }
  // 150 -> «2 ч 30 мин»
  function duration(min) {
    var h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + ' мин';
    return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  }
  function dateObj(key) { var a = key.split('-').map(Number); return new Date(Date.UTC(a[0], a[1] - 1, a[2])); }
  function fmtDate(key, opts) { return dateObj(key).toLocaleDateString('ru-RU', Object.assign({ timeZone: 'UTC' }, opts)); }
  // «чт, 30 октября»
  function dayLabel(key) { return fmtDate(key, { weekday: 'short' }) + ', ' + fmtDate(key, { day: 'numeric', month: 'long' }); }

  /* ---------- Сеть ---------- */
  function postLead(data) {
    return fetch(LEAD_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (json) {
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return json;
      });
    });
  }

  /* Свободные окна на 21 день для набора услуг.
     С сервером — GET /slots (учитывает реальные записи). Демо — считаем здесь же,
     плюс записи, сделанные в этой вкладке, чтобы повторная запись не легла на то же время. */
  var localBookings = [];
  function loadDays(ids, dur) {
    if (LEAD_ENDPOINT) {
      return fetch(LEAD_ENDPOINT + '/slots?services=' + encodeURIComponent(ids.join(',')), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (json) { return json.days; });
    }
    var now = S.moscowNow();
    return Promise.resolve(S.buildDays(dur, localBookings, { todayKey: now.key, nowMin: now.min }));
  }

  /* ---------- Шапка и меню ---------- */
  function initHeader() {
    var header = $('#header');
    var burger = $('.burger');
    var menu = $('#mobile-menu');

    function onScroll() { header.classList.toggle('is-scrolled', window.scrollY > 10); }
    requestAnimationFrame(onScroll);
    window.addEventListener('scroll', onScroll, { passive: true });

    function setMenu(open) {
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
      menu.hidden = !open;
      document.body.classList.toggle('menu-open', open);
    }
    burger.addEventListener('click', function () { setMenu(burger.getAttribute('aria-expanded') !== 'true'); });
    menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) { setMenu(false); burger.focus(); }
    });
    window.matchMedia('(min-width: 1024px)').addEventListener('change', function () { setMenu(false); });

    // Подсветка пункта меню текущей секции
    if (!('IntersectionObserver' in window)) return;
    var links = $$('.nav a');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('href') === '#' + en.target.id); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    links.forEach(function (a) { var s = $(a.getAttribute('href')); if (s) io.observe(s); });
  }

  /* ---------- Появление блоков при прокрутке ---------- */
  function initReveal() {
    var items = $$('.reveal');
    if (!('IntersectionObserver' in window) || reduceMotion) {
      items.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Галерея с фильтром (техника FLIP) ---------- */
  function initGallery() {
    var buttons = $$('.filters button');
    var items = $$('.gallery__item');
    var status = $('#gallery-status');

    // Нечётное число работ на телефоне: первая — широкая, чтобы в сетке 2×N не было «сироты»
    function layout() {
      var visible = items.filter(function (el) { return !el.hidden; });
      items.forEach(function (el) { el.classList.toggle('is-wide', visible.length % 2 === 1 && el === visible[0]); });
      return visible.length;
    }
    layout();

    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var f = btn.dataset.filter;
        buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
        var first = new Map();
        items.forEach(function (el) { if (!el.hidden) first.set(el, el.getBoundingClientRect()); });
        items.forEach(function (el) { el.hidden = !(f === 'all' || el.dataset.cat === f); });
        var n = layout();
        status.textContent = 'Показано работ: ' + n;
        if (reduceMotion) return;
        items.forEach(function (el) {
          if (el.hidden) return;
          var last = el.getBoundingClientRect();
          var was = first.get(el);
          var anim = was
            ? [{ transform: 'translate(' + (was.left - last.left) + 'px,' + (was.top - last.top) + 'px)' }, { transform: 'none' }]
            : [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }];
          el.animate(anim, { duration: 450, easing: 'cubic-bezier(.2,.7,.2,1)' });
        });
      });
    });
  }

  /* ---------- Маска телефона и проверка полей ---------- */
  function phoneDigits(v) {
    var d = v.replace(/\D/g, '');
    if (d[0] === '8' || d[0] === '7') d = d.slice(1);
    return d.slice(0, 10);
  }
  function formatPhone(d) {
    var out = '+7';
    if (d.length) out += ' (' + d.slice(0, 3);
    if (d.length >= 3) out += ')';
    if (d.length > 3) out += ' ' + d.slice(3, 6);
    if (d.length > 6) out += '-' + d.slice(6, 8);
    if (d.length > 8) out += '-' + d.slice(8, 10);
    return out;
  }
  function initPhoneMask(input) {
    var prev = '';
    input.addEventListener('focus', function () { if (!input.value) input.value = '+7 ('; });
    input.addEventListener('blur', function () { if (phoneDigits(input.value).length === 0) input.value = ''; });
    input.addEventListener('input', function (e) {
      var d = phoneDigits(input.value);
      // Набрали «8» или «7» первой цифрой по привычке — это код страны, он уже стоит
      if (!phoneDigits(prev) && (d === '8' || d === '7')) d = '';
      // Стёрли скобку или дефис — стираем и цифру перед ними
      if (e.inputType === 'deleteContentBackward' && d === phoneDigits(prev)) d = d.slice(0, -1);
      input.value = d.length ? formatPhone(d) : (document.activeElement === input ? '+7 (' : '');
      prev = input.value;
    });
    input.addEventListener('paste', function () { setTimeout(function () { input.dispatchEvent(new Event('input')); }, 0); });
  }

  var validators = {
    name: function (v) {
      v = v.trim();
      if (!v) return 'Введите имя';
      if (v.length < 2) return 'Имя слишком короткое';
      if (!/^[A-Za-zА-Яа-яЁё\s'-]+$/.test(v)) return 'Используйте только буквы';
      return '';
    },
    phone: function (v) {
      var d = phoneDigits(v);
      if (!d.length) return 'Введите телефон';
      if (d.length < 10) return 'Введите телефон полностью';
      return '';
    },
    consent: function (v, el) { return el.checked ? '' : 'Без согласия я не смогу принять запись'; }
  };

  function validateField(el) {
    var err = validators[el.dataset.validate](el.value, el);
    var wrap = el.closest('.field, .consent');
    var box = $('.field__error, .consent__error', wrap);
    wrap.classList.toggle('is-invalid', !!err);
    wrap.classList.toggle('is-valid', !err && el.type !== 'checkbox');
    el.setAttribute('aria-invalid', String(!!err));
    box.textContent = err;
    return !err;
  }
  function initFieldValidation(form) {
    $$('[data-mask="phone"]', form).forEach(initPhoneMask);
    $$('[data-validate]', form).forEach(function (el) {
      // Проверяем «на лету», но только после первого ухода с поля — чтобы не ругаться на полуслове
      el.addEventListener('blur', function () { if (el.type !== 'checkbox') { el.dataset.touched = '1'; validateField(el); } });
      el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', function () {
        if (el.dataset.touched || el.type === 'checkbox') validateField(el);
      });
    });
  }
  function validateAll(root) {
    var firstBad = null;
    $$('[data-validate]', root).forEach(function (el) {
      el.dataset.touched = '1';
      if (!validateField(el) && !firstBad) firstBad = el;
    });
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  /* ---------- Услуги: берём прямо из таблицы цен ---------- */
  var SERVICES = $$('#price-table tr[data-id]').map(function (tr) {
    return { id: tr.dataset.id, group: tr.dataset.group, name: $('b', tr).textContent, dur: +tr.dataset.dur, price: +tr.dataset.price };
  });
  function svc(id) { return SERVICES.find(function (s) { return s.id === id; }); }

  /* ---------- Ближайшее окно на первом экране ---------- */
  function initNextSlot() {
    var box = $('#next-slot');
    var base = svc('mani_gel');
    if (!box || !base) return;
    loadDays([base.id], base.dur).then(function (days) {
      var d = days.find(function (x) { return x.free.length; });
      if (!d) return;
      box.innerHTML = 'Ближайшее окно на маникюр с покрытием: <b>' + dayLabel(d.date) + ', ' + d.free[0] + '</b>';
      box.hidden = false;
    }).catch(function () { /* без окна на первом экране сайт тоже работает */ });
  }

  /* ---------- Онлайн-запись ---------- */
  function initBooking() {
    var form = $('#booking-form');
    if (!form) return;

    var state;
    function reset() { state = { step: 1, mani: '', pedi: '', extra: [], date: null, time: null, days: null, daysKey: '', result: null }; }
    reset();

    var steps = $$('.step', form);
    var progress = $$('.progress li', form);
    var btnBack = $('#step-back'), btnNext = $('#step-next'), btnSubmit = $('#step-submit');
    var errorBox = $('#step-error');
    var stepNames = ['услуги', 'дата и время', 'контакты'];
    var check = '<span class="choice__mark"><svg aria-hidden="true"><use href="#i-check"/></svg></span>';

    function ids() { return [state.mani, state.pedi].concat(state.extra).filter(Boolean); }
    // Та же функция, что на сервере: длительность, скидка за комплекс, итог
    function calc() { return S.parseServices(ids()); }

    /* Шаг 1: услуги по группам */
    var groupsBox = $('#svc-groups');
    var GROUPS = [
      { id: 'mani', title: 'Маникюр', none: 'Без маникюра' },
      { id: 'pedi', title: 'Педикюр', none: 'Без педикюра' },
      { id: 'extra', title: 'Дополнительно' }
    ];
    function choice(type, name, value, title, sub, price, checked, extraCls) {
      return '<label class="choice' + (extraCls || '') + '"><input type="' + type + '" name="' + name + '" value="' + value + '"' + (checked ? ' checked' : '') + '>' +
        '<span class="choice__box">' + check + '<span class="choice__text"><b>' + title + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' +
        (price ? '<span class="choice__price">' + price + '</span>' : '') + '</span></label>';
    }
    function renderServices() {
      groupsBox.innerHTML = GROUPS.map(function (g) {
        var list = SERVICES.filter(function (s) { return s.group === g.id; });
        var html = list.map(function (s) {
          var isChecked = g.id === 'extra' ? state.extra.indexOf(s.id) > -1 : state[g.id] === s.id;
          return choice(g.id === 'extra' ? 'checkbox' : 'radio', 'svc-' + g.id, s.id, s.name, duration(s.dur),
            (g.id === 'extra' ? '+' : '') + rub(s.price), isChecked);
        }).join('');
        if (g.none) html = choice('radio', 'svc-' + g.id, '', g.none, '', '', !state[g.id], ' choice--none') + html;
        return '<fieldset class="svc-group"><legend>' + g.title + '</legend><div class="choice-list' + (g.id !== 'mani' ? ' choice-list--2' : '') + '">' + html + '</div></fieldset>';
      }).join('');
    }
    groupsBox.addEventListener('change', function (e) {
      var g = e.target.name.replace('svc-', '');
      if (g === 'extra') state.extra = $$('input[name="svc-extra"]:checked', groupsBox).map(function (i) { return i.value; });
      else state[g] = e.target.value;
      state.time = null; // другая длительность — другие окна
      errorBox.textContent = '';
      renderSummary();
    });

    /* Шаг 2: дата и окна */
    var datesBox = $('#dates'), slotsBox = $('#slots'), hint = $('#dur-hint');

    function renderDates() {
      var c = calc();
      var key = ids().slice().sort().join(',');
      hint.innerHTML = 'Процедуры займут <b>' + duration(c.dur) + '</b>. Показываю только окна, куда они помещаются целиком.';
      if (state.days && state.daysKey === key) return drawDates();
      datesBox.innerHTML = '';
      slotsBox.innerHTML = '<p class="slots-empty" role="status">Загружаю свободные окна…</p>';
      loadDays(ids(), c.dur).then(function (days) {
        state.days = days; state.daysKey = key;
        drawDates();
      }).catch(function () {
        slotsBox.innerHTML = '<p class="slots-empty">Не удалось загрузить расписание. <button type="button" class="btn btn--link" id="slots-retry">Попробовать ещё раз</button> или напишите мне: <a href="tel:+79995550123">' + MASTER_PHONE + '</a>.</p>';
        $('#slots-retry').addEventListener('click', renderDates);
      });
    }
    function drawDates() {
      var days = state.days;
      if (!state.date || !days.some(function (d) { return d.date === state.date && d.free.length; })) {
        var first = days.find(function (d) { return d.free.length; });
        state.date = first ? first.date : null;
      }
      datesBox.innerHTML = days.map(function (d, i) {
        var dt = dateObj(d.date);
        var wd = i === 0 ? 'сег' : fmtDate(d.date, { weekday: 'short' });
        var note = d.off ? 'вых' : (d.free.length ? fmtDate(d.date, { month: 'short' }).replace('.', '') : 'занято');
        var label = (i === 0 ? 'Сегодня, ' : '') + dayLabel(d.date) + (d.off ? ', выходной' : (d.free.length ? ', свободных окон: ' + d.free.length : ', всё занято'));
        return '<button type="button" class="date-btn" data-date="' + d.date + '" aria-pressed="' + (d.date === state.date) + '"' +
          (d.free.length ? '' : ' disabled') + ' aria-label="' + label + '"><span>' + wd + '</span><b>' + dt.getUTCDate() + '</b><span class="date-btn__free">' + note + '</span></button>';
      }).join('');
      drawSlots();
      var sel = $('.date-btn[aria-pressed="true"]', datesBox);
      if (sel) datesBox.scrollLeft = Math.max(0, sel.offsetLeft - datesBox.offsetLeft - 8);
    }
    function drawSlots() {
      var d = state.days.find(function (x) { return x.date === state.date; });
      if (!d) {
        slotsBox.innerHTML = '<p class="slots-empty">На ближайшие три недели свободных окон под такой набор нет. Попробуйте убрать одну процедуру или напишите мне — иногда освобождается время.</p>';
        return;
      }
      if (d.free.indexOf(state.time) === -1) state.time = null;
      var parts = [['Утро', 0, 720], ['День', 720, 960], ['Вечер', 960, 1440]];
      slotsBox.innerHTML = parts.map(function (p) {
        var list = d.free.filter(function (t) { var m = S.parseTime(t); return m >= p[1] && m < p[2]; });
        if (!list.length) return '';
        return '<div class="slot-group" role="group" aria-label="' + p[0] + ', ' + dayLabel(d.date) + '"><p class="slot-group__title" aria-hidden="true">' + p[0] + '</p><div class="slot-grid">' +
          list.map(function (t) {
            return '<button type="button" class="slot" data-time="' + t + '" aria-pressed="' + (state.time === t) + '">' + t + '</button>';
          }).join('') + '</div></div>';
      }).join('');
    }
    datesBox.addEventListener('click', function (e) {
      var b = e.target.closest('.date-btn'); if (!b || b.disabled) return;
      state.date = b.dataset.date; state.time = null;
      $$('.date-btn', datesBox).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      drawSlots(); renderSummary();
    });
    slotsBox.addEventListener('click', function (e) {
      var b = e.target.closest('.slot'); if (!b) return;
      state.time = b.dataset.time;
      $$('.slot', slotsBox).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      errorBox.textContent = '';
      renderSummary();
    });

    /* Итог справа */
    function endTime() { return S.fmtTime(S.parseTime(state.time) + calc().dur); }
    function renderSummary() {
      var list = ids().map(svc), c = calc();
      $('#sum-services').textContent = list.length ? list.map(function (s) { return s.name; }).join(', ') : 'Не выбраны';
      $('#sum-date').textContent = state.time ? dayLabel(state.date) + ', ' + state.time + '–' + endTime() : '—';
      $('#sum-dur').textContent = c.error ? '—' : duration(c.dur);
      $('#sum-discount-row').hidden = !c.discount;
      $('#sum-discount').textContent = c.discount ? '−' + rub(c.discount) + ' за комплекс' : '';
      $('#sum-total').textContent = c.error ? '—' : rub(c.total);
      $('#step-total').textContent = c.error ? '' : rub(c.total);
    }

    /* Переходы между шагами */
    function validateStep() {
      if (state.step === 1) return calc().error || '';
      if (state.step === 2 && !state.time) return 'Выберите удобное время';
      return '';
    }
    function goTo(n, focus) {
      state.step = n;
      steps.forEach(function (s) { s.hidden = +s.dataset.step !== n; });
      progress.forEach(function (li, i) {
        li.classList.toggle('is-current', i === n - 1);
        li.classList.toggle('is-done', i < n - 1);
      });
      btnBack.hidden = n === 1;
      btnNext.hidden = n === 3;
      btnSubmit.hidden = n !== 3;
      errorBox.textContent = '';
      $('#step-status').textContent = 'Шаг ' + n + ' из 3: ' + stepNames[n - 1];
      if (n === 2) renderDates();
      if (focus) {
        var fs = steps[n - 1];
        fs.setAttribute('tabindex', '-1');
        fs.focus({ preventScroll: true });
        if (form.getBoundingClientRect().top < 0) form.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }
    }
    btnNext.addEventListener('click', function () {
      var err = validateStep();
      if (err) { errorBox.textContent = err; return; }
      goTo(state.step + 1, true);
    });
    btnBack.addEventListener('click', function () { goTo(state.step - 1, true); });

    initFieldValidation(form);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.step !== 3) { btnNext.click(); return; }
      if (!validateAll(steps[2])) return;
      var data = {
        type: 'booking',
        services: ids(),          // только коды: цену и длительность сервер посчитает сам
        date: state.date,
        time: state.time,
        name: $('#b-name').value.trim(),
        phone: $('#b-phone').value,
        contact: ($('input[name="contact"]:checked', form) || {}).value || 'telegram',
        comment: $('#b-comment').value,
        consent: true,
        website: $('[name="website"]', form).value
      };

      var request;
      if (LEAD_ENDPOINT) {
        var label = btnSubmit.innerHTML;
        btnSubmit.disabled = true;
        btnSubmit.textContent = 'Записываю…';
        request = postLead(data).finally(function () { btnSubmit.disabled = false; btnSubmit.innerHTML = label; });
      } else {
        // Демо: «сервер» в браузере. Запоминаем запись, чтобы это время пропало из окон.
        var c = calc();
        localBookings.push({ date: state.date, start_min: S.parseTime(state.time), dur: c.dur });
        request = Promise.resolve({ ok: true, id: 1000 + S.hash(String(Date.now())) % 9000, total: c.total, dur: c.dur, address: DEMO_ADDRESS });
      }

      errorBox.textContent = '';
      request.then(function (res) {
        state.result = res;
        showSuccess(data);
      }, function (err) {
        if (err.status === 409) {
          // Окно заняли, пока человек заполнял форму: обновляем расписание и возвращаем на шаг 2
          state.days = null; state.time = null;
          goTo(2, true);
          errorBox.textContent = 'Это время только что заняли. Выберите другое — расписание обновлено.';
          renderSummary();
          return;
        }
        errorBox.textContent = 'Не получилось записаться. Проверьте интернет или напишите мне: ' + MASTER_PHONE + '.';
      });
    });

    var WAYS = { telegram: 'в Telegram', whatsapp: 'в WhatsApp', call: 'звонком' };
    function showSuccess(data) {
      var res = state.result;
      $('#booking-success-text').textContent = data.name + ', жду вас ' + dayLabel(state.date) + ' в ' + state.time +
        '. Закончим примерно в ' + endTime() + '. Сумма — ' + rub(res.total) + ', оплата после процедуры. ' +
        'Подтверждение пришлю ' + WAYS[data.contact] + ' на ' + data.phone + '.';
      var a = res.address;
      $('#address-line').textContent = a ? a.line : 'Точный адрес пришлю вместе с подтверждением';
      $('#address-note').textContent = a ? a.note : '';
      $('#address-map').hidden = !(a && a.map);
      if (a && a.map) $('#address-map').href = a.map;
      if (res.id) $('#sum-note').textContent = 'Номер записи: ' + res.id + '. Оплата после процедуры: СБП или наличные.';
      $$('.step, .step-nav, .progress, #step-error', form).forEach(function (el) { el.hidden = true; });
      var ok = $('#booking-success');
      ok.hidden = false;
      ok.focus();
      if (ok.getBoundingClientRect().top < 0) form.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }

    /* .ics — событие для любого календаря, с адресом и двумя напоминаниями */
    function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n'); }
    // Строки длиннее 75 байт по стандарту переносятся (RFC 5545, п. 3.1)
    function fold(line) {
      var out = [], cur = '', bytes = 0, enc = new TextEncoder();
      Array.from(line).forEach(function (ch) {
        var b = enc.encode(ch).length;
        if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
        cur += ch; bytes += b;
      });
      out.push(cur);
      return out.join('\r\n ');
    }
    $('#add-calendar').addEventListener('click', function () {
      var p = state.date.split('-').map(Number), m = S.parseTime(state.time);
      // Москва = UTC+3 круглый год, переводим в UTC
      var start = new Date(Date.UTC(p[0], p[1] - 1, p[2], 0, m - 180));
      var end = new Date(start.getTime() + calc().dur * 60000);
      var fmt = function (d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
      var a = state.result.address;
      var desc = ids().map(function (id) { return svc(id).name; }).join(', ') + '. Сумма: ' + rub(state.result.total) + '.' +
        (a && a.note ? '\n' + a.note : '') +
        '\nОтмена или перенос — не позже чем за 12 часов: ' + MASTER_PHONE + ' (Telegram, WhatsApp).';
      var lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mindal Nails//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        'UID:' + (state.result.id || Date.now()) + '-' + state.date + '@mindal-nails',
        'DTSTAMP:' + fmt(new Date()),
        'DTSTART:' + fmt(start),
        'DTEND:' + fmt(end),
        'SUMMARY:' + icsEscape('Маникюр у Веры («Миндаль»)'),
        'DESCRIPTION:' + icsEscape(desc),
        'LOCATION:' + icsEscape(a ? a.line : 'Москва, Митино (адрес пришлёт мастер)'),
        'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape('Завтра — маникюр у Веры'), 'END:VALARM',
        'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEscape('Через 2 часа — маникюр у Веры'), 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR'
      ];
      var ics = lines.map(fold).join('\r\n');
      var url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
      var link = document.createElement('a');
      link.href = url; link.download = 'mindal-' + state.date + '.ics';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    $('#booking-again').addEventListener('click', function () {
      form.reset();
      $$('.field, .consent', form).forEach(function (w) { w.classList.remove('is-invalid', 'is-valid'); });
      $$('[data-touched]', form).forEach(function (el) { delete el.dataset.touched; });
      reset();
      $('#booking-success').hidden = true;
      $('#sum-note').textContent = 'Оплата после процедуры: СБП или наличные.';
      $$('.step-nav, .progress, #step-error', form).forEach(function (el) { el.hidden = false; });
      renderServices();
      goTo(1, true);
      renderSummary();
    });

    renderServices();
    goTo(1, false);
    renderSummary();
  }

  /* ---------- Липкая кнопка «Записаться» ---------- */
  function initStickyCta() {
    var cta = $('#sticky-cta');
    var booking = $('#booking');
    var hero = $('.hero');
    if (!cta || !('IntersectionObserver' in window)) return;
    var inBooking = false, inHero = true;
    function update() { cta.classList.toggle('is-hidden', inBooking || inHero); }
    new IntersectionObserver(function (en) { inBooking = en[0].isIntersecting; update(); }, { threshold: 0.05 }).observe(booking);
    // На первом экране уже есть большая кнопка — дубль не показываем
    new IntersectionObserver(function (en) { inHero = en[0].isIntersecting; update(); }, { threshold: 0.35 }).observe(hero);
    update();
  }

  /* ---------- Cookie-баннер ---------- */
  function initCookie() {
    var box = $('#cookie');
    if (!box) return;
    var KEY = 'mindal-cookie-ok';
    var ok = false;
    try { ok = localStorage.getItem(KEY) === '1'; } catch (e) { /* приватный режим */ }
    if (ok) return;
    box.hidden = false;
    $('#cookie-ok').addEventListener('click', function () {
      try { localStorage.setItem(KEY, '1'); } catch (e) { /* ничего страшного */ }
      box.hidden = true;
    });
  }

  /* ---------- Запуск ---------- */
  [initHeader, initReveal, initGallery, initNextSlot, initBooking, initStickyCta, initCookie]
    .forEach(function (fn) {
      try { fn(); } catch (err) { console.error('[Миндаль] ' + fn.name + ':', err); }
    });
})();
