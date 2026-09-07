'use strict';

/**
 * Service worker (Manifest V3) — оркестратор очереди каталогов.
 *
 * Отвечает за:
 *  - очередь ссылок и строго последовательную обработку;
 *  - открытие технической вкладки и ожидание её загрузки;
 *  - внедрение контентного скрипта (utils.js, pdf.js, content.js);
 *  - передачу команды CATALOG_START и приём прогресса/результата;
 *  - скачивание готового PDF через chrome.downloads.download (по одному файлу);
 *  - закрытие технической вкладки после скачивания;
 *  - состояние очереди в chrome.storage.session + журнал событий для диагностики;
 *  - keep-alive (offscreen-документ + самопинг) — чтобы MV3 не «усыпил» SW
 *    посреди обработки;
 *  - watchdog (heartbeat): если от страницы нет прогресса дольше лимита —
 *    ссылка считается зависшей, фиксируется ошибка, очередь идёт дальше;
 *  - мгновенную остановку по кнопке «Остановить» (отмена скачивания +
 *    прерывание контентного скрипта + закрытие вкладки + финализация очереди).
 *
 * Почему байты PDF не передаются по messaging:
 * Chrome ограничивает размер сообщения 64 MiB и сериализует сообщения как JSON.
 * Content script создаёт blob-URL прямо на странице, а по messaging передаётся
 * только строка URL + имя файла. SW скачивает по этому URL через
 * chrome.downloads.download; вкладка остаётся открытой до завершения скачивания
 * (blob-URL живёт, пока жива создавшая его страница).
 */

/* ================= Настройки ================= */

// Все настраиваемые параметры. Значения по умолчанию; пользователь может изменить
// их в popup («Настройки») — они хранятся в chrome.storage.local и применяются
// к CFG при старте SW и сразу при изменении (storage.onChanged).
const DEFAULTS = {
  TAB_LOAD_TIMEOUT_MS: 60_000,      // ожидание полной загрузки вкладки
  TAB_CREATE_TIMEOUT_MS: 30_000,    // таймаут создания вкладки
  INJECT_TIMEOUT_MS: 60_000,        // таймаут внедрения content script
  SEND_TIMEOUT_MS: 15_000,          // таймаут отправки команды старта
  SETTLE_MS: 600,                   // пауза после complete (гидратация JS страницы)
  INJECT_FILES: ['utils.js', 'pdf.js', 'content.js'],
  LINK_TIMEOUT_MS: 20 * 60_000,     // общий watchdog на обработку одной ссылки
  DOWNLOAD_TIMEOUT_MS: 10 * 60_000, // ожидание завершения скачивания (диалог «Сохранить как»)
  FALLBACK_DOWNLOAD_GRACE_MS: 4_000,// пауза после запасного скачивания через <a>
  KEEPALIVE_MS: 20_000,             // самопинг SW (дополнительно к offscreen keep-alive)
  HEARTBEAT_STALL_MS: 150_000,      // нет прогресса от страницы дольше — ссылка зависла
  HEARTBEAT_CHECK_MS: 10_000,       // период проверки heartbeat
  POKE_STALL_MS: 60_000,            // столько тишины — шлём повторный START («проверка пульса»)
  RETRY_MAX: 2,                     // доп. попытки на ссылку после технических ошибок
  RETRY_DELAY_MS: 5_000,            // пауза между попытками
  NAV_RECOVERY_MAX: 3,              // максимум навигаций-восстановлений на одну ссылку
  // параметры контентного скрипта (передаются в CATALOG_START)
  JPEG_Q: 0.92,                     // качество JPEG (как в исходном скрипте)
  PAGE_WAIT_TIMEOUT_MS: 60_000,     // сколько ждём появления панели миниатюр
  FETCH_TIMEOUT_MS: 120_000         // таймаут загрузки одного полноразмерного изображения
};

const CFG = { ...DEFAULTS };

