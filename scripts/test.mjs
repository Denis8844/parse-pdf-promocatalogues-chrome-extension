#!/usr/bin/env node
/**
 * Юнит-тесты чистой логики (utils.js, pdf.js) — запускаются вне браузера.
 * Также генерирует scripts/../test-out/test.pdf для проверки pypdf.
 *
 * Запуск: node scripts/test.mjs
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Выполняем оба файла в одной области видимости и забираем их top-level объявления.
const src = ['utils.js', 'pdf.js']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
  .join('\n');

const fn = new Function(`${src}\n;return { parseLinks, isHttpUrl, makeCatalogFilename, sleep, jpegInfo, collectPdfChunks, makePdfBlob, PDF_DPI, isListingUrl, parseFrenchDateRange, validitySuffix, progressCaption, catalogProgress };`);
const exports = fn();
const utils = exports;
const pdf = exports;

let passed = 0, failed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✕ ' + name + ' — ' + e.message);
  }
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg || 'не равно'}: ${ja} !== ${jb}`);
}

// Текущая дата вычисляется динамически — имя файла содержит сегодняшнюю дату,
// и тесты не должны зависеть от конкретного дня.
const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

/* ================= utils.parseLinks ================= */

console.log('parseLinks:');
t('одна ссылка на строку', () => {
  eq(utils.parseLinks('https://a.com/cat/one\nhttps://a.com/cat/two').links,
     ['https://a.com/cat/one', 'https://a.com/cat/two']);
});
t('разделители: пробелы, запятые, точки с запятой', () => {
  eq(utils.parseLinks('https://a.com/1, https://a.com/2;https://a.com/3 https://a.com/4').links,
     ['https://a.com/1', 'https://a.com/2', 'https://a.com/3', 'https://a.com/4']);
});
t('разделитель "|" (пример пользователя)', () => {
  eq(utils.parseLinks('/regardez/offres/catalogue-castorama-3751268 | /regardez/offres/catalogue-castorama-3455996 | /regardez/offres/catalogue-castorama-3455920').links,
     [
       'https://www.promocatalogues.fr/regardez/offres/catalogue-castorama-3751268',
       'https://www.promocatalogues.fr/regardez/offres/catalogue-castorama-3455996',
       'https://www.promocatalogues.fr/regardez/offres/catalogue-castorama-3455920'
     ]);
});
t('все разделители вперемешку в одном вводе', () => {
  eq(utils.parseLinks('/a/1 | /a/2, /a/3;/a/4 /a/5\n/a/6').links,
     [
       'https://www.promocatalogues.fr/a/1',
       'https://www.promocatalogues.fr/a/2',
       'https://www.promocatalogues.fr/a/3',
       'https://www.promocatalogues.fr/a/4',
       'https://www.promocatalogues.fr/a/5',
       'https://www.promocatalogues.fr/a/6'
     ]);
});
t('относительная ссылка -> абсолютная на promocatalogues.fr', () => {
  eq(utils.parseLinks('/regardez/offres/catalogue-picard-3660147').links,
     ['https://www.promocatalogues.fr/regardez/offres/catalogue-picard-3660147']);
});
t('абсолютная ссылка на сайт остаётся как есть', () => {
  eq(utils.parseLinks('https://www.promocatalogues.fr/regardez/offres/catalogue-picard-3660147').links,
     ['https://www.promocatalogues.fr/regardez/offres/catalogue-picard-3660147']);
});
t('смешанные относительные и абсолютные + дубликаты', () => {
  const r = utils.parseLinks(
    '/regardez/offres/catalogue-a-1 | https://www.promocatalogues.fr/regardez/offres/catalogue-a-1\n' +
    '/regardez/offres/catalogue-b-2'
  );
  eq(r.links, [
    'https://www.promocatalogues.fr/regardez/offres/catalogue-a-1',
    'https://www.promocatalogues.fr/regardez/offres/catalogue-b-2'
  ]);
});
t('протокол-относительная ссылка //host/path', () => {
  eq(utils.parseLinks('//www.promocatalogues.fr/regardez/offres/x').links,
     ['https://www.promocatalogues.fr/regardez/offres/x']);
});
t('без пробелов после запятой', () => {
  eq(utils.parseLinks('https://a.com/1,https://a.com/2').links,
     ['https://a.com/1', 'https://a.com/2']);
});
t('пустые строки игнорируются', () => {
  eq(utils.parseLinks('\n\n  \nhttps://a.com/1\n\n').links, ['https://a.com/1']);
});
t('дубликаты удаляются', () => {
  eq(utils.parseLinks('https://a.com/1\nhttps://a.com/1\nhttps://a.com/1').links,
     ['https://a.com/1']);
});
t('пробелы вокруг ссылок убираются', () => {
  eq(utils.parseLinks('  https://a.com/1  ').links, ['https://a.com/1']);
});
t('неверные URL отбрасываются отдельно', () => {
  const r = utils.parseLinks('https://a.com/1\nnot-a-url\nftp://x.com/2');
  eq(r.links, ['https://a.com/1']);
  eq(r.invalid, ['not-a-url', 'ftp://x.com/2']);
});
t('пустой ввод', () => {
  eq(utils.parseLinks('').links, []);
  eq(utils.parseLinks(null).links, []);
});

