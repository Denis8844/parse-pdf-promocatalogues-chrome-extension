'use strict';

/**
 * Общие утилиты. Этот файл подключается:
 *  - в popup (popup.html) — разбор ссылок из textarea;
 *  - в service worker (importScripts в background.js) — isListingUrl;
 *  - в контентный скрипт каталога (content.js через chrome.scripting.executeScript) —
 *    формирование имени файла;
 *  - в контентный скрипт страницы-списка (listing.js) — parseFrenchDateRange.
 *
 * ВАЖНО: файл не должен содержать обращений к chrome.* API, чтобы его можно было
 * использовать в любом контексте расширения (и тестировать вне браузера),
 * а его top-level объявления не должны конфликтовать с background.js
 * (importScripts выполняется в общей области видимости service worker'а).
 */

/**
 * Базовый адрес сайта, с которым работает расширение.
 * Относительные ссылки (начинающиеся с "/") автоматически добавляются к нему.
 */
const SITE_BASE_URL = 'https://www.promocatalogues.fr';

/**
 * Приводит введённую ссылку к абсолютному виду:
 *  - "https://..." / "http://..." — как есть;
 *  - "//host/path" — добавляется "https:";
 *  - "/path" — к началу добавляется SITE_BASE_URL;
 *  - остальное — не ссылка (возвращается в invalid).
 */