// Допустимые диапазоны значений (защита от некорректного ввода).
const CLAMP = {
  TAB_LOAD_TIMEOUT_MS: [5_000, 600_000],
  TAB_CREATE_TIMEOUT_MS: [5_000, 300_000],
  INJECT_TIMEOUT_MS: [5_000, 300_000],
  SEND_TIMEOUT_MS: [1_000, 60_000],
  SETTLE_MS: [0, 30_000],
  LINK_TIMEOUT_MS: [60_000, 7_200_000],
  DOWNLOAD_TIMEOUT_MS: [30_000, 3_600_000],
  FALLBACK_DOWNLOAD_GRACE_MS: [0, 60_000],
  HEARTBEAT_STALL_MS: [20_000, 1_800_000],
  HEARTBEAT_CHECK_MS: [2_000, 120_000],
  POKE_STALL_MS: [10_000, 600_000],
  RETRY_MAX: [0, 10],
  RETRY_DELAY_MS: [0, 120_000],
  NAV_RECOVERY_MAX: [1, 20],
  KEEPALIVE_MS: [5_000, 120_000],
  JPEG_Q: [0.1, 1],
  PAGE_WAIT_TIMEOUT_MS: [5_000, 600_000],
  FETCH_TIMEOUT_MS: [10_000, 600_000]
};

// Применяет сохранённые настройки (валидация + ограничение диапазонов).
function applySettings(patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const key of Object.keys(DEFAULTS)) {
    if (typeof patch[key] !== 'number' || !isFinite(patch[key])) continue;
    let v = patch[key];
    const range = CLAMP[key];
    if (range) v = Math.min(range[1], Math.max(range[0], v));
    CFG[key] = v;
  }
}

async function loadSettingsFromStorage() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    applySettings(settings);
  } catch (e) {
    console.warn('не удалось загрузить настройки:', messageOf(e));
  }
}

// Горячее применение настроек, сохранённых из popup, без перезапуска SW.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  applySettings(changes.settings.newValue);
  addLog('настройки обновлены');
});

const STORAGE_KEY = 'catalogRun';
const LOG_KEY = 'catalogLog';
const LOG_MAX = 400;

/* ================= Состояние ================= */

let run = null;            // { state, links[], current, stage, page, summary, startedAt }
let activeJobId = null;    // jobId текущей обработки
let pendingJob = null;     // { resolve, reject } — ждём CATALOG_RESULT / CATALOG_ERROR
let stopRequested = false;
let keepAliveTimer = null;
let watchdogTimer = null;
let activeTabId = null;
let currentDownloadId = null;
let lastProgressAt = 0;    // когда в последний раз был прогресс от контентного скрипта
let lastLoggedProgressKey = '';
let scriptInjected = false; // контентный скрипт внедрён в текущий документ вкладки
let injectedUrl = null;     // URL документа, в который внедрён скрипт
let navRecoveryCount = 0;   // сколько раз восстанавливали скрипт после навигации (на ссылку)
let lastPokedAt = 0;        // когда последний раз слали повторный START

/* Журнал событий (кольцевой буфер) — для диагностики: кнопка «Копировать журнал» в popup. */
const eventLog = [];

function addLog(msg) {
  eventLog.push({ t: Date.now(), msg: String(msg) });
  if (eventLog.length > LOG_MAX) eventLog.splice(0, eventLog.length - LOG_MAX);
}

class StopError extends Error {}

/* ================= Утилиты ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const messageOf = (e) => (e && e.message) ? e.message : String(e);

// Ошибки, которые бесполезно повторять: их причина окончательна и не изменится
// от новой попытки (например, ссылка ведёт не на ридер каталога).
function isDefinitiveError(msg) {
  return /страницы не найдены/.test(String(msg));
}

function withTimeout(promise, ms, message, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout && onTimeout(); } catch { /* ignore */ }
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Пауза, прерываемая остановкой очереди.
function sleepInterruptible(ms) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      if (stopRequested) { clearInterval(t); reject(new StopError('остановлено пользователем')); return; }
      if (Date.now() >= end) { clearInterval(t); resolve(); }
    }, 200);
  });
}

/* ================= Storage + broadcast ================= */

