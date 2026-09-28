'use strict';

/**
 * Контентный скрипт для СТРАНИЦ-СПИСКОВ каталогов магазина
 * (https://www.promocatalogues.fr/magasins/<ритейлер>/catalogues-promotions).
 *
 * Внедряется service worker'ом (chrome.scripting.executeScript, файлы
 * utils.js + listing.js), когда в очереди встречается ссылка-список.
 * Задача скрипта:
 *   1. собрать карточки каталогов — ссылки вида /regardez/offres/…;
 *   2. для каждой карточки прочитать статус (кружок .status__circle:
 *      online — действует, futureOnline — скоро начнётся) и текст
 *      «Valable: 25 sept. au 12 oct.» (дата действия);
 *   3. нажать «Charger plus de catalogues», пока сайт не отдаст все каталоги;
 *   4. вернуть список в service worker.
 *
 * Даты разбираются функцией parseFrenchDateRange из utils.js
 * (внедряется раньше этого файла).
 *
 * Протокол обмена с service worker:
 *  - SW -> listing: {type:'LISTING_START', jobId} — начать сбор;
 *  - SW -> listing: {type:'LISTING_ABORT', jobId} — остановить;
 *  - listing -> SW: {type:'LISTING_PROGRESS', jobId, found} — сколько найдено;
 *  - listing -> SW: {type:'LISTING_RESULT', jobId, catalogues} — итог;
 *  - listing -> SW: {type:'LISTING_ERROR', jobId, message}.
 *
 * Формат catalogues: [{url, title, dateText, status, active, validity}].
 * Скрипт ничего не скачивает — только собирает список; скачивание каждого
 * каталога выполняет обычный конвейер (content.js) в отдельной вкладке.
 */

