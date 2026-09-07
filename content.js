'use strict';

/**
 * Контентный скрипт — перенос основной логики исходного скрипта.
 *
 * Внедряется на страницу каталога по команде service worker'а
 * (chrome.scripting.executeScript). Работает внутри страницы, поэтому:
 *  - fetch изображений выполняется тем же контекстом, что и в исходном скрипте
 *    (same-origin: куки, referer, отсутствие CORS-проблем — сетевое поведение идентично);
 *  - поиск страниц, конвертация webp -> jpeg и сборка PDF — один в один как в исходнике.
 *
 * Протокол обмена с service worker:
 *  - SW -> content: {type:'CATALOG_START', jobId} — начать обработку;
 *  - SW -> content: {type:'CATALOG_ABORT', jobId} — остановить (по запросу пользователя
 *    или таймауту); прерывает даже выполняющиеся fetch-запросы через AbortController;
 *  - SW -> content: {type:'CATALOG_TRIGGER_DOWNLOAD', filename} — запасной способ скачивания;
 *  - content -> SW: {type:'CATALOG_PROGRESS', jobId, stage, page, total};
 *  - content -> SW: {type:'CATALOG_RESULT', jobId, blobUrl, filename, pageCount, size};
 *  - content -> SW: {type:'CATALOG_ERROR', jobId, message}.
 *
 * Готовый PDF НЕ передаётся по messaging: через сообщения ходит только строка blob-URL.
 * Это обходит лимит Chrome на размер сообщения (64 MiB) и JSON-сериализацию типизированных
 * массивов. Blob живёт в памяти страницы до закрытия вкладки, а service worker в это время
 * скачивает его через chrome.downloads.download.
 */

