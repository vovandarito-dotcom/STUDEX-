/* STUDEX: связь интерфейса с настоящим сервером (Supabase Edge Function "api").
   Подключается после основного скрипта и заменяет демо-действия на запросы к серверу. */
(function () {
  const C = window.STUDEX || {};
  const tg = window.Telegram && window.Telegram.WebApp;
  const INIT = (tg && tg.initData) || '';
  const API = (C.SUPABASE_URL || '') + '/functions/v1/api';
  const RN = { buyer: 'Покупатель', seller: 'Продавец', admin: 'Администратор', director: 'Директор' };
  const ERR = {
    bad_code: 'Неверный код или он уже использован',
    rate_limited: 'Слишком много попыток. Попробуйте позже',
    contacts: 'Обмен контактами запрещён правилами платформы',
    forbidden: 'Это действие вам недоступно',
    blocked: 'Аккаунт заблокирован',
    conflict: 'Данные уже изменились. Попробуйте ещё раз',
    not_found: 'Не найдено',
    auth: 'Откройте приложение через Telegram',
    bad_title: 'Заголовок: от 5 до 120 символов',
    bad_description: 'Описание слишком короткое или длинное',
    bad_amount: 'Введите корректную сумму',
    bad_message: 'Сообщение пустое или слишком длинное',
  };
  const errMsg = (e) => ERR[e && e.error] || 'Что-то пошло не так. Попробуйте ещё раз';
  let ME = null, busy = false, sig = '';

  async function call(action, data) {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.ANON_KEY, Authorization: 'Bearer ' + C.ANON_KEY, 'x-init-data': INIT },
      body: JSON.stringify(Object.assign({ action }, data || {})),
    });
    const j = await r.json().catch(() => ({ error: 'server' }));
    if (!r.ok || j.error) throw j;
    return j;
  }
  const hm = (iso) => new Date(iso).toTimeString().slice(0, 5);

  function apply(j) {
    const s = j.state;
    if (!s || !s.me) { ME = null; return; }
    ME = s.me;
    S.users = (s.users || []).map((u) => ({ n: u.n, r: RN[u.r], bl: u.bl }));
    P.length = 0;
    (s.offers || []).forEach((o) => P.push(o));
    S.ads = s.ads || [];
    S.orders = s.orders || [];
    S.msgs = {};
    Object.keys(s.msgs || {}).forEach((k) => { S.msgs[k] = s.msgs[k].map((m) => [m.w, m.t, hm(m.at)]); });
    S.led = s.led || [];
    S.cs = s.cs || {};
    S.cmp = s.cmp || [];
    S.audit = (s.audit || []).map((a) => a.t + ' · ' + hm(a.at));
    S.nt = (s.nt || []).map((x) => ({ h: hm(x.at), t: x.t }));
    S.hid = s.hid || [];
    ADL.length = 0;
    S.ab = {};
    (s.admins || []).forEach((a) => { ADL.push([a.n, 'Администратор №' + a.n]); S.ab[a.n] = a.bl; });
    S.mystats = s.stats || {};
  }
  function enter() {
    S.dir = ME.role === 'director';
    S.role = S.dir ? 'admin' : ME.role;
    S.tab = NAV[S.role][0][0];
    S.st = [];
  }
  async function act(action, data, ok) {
    if (busy) return null;
    busy = true;
    try {
      const j = await call(action, data);
      apply(j);
      if (ok) toast(ok);
      busy = false;
      return j;
    } catch (e) {
      toast(errMsg(e));
      busy = false;
      return null;
    } finally {
      draw();
    }
  }
  const openOrder = (id) => { S.st = [{ v: 'order', id }]; S.tab = 'orders'; };

  // Экран загрузки и ошибок
  const draw1 = draw;
  window.draw = function () {
    if (S.loading || S.fatal) {
      const m = document.getElementById('mn');
      document.getElementById('hd').innerHTML = '';
      document.getElementById('ft').innerHTML = '';
      m.style.padding = '8px 18px';
      m.innerHTML = '<div class="sw">' + cap(80) + '<h1 style="font-size:24px;margin-top:12px">STUDEX</h1><p class="mu" style="margin-top:8px">' + (S.fatal || 'Загрузка…') + '</p></div>';
      return;
    }
    draw1();
  };

  // Убираем демо-элементы
  const strip = (h) => h
    .replace(/<h2>Роль в демо<\/h2>(<button class="chip[^>]*>[^<]*<\/button>)+/g, '')
    .replace(/В демо она ничего не копирует\./g, '');
  ['settings', 'sys'].forEach((k) => { const f = V[k]; V[k] = (...a) => strip(f(...a)); });
  window.setRole = function () {};
  const regDraw0 = regDraw;
  window.regDraw = function () {
    regDraw0();
    document.querySelectorAll('#mn p').forEach((p) => { if (p.textContent.indexOf('Демо') === 0) p.remove(); });
  };

  // Действия через сервер
  window.order = async (pid) => { const j = await act('order_new', { offer: pid }, 'Заказ создан'); if (j) { openOrder(j.id); draw(); } };
  window.publish = async function () {
    const d = S.dr;
    if (!d.t || d.t.trim().length < 5) return toast('Заголовок: минимум 5 символов');
    if (!d.d || d.d.trim().length < 20) return toast('Опишите задачу подробнее: минимум 20 символов');
    if (bad(d.t + ' ' + d.d)) return toast('Контакты в объявлении запрещены');
    if (!d.ok) return toast('Подтвердите условия академической честности');
    const j = await act('ad_new', { title: d.t.trim(), category: d.c || CATS[0][0], description: d.d.trim(), term: d.tm || TM[1], type: d.ty || TY[0] }, 'Объявление опубликовано');
    if (j) { S.dr = {}; S.st = []; S.tab = 'catalog'; S.seg = 'ad'; draw(); }
  };
  window.respond = (id) => act('ad_respond', { ad: id }, 'Отклик отправлен');
  window.pick = async (aid, s) => { const j = await act('ad_pick', { ad: aid, seller: s }, 'Исполнитель выбран'); if (j) { openOrder(j.id); S.tab = 'profile'; draw(); } };
  window.propose = function (id) {
    const v = parseFloat(document.getElementById('am').value);
    if (!(v > 0)) return toast('Введите сумму больше нуля');
    return act('propose', { order: id, amount: v }, 'Сумма отправлена покупателю');
  };
  window.o_ = (id) => act('step', { order: id, to: 8 }, 'Вы отказались от суммы, заказ отменён');
  window.step = (id, st, t) => act('step', { order: id, to: st }, t);
  window.rate = (id, n) => act('rate', { order: id, rating: n }, 'Спасибо за отзыв');
  window.cash = function (n) {
    const v = parseFloat(document.getElementById('cs').value);
    if (!(v > 0)) return toast('Введите сумму больше нуля');
    return act('cash', { seller: n, amount: v }, 'Запись добавлена');
  };
  window.block = (n) => act('block', { number: n }, 'Готово');
  window.hide = (k) => act('hide', { key: k });
  window.complain = (id) => act('complain', { order: id }, 'Жалоба отправлена администратору');
  window.decide = (cid, r) => act('decide', { id: cid, r: r }, 'Решение сохранено');
  window.adminChat = async (id) => { const j = await act('chat_open', { order: id }); if (j) { S.st.push({ v: 'chat', id }); draw(); } };
  window.bulk = async function () {
    if (!S.bc) { S.bc = true; draw(); setTimeout(() => { if (S.bc) { S.bc = false; draw(); } }, 4000); return; }
    S.bc = false;
    for (const o of S.orders.filter((x) => x.st === 5)) {
      try { apply(await call('step', { order: o.id, to: 6 })); } catch (e) { toast(errMsg(e)); break; }
    }
    toast('Заказы утверждены');
    draw();
  };
  window.attach = () => toast('Отправка файлов появится в следующем обновлении');
  window.send = async function (id) {
    const i = document.getElementById('mi'), t = i.value.trim();
    if (!t) return;
    if (bad(t)) return toast('Обмен контактами запрещён правилами платформы');
    i.value = '';
    try {
      apply(await call('send', { order: id, text: t }));
      const ms = document.getElementById('ms');
      if (ms) { ms.innerHTML = msgs(id, S.role === 'seller' ? 's' : 'b'); document.getElementById('mn').scrollTop = 1e5; }
    } catch (e) { i.value = t; toast(errMsg(e)); }
  };

  // Регистрация и вход
  window.regGo = async function (m) {
    const g = S.rg;
    if (!g.ok) return toast('Примите правила платформы');
    if (m && [25, 50, 75].indexOf(g.c.trim().length) < 0) return toast('Проверьте код');
    try {
      g.m = 0;
      apply(await call('register', { code: m ? g.c.trim() : null }));
      if (!ME) return toast('Не удалось зарегистрироваться');
      g.done = RN[ME.role] + ' №' + ME.number;
      draw();
    } catch (e) { toast(errMsg(e)); }
  };
  window.regEnter = function () { S.reg = 0; S.rg = null; S.splash = false; enter(); draw(); };

  // Реальные экраны вместо демо-данных
  V.profile = () => {
    const st = S.mystats || {};
    const title = S.dir ? 'Директор' : S.role === 'admin' ? 'Администратор' : S.role === 'seller' ? 'Продавец' : 'Пользователь';
    return '<div style="text-align:center;margin:8px 0 14px"><div class="ic" style="width:96px;height:96px;border-radius:50%;margin:0 auto 10px">' + cap(56) + '</div><h2 style="margin:0">' + title + ' №' + ME.number + '</h2>' + (st.avg ? '<div class="mu">★ ' + st.avg + ' · ' + st.sales + ' заказов</div>' : '') + '</div>' +
      '<div class="row" style="margin-bottom:12px"><div class="stat"><b>' + (st.buys || 0) + '</b>Покупок</div><div class="stat"><b>' + (st.sales || 0) + '</b>Продаж</div><div class="stat"><b>' + (st.avg || '—') + '</b>Рейтинг</div></div>' +
      '<div class="card cl" onclick="go(\'orders\')">Мои заказы</div>' +
      (S.role === 'buyer' ? '<div class="card cl" onclick="go(\'bal\')">Мои расходы: ' + rub(spent()) + '</div><div class="card cl" onclick="go(\'myads\')">Мои объявления</div><div class="card cl" onclick="go(\'fav\')">Избранное: ' + S.fav.size + '</div>' : '') +
      (S.role === 'seller' ? '<div class="card cl" onclick="go(\'myoff\')">Мои предложения</div>' : '') +
      (S.role === 'buyer' ? '<div class="card cl" onclick="S.reg=1;S.rg=null;draw()">У меня есть код</div>' : '') +
      '<div class="card cl" onclick="go(\'about\')">О платформе</div><div class="card cl" onclick="go(\'policy\')">Политика и правила</div>';
  };
  V.myads = () => S.ads.filter((a) => a.b === ME.number).map(cardA).join('') || '<div class="card mu">У вас нет объявлений.</div>';
  V.ad = (id) => {
    const a = ad(id), mine = S.role === 'buyer' && a && a.b === ME.number;
    if (!a) return '<div class="card mu">Объявление недоступно.</div>';
    return '<div class="card"><div class="row"><div class="ic">' + ic(ci(a.c)) + '</div><div class="sp"><b>' + esc(a.t) + '</b><div class="mu">' + a.c + '</div></div></div><p class="mu" style="margin-top:10px">' + esc(a.d) + '</p><div class="row" style="margin-top:10px"><span class="tag">' + a.ty + '</span><span class="tag">Срок: ' + a.tm + '</span></div><p class="mu" style="margin-top:10px">Автор: Покупатель №' + a.b + '</p></div>' +
      (S.role === 'seller' ? (a.rs.indexOf(ME.number) >= 0 ? '<div class="card mu">Вы откликнулись. Ждите решения покупателя.</div>' : '<button class="btn" onclick="respond(' + id + ')">Откликнуться</button>') : '') +
      (mine ? '<h2>Отклики</h2>' + (a.rs.map((s) => '<div class="card row"><div class="ic">' + cap(26) + '</div><div class="sp"><b>Продавец №' + s + '</b></div><button class="chip on" style="margin:0" onclick="pick(' + id + ',' + s + ')">Выбрать</button></div>').join('') || '<div class="card mu">Откликов пока нет.</div>') : '');
  };
  V.finance = () => {
    const n = ME.number, A = accrued(n), C2 = paid(n), D = A - C2;
    return '<div class="card"><div class="mu">Начислено комиссии (20%)</div><div style="font-size:30px;font-weight:700">' + rub(A) + '</div><div class="row mu" style="margin-top:6px"><span>Передано наличными</span><span class="sp"></span>' + rub(C2) + '</div><div class="row" style="margin-top:4px"><b>' + (D >= 0 ? 'Долг перед платформой' : 'Переплата') + '</b><span class="sp"></span><b class="' + (D > 0 ? 'wa' : 'ok') + '">' + rub(Math.abs(D)) + '</b></div></div>' +
      '<div class="card"><div class="mu">Заработано (после комиссии)</div><div style="font-size:26px;font-weight:700">' + rub(earn(n)) + '</div><div class="mu">Деньги вы получили напрямую от покупателей. Это учёт: платформа их не хранит.</div></div>' +
      '<p class="mu" style="margin:0 2px">Комиссия передаётся наличными раз в неделю (пн–вс). Частичная оплата допускается, остаток переносится.</p><h2>Выполненные заказы</h2>' +
      (done().filter((o) => o.s === n).map((o) => '<div class="card row"><span>№' + o.id + '</span><span class="sp"></span><span>' + rub(o.amt) + ' · комиссия ' + rub(fee(o.amt)) + '</span></div>').join('') || '<div class="card mu">Пока нет выполненных заказов.</div>');
  };
  V.admins = () => '<p class="mu" style="margin:4px 2px 10px">Контроль администраторов. Администраторы не видят этот раздел.</p>' +
    (ADL.map((a) => { const bl = (S.ab || {})[a[0]]; return '<div class="card row"><div class="sp"><b>' + a[1] + '</b><div class="mu">' + (bl ? 'Заблокирован' : 'Активен') + '</div></div><button class="chip ' + (bl ? 'on' : '') + '" style="margin:0" onclick="block(' + a[0] + ')">' + (bl ? 'Разблокировать' : 'Заблокировать') + '</button></div>'; }).join('') || '<div class="card mu">Администраторов пока нет.</div>');

  // Предложения продавца
  Object.assign(TT, { myoff: 'Мои предложения', newoff: 'Новое предложение' });
  V.myoff = () => '<button class="btn" style="margin:0 0 12px" onclick="S.od={};go(\'newoff\')">+ Добавить предложение</button>' + (P.filter((p) => p.s === ME.number).map(cardP).join('') || '<div class="card mu">У вас пока нет предложений.</div>');
  V.newoff = () => {
    const d = S.od = S.od || {};
    return '<p class="mu" style="margin:0 2px 12px">Опишите, чем вы можете помочь. Цену вы назовёте в чате заказа.</p>' +
      '<input placeholder="Название" value="' + esc(d.t || '') + '" oninput="S.od.t=this.value">' +
      '<select onchange="S.od.c=this.value">' + CATS.map((c) => '<option ' + (d.c === c[0] ? 'selected' : '') + '>' + c[0] + '</option>').join('') + '</select>' +
      '<select onchange="S.od.f=this.value">' + ['Чат', 'PDF', 'DOCX', 'Чат + файл', 'PPTX'].map((f) => '<option ' + (d.f === f ? 'selected' : '') + '>' + f + '</option>').join('') + '</select>' +
      '<textarea placeholder="Описание: что входит, как проходит работа" oninput="S.od.d=this.value">' + esc(d.d || '') + '</textarea>' +
      '<div class="mu" style="margin-bottom:6px">Срок</div>' + TM.map((t) => '<button class="chip ' + ((d.tm || TM[1]) === t ? 'on' : '') + '" onclick="S.od.tm=\'' + t + '\';draw()">' + t + '</button>').join('') +
      '<button class="btn" onclick="publishOffer()">Опубликовать</button>';
  };
  window.publishOffer = async function () {
    const d = S.od || {};
    if (!d.t || d.t.trim().length < 5) return toast('Название: минимум 5 символов');
    if (!d.d || d.d.trim().length < 10) return toast('Опишите предложение: минимум 10 символов');
    if (bad(d.t + ' ' + d.d)) return toast('Контакты в предложении запрещены');
    const j = await act('offer_new', { title: d.t.trim(), category: d.c || CATS[0][0], description: d.d.trim(), term: d.tm || TM[1], format: d.f || 'Чат' }, 'Предложение опубликовано');
    if (j) { S.od = {}; S.st = [{ v: 'myoff' }]; draw(); }
  };

  // Обновление данных раз в несколько секунд
  const signature = () => JSON.stringify([S.orders.map((o) => [o.id, o.st, o.amt]), S.ads.length, S.nt.length, S.cmp.length, Object.keys(S.msgs).map((k) => S.msgs[k].length)]);
  setInterval(async () => {
    if (!ME || busy || document.hidden || S.reg || S.splash) return;
    try {
      const topc = S.st[S.st.length - 1];
      const j = await call('state', topc && topc.v === 'chat' && S.role === 'admin' ? { chat: topc.id } : {});
      const before = signature();
      apply(j);
      const top = S.st[S.st.length - 1];
      if (top && top.v === 'chat') {
        const ms = document.getElementById('ms');
        if (ms) ms.innerHTML = msgs(top.id, S.role === 'seller' ? 's' : 'b');
        return;
      }
      const ae = document.activeElement;
      if (signature() !== before && !(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) && !document.getElementById('pvw')) draw();
    } catch (e) { /* пропускаем, повторим позже */ }
  }, 6000);

  // Запуск
  (async function boot() {
    S.loading = true; S.splash = false; draw();
    if (!INIT || !C.SUPABASE_URL || !C.ANON_KEY) {
      S.loading = false;
      S.fatal = !INIT ? 'Откройте приложение через Telegram, нажав кнопку у бота.' : 'Не заполнен файл config.js (адрес и ключ Supabase).';
      return draw();
    }
    try {
      const j = await call('state', {});
      apply(j);
      S.loading = false;
      if (ME) { S.reg = 0; S.splash = false; enter(); } else { S.splash = true; S.reg = 0; }
    } catch (e) {
      S.loading = false;
      S.fatal = errMsg(e) + '. Обновите страницу.';
    }
    draw();
  })();
})();