/* ================= utils.makeCatalogFilename ================= */

console.log('makeCatalogFilename:');
t('хвост сайта « – Name» (en dash) убирается', () => {
  const f = utils.makeCatalogFilename('Осенний каталог – Магазин', '/catalog/autumn');
  eq(f, `Осенний_каталог_${TODAY}.pdf`);
});
t('em dash (—) НЕ входит в regex исходника — сохраняется как "_"', () => {
  // В исходном скрипте класс символов [-–|] не содержит длинного тире,
  // поэтому поведение «Осенний каталог — Магазин» → «Осенний_каталог_Магазин».
  const f = utils.makeCatalogFilename('Осенний каталог — Магазин', '/x');
  eq(f, `Осенний_каталог_Магазин_${TODAY}.pdf`);
});
t('хвост « | Name» убирается', () => {
  const f = utils.makeCatalogFilename('Каталог | Site', '/x');
  eq(f, `Каталог_${TODAY}.pdf`);
});
t('недопустимые символы -> "_"', () => {
  const f = utils.makeCatalogFilename('Каталог: Весна/2026!', '/x');
  eq(f, `Каталог_Весна_2026_${TODAY}.pdf`);
});
t('кириллица и цифры сохраняются', () => {
  const f = utils.makeCatalogFilename('Скидки 50% на всё', '/x');
  eq(f, `Скидки_50_на_всё_${TODAY}.pdf`);
});
t('пустой заголовок -> последний сегмент URL', () => {
  eq(utils.makeCatalogFilename('', '/catalog/summer'), `summer_${TODAY}.pdf`);
});
t('пустой заголовок и пустой путь -> catalogue', () => {
  eq(utils.makeCatalogFilename('', ''), `catalogue_${TODAY}.pdf`);
});
t('длина ограничена 60 символами', () => {
  const long = 'A'.repeat(120);
  const f = utils.makeCatalogFilename(long, '/x');
  eq(f.slice(0, 60), 'A'.repeat(60));
});
t('заголовок из одних спецсимволов -> сегмент URL', () => {
  // После очистки строка пуста -> используется последний сегмент URL.
  eq(utils.makeCatalogFilename('!!! ???', '/catalog/fall'), `fall_${TODAY}.pdf`);
});
t('заголовок с дефисами не пустеет (как в исходнике)', () => {
  // Исходный скрипт оставляет "-" после очистки ("---" -> "--"), slug не используется.
  eq(utils.makeCatalogFilename('!!! ... ---', '/catalog/fall'), `--_${TODAY}.pdf`);
});
t('номер каталога добавляется в конец имени (пример из ТЗ)', () => {
  const f = utils.makeCatalogFilename('Catalogue Noz - Promocatalogues.fr', '/regardez/offres/catalogue-noz-3766479');
  eq(f, `Catalogue_Noz_3766479_${TODAY}.pdf`);
});
t('номер каталога: picard', () => {
  const f = utils.makeCatalogFilename('Catalogue Picard - Promocatalogues.fr', '/regardez/offres/catalogue-picard-3660147');
  eq(f, `Catalogue_Picard_3660147_${TODAY}.pdf`);
});
t('номера в ссылке нет — номер не добавляется', () => {
  const f = utils.makeCatalogFilename('Каталог Весна – Site', '/regardez/offres/catalogue-printemps');
  eq(f, `Каталог_Весна_${TODAY}.pdf`);
});
t('slug с номером — номер не дублируется', () => {
  // Пустой заголовок -> base = последний сегмент URL, он уже содержит номер.
  eq(utils.makeCatalogFilename('', '/regardez/offres/catalogue-noz-3766479'),
     `catalogue-noz-3766479_${TODAY}.pdf`);
});
t('номер уже в заголовке — не дублируется', () => {
  eq(utils.makeCatalogFilename('Catalogue Noz 3766479 - Site', '/regardez/offres/catalogue-noz-3766479'),
     `Catalogue_Noz_3766479_${TODAY}.pdf`);
});
t('сегмент из одних цифр номером не считается', () => {
  eq(utils.makeCatalogFilename('Нечто', '/flyers/3660147'), `Нечто_${TODAY}.pdf`);
});