async function saveRun() {
  if (!run) return;
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: run, [LOG_KEY]: eventLog });
  } catch (e) {
    console.warn('не удалось сохранить состояние:', messageOf(e));
  }
}

async function loadState() {
  return chrome.storage.session.get([STORAGE_KEY, LOG_KEY]);
}

function broadcast() {
  const snapshot = run;
  chrome.runtime.sendMessage({ type: 'RUN_UPDATE', run: snapshot }).catch(() => {});
  updateBadge();
}

function updateBadge() {
  let text = '';
  if (run && run.state === 'running' && run.links && run.links.length) {
    text = `${Math.min(run.current + 1, 99)}/${Math.min(run.links.length, 99)}`;
    if (text.length > 4) text = text.slice(0, 4);
  }
  chrome.action.setBadgeText({ text }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' }).catch(() => {});
}

/* ================= Keep-alive SW + heartbeat ================= */

// Пока идёт обработка:
//  1) offscreen-документ шлёт сообщения каждые 15 с (основной механизм);
//  2) дополнительно шлём сами себе сообщение каждые 20 с;
//  3) heartbeat: если от контентного скрипта нет прогресса дольше HEARTBEAT_STALL_MS,
//     ссылка считается зависшей (краш вкладки, потерянные сообщения) — фиксируем
//     ошибку и переходим к следующей.
function startWatchdog() {
  stopWatchdog();
  lastProgressAt = Date.now();
  watchdogTimer = setInterval(() => {
    // keep-alive
    chrome.runtime.sendMessage({ type: 'KEEPALIVE' }).catch(() => {});

    // heartbeat: только во время стадий, которыми управляет контентный скрипт
    if (!run || run.state !== 'running' || !activeJobId) return;
    if (run.stage === 'opening' || run.stage === 'downloading' || run.stage === 'idle') return;

    const idleMs = Date.now() - lastProgressAt;

    // «Проверка пульса»: тишина дольше POKE_STALL_MS — повторно шлём команду старта.
    // Контентный скрипт идемпотентен для того же jobId (не запустится дважды),
    // но если он умер молча (краш документа, потерянные сообщения) — оживёт.
    if (idleMs > CFG.POKE_STALL_MS && Date.now() - lastPokedAt > CFG.POKE_STALL_MS) {
      lastPokedAt = Date.now();
      addLog('нет прогресса ' + Math.round(CFG.POKE_STALL_MS / 1000) + ' с — повторная команда старта');
      chrome.tabs.sendMessage(activeTabId, { type: 'CATALOG_START', jobId: activeJobId }).catch(() => {});
    }

    if (idleMs <= CFG.HEARTBEAT_STALL_MS) return;

    addLog(`heartbeat: нет прогресса от страницы более ${Math.round(CFG.HEARTBEAT_STALL_MS / 60000)} мин — прерываю ссылку`);
    if (activeTabId != null) {
      chrome.tabs.sendMessage(activeTabId, { type: 'CATALOG_ABORT', jobId: activeJobId }).catch(() => {});
    }
    lastProgressAt = Date.now(); // не срабатываем повторно
    const p = pendingJob;
    pendingJob = null;
    if (p) p.reject(new Error('страница не отвечает: нет прогресса более ' + (CFG.HEARTBEAT_STALL_MS / 60000) + ' минут'));
  }, CFG.HEARTBEAT_CHECK_MS);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/* ---------- offscreen keep-alive документ ---------- */

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'keep-alive service worker во время обработки очереди каталогов'
    });
  } catch (e) {
    if (!/single offscreen/i.test(messageOf(e))) {
      addLog('offscreen недоступен: ' + messageOf(e));
      console.warn('offscreen не создан:', messageOf(e));
    }
  }
}

async function closeOffscreen() {
  try {
    await chrome.offscreen.closeDocument();
  } catch { /* документа нет — ок */ }
}

/* ================= Восстановление после перезапуска SW ================= */

let recoveryPromise = null;