function normalizeCatalogLink(raw) {
  const s = String(raw).trim();

  if (/^https?:\/\//i.test(s)) return { url: s };
  if (/^\/\//.test(s)) return { url: 'https:' + s };
  if (/^\//.test(s)) {
    return { url: SITE_BASE_URL.replace(/\/+$/, '') + '/' + s.replace(/^\/+/, '') };
  }
  return { invalid: s };
}

/**
 * Разбирает текст из textarea в список ссылок.
 *
 * Правила:
 *  - одна ссылка на строку (основной формат);
 *  - ссылки, разделённые пробелами;
 *  - ссылки, разделённые запятыми;
 *  - ссылки, разделённые точкой с запятой;
 *  - ссылки, разделённые вертикальной чертой "|";
 *  - все разделители можно смешивать в одном вводе;
 *  - пустые строки игнорируются;
 *  - повторяющиеся ссылки удаляются (в т.ч. когда одна ссылка введена
 *    и в относительном, и в абсолютном виде);
 *  - пробелы вокруг ссылок удаляются.
 *
 * Относительные ссылки ("/regardez/offres/...") автоматически дополняются
 * до https://www.promocatalogues.fr/...
 *
 * @param {string} text
 * @returns {{links: string[], invalid: string[]}}
 */
function parseLinks(text) {
  if (!text || typeof text !== 'string') {
    return { links: [], invalid: [] };
  }

  const seen = new Set();
  const links = [];
  const invalid = [];

  // Разделители: перевод строки, пробел/таб, запятая, точка с запятой, "|".
  const parts = String(text)
    .split(/[\s,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const { url, invalid: bad } = normalizeCatalogLink(part);
    if (bad !== undefined) {
      invalid.push(bad);
      continue;
    }
    if (!isHttpUrl(url)) {
      invalid.push(part);
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    links.push(url);
  }

  return { links, invalid };
}

/**
 * Проверяет, что строка является корректным http/https URL.
 * Другие схемы (file:, javascript:, data: и т.п.) не поддерживаются.
 */
function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Формирует имя PDF-файла по логике исходного скрипта:
 *   1. document.title с удалением хвоста сайта (regex исходного скрипта);
 *   2. недопустимые символы заменяются на "_";
 *   3. длина ограничена 60 символами;
 *   4. если результат пуст — последний сегмент пути URL (или 'catalogue');
 *   5. к имени добавляется номер каталога из ссылки (перед датой, если он есть
 *      и ещё не присутствует в названии — чтобы не дублировать);
 *   6. дата в конце имени:
 *        - если известна дата действия каталога (со страницы-списка) — она:
 *          «…_du_2026-09-25_au_2026-10-12.pdf»;
 *        - иначе сегодняшняя дата, как в исходном скрипте: «…_2026-08-27.pdf».
 *
 * @param {string} title  — document.title страницы каталога
 * @param {string} pathname — location.pathname страницы каталога
 * @param {{from?: string, to?: string}} [validity] — дата действия каталога
 *   (YYYY-MM-DD), собранная со страницы-списка; может отсутствовать
 * @returns {string} например: "Название_3766479_du_2026-09-25_au_2026-10-12.pdf"
 */
function makeCatalogFilename(title, pathname, validity) {
  const d = new Date();
  const today =
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`;

  const slug = (pathname || '').split('/').filter(Boolean).pop() || 'catalogue';

  const base = String(title || '')
    .replace(/\s*[-–|]\s*[^-–|]*$/, '') // убрать хвост сайта: " — SiteName" / " | Site"
    .replace(/[^\p{L}\p{N}-]+/gu, '_')  // очистить недопустимые символы
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || slug;

  // Номер каталога из ссылки — добавляем к имени файла перед датой.
  const id = extractCatalogId(pathname);
  const suffix = (id && !base.endsWith(id)) ? `_${id}` : '';

  // Дата действия каталога (если известна) вместо сегодняшней даты.
  const v = validitySuffix(validity);

  return v
    ? `${base}${suffix}_${v}.pdf`
    : `${base}${suffix}_${today}.pdf`;
}

/**
 * Достаёт номер каталога из пути ссылки.
 * Например, "/regardez/offres/catalogue-noz-3766479" -> "3766479".
 * Если номера в ссылке нет — возвращает null (номер в имя не добавляется).
 * Сегмент, состоящий только из цифр (например "/flyers/3660147"),
 * номером каталога не считается.
 */
function extractCatalogId(pathname) {
  const seg = String(pathname || '').split('/').filter(Boolean).pop();
  if (!seg) return null;
  const m = /-(\d+)$/.exec(seg);
  return m ? m[1] : null;
}

/* ================= Страницы-списки каталогов ================= */

/**
 * Ссылка на страницу-список каталогов магазина:
 *   https://www.promocatalogues.fr/magasins/<ритейлер>/catalogues-promotions
 * Такие ссылки расширение разворачивает в отдельные каталоги: открывает страницу,
 * собирает с неё все карточки каталогов и ставит их в очередь по одному.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isListingUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (!/(^|\.)promocatalogues\.fr$/.test(u.hostname)) return false;
    return /^\/magasins\/[^/]+\/catalogues-promotions\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/* ================= Прогресс очереди: магазины и каталоги ================= */

/**
 * Разложение прогресса очереди для заголовка popup.
 *
 * Ссылка-список (/magasins/…) после сбора заменяется в очереди своими
 * каталогами (у каждого есть fromListing — url страницы магазина), поэтому
 * «магазинами» считаем: ссылки-списки, ещё оставшиеся в очереди (в том числе
 * пропущенные/ошибочные), плюс уникальные fromListing у каталогов.
 *
 * Возвращает строку вида
 *   «Магазин 1 из 3 · Каталоги 2 из 12 · Всего 15 из 34»
 * где «Каталоги» — прогресс внутри текущего магазина, «Всего» — суммарный
 * счётчик всех каталогов в очереди. Частные случаи:
 *   - идёт сбор списка: «Магазин 2 из 3 · Каталоги: собираю список · Всего …»
 *   - ссылка вставлена вручную (без fromListing): «Каталог 15 из 34»
 */
function progressCaption(links, cur) {
  const list = Array.isArray(links) ? links : [];
  const curLink = list[cur];
  if (!curLink) return '';

  const isStore = (l) => isListingUrl(l.url);
  const curIsStore = isStore(curLink);

  // Все магазины очереди: ссылки-списки + уникальные fromListing
  const storeUrls = new Set();
  for (const l of list) {
    if (isStore(l)) storeUrls.add(l.url);
    else if (l.fromListing) storeUrls.add(l.fromListing);
  }

  // Сколько разных магазинов встретилось до текущей позиции
  const seen = new Set();
  let storesBefore = 0;
  for (let i = 0; i < cur; i++) {
    const l = list[i];
    const key = isStore(l) ? l.url : (l.fromListing || null);
    if (key && !seen.has(key)) { seen.add(key); storesBefore++; }
  }

  const cp = catalogProgress(list, cur);
  const total = `Всего ${cp.pos} из ${cp.total}`;

  if (curIsStore) {
    // Ссылка-список ещё в очереди — значит, её каталоги собираются прямо сейчас
    const no = storesBefore + 1;
    return `Магазин ${no} из ${storeUrls.size} · Каталоги: собираю список · ${total}`;
  }

  const storeUrl = curLink.fromListing;
  if (!storeUrl || !storeUrls.has(storeUrl)) {
    // Каталог вставлен вручную, не из ссылки-списка
    return `Каталог ${cp.pos} из ${cp.total}`;
  }
  // Если каталоги этого магазина уже встречались раньше — он посчитан в storesBefore
  const no = storesBefore - (seen.has(storeUrl) ? 1 : 0) + 1;
  const siblings = list.filter((l) => l.fromListing === storeUrl);
  const k = siblings.indexOf(curLink) + 1;
  return `Магазин ${no} из ${storeUrls.size} · Каталоги ${k} из ${siblings.length} · ${total}`;
}

/**
 * Прогресс по каталогам без учёта ссылок-списков (для полосы прогресса).
 * Возвращает {pos, total}: total — сколько каталогов в очереди,
 * pos — позиция текущей ссылки среди них (сама ссылка-список позицию
 * не сдвигает, поэтому во время сбора списка pos = число готовых каталогов).
 */
function catalogProgress(links, cur) {
  const list = Array.isArray(links) ? links : [];
  let total = 0;
  let pos = 0;
  for (let i = 0; i < list.length; i++) {
    if (isListingUrl(list[i].url)) continue; // ссылка-список — не каталог
    total++;
    if (i <= cur) pos++;
  }
  return { pos, total };
}

/* ================= Даты действия каталога (французский формат) ================= */

/**
 * Французские месяцы: сокращения с сайта и полные названия.
 * Ключи без точек и диакритики (текст нормализуется перед поиском).
 */
const FRENCH_MONTHS = {
  janv: 1, janvier: 1,
  fevr: 2, fevrier: 2,
  mars: 3,
  avr: 4, avril: 4,
  mai: 5,
  juin: 6,
  juil: 7, juillet: 7,
  aout: 8,
  sept: 9, septembre: 9,
  oct: 10, octobre: 10,
  nov: 11, novembre: 11,
  dec: 12, decembre: 12
};

// Насколько дата может быть в прошлом, чтобы не считать её «прошлогодней».
// Защита от перехода года: «au 11 janv.», увиденное в декабре, — это январь
// СЛЕДУЮЩЕГО года; при этом давно начавшийся каталог («3 avr. au 30 sept.»)
// остаётся в текущем году.
const DATE_PAST_GRACE_MS = 120 * 24 * 60 * 60 * 1000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Разбирает дату действия каталога из текста карточки на странице-списке.
 *
 * Примеры текста (элемент <small> с кружком статуса):
 *   «Valable: 25 sept. au 12 oct.»            — диапазон, год не указан;
 *   «Valable: 1er déc. 2026 au 11 janv. 2027» — диапазон с явными годами;
 *   «à partir du 5 janv.»                     — одна дата.
 *
 * Правила определения года (когда его нет в тексте):
 *   - опираемся на ДАТУ КОНЦА: активные каталоги заканчиваются в будущем,
 *     поэтому «конец в этом году, но давно прошёл» означает январь следующего
 *     года (страница открыта в декабре);
 *   - если начало позже конца («29 déc. au 11 janv.») — начало в прошлом году.
 *
 * @param {string} text — текст карточки («Valable: …»)
 * @param {Date} [now] — «текущая» дата (для тестов)
 * @returns {{from: string, to?: string} | null} даты в формате YYYY-MM-DD
 */
function parseFrenchDateRange(text, now) {
  if (text == null) return null;
  now = (now instanceof Date) ? now : new Date();

  // нижний регистр + снятие диакритики: «août» -> «aout», «déc.» -> «dec.»
  const s = String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // «25 sept.», «1er janv», «12 oct. 2026» — день (+«1er»), месяц, необязательный год
  const re = /(\d{1,2})(?:er)?\s+([a-z]+)\.?(?:\s+(\d{4}))?/g;
  const found = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const month = FRENCH_MONTHS[m[2]];
    if (!month) continue;
    const day = parseInt(m[1], 10);
    if (day < 1 || day > 31) continue;
    found.push({ day, month, year: m[3] ? parseInt(m[3], 10) : null });
    if (found.length >= 2) break;
  }
  if (!found.length) return null;

  const thisYear = now.getFullYear();
  const pastLimit = now.getTime() - DATE_PAST_GRACE_MS;

  // Одна дата
  if (found.length === 1) {
    const a = found[0];
    let year = a.year;
    if (year == null) {
      year = thisYear;
      if (new Date(thisYear, a.month - 1, a.day).getTime() < pastLimit) year = thisYear + 1;
    }
    return { from: isoDate(year, a.month, a.day) };
  }

  // Диапазон «X au Y»
  const a = found[0];
  const b = found[1];
  if (a.year != null && b.year != null) {
    return { from: isoDate(a.year, a.month, a.day), to: isoDate(b.year, b.month, b.day) };
  }

  let endYear = (b.year != null) ? b.year : thisYear;
  if (b.year == null && new Date(endYear, b.month - 1, b.day).getTime() < pastLimit) {
    endYear = thisYear + 1;
  }
  let startYear = (a.year != null) ? a.year : endYear;
  if (new Date(startYear, a.month - 1, a.day) > new Date(endYear, b.month - 1, b.day)) {
    startYear = endYear - 1;
  }
  return { from: isoDate(startYear, a.month, a.day), to: isoDate(endYear, b.month, b.day) };
}

/**
 * Суффикс даты действия для имени файла:
 *   {from, to} -> «du_2026-09-25_au_2026-10-12»
 *   {from}     -> «du_2026-09-25»
 *   {to}       -> «au_2026-10-12»
 * Некорректные значения игнорируются (null).
 */
function validitySuffix(validity) {
  if (!validity || typeof validity !== 'object') return null;
  const okDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : null);
  const from = okDate(validity.from);
  const to = okDate(validity.to);
  if (from && to) return `du_${from}_au_${to}`;
  if (from) return `du_${from}`;
  if (to) return `au_${to}`;
  return null;
}

/**
 * Короткая пауза (для контентного скрипта).
 * При abort=true бросает исключение, если флаг aborted установлен.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
