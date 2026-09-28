#!/usr/bin/env node
/**
 * Интеграционный тест listing.js (сбор каталогов со страницы-списка)
 * на мини-DOM — без браузера и jsdom.
 *
 * Проверяет полный путь: LISTING_START → сканирование карточек → LISTING_RESULT:
 *  - находит все ссылки /regardez/offres/… и группирует их по каталогу;
 *  - карточка определяется по ближайшему предку с .status__circle
 *    (с защитой от «перелёта» выше карточки);
 *  - статус (online / futureOnline / прочие) и текст «Valable: …» читаются
 *    из <small> карточки;
 *  - дата действия разбирается parseFrenchDateRange (utils.js);
 *  - ссылки вне карточек игнорируются.
 *
 * Запуск: node scripts/test-listing.mjs
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ✓ ' + name); })
    .catch((e) => { failed++; console.error('  ✕ ' + name + ' — ' + e.message); });
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg || 'не равно'}: ${ja} !== ${jb}`);
}

/* ================= мини-DOM ================= */

class El {
  constructor(tag, attrs = {}, text = '') {
    this.tag = String(tag).toLowerCase();
    this.attrs = attrs || {};
    this.children = [];
    this.parent = null;
    this._text = text;
    this.offsetParent = {}; // «видимый»
  }
  get className() { return this.attrs.class || ''; }
  get parentElement() { return this.parent; }
  get textContent() {
    return (this._text || '') + this.children.map((c) => c.textContent).join('');
  }
  append(...kids) {
    for (const k of kids) { k.parent = this; this.children.push(k); }
    return this;
  }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }

  matchesOne(sel) {
    sel = sel.trim();
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      return this.className.split(/\s+/).includes(cls);
    }
    const m = /^([a-z0-9]+)?(?:\[([\w-]+)(?:\*="([^"]+)")?\])?$/i.exec(sel);
    if (!m) return false;
    const tag = m[1] ? m[1].toLowerCase() : null;
    const attr = m[2];
    const val = m[3];
    if (tag && this.tag !== tag) return false;
    if (attr) {
      const actual = this.getAttribute(attr);
      if (actual == null) return false;
      if (val !== undefined && !actual.includes(val)) return false;
    }
    return true;
  }
  querySelectorAll(sel) {
    const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (parts.some((p) => c.matchesOne(p))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    let node = this;
    while (node) {
      if (node.matchesOne && node.matchesOne(sel)) return node;
      node = node.parent;
    }
    return null;
  }
  click() { this._clicked = (this._clicked || 0) + 1; }
  scrollIntoView() { /* no-op */ }
}

/* ================= сборка страницы-списка (разметка как на сайте) ================= */

const FR_MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const pad2 = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const frDate = (d) => `${d.getDate()} ${FR_MONTHS[d.getMonth()]}`;

// даты действия — относительные, чтобы тест не зависел от дня запуска
const d1 = new Date(Date.now() + 2 * 86400000);   // онлайн-каталог: +2 дня
const d2 = new Date(Date.now() + 16 * 86400000);
const d3 = new Date(Date.now() + 1 * 86400000);   // будущий каталог (futureOnline): +1 день
const d4 = new Date(Date.now() + 15 * 86400000);
const dp1 = new Date(Date.now() - 60 * 86400000); // завершившийся каталог
const dp2 = new Date(Date.now() - 40 * 86400000);

const RANGE_ONLINE = `Valable: ${frDate(d1)} au ${frDate(d2)}`;
const RANGE_FUTURE = `Valable: ${frDate(d3)} au ${frDate(d4)}`;
const RANGE_PAST = `Valable: ${frDate(dp1)} au ${frDate(dp2)}`;

function card({ href, title, status, dateText, withOffersBlock }) {
  const c = new El('div', { class: 'card h-100' });
  c.append(new El('a', { href }, 'Open flyer'));
  if (title) c.append(new El('h3', {}, title));
  const small = new El('small', { class: 'd-flex align-items-center flex-nowrap text-muted mb-0 w-100' });
  const inner = new El('div');
  inner.append(new El('div', { class: `status__circle ${status}` }));
  inner._text = ` ${dateText} `;
  small.append(inner);
  c.append(small);
  if (withOffersBlock) {
    const offers = new El('div', { class: 'offers-block' });
    offers.append(new El('a', { href }, 'Les meilleurs choix'));
    c.append(offers);
  }
  return c;
}