function recoverRun() {
  if (!recoveryPromise) {
    recoveryPromise = (async () => {
      try {
        const { [STORAGE_KEY]: stored, [LOG_KEY]: prevLog } = await loadState();

        // восстанавливаем журнал предыдущей жизни SW
        if (Array.isArray(prevLog)) {
          for (const e of prevLog) {
            if (e && typeof e.t === 'number' && e.msg) eventLog.push(e);
          }
          if (eventLog.length > LOG_MAX) eventLog.splice(0, eventLog.length - LOG_MAX);
        }

        addLog('service worker старт, v' + chrome.runtime.getManifest().version);

        if (stored) {
          if (stored.state === 'running') {
            // SW перезапустился посреди очереди — живой обработки больше нет.
            stored.state = 'stopped';
            const i = (stored.current != null && stored.current >= 0) ? stored.current : stored.links.length - 1;
            if (stored.links && stored.links[i]) {
              stored.links[i].status = 'error';
              stored.links[i].error = 'обработка прервана перезапуском расширения';
              stored.links[i].endedAt = Date.now();
            }
            stored.endedAt = Date.now();
            // оставшиеся ссылки — отменённые
            if (Array.isArray(stored.links)) {
              for (let k = 0; k < stored.links.length; k++) {
                if (k !== i && stored.links[k].status === 'pending') {
                  stored.links[k].status = 'cancelled';
                  stored.links[k].error = 'остановлено перезапуском расширения';
                }
              }
            }
            stored.current = -1;
            stored.stage = 'idle';
            stored.page = null;
            // сводка
            stored.summary = {
              ok: (stored.links || []).filter((l) => l.status === 'done').length,
              err: (stored.links || []).filter((l) => l.status === 'error').length,
              cancelled: (stored.links || []).filter((l) => l.status === 'cancelled').length,
              total: (stored.links || []).length
            };
            addLog('восстановление: очередь помечена остановленной (перезапуск SW)');
          }
          run = stored;
          await saveRun();
          broadcast();
        }
      } catch (e) {
        console.warn('recoverRun:', messageOf(e));
      }
    })();
  }
  return recoveryPromise;
}

chrome.runtime.onStartup.addListener(() => { recoveryPromise = null; recoverRun(); });
chrome.runtime.onInstalled.addListener(() => { recoveryPromise = null; recoverRun(); });

// На каждом холодном старте проверяем, не осталась ли незавершённая очередь.
recoverRun();
loadSettingsFromStorage(); // применяем сохранённые пользователем настройки

/* ================= Обработка сообщений ================= */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  switch (msg.type) {

    case 'START':
      return handleStart(msg);

    case 'STOP':
      return handleStop();

    case 'GET_STATE':
      return (async () => {
        await recoveryPromise;
        return { run };
      })();

    case 'GET_LOG':
      return (async () => {
        await recoveryPromise; // иначе при холодном старте SW журнал выглядит пустым
        return { log: eventLog };
      })();

    case 'GET_SETTINGS':
      return (async () => {
        await recoveryPromise; // единообразно с GET_STATE/GET_LOG
        return { current: { ...CFG }, defaults: { ...DEFAULTS } };
      })();

    // Сообщения от контентного скрипта
    case 'CATALOG_PROGRESS':
      return handleCatalogProgress(msg);

    case 'CATALOG_RESULT':
      return handleCatalogResult(msg);

    case 'CATALOG_ERROR':
      return handleCatalogError(msg);

    default:
      // KEEPALIVE, RUN_UPDATE и прочие — игнорируем.
      return undefined;
  }
});

/* ================= Падение вкладки ================= */

// Если техническая вкладка закрыта или аварийно завершена (краш рендерера, OOM,
// либо её закрыли кнопкой «Остановить»), немедленно прерываем ожидание результата.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== activeTabId) return;
  activeTabId = null;
  const p = pendingJob;
  pendingJob = null;
  if (p) {
    p.reject(stopRequested
      ? new StopError('остановлено пользователем')
      : new Error('вкладка закрыта или аварийно завершена'));
  }
});

/* ================= Навигация вкладки ================= */

