'use strict';

/**
 * Общие утилиты. Этот файл подключается:
 *  - в popup (popup.html) — разбор ссылок из textarea;
 *  - в контентный скрипт (через chrome.scripting.executeScript) — формирование имени файла.
 *
 * ВАЖНО: файл не должен содержать обращений к chrome.* API, чтобы его можно было
 * использовать в любом контексте расширения (и тестировать вне браузера).
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
 *   5. к имени добавляется текущая дата YYYY-MM-DD;
 *   6. к имени добавляется номер каталога из ссылки (перед датой, если он есть
 *      и ещё не присутствует в названии — чтобы не дублировать).
 *
 * @param {string} title  — document.title страницы каталога
 * @param {string} pathname — location.pathname страницы каталога
 * @returns {string} например: "Название_каталога_3766479_2026-08-27.pdf"
 */
function makeCatalogFilename(title, pathname) {
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

  return `${base}${suffix}_${today}.pdf`;
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

/**
 * Короткая пауза (для контентного скрипта).
 * При abort=true бросает исключение, если флаг aborted установлен.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
