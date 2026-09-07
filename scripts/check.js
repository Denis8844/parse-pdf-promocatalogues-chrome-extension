#!/usr/bin/env node
/**
 * Быстрая проверка проекта перед загрузкой в Chrome:
 *  - манифест (MV3, permissions, файлы существуют);
 *  - синтаксис всех JS-файлов (node --check);
 *  - иконки — валидные PNG нужных размеров.
 *
 * Запуск: node scripts/check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const errors = [];
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => { errors.push(m); console.error('  ✕ ' + m); };

// --- manifest ---
console.log('manifest.json');
const manifestPath = path.join(ROOT, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.manifest_version !== 3) fail('manifest_version !== 3');
else ok('Manifest V3');

for (const p of ['tabs', 'scripting', 'downloads', 'storage']) {
  if (!(manifest.permissions || []).includes(p)) fail(`нет permission "${p}"`);
}
ok('permissions: tabs, scripting, downloads, storage');

if (!Array.isArray(manifest.host_permissions)) fail('нет host_permissions');
else ok('host_permissions: ' + manifest.host_permissions.join(', '));

if (!manifest.background || manifest.background.service_worker !== 'background.js') {
  fail('background.service_worker !== background.js');
} else ok('service worker: background.js');

// --- файлы из манифеста ---
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.action.default_icon || {}),
  ...Object.values(manifest.icons || {}),
  'offscreen.html',  // используется background.js через chrome.offscreen
  'offscreen.js'
];
for (const f of referenced) {
  if (!fs.existsSync(path.join(ROOT, f))) fail(`нет файла: ${f}`);
}
ok('все файлы из манифеста на месте');

// --- синтаксис JS ---
console.log('синтаксис JS');
for (const f of ['background.js', 'content.js', 'pdf.js', 'utils.js', 'popup.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
    ok(f);
  } catch (e) {
    fail(`${f}: ${String(e.stderr || e.message).trim()}`);
  }
}

// --- иконки ---
console.log('иконки');
for (const size of [16, 32, 48, 128]) {
  const p = path.join(ROOT, 'icons', `icon${size}.png`);
  if (!fs.existsSync(p)) { fail(`нет icons/icon${size}.png`); continue; }
  const buf = fs.readFileSync(p);
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) fail(`icons/icon${size}.png — не PNG`);
  else ok(`icon${size}.png (PNG)`);
}

console.log('');
if (errors.length) {
  console.error(`ПРОВЕРКА НЕ ПРОЙДЕНА: ${errors.length} ошибка(и)`);
  process.exit(1);
}
console.log('Всё в порядке — можно загружать расширение в chrome://extensions');