// Если страница после внедрения скрипта переходит по новой ссылке (антибот-редирект,
// challenge-страница, редирект http->https), внедрённый контентный скрипт умирает
// вместе с документом — и очередь «затихает» до heartbeat. Перехватываем навигацию
// и автоматически внедряем скрипт заново в новый документ + запускаем обработку.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (tabId !== activeTabId) return;
  if (!pendingJob || !run || run.state !== 'running') return; // восстанавливаем только в работе
  if (stopRequested) return;

  // Началась загрузка нового документа — старый контентный скрипт мёртв.
  if (info.status === 'loading') {
    scriptInjected = false;
    return;
  }
  if (info.status !== 'complete') return;

  const url = tab && tab.url;
  if (!url) return;
  if (scriptInjected && url === injectedUrl) return; // тот же документ — ничего не делаем

  // Защита от бесконечных редиректов: больше NAV_RECOVERY_MAX восстановлений не делаем.
  if (navRecoveryCount >= CFG.NAV_RECOVERY_MAX) {
    addLog('слишком много навигаций (' + navRecoveryCount + ') — прерываю ссылку');
    const p = pendingJob;
    pendingJob = null;
    if (p) p.reject(new Error('страница многократно перенаправляется'));
    return;
  }
  navRecoveryCount++;

  addLog('навигация вкладки → ' + url + ': повторное внедрение скрипта');
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: CFG.INJECT_FILES });
    await chrome.tabs.sendMessage(tabId, {
      type: 'CATALOG_START',
      jobId: activeJobId,
      settings: settingsPayload()
    });
    scriptInjected = true;
    injectedUrl = url;
    lastProgressAt = Date.now();
    addLog('повторное внедрение выполнено');
  } catch (e) {
    addLog('повторное внедрение не удалось: ' + messageOf(e));
  }
});

// Настройки контентного скрипта — передаются вместе с командой старта.
function settingsPayload() {
  return {
    jpegQ: CFG.JPEG_Q,
    pageWaitTimeoutMs: CFG.PAGE_WAIT_TIMEOUT_MS,
    fetchTimeoutMs: CFG.FETCH_TIMEOUT_MS
  };
}

/* ================= Старт / стоп очереди ================= */

async function handleStart(msg) {
  await recoveryPromise;

  const urls = (Array.isArray(msg.urls) ? msg.urls : []).filter(Boolean);
  if (!urls.length) throw new Error('нет ссылок для обработки');
  if (run && run.state === 'running') throw new Error('обработка уже идёт');

  stopRequested = false;

  run = {
    state: 'running',
    startedAt: new Date().toISOString(),
    current: -1,
    stage: 'idle',
    page: null,
    summary: null,
    links: urls.map((u) => ({
      url: u,
      status: 'pending',   // pending | active | done | error | cancelled
      error: null,
      filename: null
    }))
  };

  addLog(`старт очереди: ${urls.length} ссылок`);
  await saveRun();
  broadcast();
  startWatchdog();
  ensureOffscreen(); // keep-alive: не ждём, очередь стартует сразу

  // Запускаем очередь в фоне, не блокируя ответ popup.
  void runQueue();

  return { ok: true };
}

// Остановка должна сработать ВСЕГДА, даже если очередь в SW «умерла» (перезапуск
// service worker, зависший рендерер): финализируем состояние сами, идемпотентно
// по отношению к runQueue.
async function handleStop() {
  if (!run) return { ok: true };
  const wasRunning = run.state === 'running';
  stopRequested = true;
  addLog('остановка по запросу пользователя');

  // 1) прерываем контентный скрипт
  if (activeJobId && activeTabId != null) {
    chrome.tabs.sendMessage(activeTabId, { type: 'CATALOG_ABORT', jobId: activeJobId }).catch(() => {});
  }

  // 2) отменяем текущее скачивание
  if (currentDownloadId != null) {
    try { await chrome.downloads.cancel(currentDownloadId); } catch { /* уже завершено */ }
  }

  // 3) мгновенно закрываем техническую вкладку — это гарантированно прерывает и
  //    контентный скрипт, и ожидание результата (см. tabs.onRemoved), даже если
  //    messaging не работает
  if (activeTabId != null) {
    try { await chrome.tabs.remove(activeTabId); } catch { /* уже закрыта */ }
    activeTabId = null;
  }

  // 4) финализируем очередь сами
  if (wasRunning) finalizeRun();

  stopWatchdog();
  closeOffscreen();

  return { ok: true };
}