function buildPage() {
  const body = new El('body');
  const section = new El('section', { class: 'catalog-list' });
  section.append(
    card({
      href: '/regardez/offres/catalogue-carrefour-3814497',
      title: 'Catalogue Carrefour',
      status: 'online',
      dateText: RANGE_ONLINE,
      withOffersBlock: true
    }),
    card({
      href: '/regardez/offres/catalogue-carrefour-3803543',
      title: "PASSEZ L'AUTOMNE CONNECTÉ",
      status: 'futureOnline',
      dateText: RANGE_FUTURE,
      withOffersBlock: false
    }),
    card({
      href: '/regardez/offres/catalogue-carrefour-1111111',
      title: 'VIEUX CATALOGUE',
      status: 'offline',
      dateText: RANGE_PAST,
      withOffersBlock: false
    })
  );

  // ссылка /regardez/… вне карточки (рекламный блок внутри секции с карточками):
  // ближайший предок с .status__circle — вся секция, в ней 3 разных каталога → пропускается
  const ad = new El('div', { class: 'ad' });
  ad.append(new El('a', { href: '/regardez/offres/catalogue-carrefour-9999999' }, 'pub'));
  section.append(ad);

  // мини-карточка снизу страницы: ссылка на /magasins/… — не каталог, игнорируется
  const mini = new El('div', { class: 'mini' });
  mini.append(new El('a', { href: '/magasins/carrefour/catalogues-promotions' }, 'Carrefour'));
  mini.append(new El('div', { class: 'status__circle online' }));

  // ссылка /regardez/… прямо в body, вне карточки — игнорируется
  const footerLink = new El('a', { href: '/regardez/offres/catalogue-carrefour-8888888' }, 'footer');

  body.append(section, mini, footerLink);
  return body;
}

/* ================= окружение для listing.js ================= */

async function runListingOnce(body) {
  const sent = [];
  let listener = null;

  const windowMock = { scrollTo() { /* no-op */ } };
  const documentMock = {
    body,
    querySelectorAll(sel) { return body.querySelectorAll(sel); }
  };
  const chromeMock = {
    runtime: {
      sendMessage: async (msg) => { sent.push(msg); return { ok: true }; },
      onMessage: { addListener: (fn) => { listener = fn; } }
    }
  };
  const locationMock = {
    origin: 'https://www.promocatalogues.fr',
    pathname: '/magasins/carrefour/catalogues-promotions'
  };

  // utils.js + listing.js выполняются в одном скоупе, как в реальной вкладке
  const src =
    fs.readFileSync(path.join(ROOT, 'utils.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(ROOT, 'listing.js'), 'utf8');
  const fn = new Function('window', 'document', 'chrome', 'location', src);
  fn(windowMock, documentMock, chromeMock, locationMock);

  if (!listener) throw new Error('listing.js не зарегистрировал обработчик сообщений');

  listener({ type: 'LISTING_START', jobId: 'job-1' }, {}, () => {});

  // ждём LISTING_RESULT (внутри — паузы фолбэк-прокрутки, ~2 с)
  const deadline = Date.now() + 15000;
  while (!sent.some((m) => m.type === 'LISTING_RESULT')) {
    if (Date.now() > deadline) throw new Error('LISTING_RESULT не пришёл; получено: ' + sent.map((m) => m.type).join(', '));
    await new Promise((r) => setTimeout(r, 100));
  }
  return sent;
}

/* ================= тесты ================= */

console.log('listing.js (страница-список):');

const sent = await runListingOnce(buildPage());
const result = sent.find((m) => m.type === 'LISTING_RESULT');

await t('пришёл LISTING_RESULT с jobId', () => {
  eq(result.jobId, 'job-1');
  eq(Array.isArray(result.catalogues), true);
});

await t('найдено ровно 3 каталога (вне карточек — игнор)', () => {
  eq(result.catalogues.length, 3);
});

await t('каталог 1: online, активен, название и дата', () => {
  const c = result.catalogues[0];
  eq(c.url, 'https://www.promocatalogues.fr/regardez/offres/catalogue-carrefour-3814497');
  eq(c.status, 'online');
  eq(c.active, true);
  eq(c.title, 'Catalogue Carrefour');
  eq(c.dateText, RANGE_ONLINE);
});

await t('каталог 1: дата действия распознана и попадёт в имя файла', () => {
  eq(result.catalogues[0].validity, { from: iso(d1), to: iso(d2) });
});

await t('каталог 2: futureOnline — тоже активен (скоро начнётся)', () => {
  const c = result.catalogues[1];
  eq(c.status, 'futureOnline');
  eq(c.active, true);
  eq(c.validity, { from: iso(d3), to: iso(d4) });
});

await t('каталог 3: offline — не активен, в скачивание не попадёт', () => {
  const c = result.catalogues[2];
  eq(c.status, 'offline');
  eq(c.active, false);
});

await t('дубликаты ссылок внутри одной карточки схлопываются', () => {
  // в первой карточке две ссылки на один каталог (Open flyer + блок «meilleurs choix»)
  eq(result.catalogues.filter((c) => c.url.includes('3814497')).length, 1);
});

await t('прогресс о количестве найденного отправлялся', () => {
  const p = sent.find((m) => m.type === 'LISTING_PROGRESS');
  eq(typeof p.found, 'number');
  eq(p.found >= 3, true);
});

console.log('');
console.log(`Результат: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