(() => {
  if (window.__catalogListingLoaded) return;
  window.__catalogListingLoaded = true;

  const CLICK_WAIT_TIMEOUT_MS = 15_000; // сколько ждать новых карточек после клика
  const CLICK_POLL_MS = 400;            // период опроса DOM
  const MAX_LOAD_MORE_CLICKS = 40;      // защита от вечного «Charger plus»
  const SCROLL_ROUNDS = 3;              // фолбэк: прокрутки вниз, если кнопки нет

  let activeJobId = null;
  let aborted = false;
  let busy = false;

  /* ---------- служебное ---------- */

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => {
      console.error('[catalog-downloader] сообщение не доставлено в service worker:',
        msg.type, e && e.message ? e.message : e);
    });
  }

  function checkAbort() {
    if (aborted) throw new Error('остановлено пользователем');
  }

  /* ---------- приём сообщений от service worker ---------- */

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'LISTING_START':
        void handleStart(msg).catch((e) => {
          if (!aborted) {
            send({ type: 'LISTING_ERROR', jobId: msg.jobId, message: String(e && e.message || e) });
          }
        });
        return { ok: true };

      case 'LISTING_ABORT':
        if (msg.jobId === activeJobId) aborted = true;
        return { ok: true };

      default:
        return;
    }
  });

  async function handleStart(msg) {
    if (busy) {
      // Повторная команда того же задания («проверка пульса» в SW) — уже работаем.
      if (msg.jobId === activeJobId) return;
      send({ type: 'LISTING_ERROR', jobId: msg.jobId, message: 'страница уже обрабатывается' });
      return;
    }
    busy = true;
    aborted = false;
    activeJobId = msg.jobId;

    console.log('[catalog-downloader] сбор списка каталогов, jobId:', msg.jobId);

    try {
      const catalogues = await collectAll();
      if (aborted) return;
      await send({ type: 'LISTING_RESULT', jobId: activeJobId, catalogues });
    } catch (e) {
      if (!aborted) {
        await send({
          type: 'LISTING_ERROR',
          jobId: activeJobId,
          message: e && e.message ? e.message : String(e)
        });
      }
    } finally {
      busy = false;
    }
  }

  /* ---------- поиск карточек каталогов ---------- */

  // Абсолютный URL каталога из ссылки (без хеша и параметров) либо null.
  function catalogUrlOf(a) {
    try {
      const u = new URL(a.getAttribute('href') || '', location.origin);
      u.hash = '';
      u.search = '';
      return u.href;
    } catch {
      return null;
    }
  }

  // Ближайший предок ссылки, в котором есть кружок статуса (.status__circle), —
  // это карточка каталога. Защита от «перелёта» выше карточки: карточка должна
  // ссылаться ровно на один каталог (все ссылки /regardez/offres/ внутри неё
  // ведут на один и тот же URL).
  function cardOf(a) {
    let node = a.parentElement;
    while (node && node !== document.body) {
      if (node.querySelector('.status__circle')) {
        const urls = new Set();
        node.querySelectorAll('a[href*="/regardez/offres/"]').forEach((x) => {
          const u = catalogUrlOf(x);
          if (u) urls.add(u);
        });
        return urls.size === 1 ? node : null;
      }
      node = node.parentElement;
    }
    return null;
  }

  // Один проход по DOM: все ссылки /regardez/offres/…, сгруппированные по URL.
  function scanCatalogues() {
    const map = new Map();

    document.querySelectorAll('a[href*="/regardez/offres/"]').forEach((a) => {
      const url = catalogUrlOf(a);
      if (!url) return;

      const card = cardOf(a);
      if (!card) return; // ссылка вне карточки каталога

      const circle = card.querySelector('.status__circle');
      const statusMatch = circle ? /status__circle\s+([\w-]+)/.exec(circle.className) : null;
      const status = statusMatch ? statusMatch[1] : 'unknown';

      // Текст «Valable: 25 sept. au 12 oct.» — из <small> с кружком статуса.
      const small = circle ? circle.closest('small') : null;
      const dateText = small ? small.textContent.replace(/\s+/g, ' ').trim() : '';

      const heading = card.querySelector('h1,h2,h3,h4,h5,h6');
      const title = heading ? heading.textContent.replace(/\s+/g, ' ').trim() : '';

      const entry = {
        url,
        title,
        dateText,
        status,
        active: status === 'online' || status === 'futureOnline'
      };

      const prev = map.get(url);
      if (!prev) {
        map.set(url, entry);
      } else if (!prev.dateText && dateText) {
        // та же карточка, но ссылка без даты — дополняем данные
        prev.dateText = dateText;
        prev.status = status;
        prev.active = entry.active;
        if (!prev.title && title) prev.title = title;
      }
    });

    return [...map.values()];
  }

  /* ---------- «Charger plus de catalogues» ---------- */

  function findLoadMore() {
    const candidates = document.querySelectorAll('button, [role="button"], a');
    for (const el of candidates) {
      if (!el.offsetParent) continue; // невидимый элемент
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^charger plus/i.test(t)) continue;
      // <a href="…"> может увести со страницы — такой «кнопкой» не пользуемся
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (href && href !== '#' && !/^javascript:/i.test(href)) continue;
      }
      return el;
    }
    return null;
  }

  // Нажимает «Charger plus», пока появляются новые карточки.
  async function loadAllCatalogues() {
    for (let click = 0; click < MAX_LOAD_MORE_CLICKS; click++) {
      checkAbort();

      const btn = findLoadMore();
      if (!btn) break;

      const before = scanCatalogues().length;
      try { btn.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
      btn.click();

      const deadline = Date.now() + CLICK_WAIT_TIMEOUT_MS;
      let grown = false;
      while (Date.now() < deadline) {
        checkAbort();
        await sleep(CLICK_POLL_MS);
        if (scanCatalogues().length > before) { grown = true; break; }
        if (!findLoadMore()) return; // кнопка исчезла — всё загружено
      }
      if (!grown) break; // клик ничего не дал — больше грузить нечего

      const total = scanCatalogues().length;
      await send({ type: 'LISTING_PROGRESS', jobId: activeJobId, found: total });
    }

    // Фолбэк: если кнопки не было, прокручиваем страницу вниз — некоторые
    // списки подгружают карточки при прокрутке.
    for (let i = 0; i < SCROLL_ROUNDS; i++) {
      checkAbort();
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(600);
    }
    window.scrollTo(0, 0);
  }

  /* ---------- основной сценарий ---------- */

  async function collectAll() {
    await send({ type: 'LISTING_PROGRESS', jobId: activeJobId, found: scanCatalogues().length });
    await loadAllCatalogues();

    // Финальный проход: разбираем даты действия («Valable: …») в структуру.
    return scanCatalogues().map((c) => ({
      ...c,
      validity: parseFrenchDateRange(c.dateText) || null
    }));
  }
})();