/* ================= Очередь ================= */

async function runQueue() {
  try {
    for (let i = 0; i < run.links.length; i++) {
      if (stopRequested) break;

      run.current = i;
      const link = run.links[i];
      link.status = 'active';
      link.error = null;
      link.startedAt = Date.now();
      link.attempt = 1;
      await saveRun();
      broadcast();

      const maxAttempts = 1 + CFG.RETRY_MAX;
      addLog(`[${i + 1}/${run.links.length}] начало: ${link.url}`);

      // Дополнительный уровень защиты: повторные попытки после технических сбоев
      // (таймауты, HTTP-ошибки, heartbeat, сеть). Окончательные ошибки
      // (например, «страницы не найдены») не повторяются.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (stopRequested) break;

        if (attempt > 1) {
          link.status = 'retrying';
          link.attempt = attempt;
          addLog(`повторная попытка ${attempt}/${maxAttempts}: ${link.url}`);
          await saveRun();
          broadcast();
          try {
            await sleepInterruptible(CFG.RETRY_DELAY_MS);
          } catch { /* StopError */ }
          if (stopRequested) break;
          link.status = 'active';
          await saveRun();
          broadcast();
        }

        try {
          await processLink(link);
          link.status = 'done';
          break;
        } catch (e) {
          const stopped = stopRequested || e instanceof StopError;
          if (stopped) {
            link.status = 'cancelled';
            link.error = 'остановлено пользователем';
            break;
          }
          link.error = messageOf(e);
          addLog(`попытка ${attempt} не удалась: ${link.error}`);
          if (!stopped) console.error('ссылка не обработана:', link.url, '—', link.error);

          if (isDefinitiveError(link.error) || attempt >= maxAttempts) {
            link.status = 'error';
            break;
          }
        }
      }

      link.endedAt = Date.now(); // фиксируем время завершения — таймер ссылки замирает

      await saveRun();
      broadcast();
    }

    finalizeRun();
  } catch (e) {
    console.error('runQueue:', e);
    if (run && run.state === 'running') {
      run.state = 'stopped';
      const i = run.current >= 0 ? run.current : 0;
      if (run.links[i]) {
        run.links[i].status = 'error';
        run.links[i].error = 'внутренняя ошибка: ' + messageOf(e);
      }
      addLog('внутренняя ошибка очереди: ' + messageOf(e));
      await saveRun();
      broadcast();
    }
  } finally {
    stopWatchdog();
    closeOffscreen();
    updateBadge();
  }
}

function finalizeRun() {
  if (!run || run.state !== 'running') return; // уже завершена (например, handleStop)

  const stopped = stopRequested;

  // если остановлены — оставшиеся и текущая ссылки помечаются отменёнными
  if (stopped) {
    for (const l of run.links) {
      if (l.status === 'pending' || l.status === 'active') {
        l.status = 'cancelled';
        l.error = 'остановлено пользователем';
      }
    }
  }

  const ok = run.links.filter((l) => l.status === 'done').length;
  const err = run.links.filter((l) => l.status === 'error').length;
  const cancelled = run.links.filter((l) => l.status === 'cancelled').length;

  // фиксируем время завершения для всех завершённых ссылок (таймеры в popup замирают)
  for (const l of run.links) {
    if (l.startedAt && !l.endedAt && (l.status === 'done' || l.status === 'error' || l.status === 'cancelled')) {
      l.endedAt = Date.now();
    }
  }
  run.endedAt = Date.now();

  run.summary = { ok, err, cancelled, total: run.links.length };
  run.state = stopped ? 'stopped' : 'finished';
  run.stage = 'idle';
  run.page = null;
  run.current = -1;

  addLog('очередь завершена: ' + JSON.stringify(run.summary));
  console.log('очередь завершена:', JSON.stringify(run.summary));
  saveRun();
  broadcast();
}