/* ================= utils.makeCatalogFilename + дата действия ================= */

console.log('makeCatalogFilename с датой действия:');
t('диапазон действия: …_du_…_au_….pdf', () => {
  const f = utils.makeCatalogFilename(
    'Catalogue Carrefour - Promocatalogues.fr',
    '/regardez/offres/catalogue-carrefour-3814497',
    { from: '2026-09-29', to: '2026-10-12' }
  );
  eq(f, 'Catalogue_Carrefour_3814497_du_2026-09-29_au_2026-10-12.pdf');
});
t('только начало действия: …_du_….pdf', () => {
  eq(utils.makeCatalogFilename('Каталог', '/x', { from: '2026-09-25' }), `Каталог_du_2026-09-25.pdf`);
});
t('только конец действия: …_au_….pdf', () => {
  eq(utils.makeCatalogFilename('Каталог', '/regardez/offres/catalogue-x-5', { to: '2026-10-12' }),
     'Каталог_5_au_2026-10-12.pdf');
});
t('некорректная дата — fallback на сегодняшнюю (как раньше)', () => {
  eq(utils.makeCatalogFilename('Каталог', '/x', { from: 'не-дата' }), `Каталог_${TODAY}.pdf`);
  eq(utils.makeCatalogFilename('Каталог', '/x', {}), `Каталог_${TODAY}.pdf`);
});
t('без даты — сегодняшняя (обратная совместимость)', () => {
  eq(utils.makeCatalogFilename('Каталог', '/x', null), `Каталог_${TODAY}.pdf`);
  eq(utils.makeCatalogFilename('Каталог', '/x'), `Каталог_${TODAY}.pdf`);
});
t('validitySuffix: варианты', () => {
  eq(utils.validitySuffix({ from: '2026-09-25', to: '2026-10-12' }), 'du_2026-09-25_au_2026-10-12');
  eq(utils.validitySuffix({ from: '2026-09-25' }), 'du_2026-09-25');
  eq(utils.validitySuffix({ to: '2026-10-12' }), 'au_2026-10-12');
  eq(utils.validitySuffix(null), null);
  eq(utils.validitySuffix({ from: '25/09/2026' }), null);
});

/* ================= utils.parseFrenchDateRange ================= */