(() => {
  if (window.__catalogDownloaderLoaded) return;
  window.__catalogDownloaderLoaded = true;

  const Q = 0.92;                       // качество JPEG — как в исходном скрипте
  const PAGE_WAIT_TIMEOUT_MS = 60_000;  // сколько ждём появления панели миниатюр
  const PAGE_WAIT_POLL_MS = 400;        // период опроса DOM
  const FETCH_TIMEOUT_MS = 120_000;     // таймаут загрузки одного полноразмерного изображения

  let activeJobId = null;
  let aborted = false;
  let busy = false;
  let abortController = null;           // прерывает выполняющиеся fetch при остановке

  // Активные настройки (передаются service worker'ом в CATALOG_START).
  let activeSettings = {
    jpegQ: Q,
    pageWaitTimeoutMs: PAGE_WAIT_TIMEOUT_MS,
    fetchTimeoutMs: FETCH_TIMEOUT_MS
  };

  const sNum = (v, fallback) => (typeof v === 'number' && isFinite(v)) ? v : fallback;

  // Храним последний blob-URL и имя файла, чтобы SW мог попросить скачать их запасным способом.
  let lastBlobUrl = null;
  let lastFilename = null;

  /* ---------- служебное ---------- */

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((e) => {
      // Сообщение не доставлено в SW — пишем в консоль страницы: это видно
      // в DevTools вкладки каталога и помогает диагностировать «тишину».
      console.error('[catalog-downloader] сообщение не доставлено в service worker:',
        msg.type, e && e.message ? e.message : e);
    });
  }

  function checkAbort() {
    if (aborted) throw new Error('остановлено пользователем');
  }

  // fetch с таймаутом, который можно мгновенно прервать командой CATALOG_ABORT
  function fetchImage(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onRunAbort = () => ctrl.abort();
    if (abortController) abortController.signal.addEventListener('abort', onRunAbort, { once: true });
    return fetch(url, { signal: ctrl.signal }).finally(() => {
      clearTimeout(timer);
      if (abortController) abortController.signal.removeEventListener('abort', onRunAbort);
    });
  }

  /* ---------- приём сообщений от service worker ---------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'CATALOG_START':
        void handleStart(msg).catch((e) => {
          if (!aborted) {
            send({ type: 'CATALOG_ERROR', jobId: msg.jobId, message: String(e && e.message || e) });
          }
        });
        return { ok: true };

      case 'CATALOG_ABORT':
        if (msg.jobId === activeJobId) {
          aborted = true;
          if (abortController) abortController.abort();
        }
        return { ok: true };

      case 'CATALOG_TRIGGER_DOWNLOAD':
        // Запасной путь: если chrome.downloads.download не принял blob-URL
        // (крайний случай), качаем как в исходном скрипте — через <a download>.
        if (msg.jobId === activeJobId && lastBlobUrl && msg.filename) {
          triggerDownload(lastBlobUrl, msg.filename);
        }
        return { ok: true };

      default:
        return;
    }
  });

  function triggerDownload(blobUrl, filename) {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------- основная обработка ---------- */

  async function handleStart(msg) {
    if (busy) {
      // Повторная команда старта того же задания (SW «проверяет пульс») — уже работаем,
      // это не ошибка. Команда другого задания — ошибка.
      if (msg.jobId === activeJobId) return;
      send({ type: 'CATALOG_ERROR', jobId: msg.jobId, message: 'страница уже обрабатывается' });
      return;
    }
    busy = true;
    aborted = false;
    activeJobId = msg.jobId;
    abortController = new AbortController();

    // Применяем настройки от SW (если переданы) с фолбэком на встроенные значения.
    const s = msg.settings || {};
    activeSettings = {
      jpegQ: sNum(s.jpegQ, Q),
      pageWaitTimeoutMs: sNum(s.pageWaitTimeoutMs, PAGE_WAIT_TIMEOUT_MS),
      fetchTimeoutMs: sNum(s.fetchTimeoutMs, FETCH_TIMEOUT_MS)
    };

    console.log('[catalog-downloader] старт обработки, jobId:', msg.jobId);

    try {
      const result = await runCatalog();
      if (aborted) return; // пользователь остановил — результат не нужен
      await send({ type: 'CATALOG_RESULT', jobId: activeJobId, ...result });
    } catch (e) {
      if (!aborted) {
        await send({
          type: 'CATALOG_ERROR',
          jobId: activeJobId,
          message: e && e.message ? e.message : String(e)
        });
      }
    } finally {
      busy = false;
      abortController = null;
    }
  }

  async function runCatalog() {
    // Сразу сообщаем о старте — heartbeat в SW видит, что скрипт жив.
    await send({ type: 'CATALOG_PROGRESS', jobId: activeJobId, stage: 'pages' });

    // 1. Собираем страницы из панели миниатюр (с ожиданием появления — разумный
    //    timeout с опросом, а не фиксированная большая задержка).
    const map = new Map();
    const deadline = Date.now() + activeSettings.pageWaitTimeoutMs;
    let lastProgressAt = 0;

    while (map.size === 0) {
      document.querySelectorAll('[id^="overview-pages-"]').forEach((el) => {
        const n = +el.id.replace('overview-pages-', '');
        const im = el.querySelector('img');
        if (!im) return;
        const u = im.currentSrc || im.src;
        if (/\/flyers\/\d+\//.test(u)) map.set(n, u);
      });

      if (map.size > 0) break;
      checkAbort();
      if (Date.now() > deadline) break;

      const now = Date.now();
      if (now - lastProgressAt > 2000) {
        lastProgressAt = now;
        await send({ type: 'CATALOG_PROGRESS', jobId: activeJobId, stage: 'pages' });
      }
      await sleep(PAGE_WAIT_POLL_MS);
    }

    const nums = [...map.keys()].sort((a, b) => a - b);

    if (!nums.length) {
      throw new Error('страницы не найдены — открой ридер каталога');
    }

    console.log('каталог: найдено страниц:', nums.length);

    // 2. Качаем страницы в полном размере и пережимаем webp -> jpeg.
    const pages = [];

    for (const n of nums) {
      checkAbort();

      // В исходном скрипте: /(260x270WebP|thumbnailFixedWidth|largeWebP)/ -> /zoomLargeWebP/.
      // Добавлен вариант "260x270" (без WebP): на сайте у некоторых страниц миниатюра лежит
      // в папке 260x270/ (например, последняя страница каталога Picard — jpeg), а файл
      // zoomLargeWebP для неё существует — иначе такая страница попадала бы в PDF крошечной.
      const big = map.get(n).replace(
        /\/(260x270WebP|260x270|thumbnailFixedWidth|largeWebP)\//,
        '/zoomLargeWebP/'
      );

      await send({
        type: 'CATALOG_PROGRESS',
        jobId: activeJobId,
        stage: 'page',
        page: n,
        total: nums.length
      });

      let r;
      try {
        r = await fetchImage(big, activeSettings.fetchTimeoutMs);
      } catch (err) {
        if (aborted) throw new Error('остановлено пользователем');
        const isTimeout = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
        if (isTimeout) {
          throw new Error(`страница ${n}: таймаут загрузки изображения (${Math.round(activeSettings.fetchTimeoutMs / 1000)} с)`);
        }
        throw new Error(`страница ${n}: ошибка сети: ${err && err.message ? err.message : err}`);
      }

      checkAbort();

      if (!r.ok) {
        throw new Error('страница ' + n + ': HTTP ' + r.status);
      }

      const bmp = await createImageBitmap(await r.blob());

      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;

      c.getContext('2d').drawImage(bmp, 0, 0);

      bmp.close();

      const jb = await new Promise((res) => c.toBlob(res, 'image/jpeg', activeSettings.jpegQ));

      const bytes = new Uint8Array(await jb.arrayBuffer());

      pages.push({
        bytes,
        ...jpegInfo(bytes)
      });

      c.width = c.height = 0; // освобождаем память канваса

      console.log('страница', n, '/', nums.length);
    }

    // 3. Собираем PDF (алгоритм исходного скрипта, перенесён в pdf.js).
    await send({ type: 'CATALOG_PROGRESS', jobId: activeJobId, stage: 'pdf' });

    const chunks = collectPdfChunks(pages);
    const blob = new Blob(chunks, { type: 'application/pdf' });

    lastBlobUrl = URL.createObjectURL(blob);
    lastFilename = makeCatalogFilename(document.title, location.pathname);

    console.log('готово:', nums.length, 'страниц →', lastFilename);

    return {
      blobUrl: lastBlobUrl,
      filename: lastFilename,
      pageCount: nums.length,
      size: blob.size
    };
  }
})();