/* ================= Обработка одной ссылки ================= */

async function processLink(link) {
  const url = link.url;
  let tabId = null;

  try {
    // 1. Открываем техническую вкладку.
    run.stage = 'opening';
    await saveRun();
    broadcast();

    const settings = await chrome.storage.local.get('activeTab');
    const tab = await withTimeout(
      chrome.tabs.create({ url, active: !!settings.activeTab }),
      CFG.TAB_CREATE_TIMEOUT_MS,
      'не удалось открыть вкладку за отведённое время'
    );
    tabId = tab.id;
    activeTabId = tabId;
    scriptInjected = false;
    injectedUrl = null;
    navRecoveryCount = 0; // лимит навигаций — на каждую ссылку свой
    addLog(`вкладка ${tabId} открыта: ${url}`);

    // 2. Ждём полной загрузки (опрос, а не фиксированная задержка).
    await waitTabComplete(tabId, CFG.TAB_LOAD_TIMEOUT_MS);
    checkStop();
    await sleepInterruptible(CFG.SETTLE_MS);
    addLog('вкладка загружена');

    // 3. Внедряем контентный скрипт.
    run.stage = 'pages';
    await saveRun();
    broadcast();

    await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        files: CFG.INJECT_FILES
      }),
      CFG.INJECT_TIMEOUT_MS,
      'не удалось внедрить скрипт в страницу за отведённое время'
    );
    scriptInjected = true;
    try {
      const t = await chrome.tabs.get(tabId);
      injectedUrl = (t && t.url) || url;
    } catch { injectedUrl = url; }
    addLog('контентный скрипт внедрён');

    // 4. Запускаем обработку и ждём результат.
    activeJobId = crypto.randomUUID();
    lastProgressAt = Date.now();
    const jobPromise = new Promise((resolve, reject) => {
      pendingJob = { resolve, reject };
    });

    try {
      await withTimeout(
        chrome.tabs.sendMessage(tabId, {
          type: 'CATALOG_START',
          jobId: activeJobId,
          settings: settingsPayload()
        }),
        CFG.SEND_TIMEOUT_MS,
        'контентный скрипт не принял команду старта'
      );

      const result = await withTimeout(
        jobPromise,
        CFG.LINK_TIMEOUT_MS,
        'таймаут обработки страницы',
        () => {
          // Сообщаем контентному скрипту об остановке, чтобы он не продолжал качать страницы.
          chrome.tabs.sendMessage(tabId, { type: 'CATALOG_ABORT', jobId: activeJobId }).catch(() => {});
        }
      );

      checkStop();
      addLog(`PDF готов: ${result.pageCount} стр., ${(result.size / 1048576).toFixed(1)} МБ — ${result.filename}`);

      // 5. Скачиваем PDF через официальный Downloads API.
      //    Файл качается по blob-URL, созданному на странице; вкладка остаётся
      //    открытой до завершения скачивания, иначе blob-URL умрёт.
      run.stage = 'downloading';
      link.filename = result.filename;
      await saveRun();
      broadcast();

      let dlId = null;
      try {
        dlId = await chrome.downloads.download({
          url: result.blobUrl,
          filename: result.filename,
          conflictAction: 'uniquify'
        });
        addLog(`скачивание запущено: ${result.filename}`);
      } catch (e) {
        // Крайний случай: Chrome не принял blob-URL. Используем запасной путь —
        // скачивание через <a download> на самой странице (как в исходном скрипте).
        addLog('downloads.download не принял blob-URL, запасной вариант: ' + messageOf(e));
        console.warn('downloads.download не принял blob-URL, запасной вариант:', messageOf(e));
        await chrome.tabs.sendMessage(tabId, {
          type: 'CATALOG_TRIGGER_DOWNLOAD',
          jobId: activeJobId,
          filename: result.filename
        }).catch(() => {});
        await sleepInterruptible(CFG.FALLBACK_DOWNLOAD_GRACE_MS);
        return;
      }

      currentDownloadId = dlId;
      try {
        await waitDownloadDone(dlId, CFG.DOWNLOAD_TIMEOUT_MS);
        addLog('скачивание завершено: ' + result.filename);
      } finally {
        currentDownloadId = null;
      }
    } finally {
      // Если сообщение не ушло или обработка прервалась по таймауту — не оставляем
      // «висячий» pendingJob: поздние сообщения от старой вкладки не должны ничего решать.
      pendingJob = null;
    }

  } finally {
    // Техническая вкладка закрывается в любом случае (blob-URL умирает вместе с ней).
    if (tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch { /* уже закрыта */ }
    }
    activeTabId = null;
  }
}

