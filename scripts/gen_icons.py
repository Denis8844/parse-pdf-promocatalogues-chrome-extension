#!/usr/bin/env python3
"""Генерирует иконки расширения (16/32/48/128) — синий квадрат с документом PDF."""
from PIL import Image, ImageDraw

S = 512  # базовый размер с суперсэмплингом

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# --- фон: вертикальный градиент + скругление ---
top = (26, 115, 232)
bot = (11, 87, 208)
for y in range(S):
    t = y / (S - 1)
    color = tuple(round(a + (b - a) * t) for a, b in zip(top, bot))
    d.line([(0, y), (S, y)], fill=color)

mask = Image.new('L', (S, S), 0)
dm = ImageDraw.Draw(mask)
dm.rounded_rectangle([0, 0, S - 1, S - 1], radius=116, fill=255)
img.putalpha(mask)

d = ImageDraw.Draw(img)

# --- белая страница документа с загнутым уголком ---
page = (138, 84, 374, 430)  # l, t, r, b
d.rounded_rectangle(page, radius=26, fill=(255, 255, 255, 255))

# загнутый уголок (треугольник сверху-справа)
fold = [(296, 84), (374, 84), (374, 162)]
d.polygon(fold, fill=(232, 239, 251, 255))
d.line([(296, 84), (374, 162)], fill=(200, 213, 240, 255), width=4)

# --- «строки текста» ---
line_color = (157, 184, 220, 255)
d.rounded_rectangle([176, 206, 336, 224], radius=9, fill=line_color)
d.rounded_rectangle([176, 250, 336, 268], radius=9, fill=line_color)
d.rounded_rectangle([176, 294, 276, 312], radius=9, fill=line_color)

# --- стрелка «скачать» ---
arrow = (26, 115, 232, 255)
d.rounded_rectangle([252, 336, 270, 392], radius=8, fill=arrow)
d.polygon([(238, 372), (284, 372), (261, 404)], fill=arrow)

# --- экспорт во все размеры ---
out = 'icons'
for size in (128, 48, 32, 16):
    im = img.resize((size, size), Image.LANCZOS)
    im.save(f'{out}/icon{size}.png')
    print(f'icon{size}.png ok')

# контрольный просмотр 128
img.resize((128, 128), Image.LANCZOS).save(f'{out}/icon128.png')