console.log('parseFrenchDateRange:');
const NOW = new Date(2026, 8, 28); // 28 сентября 2026 (месяцы с 0)
t('простой диапазон «Valable: 25 sept. au 12 oct.»', () => {
  eq(utils.parseFrenchDateRange('Valable: 25 sept. au 12 oct.', NOW),
     { from: '2026-09-25', to: '2026-10-12' });
});
t('будущий каталог (futureOnline): «29 sept. au 12 oct.»', () => {
  eq(utils.parseFrenchDateRange('Valable: 29 sept. au 12 oct.', NOW),
     { from: '2026-09-29', to: '2026-10-12' });
});
t('«1er» распознаётся как 1-е число', () => {
  eq(utils.parseFrenchDateRange('Valable: 1er sept. au 30 sept.', NOW),
     { from: '2026-09-01', to: '2026-09-30' });
});
t('полные названия месяцев и диакритика (août, décembre)', () => {
  eq(utils.parseFrenchDateRange('Valable: 25 août au 15 décembre', NOW),
     { from: '2026-08-25', to: '2026-12-15' });
});
t('явные годы в тексте используются как есть', () => {
  eq(utils.parseFrenchDateRange('Valable: 29 déc. 2026 au 11 janv. 2027', NOW),
     { from: '2026-12-29', to: '2027-01-11' });
});
t('переход года без явных годов: «29 déc. au 11 janv.» в декабре', () => {
  const dec = new Date(2026, 11, 15); // 15 декабря 2026
  eq(utils.parseFrenchDateRange('Valable: 29 déc. au 11 janv.', dec),
     { from: '2026-12-29', to: '2027-01-11' });
});
t('одна дата в будущем январе (декабрь) → следующий год', () => {
  const dec = new Date(2026, 11, 15);
  eq(utils.parseFrenchDateRange('à partir du 5 janv.', dec), { from: '2027-01-05' });
});
t('давно начавшийся каталог остаётся в текущем году', () => {
  // «3 avr. au 30 sept.» на 28 сентября: конец в будущем — год не сдвигается
  eq(utils.parseFrenchDateRange('Valable: 3 avr. au 30 sept.', NOW),
     { from: '2026-04-03', to: '2026-09-30' });
});
t('одна дата в прошлом — текущий год', () => {
  eq(utils.parseFrenchDateRange('Valable: 15 sept.', NOW), { from: '2026-09-15' });
});
t('текст без дат — null', () => {
  eq(utils.parseFrenchDateRange('Valable dans 5 jours', NOW), null);
  eq(utils.parseFrenchDateRange('', NOW), null);
  eq(utils.parseFrenchDateRange(null, NOW), null);
});
t('время работы магазина («08:00 - 22:00») не распознаётся как дата', () => {
  eq(utils.parseFrenchDateRange('Aujourd\'hui : 08:00 - 22:00', NOW), null);
});

/* ================= utils.isListingUrl ================= */

console.log('isListingUrl:');
t('ссылка-список распознаётся', () => {
  eq(utils.isListingUrl('https://www.promocatalogues.fr/magasins/carrefour/catalogues-promotions'), true);
});
t('с trailing slash и без www', () => {
  eq(utils.isListingUrl('https://promocatalogues.fr/magasins/aldi/catalogues-promotions/'), true);
});
t('относительный путь после normalizeCatalogLink — тоже список', () => {
  const { links } = utils.parseLinks('/magasins/lidl/catalogues-promotions');
  eq(links.length, 1);
  eq(utils.isListingUrl(links[0]), true);
});
t('ридер каталога — не список', () => {
  eq(utils.isListingUrl('https://www.promocatalogues.fr/regardez/offres/catalogue-carrefour-3814497'), false);
});
t('другие страницы магазина — не список', () => {
  eq(utils.isListingUrl('https://www.promocatalogues.fr/magasins/carrefour/offres'), false);
  eq(utils.isListingUrl('https://www.promocatalogues.fr/magasins/carrefour'), false);
});
t('чужой домен — не список', () => {
  eq(utils.isListingUrl('https://example.com/magasins/x/catalogues-promotions'), false);
  eq(utils.isListingUrl('не ссылка'), false);
});

/* ================= Настройки background.js / popup.js ================= */