function checkStop() {
  if (stopRequested) throw new StopError('остановлено пользователем');
}

/* ---------- ожидание загрузки вкладки ---------- */

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const t = setInterval(async () => {
      if (stopRequested) {
        clearInterval(t);
        reject(new StopError('остановлено пользователем'));
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(t);
        reject(new Error('страница не загрузилась за отведённое время'));
        return;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          clearInterval(t);
          resolve();
        }
      } catch {
        clearInterval(t);
        reject(new Error('вкладка была закрыта до завершения обработки'));
      }
    }, 400);
  });
}

/* ---------- ожидание завершения скачивания ---------- */

function waitDownloadDone(downloadId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const done = () => settle(resolve);
    const fail = (err) => settle(reject, err);

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;

      if (delta.state.current === 'complete') {
        cleanup();
        done();
      } else if (delta.state.current === 'interrupted') {
        cleanup();
        const reason = delta.error && delta.error.current ? `: ${delta.error.current}` : '';
        if (stopRequested) {
          fail(new StopError('остановлено пользователем'));
        } else {
          fail(new Error(`скачивание прервано${reason}`));
        }
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
    };

    const timer = setTimeout(() => {
      cleanup();
      fail(new Error('таймаут ожидания скачивания (возможно, открыт диалог «Сохранить как»)'));
    }, timeoutMs);

    chrome.downloads.onChanged.addListener(onChanged);

    // Страховка от гонки: если скачивание завершилось до установки слушателя.
    chrome.downloads.search({ id: downloadId }).then((items) => {
      const it = items && items[0];
      if (!it || it.state === 'in_progress') return;
      if (it.state === 'complete') { cleanup(); done(); }
      else if (it.state === 'interrupted') {
        cleanup();
        if (stopRequested) fail(new StopError('остановлено пользователем'));
        else fail(new Error(`скачивание прервано${it.error ? ': ' + it.error : ''}`));
      }
    }).catch(() => {});
  });
}

/* ================= Сообщения контентного скрипта ================= */

async function handleCatalogProgress(msg) {
  if (msg.jobId !== activeJobId) return { ignored: true };

  lastProgressAt = Date.now();
  if (typeof msg.stage === 'string') run.stage = msg.stage;
  if (msg.page != null) {
    run.page = { current: msg.page, total: msg.total };
  }
  // журналируем смену этапа и «круглые» номера страниц (не каждое сообщение)
  const key = String(run.stage) + (msg.page ? `:${msg.page.current}/${msg.page.total}` : '');
  if (key !== lastLoggedProgressKey) {
    lastLoggedProgressKey = key;
    addLog('прогресс: ' + key);
  }
  await saveRun();
  broadcast();
  return { ok: true };
}

async function handleCatalogResult(msg) {
  if (msg.jobId !== activeJobId) return { ignored: true };
  const p = pendingJob;
  pendingJob = null;
  if (p) p.resolve(msg);
  return { ok: true };
}

async function handleCatalogError(msg) {
  if (msg.jobId !== activeJobId) return { ignored: true };
  addLog('ошибка от страницы: ' + (msg.message || 'неизвестная ошибка'));
  const p = pendingJob;
  pendingJob = null;
  if (p) p.reject(new Error(msg.message || 'неизвестная ошибка'));
  return { ok: true };
}
