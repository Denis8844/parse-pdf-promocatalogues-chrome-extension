'use strict';

/**
 * Keep-alive для service worker'а (работает внутри offscreen-документа).
 *
 * Отправляет сообщение каждые 15 секунд — это событие для SW, которое сбрасывает
 * его таймер бездействия. Пока очередь обрабатывается, service worker не уснёт.
 */
const KEEPALIVE_INTERVAL_MS = 15_000;

setInterval(() => {
  chrome.runtime.sendMessage({ type: 'KEEPALIVE' }).catch(() => {});
}, KEEPALIVE_INTERVAL_MS);