/* ================= Прогресс очереди: магазины и каталоги ================= */

console.log('прогресс очереди (магазины/каталоги):');
{
  const S1 = 'https://www.promocatalogues.fr/magasins/carrefour/catalogues-promotions';
  const S2 = 'https://www.promocatalogues.fr/magasins/aldi/catalogues-promotions';
  const C = (n, from) => ({
    url: 'https://www.promocatalogues.fr/regardez/offres/catalogue-x-' + n,
    fromListing: from || null
  });
  const L = (u) => ({ url: u });

  t('каталоги первого магазина: позиция внутри магазина и всего', () => {
    const links = [C(1, S1), C(2, S1), C(3, S1), L(S2)];
    eq(utils.progressCaption(links, 1), 'Магазин 1 из 2 · Каталоги 2 из 3 · Всего 2 из 3');
    eq(utils.progressCaption(links, 2), 'Магазин 1 из 2 · Каталоги 3 из 3 · Всего 3 из 3');
  });

  t('второй магазин: счётчик магазинов растёт, «всего» — по всем каталогам', () => {
    const links = [C(1, S1), C(2, S1), C(3, S1), C(4, S2), C(5, S2)];
    eq(utils.progressCaption(links, 3), 'Магазин 2 из 2 · Каталоги 1 из 2 · Всего 4 из 5');
  });

  t('идёт сбор списка магазина', () => {
    const links = [C(1, S1), L(S2)];
    eq(utils.progressCaption(links, 1), 'Магазин 2 из 2 · Каталоги: собираю список · Всего 1 из 1');
  });

  t('самый первый магазин, каталогов в очереди ещё нет', () => {
    const links = [L(S1), L(S2)];
    eq(utils.progressCaption(links, 0), 'Магазин 1 из 2 · Каталоги: собираю список · Всего 0 из 0');
  });

  t('пропущенный магазин (0 активных каталогов) всё равно считается магазином', () => {
    // S1 осталась в очереди как skipped, S2 развёрнута в каталоги
    const links = [L(S1), C(4, S2), C(5, S2)];
    eq(utils.progressCaption(links, 1), 'Магазин 2 из 2 · Каталоги 1 из 2 · Всего 1 из 2');
  });

  t('ручные каталоги без магазинов — формат как раньше', () => {
    const links = [C(1), C(2), C(3)];
    eq(utils.progressCaption(links, 1), 'Каталог 2 из 3');
  });

  t('catalogProgress: ссылки-списки не считаются каталогами', () => {
    const links = [L(S1), C(1, S1), C(2, S1), L(S2), C(3, S2)];
    eq(JSON.stringify(utils.catalogProgress(links, 0)), '{"pos":0,"total":3}');
    eq(JSON.stringify(utils.catalogProgress(links, 1)), '{"pos":1,"total":3}');
    eq(JSON.stringify(utils.catalogProgress(links, 3)), '{"pos":2,"total":3}');
  });
}

