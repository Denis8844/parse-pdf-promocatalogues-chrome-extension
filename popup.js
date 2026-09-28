'use strict';

/**
 * Popup — интерфейс очереди каталогов.
 *
 * Сам popup НЕ трогает DOM страниц каталога: он только собирает ссылки,
 * отправляет их в service worker (START) и отображает состояние очереди,
 * которое приходит из background.js (GET_STATE при открытии + живые RUN_UPDATE).
 */

const $ = (s) => document.querySelector(s);

const elUrls = $('#urls');
const elCount = $('#count');
const elStart = $('#start');
const elStop = $('#stop');
const elActiveTab = $('#activeTab');
const elStatus = $('#status');
const elCap = $('#cap');
const elStage = $('#stage');
const elElapsed = $('#elapsed');
const elFill = $('#fill');
const elList = $('#list');
const elSummary = $('#summary');
const elVer = $('#ver');
const elLogBtn = $('#logBtn');

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (m >= 60) {
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${m}:${String(ss).padStart(2, '0')}`;
}

function updateTicks() {
  const now = Date.now();

  // Общий таймер: тикает только пока очередь работает; по завершении замирает
  // на финальной длительности («всего: …»).
  if (run && run.startedAt) {
    const base = new Date(run.startedAt).getTime();
    if (run.state === 'running') {
      elElapsed.textContent = 'прошло: ' + fmtDuration(now - base);
    } else if (run.endedAt) {
      elElapsed.textContent = 'всего: ' + fmtDuration(run.endedAt - base);
    } else {
      elElapsed.textContent = '';
    }
  } else {
    elElapsed.textContent = '';
  }

  // Тикают только живые таймеры активной ссылки; завершённые ссылки показывают
  // зафиксированную длительность (текст уже вставлен в renderLinkItem).
  document.querySelectorAll('#list .tick.live').forEach((el) => {
    const start = Number(el.dataset.start || 0);
    if (!start) return;
    el.textContent = 'обработка: ' + fmtDuration(now - start);
  });
}

const STAGE_TEXTS = {
  idle: '',
  opening: 'Открытие страницы…',
  listing: 'Чтение списка каталогов магазина…',
  pages: 'Загрузка страниц…',
  page: '',            // для этого этапа показываем «Страница X из Y»
  pdf: 'Создание PDF…',
  downloading: 'Скачивание файла…'
};

const ICONS = {
  pending: '○',
  active: '⏳',
  retrying: '↻',
  done: '✓',
  error: '✕',
  cancelled: '⊘',
  skipped: '∅'
};

// Маленькая иконка «копировать» (inline SVG — без внешних ресурсов)
const COPY_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

// Абсолютный URL -> относительная ссылка (/regardez/offres/catalogue-picard-3660147)
function toRelativeLink(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return url;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function onCopyRelative(url, btn) {
  copyText(toRelativeLink(url));
  btn.classList.add('copied');
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  setTimeout(() => {
    btn.classList.remove('copied');
    btn.innerHTML = COPY_SVG;
  }, 1500);
}

let run = null;          // последнее известное состояние очереди
let lastSendError = null;

/* ================= Подсчёт ссылок ================= */

function refreshCount() {
  const { links, invalid } = parseLinks(elUrls.value);
  if (!links.length && !invalid.length) {
    elCount.textContent = 'Ссылок пока нет';
  } else if (invalid.length) {
    elCount.textContent = `Найдено ссылок: ${links.length} · Неверных: ${invalid.length}`;
  } else {
    elCount.textContent = `Найдено ссылок: ${links.length}`;
  }
  elStart.disabled = !links.length || (run && run.state === 'running');
}

/* ================= Черновик списка ссылок ================= */

// Popup уничтожается при закрытии — вместе с содержимым textarea. Чтобы вставленные
// ссылки не пропадали, сохраняем их в chrome.storage.local (с дебаунсом на ввод,
// чтобы не писать в хранилище на каждое нажатие клавиши) и восстанавливаем
// при следующем открытии: список можно дополнять по одной ссылке.
const DRAFT_KEY = 'urlsDraft';
let draftSaveTimer = null;

function saveUrlsDraft() {
  chrome.storage.local.set({ [DRAFT_KEY]: elUrls.value }).catch(() => {});
}

function scheduleUrlsDraftSave() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    saveUrlsDraft();
  }, 300);
}

function onUrlsInput() {
  refreshCount();
  scheduleUrlsDraftSave();
}

/* ================= Рендер состояния ================= */

function render() {
  if (!run) {
    elStatus.classList.add('hidden');
    return;
  }

  elStatus.classList.remove('hidden');
  const running = run.state === 'running';
  const links = run.links || [];

  // Заголовок: «Каталог 2 из 5»
  if (running && run.current >= 0) {
    elCap.textContent = `Каталог ${run.current + 1} из ${links.length}`;
  } else if (run.state === 'finished') {
    elCap.textContent = 'Обработка завершена';
  } else if (run.state === 'stopped') {
    elCap.textContent = 'Обработка остановлена';
  } else {
    elCap.textContent = 'Ожидание…';
  }

  // Текущий этап
  if (running && run.current >= 0) {
    if (run.stage === 'page' && run.page && run.page.total) {
      elStage.textContent = `Страница ${run.page.current} из ${run.page.total}`;
    } else {
      elStage.textContent = STAGE_TEXTS[run.stage] || '';
    }
  } else {
    elStage.textContent = '';
  }

  // Прогресс
  let percent = 0;
  if (running && run.current >= 0 && links.length) {
    let within = 1;
    if (run.stage === 'page' && run.page && run.page.total) {
      within = Math.max(0, (run.page.current - 1) / run.page.total);
    } else if (run.stage === 'pages' || run.stage === 'opening' || run.stage === 'listing') {
      within = 0;
    }
    percent = ((run.current + within) / links.length) * 100;
  } else if (run.state === 'finished' || run.state === 'stopped') {
    percent = 100;
  }
  elFill.style.width = Math.round(Math.max(0, Math.min(100, percent))) + '%';

  // Список ссылок
  elList.textContent = '';
  links.forEach((link, i) => {
    elList.appendChild(renderLinkItem(link, i));
  });

  // Итог
  if (run.summary) {
    elSummary.classList.remove('hidden');
    const s = run.summary;
    let html = `<div class="s-title">${run.state === 'stopped' ? 'Обработка остановлена' : 'Обработка завершена'}</div>`;
    html += `Успешно: <b>${s.ok}</b> · Ошибки: <span class="s-err"><b>${s.err}</b></span> · Всего: <b>${s.total}</b>`;
    if (s.cancelled) html += ` · Отменено: <b>${s.cancelled}</b>`;
    if (s.skipped) html += ` · Пропущено: <b>${s.skipped}</b>`;
    // Кнопка «Повторить ошибки» — только когда очередь завершена и есть ошибки
    if (s.err > 0 && (run.state === 'finished' || run.state === 'stopped')) {
      html += `<div class="retry-row"><button id="retryBtn" class="primary">Повторить ошибки (${s.err})</button></div>`;
    }
    elSummary.innerHTML = html;
    const rb = elSummary.querySelector('#retryBtn');
    if (rb) rb.addEventListener('click', onRetry);
  } else {
    elSummary.classList.add('hidden');
  }

  updateTicks();
  elStart.disabled = !runningStateAwareCanStart();
  elStop.disabled = !running;
}

function runningStateAwareCanStart() {
  const { links } = parseLinks(elUrls.value);
  return !!links.length && !(run && run.state === 'running');
}

function renderLinkItem(link, i) {
  const li = document.createElement('li');
  li.className = 'item ' + link.status;

  const ic = document.createElement('span');
  ic.className = 'ic';
  ic.textContent = ICONS[link.status] || '○';

  const body = document.createElement('div');
  body.className = 'body';

  const url = document.createElement('div');
  url.className = 'url';
  url.textContent = `${i + 1}. ${link.url}`;
  url.title = link.url;
  body.appendChild(url);

  // Дата действия каталога («Valable: 25 sept. au 12 oct.») — у каталогов,
  // развёрнутых из ссылки-списка; показывается всегда, в любом статусе
  // (и во время загрузки, и после завершения).
  if (link.dateText) {
    const d = document.createElement('div');
    d.className = 'date';
    d.textContent = link.dateText;
    d.title = 'дата действия каталога';
    body.appendChild(d);
  }

  if (link.status === 'done' && link.filename) {
    const f = document.createElement('div');
    f.className = 'file';
    f.textContent = `скачан: ${link.filename}`;
    f.title = link.filename;
    body.appendChild(f);
  }

  // Таймер ссылки: активная — тикает; завершённая — зафиксированная длительность
  // (по endedAt, а не по текущему времени, чтобы не «тикал» после завершения).
  if (link.status === 'active' && link.startedAt) {
    const t = document.createElement('div');
    t.className = 'tick live muted';
    t.dataset.start = link.startedAt;
    t.textContent = 'обработка: …';
    body.appendChild(t);
  } else if (link.startedAt && link.endedAt) {
    const dur = fmtDuration(link.endedAt - link.startedAt);
    const t = document.createElement('div');
    t.className = 'tick muted';
    t.textContent = `заняло: ${dur}`;
    body.appendChild(t);
  }

  if ((link.status === 'error' || link.status === 'cancelled' || link.status === 'skipped') && link.error) {
    const e = document.createElement('div');
    e.className = 'err';
    e.textContent = link.error;
    e.title = link.error;
    body.appendChild(e);
  }

  li.append(ic, body);

  // Кнопка «скопировать относительную ссылку» — у каждой строки
  const copy = document.createElement('button');
  copy.className = 'copy';
  copy.type = 'button';
  copy.title = 'Скопировать относительную ссылку';
  copy.innerHTML = COPY_SVG;
  copy.addEventListener('click', () => onCopyRelative(link.url, copy));
  li.appendChild(copy);

  return li;
}

/* ================= Сообщения ================= */

async function sendMessage(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (e) {
    lastSendError = e && e.message ? e.message : String(e);
    return { error: lastSendError };
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'RUN_UPDATE' && msg.run) {
    run = msg.run;
    render();
  }
});

/* ================= Действия ================= */

async function onStart() {
  const { links } = parseLinks(elUrls.value);
  if (!links.length) return;

  elStart.disabled = true;
  elStop.disabled = true;

  const res = await sendMessage({ type: 'START', urls: links });

  if (res && res.error) {
    elCap.textContent = 'Не удалось запустить';
    elStage.textContent = res.error;
    elStatus.classList.remove('hidden');
  } else {
    // Состояние придёт по RUN_UPDATE; на всякий случай запросим сразу.
    const st = await sendMessage({ type: 'GET_STATE' });
    if (st && st.run) { run = st.run; render(); }
  }
}

async function onStop() {
  await sendMessage({ type: 'STOP' });
}

/* ================= Повтор ошибочных ссылок ================= */

// После завершения очереди — запустить заново только ссылки со статусом «error».
async function onRetry() {
  if (!run || (run.state !== 'finished' && run.state !== 'stopped')) return;
  const urls = run.links.filter((l) => l.status === 'error').map((l) => l.url);
  if (!urls.length) return;

  elStart.disabled = true;
  elStop.disabled = true;

  const res = await sendMessage({ type: 'START', urls });

  if (res && res.error) {
    elCap.textContent = 'Не удалось запустить';
    elStage.textContent = res.error;
    elStatus.classList.remove('hidden');
  } else {
    const st = await sendMessage({ type: 'GET_STATE' });
    if (st && st.run) { run = st.run; render(); }
  }
}

/* ================= Настройки ================= */

const elMain = $('#main');
const elSettings = $('#settings');
const elSetFields = $('#setFields');
const elSetStatus = $('#setStatus');
const elSetBack = $('#setBack');
const elSetReset = $('#setReset');
const elSetSave = $('#setSave');
const elGear = $('#gear');

// Описание полей настроек. Значения ms-полей в UI показываются в секундах.
const SETTINGS_GROUPS = [
  {
    title: 'Таймауты (в секундах)',
    fields: [
      { key: 'TAB_CREATE_TIMEOUT_MS', label: 'Открытие вкладки', min: 5, max: 300, step: 1, ms: true },
      { key: 'TAB_LOAD_TIMEOUT_MS', label: 'Загрузка страницы', min: 5, max: 600, step: 1, ms: true },
      { key: 'INJECT_TIMEOUT_MS', label: 'Внедрение скрипта', min: 5, max: 300, step: 1, ms: true },
      { key: 'SEND_TIMEOUT_MS', label: 'Отправка команды старта', min: 1, max: 60, step: 1, ms: true },
      { key: 'SETTLE_MS', label: 'Пауза после загрузки', hint: 'после загрузки, до внедрения скрипта', min: 0, max: 30, step: 0.1, ms: true },
      { key: 'PAGE_WAIT_TIMEOUT_MS', label: 'Поиск страниц каталога', hint: 'сколько ждать панель миниатюр', min: 5, max: 600, step: 1, ms: true },
      { key: 'LISTING_TIMEOUT_MS', label: 'Сбор списка каталогов', hint: 'страница /magasins/…: список и «Charger plus»', min: 30, max: 600, step: 5, ms: true },
      { key: 'FETCH_TIMEOUT_MS', label: 'Загрузка одного изображения', min: 10, max: 600, step: 1, ms: true },
      { key: 'LINK_TIMEOUT_MS', label: 'Лимит на одну ссылку', hint: 'общий watchdog', min: 60, max: 7200, step: 60, ms: true },
      { key: 'DOWNLOAD_TIMEOUT_MS', label: 'Ожидание скачивания PDF', hint: 'в т.ч. диалог «Сохранить как»', min: 30, max: 3600, step: 30, ms: true }
    ]
  },
  {
    title: 'Повторы и защита',
    fields: [
      { key: 'RETRY_MAX', label: 'Повторные попытки', unit: 'раз', min: 0, max: 10, step: 1 },
      { key: 'RETRY_DELAY_MS', label: 'Пауза между попытками', min: 0, max: 120, step: 1, ms: true },
      { key: 'POKE_STALL_MS', label: 'Тишина до «проверки пульса»', hint: 'повторный старт при молчании страницы', min: 10, max: 600, step: 5, ms: true },
      { key: 'HEARTBEAT_STALL_MS', label: 'Heartbeat: ссылка зависла', hint: 'нет прогресса дольше — ошибка и дальше', min: 20, max: 1800, step: 10, ms: true },
      { key: 'NAV_RECOVERY_MAX', label: 'Восстановления после редиректов', unit: 'раз', min: 1, max: 20, step: 1 }
    ]
  },
  {
    title: 'Качество изображений',
    fields: [
      { key: 'JPEG_Q', label: 'Качество JPEG', hint: '0.1 — меньше размер, 1 — максимальное', min: 0.1, max: 1, step: 0.01 }
    ]
  }
];

let setCurrent = {};   // текущие эффективные значения (в ms)
let setDefaults = {};  // значения по умолчанию

// Резервные значения по умолчанию (дубликат DEFAULTS из background.js).
// Используются, если service worker не ответил (например, ещё не перезапущен
// после обновления) — поля настроек никогда не должны показывать 0.
const SETTINGS_FALLBACK = {
  TAB_LOAD_TIMEOUT_MS: 60000,
  TAB_CREATE_TIMEOUT_MS: 30000,
  INJECT_TIMEOUT_MS: 60000,
  SEND_TIMEOUT_MS: 15000,
  SETTLE_MS: 600,
  LINK_TIMEOUT_MS: 1200000,
  DOWNLOAD_TIMEOUT_MS: 600000,
  FALLBACK_DOWNLOAD_GRACE_MS: 4000,
  KEEPALIVE_MS: 20000,
  HEARTBEAT_STALL_MS: 150000,
  HEARTBEAT_CHECK_MS: 10000,
  POKE_STALL_MS: 60000,
  RETRY_MAX: 2,
  RETRY_DELAY_MS: 5000,
  NAV_RECOVERY_MAX: 3,
  JPEG_Q: 0.92,
  PAGE_WAIT_TIMEOUT_MS: 60000,
  FETCH_TIMEOUT_MS: 120000,
  LISTING_TIMEOUT_MS: 180000
};

function setStatus(text, cls) {
  elSetStatus.textContent = text;
  elSetStatus.className = cls ? cls : 'muted';
}

function renderSettings(current, defaults) {
  setCurrent = current || {};
  setDefaults = defaults || {};
  elSetFields.textContent = '';
  for (const group of SETTINGS_GROUPS) {
    const h = document.createElement('h4');
    h.textContent = group.title;
    elSetFields.appendChild(h);
    for (const f of group.fields) {
      const row = document.createElement('div');
      row.className = 'fld';

      const label = document.createElement('label');
      label.textContent = f.label;
      if (f.hint) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = f.hint;
        label.appendChild(hint);
      }

      const input = document.createElement('input');
      input.type = 'number';
      input.id = 'set-' + f.key;
      input.min = f.min;
      input.max = f.max;
      input.step = f.step;
      // Текущее → значения по умолчанию → резервные значения → (никогда не 0)
      let raw = setCurrent[f.key];
      if (raw === undefined) raw = setDefaults[f.key];
      if (raw === undefined) raw = SETTINGS_FALLBACK[f.key];
      if (raw === undefined) raw = f.ms ? f.min * 1000 : f.min;
      input.value = f.ms ? Number((raw / 1000).toFixed(3)) : raw;

      const unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = f.ms ? 'с' : (f.unit || '');

      row.append(label, input, unit);
      elSetFields.appendChild(row);
    }
  }
  setStatus('', '');
}

async function openSettings() {
  const res = await sendMessage({ type: 'GET_SETTINGS' });
  renderSettings(res && res.current, (res && res.defaults) || {});
  elMain.classList.add('hidden');
  elSettings.classList.remove('hidden');
}

function closeSettings() {
  elSettings.classList.add('hidden');
  elMain.classList.remove('hidden');
  render(); // обновляем основной вид (на случай, если что-то поменялось)
}

async function saveSettings() {
  const patch = {};
  for (const group of SETTINGS_GROUPS) {
    for (const f of group.fields) {
      const input = document.getElementById('set-' + f.key);
      let v = parseFloat(input.value);
      if (!isFinite(v)) {
        const cur = setCurrent[f.key] !== undefined ? setCurrent[f.key] : 0;
        v = f.ms ? cur / 1000 : cur;
      }
      v = Math.min(f.max, Math.max(f.min, v));
      patch[f.key] = f.ms ? Math.round(v * 1000) : v;
      input.value = f.ms ? Number((patch[f.key] / 1000).toFixed(3)) : patch[f.key];
    }
  }
  try {
    await chrome.storage.local.set({ settings: patch });
    setCurrent = { ...setCurrent, ...patch };
    setStatus('Сохранено ✓', 'ok');
  } catch (e) {
    setStatus('Ошибка сохранения: ' + (e && e.message ? e.message : e), 'err');
  }
  setTimeout(() => setStatus('', ''), 2200);
}

async function resetSettings() {
  renderSettings(setDefaults, setDefaults);
  await saveSettings();
}

/* ================= Журнал ================= */

async function onCopyLog() {
  const res = await sendMessage({ type: 'GET_LOG' });
  const log = (res && Array.isArray(res.log)) ? res.log : [];

  const lines = [];
  lines.push('Скачать каталоги v' + chrome.runtime.getManifest().version);
  if (run) {
    lines.push('состояние: ' + run.state +
      (run.summary ? ' | ' + JSON.stringify(run.summary) : ''));
    run.links.forEach((l, i) => {
      lines.push(`${i + 1}. [${l.status}]${l.attempt ? ' (попытка ' + l.attempt + ')' : ''} ${l.url}` +
        (l.error ? ' — ' + l.error : '') +
        (l.filename ? ' → ' + l.filename : ''));
    });
  }
  lines.push('--- журнал ---');
  log.forEach((e) => lines.push(new Date(e.t).toLocaleString('ru-RU') + '  ' + e.msg));
  const text = lines.join('\n');

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  elLogBtn.textContent = 'скопировано ✓';
  setTimeout(() => { elLogBtn.textContent = 'Копировать журнал'; }, 2500);
}

/* ================= Инициализация ================= */

async function init() {
  // Настройка «открывать на переднем плане»
  try {
    const s = await chrome.storage.local.get('activeTab');
    elActiveTab.checked = !!s.activeTab;
  } catch { /* ignore */ }
  elActiveTab.addEventListener('change', () => {
    chrome.storage.local.set({ activeTab: elActiveTab.checked }).catch(() => {});
  });

  // Черновик ссылок из прошлого открытия окна: список не сбрасывается,
  // его можно дополнить новыми ссылками
  try {
    const { urlsDraft } = await chrome.storage.local.get(DRAFT_KEY);
    if (typeof urlsDraft === 'string' && urlsDraft) elUrls.value = urlsDraft;
  } catch { /* ignore */ }

  // Текущее состояние очереди
  const st = await sendMessage({ type: 'GET_STATE' });
  if (st && st.run) { run = st.run; render(); }

  // Версия — чтобы было видно, обновилось ли расширение
  try {
    elVer.textContent = chrome.runtime.getManifest().version;
  } catch { /* ignore */ }

  // События
  elUrls.addEventListener('input', onUrlsInput);
  elStart.addEventListener('click', onStart);
  elStop.addEventListener('click', onStop);
  elLogBtn.addEventListener('click', onCopyLog);
  elGear.addEventListener('click', openSettings);
  elSetBack.addEventListener('click', closeSettings);
  elSetSave.addEventListener('click', saveSettings);
  elSetReset.addEventListener('click', resetSettings);
  elUrls.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onStart();
  });

  // При закрытии окна сохраняем черновик немедленно (pagehide успевает сработать
  // раньше смерти popup — на случай, если debounce ещё не сработал)
  window.addEventListener('pagehide', () => {
    if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null; }
    saveUrlsDraft();
  });

  // Таймер «прошло/обработка» — обновляется каждую секунду
  setInterval(updateTicks, 1000);

  refreshCount();
}

init();
