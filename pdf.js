'use strict';

/**
 * Модуль сборки PDF — прямой перенос логики исходного скрипта.
 *
 * PDF собирается вручную (без сторонних библиотек), как в исходном скрипте:
 *  - каждая JPEG-страница кладётся в PDF как XObject /Image с фильтром DCTDecode;
 *  - размер PDF-страницы: w = p.w * 72 / DPI, h = p.h * 72 / DPI (DPI = 300);
 *  - объекты записываются в поток байтов с корректной xref-таблицей.
 */

const PDF_DPI = 300;

/**
 * Разбор заголовка JPEG: ширина, высота, количество компонентов.
 * Функционально идентична jpegInfo() из исходного скрипта.
 *
 * @param {Uint8Array} d — байты JPEG
 * @returns {{w: number, h: number, comps: number}}
 */
function jpegInfo(d) {
  let i = 2;
  while (i < d.length) {
    if (d[i] !== 0xff) { i++; continue; }
    const mk = d[i + 1];
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      return {
        h: (d[i + 5] << 8) | d[i + 6],
        w: (d[i + 7] << 8) | d[i + 8],
        comps: d[i + 9]
      };
    }
    i += 2 + ((d[i + 2] << 8) | d[i + 3]);
  }
  throw new Error('не JPEG');
}

/**
 * Собирает PDF из массива страниц.
 *
 * @param {Array<{bytes: Uint8Array, w: number, h: number, comps: number}>} pages
 * @returns {Uint8Array[]} массив байтовых чанков PDF (для new Blob(chunks, {type:'application/pdf'}))
 */
function collectPdfChunks(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;

  const push = (c) => {
    const b = typeof c === 'string' ? enc.encode(c) : c;
    chunks.push(b);
    len += b.length;
  };

  const obj = (n, body, s) => {
    offsets[n] = len;

    push(`${n} 0 obj\n${body}\n`);

    if (s) {
      push('stream\n');
      push(s);
      push('\nendstream\n');
    }

    push('endobj\n');
  };

  const N = pages.length;

  const pid = (i) => 3 + i * 3;
  const cid = (i) => 4 + i * 3;
  const iid = (i) => 5 + i * 3;

  push('%PDF-1.4\n');

  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');

  obj(
    2,
    `<< /Type /Pages /Count ${N} /Kids [${
      pages.map((_, i) => `${pid(i)} 0 R`).join(' ')
    }] >>`
  );

  pages.forEach((p, i) => {
    const w = (p.w * 72 / PDF_DPI).toFixed(2);
    const h = (p.h * 72 / PDF_DPI).toFixed(2);

    obj(
      pid(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${iid(i)} 0 R >> >> /Contents ${cid(i)} 0 R >>`
    );

    const cs = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;

    obj(
      cid(i),
      `<< /Length ${cs.length} >>`,
      cs
    );

    obj(
      iid(i),
      `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /Device${p.comps === 1 ? 'Gray' : 'RGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>`,
      p.bytes
    );
  });

  const total = 2 + 3 * N;
  const xo = len;

  let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;

  for (let n = 1; n <= total; n++) {
    x += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  }

  push(x);

  push(
    `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xo}\n%%EOF\n`
  );

  return chunks;
}

/**
 * Удобная обёртка: сразу возвращает Blob с PDF.
 */
function makePdfBlob(pages) {
  return new Blob(collectPdfChunks(pages), { type: 'application/pdf' });
}