console.log('настройки (DEFAULTS/CLAMP/UI):');
t('каждый ключ DEFAULTS реально используется в коде (нет «мёртвых» настроек)', () => {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const m = /const DEFAULTS = \{([\s\S]*?)\n\};/.exec(bg);
  if (!m) throw new Error('не найден блок DEFAULTS');
  const keys = [...m[1].matchAll(/^\s*([A-Z][A-Z_0-9]*):/gm)].map((x) => x[1]);
  if (keys.length < 10) throw new Error('ключи DEFAULTS не извлеклись: ' + keys.length);
  const dead = keys.filter((k) => !new RegExp('CFG\\.' + k + '\\b').test(bg));
  if (dead.length) throw new Error('объявлены, но не используются: ' + dead.join(', '));
});
t('диапазоны CLAMP совпадают с min/max полей настроек в popup', () => {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const pp = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

  const clampM = /const CLAMP = \{([\s\S]*?)\n\};/.exec(bg);
  if (!clampM) throw new Error('не найден блок CLAMP');
  const clamps = {};
  for (const mm of clampM[1].matchAll(/^\s*([A-Z][A-Z_0-9]*):\s*\[\s*([\d_.]+)\s*,\s*([\d_.]+)\s*\]/gm)) {
    clamps[mm[1]] = [Number(mm[2].replace(/_/g, '')), Number(mm[3].replace(/_/g, ''))];
  }

  const groupsM = /const SETTINGS_GROUPS = \[([\s\S]*?)\n\];/.exec(pp);
  if (!groupsM) throw new Error('не найден SETTINGS_GROUPS');
  const fields = [...groupsM[1].matchAll(/\{[^{}]*?key:\s*'([A-Z][A-Z_0-9]*)'[^{}]*?min:\s*([\d.]+)[^{}]*?max:\s*([\d.]+)[^{}]*?\}/g)];
  if (fields.length < 10) throw new Error('поля настроек не извлеклись: ' + fields.length);

  for (const f of fields) {
    const key = f[1];
    const min = Number(f[2]);
    const max = Number(f[3]);
    const c = clamps[key];
    if (!c) throw new Error(`у поля ${key} нет ограничения в CLAMP`);
    // ms-поля в UI показываются в секундах
    const isMs = /ms:\s*true/.test(f[0]);
    const [cmin, cmax] = isMs ? [c[0] / 1000, c[1] / 1000] : c;
    if (cmin !== min || cmax !== max) {
      throw new Error(`${key}: UI ${min}–${max} с, CLAMP ${cmin}–${cmax}${isMs ? ' с' : ''}`);
    }
  }
});

/* ================= pdf.jpegInfo ================= */

function fakeJpeg(w, h, comps) {
  // минимальный валидный JPEG: SOI + APP0 + SOF0 + EOI (для jpegInfo достаточно SOF0)
  const parts = [0xff, 0xd8];
  // APP0 (JFIF)
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  parts.push(...app0);
  // SOF0
  const sofLen = 8 + 3 * comps;
  const sof = [0xff, 0xc0, (sofLen >> 8) & 0xff, sofLen & 0xff, 8,
               (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, comps];
  for (let c = 0; c < comps; c++) sof.push(c + 1, 0x11, 0);
  parts.push(...sof);
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

console.log('jpegInfo:');
t('разбор SOF0: RGB', () => {
  const b = fakeJpeg(1000, 1414, 3);
  eq(pdf.jpegInfo(b), { h: 1414, w: 1000, comps: 3 });
});
t('разбор SOF0: grayscale', () => {
  const b = fakeJpeg(800, 1200, 1);
  eq(pdf.jpegInfo(b), { h: 1200, w: 800, comps: 1 });
});
t('проход по APP0 -> SOF0', () => {
  // jpegInfo должен перепрыгнуть APP0 через поле длины и найти SOF0
  const b = fakeJpeg(640, 480, 3);
  eq(pdf.jpegInfo(b).w, 640);
});
t('не JPEG -> ошибка', () => {
  let threw = false;
  try { pdf.jpegInfo(new Uint8Array([1, 2, 3, 4])); } catch { threw = true; }
  if (!threw) throw new Error('ожидалась ошибка');
});

/* ================= pdf.collectPdfChunks ================= */

console.log('collectPdfChunks:');

function makePages() {
  const j1 = fakeJpeg(1000, 1414, 3);
  const j2 = fakeJpeg(800, 1200, 1);
  const j3 = fakeJpeg(1200, 1600, 3);
  return [
    { bytes: j1, w: 1000, h: 1414, comps: 3 },
    { bytes: j2, w: 800, h: 1200, comps: 1 },
    { bytes: j3, w: 1200, h: 1600, comps: 3 }
  ];
}

const pdfBytes = Buffer.concat(pdf.collectPdfChunks(makePages()).map((c) => Buffer.from(c)));

t('заголовок %PDF-1.4 и %%EOF', () => {
  if (pdfBytes.subarray(0, 8).toString() !== '%PDF-1.4') throw new Error('нет заголовка');
  if (!/%PDF-1\.4\n/.test(pdfBytes.subarray(pdfBytes.length - 12).toString('latin1'))) {
    // простая проверка хвоста
  }
  if (!pdfBytes.toString('latin1').includes('%%EOF')) throw new Error('нет %%EOF');
});

t('xref: все объекты по своим смещениям, trailer корректен', () => {
  const s = pdfBytes.toString('latin1');
  const sxm = s.match(/startxref\s+(\d+)/);
  if (!sxm) throw new Error('нет startxref');
  const xrefOff = parseInt(sxm[1], 10);
  const xrefHead = s.slice(xrefOff);
  const m = xrefHead.match(/xref\n0 (\d+)\n/);
  if (!m) throw new Error('нет xref');
  const total = parseInt(m[1], 10) - 1; // объекты 1..total
  const lines = xrefHead.split('\n');
  for (let n = 1; n <= total; n++) {
    const off = parseInt(lines[2 + n].slice(0, 10), 10);
    const head = s.slice(off, off + 20);
    if (!head.startsWith(`${n} 0 obj`)) throw new Error(`объект ${n} не найден по смещению ${off}: ${head}`);
  }
  const trailer = s.slice(xrefOff + xrefHead.indexOf('trailer'));
  if (!trailer.includes(`/Size ${total + 1}`)) throw new Error('неверный /Size');
  if (!trailer.includes('/Root 1 0 R')) throw new Error('неверный /Root');
});

t('MediaBox: w = p.w*72/300 с двумя знаками', () => {
  const s = pdfBytes.toString('latin1');
  const expect1 = '1000 * 72 / 300'; // 240.00
  const mb = (w, h) => `/MediaBox [0 0 ${(w * 72 / 300).toFixed(2)} ${(h * 72 / 300).toFixed(2)}]`;
  if (!s.includes(mb(1000, 1414))) throw new Error('MediaBox страницы 1 неверный: ' + expect1);
  if (!s.includes(mb(800, 1200))) throw new Error('MediaBox страницы 2 неверный');
  if (!s.includes(mb(1200, 1600))) throw new Error('MediaBox страницы 3 неверный');
});

t('/Count = 3 и DeviceGray для comps=1', () => {
  const s = pdfBytes.toString('latin1');
  if (!s.includes('/Count 3')) throw new Error('нет /Count 3');
  if (!s.includes('/ColorSpace /DeviceGray')) throw new Error('нет DeviceGray');
  if (!s.includes('/ColorSpace /DeviceRGB')) throw new Error('нет DeviceRGB');
  if (!s.includes('/Filter /DCTDecode')) throw new Error('нет DCTDecode');
});

t('JPEG-байты страниц присутствуют в потоке', () => {
  const hay = pdfBytes;
  for (const p of makePages()) {
    const needle = Buffer.from(p.bytes);
    let found = false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (hay[i] === 0xff && hay[i + 1] === 0xd8 && hay.subarray(i, i + needle.length).equals(needle)) {
        found = true; break;
      }
    }
    if (!found) throw new Error('JPEG-поток не найден');
  }
});

t('Length потоков корректны', () => {
  const s = pdfBytes.toString('latin1');
  const re = /\/Length (\d+) >>\nstream\n/g;
  let m;
  let checked = 0;
  while ((m = re.exec(s)) !== null) {
    const len = parseInt(m[1], 10);
    const streamStart = m.index + m[0].length;
    const streamEnd = s.indexOf('\nendstream', streamStart);
    if (streamEnd < 0) throw new Error('нет endstream');
    const actual = streamEnd - streamStart;
    if (actual !== len) throw new Error(`/Length ${len}, фактически ${actual}`);
    checked++;
  }
  if (checked < 4) throw new Error('мало потоков: ' + checked);
});

// сохраняем для проверки pypdf
fs.mkdirSync(path.join(ROOT, 'test-out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'test-out', 'test.pdf'), pdfBytes);

console.log('');
console.log(`Результат: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
