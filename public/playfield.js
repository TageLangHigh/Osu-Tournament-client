// Zeichnet ein Spielfeld mit derselben Geometrie wie der osu!-Client und dem Skin des Nutzers.
// Alle Felder hängen an einer Uhr, deshalb gibt es weder eigenen Puffer noch Nachladen pro Spieler.

import { prepareMap, sliderBall } from '/shared/beatmap.js';

const FIELD_W = 512;
const FIELD_H = 384;
const STALE_MS = 450;
const FALLBACK_COMBOS = ['rgb(255,192,0)', 'rgb(0,202,0)', 'rgb(18,124,255)', 'rgb(242,24,57)'];

const loadImage = (entry) => new Promise((resolve) => {
  if (!entry) {
    resolve(null);
    return;
  }
  const image = new Image();
  image.onload = () => resolve({ image, width: image.naturalWidth * (entry.hd ? 0.5 : 1), height: image.naturalHeight * (entry.hd ? 0.5 : 1) });
  image.onerror = () => resolve(null);
  image.src = entry.url;
});

async function loadTable(table) {
  const entries = await Promise.all(Object.entries(table).map(async ([key, value]) => [key, Array.isArray(value) ? (await Promise.all(value.map(loadImage))).filter(Boolean) : await loadImage(value)]));
  return Object.fromEntries(entries);
}

/** Lädt alle Bilder eines Skins einmal. Sie werden von allen Feldern geteilt. */
export async function loadSkinAssets(skin) {
  const [assets, numbers, score, combo] = await Promise.all([loadTable(skin.assets), loadTable(skin.numbers), loadTable(skin.score), loadTable(skin.combo)]);
  return { ...skin, assets, numbers, score, combo, tints: new Map() };
}

function tinted(skin, sprite, color) {
  const key = `${sprite.image.src}|${color}`;
  let canvas = skin.tints.get(key);
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.width = sprite.image.naturalWidth;
  canvas.height = sprite.image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(sprite.image, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(sprite.image, 0, 0);
  skin.tints.set(key, canvas);
  return canvas;
}

const parseRgb = (color) => (color.match(/\d+/g) ?? [255, 255, 255]).slice(0, 3).map(Number);
const mix = ([r, g, b], factor) => `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;

export class Playfield {
  constructor(canvas, { color = '#ffffff', skin = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.skin = skin;
    this.prepared = null;
    this.mapColours = null;
    this.combos = FALLBACK_COMBOS;
    this.frames = [];
    this.marks = [];
    this.missed = new Set();
    this.cut = false;
    this.first = 0;
    this.hud = { combo: 0, score: 0, accuracy: 100 };
    this.resize();
    this.updateColours();
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    // Wie im Client: Die Fläche misst 640 x 480 Einheiten, das Feld sitzt leicht unter der Mitte.
    this.scale = Math.min(this.canvas.width / 640, this.canvas.height / 480);
    this.offsetX = (this.canvas.width - FIELD_W * this.scale) / 2;
    this.offsetY = (this.canvas.height - FIELD_H * this.scale) / 2 + 8 * this.scale;
    this.bodies = new Map();
  }

  setSkin(skin) {
    this.skin = skin;
    this.updateColours();
    this.bodies = new Map();
  }

  updateColours() {
    this.combos = this.mapColours?.length ? this.mapColours : this.skin?.colours?.length ? this.skin.colours : FALLBACK_COMBOS;
  }

  setMap(map, mods) {
    this.prepared = prepareMap(map, mods);
    this.mapColours = map.colours ?? null;
    this.updateColours();
    this.first = 0;
    this.bodies = new Map();
  }

  push(frames = [], marks = []) {
    for (const frame of frames) this.frames.push(frame);
    for (const mark of marks) {
      this.marks.push(mark);
      if (mark.value === 0) this.missed.add(mark.t);
    }
  }

  frameAt(time) {
    const { frames } = this;
    if (!frames.length || frames[0][0] > time) return null;
    let low = 0;
    let high = frames.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (frames[mid][0] <= time) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  cursorAt(time) {
    const index = this.frameAt(time);
    if (index === null) return null;
    const a = this.frames[index];
    const b = this.frames[index + 1];
    if (!b || b[0] === a[0]) return [a[1], a[2], a[3]];
    const f = (time - a[0]) / (b[0] - a[0]);
    return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3]];
  }

  sprite(ctx, entry, x, y, size, source = entry?.image) {
    const width = entry.width * size;
    const height = entry.height * size;
    ctx.drawImage(source, x - width / 2, y - height / 2, width, height);
  }

  /** Slider-Körper einmal in ein Bild rendern. Das spart bei vier Feldern viel Zeichenarbeit. */
  sliderBody(index, object, comboColor) {
    let body = this.bodies.get(index);
    if (body) return body;
    const { radius } = this.prepared;
    const xs = object.path.map((point) => point[0]);
    const ys = object.path.map((point) => point[1]);
    const pad = radius * 1.1;
    const left = Math.min(...xs) - pad;
    const top = Math.min(...ys) - pad;
    const width = Math.max(...xs) + pad - left;
    const height = Math.max(...ys) + pad - top;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * this.scale);
    canvas.height = Math.ceil(height * this.scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(this.scale, this.scale);
    ctx.translate(-left, -top);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const path = new Path2D();
    object.path.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
    ctx.strokeStyle = this.skin?.sliderBorder ?? '#ffffff';
    ctx.lineWidth = radius * 1.92;
    ctx.stroke(path);
    const track = parseRgb(this.skin?.sliderTrack ?? comboColor);
    const passes = 10;
    for (let i = 0; i < passes; i++) {
      const progress = i / (passes - 1);
      ctx.strokeStyle = mix(track, 0.32 + 0.38 * progress);
      ctx.lineWidth = radius * 1.74 * (1 - progress * 0.92);
      ctx.stroke(path);
    }
    body = { canvas, left, top, width, height };
    this.bodies.set(index, body);
    return body;
  }

  drawNumber(ctx, value, x, y, objectScale) {
    const table = this.skin?.numbers;
    const text = String(value);
    const digits = [...text].map((digit) => table?.[digit]).filter(Boolean);
    if (digits.length !== text.length) {
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${44 * objectScale}px Bahnschrift, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 1);
      return;
    }
    const size = objectScale * 0.8;
    const overlap = (this.skin.hitCircleOverlap ?? -2) * size;
    const total = digits.reduce((sum, digit) => sum + digit.width * size, 0) - overlap * (digits.length - 1);
    let cursor = x - total / 2;
    for (const digit of digits) {
      const width = digit.width * size;
      ctx.drawImage(digit.image, cursor, y - (digit.height * size) / 2, width, digit.height * size);
      cursor += width - overlap;
    }
  }

  drawCircle(ctx, x, y, object, color, alpha, grow = 1, showNumber = true) {
    const { radius } = this.prepared;
    const objectScale = (radius / 64) * grow;
    const assets = this.skin?.assets;
    ctx.globalAlpha = alpha;
    if (assets?.hitcircle) {
      const overlay = assets.hitcircleoverlay;
      if (overlay && !this.skin.overlayAboveNumber) this.sprite(ctx, overlay, x, y, objectScale);
      this.sprite(ctx, assets.hitcircle, x, y, objectScale, tinted(this.skin, assets.hitcircle, color));
      if (overlay && this.skin.overlayAboveNumber) {
        if (showNumber) this.drawNumber(ctx, object.combo, x, y, objectScale);
        this.sprite(ctx, overlay, x, y, objectScale);
      } else if (showNumber) this.drawNumber(ctx, object.combo, x, y, objectScale);
      return;
    }
    ctx.fillStyle = 'rgba(20,22,28,0.92)';
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.92, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = radius * 0.13;
    ctx.stroke();
    if (showNumber) this.drawNumber(ctx, object.combo, x, y, objectScale);
  }

  drawApproach(ctx, object, color, alpha, progress) {
    const { radius } = this.prepared;
    const size = 1 + 2.3 * progress;
    ctx.globalAlpha = alpha;
    const approach = this.skin?.assets.approachcircle;
    if (approach) {
      this.sprite(ctx, approach, object.x, object.y, (radius / 64) * size, tinted(this.skin, approach, color));
      return;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(object.x, object.y, radius * size, 0, Math.PI * 2);
    ctx.stroke();
  }

  drawSpinner(ctx, object, alpha, time) {
    const assets = this.skin?.assets;
    const progress = Math.max(0, Math.min(1, (time - object.t) / (object.end - object.t)));
    const scale = 0.72;
    const cursor = this.cursorAt(time);
    const angle = cursor ? Math.atan2(cursor[1] - 192, cursor[0] - 256) : 0;
    ctx.globalAlpha = alpha;
    const circle = assets?.spinnerCircle ?? assets?.spinnerTop;
    if (circle) {
      ctx.save();
      ctx.translate(256, 192);
      ctx.rotate(angle);
      this.sprite(ctx, circle, 0, 0, scale);
      ctx.restore();
      if (assets.spinnerMiddle) this.sprite(ctx, assets.spinnerMiddle, 256, 192, scale);
    }
    const shrink = Math.max(0.02, 1 - progress);
    if (assets?.spinnerApproach) {
      this.sprite(ctx, assets.spinnerApproach, 256, 192, scale * 1.9 * shrink);
    } else {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(256, 192, 180 * shrink + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawSlider(ctx, object, index, color, alpha, time) {
    const { radius } = this.prepared;
    const objectScale = radius / 64;
    const body = this.sliderBody(index, object, color);
    ctx.globalAlpha = alpha * 0.92;
    ctx.drawImage(body.canvas, body.left, body.top, body.width, body.height);

    const assets = this.skin?.assets;
    const [endX, endY] = object.path.at(-1);
    if (time < object.end) {
      // Wie im Client: Am Ende steht nur dann ein Kreis, wenn der Skin dafür ein eigenes Bild hat.
      if (assets?.sliderendcircle) {
        ctx.globalAlpha = alpha;
        this.sprite(ctx, assets.sliderendcircle, endX, endY, objectScale, tinted(this.skin, assets.sliderendcircle, color));
        if (assets.sliderendcircleoverlay) this.sprite(ctx, assets.sliderendcircleoverlay, endX, endY, objectScale);
      }
      if (object.slides > 1 && assets?.reversearrow) {
        const before = object.path.at(-2) ?? object.path[0];
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(endX, endY);
        ctx.rotate(Math.atan2(before[1] - endY, before[0] - endX));
        this.sprite(ctx, assets.reversearrow, 0, 0, objectScale);
        ctx.restore();
      }
    }
    const span = (object.end - object.t) / object.slides;
    if (assets?.sliderscorepoint && time < object.t + span) {
      ctx.globalAlpha = alpha;
      for (const check of object.checks) {
        if (check >= object.t + span - 1) break;
        if (check < time) continue;
        const [tx, ty] = sliderBall(object, check);
        this.sprite(ctx, assets.sliderscorepoint, tx, ty, objectScale);
      }
    }
    if (time < object.t) this.drawCircle(ctx, object.x, object.y, object, color, alpha);
    if (time < object.t || time > object.end) return;

    const [bx, by] = sliderBall(object, time);
    const [nx, ny] = sliderBall(object, Math.min(object.end, time + 8));
    const ballFrames = assets?.sliderball ?? [];
    ctx.globalAlpha = 1;
    if (ballFrames.length) {
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(Math.atan2(ny - by, nx - bx));
      this.sprite(ctx, ballFrames[Math.floor(time / 16) % ballFrames.length], 0, 0, objectScale);
      ctx.restore();
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(bx, by, radius * 0.72, 0, Math.PI * 2);
      ctx.fill();
    }
    const cursor = this.cursorAt(time);
    const tracking = cursor && (cursor[2] & 3) && Math.hypot(cursor[0] - bx, cursor[1] - by) < radius * 2.4;
    const follow = assets?.followcircle ?? [];
    if (tracking && follow.length) {
      this.sprite(ctx, follow[Math.floor(time / 40) % follow.length], bx, by, objectScale);
    } else if (tracking) {
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(bx, by, radius * 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawObject(ctx, object, index, time) {
    const { preempt, fadeIn, hidden } = this.prepared;
    const appear = object.t - preempt;
    let alpha = Math.min(1, (time - appear) / fadeIn);
    if (hidden) {
      const fadeOutStart = appear + fadeIn;
      const span = object.type === 'slider' ? Math.max(1, object.end - fadeOutStart) : preempt * 0.45;
      if (time > fadeOutStart) alpha *= Math.max(0, 1 - (time - fadeOutStart) / span);
    }
    if (time > object.end && object.type !== 'circle') alpha *= Math.max(0, 1 - (time - object.end) / 180);
    alpha = Math.max(0, alpha);
    const color = this.combos[object.comboIndex % this.combos.length];

    if (object.type === 'spinner') {
      this.drawSpinner(ctx, object, alpha, time);
      return;
    }
    if (object.type === 'slider') this.drawSlider(ctx, object, index, color, alpha, time);
    else if (time <= object.t) this.drawCircle(ctx, object.x, object.y, object, color, alpha);

    // Treffer lassen den Kreis aufgehen, ein Miss lässt ihn einfach verschwinden.
    const judged = object.type === 'slider' ? object.end : object.t;
    if (time > object.t && time < object.t + 240 && !this.missed.has(judged)) {
      const progress = (time - object.t) / 240;
      this.drawCircle(ctx, object.x, object.y, object, color, (1 - progress) * (hidden ? 0.5 : 1), 1 + 0.4 * progress, false);
    }
    if (time < object.t && !hidden) this.drawApproach(ctx, object, color, Math.min(1, alpha * 0.9), (object.t - time) / preempt);
  }

  drawFollowPoints(ctx, time) {
    const frames = this.skin?.assets.followpoint ?? [];
    if (!frames.length) return;
    const { objects, preempt, radius } = this.prepared;
    const spacing = 32;
    for (let i = Math.max(1, this.first); i < objects.length; i++) {
      const previous = objects[i - 1];
      const next = objects[i];
      if (next.t - preempt > time) break;
      if (next.combo === 1 || next.type === 'spinner' || previous.type === 'spinner' || time > next.t) continue;
      const [fromX, fromY] = previous.type === 'slider' ? sliderBall(previous, previous.end) : [previous.x, previous.y];
      const dx = next.x - fromX;
      const dy = next.y - fromY;
      const length = Math.hypot(dx, dy);
      if (length < spacing * 2) continue;
      const count = Math.floor(length / spacing);
      const duration = Math.max(1, next.t - previous.end);
      for (let step = 1; step < count; step++) {
        const fraction = step / count;
        const moment = previous.end + duration * fraction;
        const alpha = Math.min(1, Math.max(0, (time - (moment - preempt * 0.55)) / 120)) * Math.max(0, Math.min(1, (moment + 60 - time) / 80));
        if (alpha <= 0) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(fromX + dx * fraction, fromY + dy * fraction);
        ctx.rotate(Math.atan2(dy, dx));
        this.sprite(ctx, frames[0], 0, 0, radius / 64);
        ctx.restore();
      }
    }
  }

  drawMarks(ctx, time) {
    const assets = this.skin?.assets;
    for (let i = this.marks.length - 1; i >= 0; i--) {
      const mark = this.marks[i];
      const age = time - mark.t;
      if (mark.t < time - 2000) break;
      if (age < 0 || age > 640) continue;
      const value = mark.value === 0 || mark.broke ? 0 : mark.value;
      const frames = assets?.[`hit${value}`] ?? [];
      ctx.globalAlpha = Math.min(1, 1.6 * (1 - age / 640));
      if (frames.length) {
        const frame = frames[Math.min(frames.length - 1, Math.floor(age / 16))];
        this.sprite(ctx, frame, mark.x, mark.y + (value === 0 ? age * 0.03 : 0), this.prepared.radius / 64);
        continue;
      }
      ctx.fillStyle = { 0: '#ff4d4d', 50: '#ffc94d', 100: '#7dff9a' }[value];
      ctx.font = `700 ${this.prepared.radius * 0.9}px Bahnschrift, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(value === 0 ? 'X' : String(value), mark.x, mark.y - age * 0.03);
    }
  }

  drawCursor(ctx, time) {
    const assets = this.skin?.assets;
    const cursor = this.cursorAt(time);
    if (!cursor) return;
    const [x, y, keys] = cursor;
    const pressed = keys & 3;
    const trail = assets?.cursortrail;
    const longTrail = Boolean(assets?.cursormiddle);
    const samples = longTrail ? 26 : 10;
    const gap = longTrail ? 7 : 16;
    if (trail) {
      for (let i = samples; i > 0; i--) {
        const point = this.cursorAt(time - i * gap);
        if (!point) continue;
        ctx.globalAlpha = (1 - i / samples) * 0.55;
        this.sprite(ctx, trail, point[0], point[1], 0.5);
      }
    }
    ctx.globalAlpha = 1;
    if (assets?.cursor) {
      const size = 0.5 * (pressed && this.skin.cursorExpand ? 1.2 : 1);
      ctx.save();
      ctx.translate(x, y);
      if (this.skin.cursorRotate) ctx.rotate(time / 1600);
      if (this.skin.cursorCentre) this.sprite(ctx, assets.cursor, 0, 0, size);
      else ctx.drawImage(assets.cursor.image, 0, 0, assets.cursor.width * size, assets.cursor.height * size);
      ctx.restore();
      if (assets.cursormiddle) this.sprite(ctx, assets.cursormiddle, x, y, 0.5);
      return;
    }
    ctx.fillStyle = pressed ? '#fff' : this.color;
    ctx.beginPath();
    ctx.arc(x, y, pressed ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Zeichnet Text mit den Ziffern des Skins. Fehlen sie, springt die Schrift ein. */
  drawDigits(ctx, table, text, x, y, height, align, overlap = 0) {
    const glyphs = [...text].map((char) => table?.[char]);
    if (glyphs.some((glyph) => !glyph)) {
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${height}px Bahnschrift, "Segoe UI", sans-serif`;
      ctx.textAlign = align;
      ctx.textBaseline = 'top';
      ctx.fillText(text, x, y);
      return;
    }
    const scale = height / glyphs[0].height;
    const total = glyphs.reduce((sum, glyph) => sum + (glyph.width - overlap) * scale, 0);
    let cursor = align === 'right' ? x - total : x;
    for (const glyph of glyphs) {
      ctx.drawImage(glyph.image, cursor, y, glyph.width * scale, glyph.height * scale);
      cursor += (glyph.width - overlap) * scale;
    }
  }

  drawHud(ctx, time) {
    const { canvas, skin } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    const unit = canvas.height / 480;
    const pad = 10 * unit;
    const { combo, score, accuracy } = this.hud;
    this.drawDigits(ctx, skin?.combo, `${combo}x`, 12 * unit, canvas.height - 44 * unit, 36 * unit, 'left', skin?.comboOverlap ?? 0);
    this.drawDigits(ctx, skin?.score, String(Math.round(score)).padStart(7, '0'), canvas.width - pad, pad, 34 * unit, 'right', skin?.scoreOverlap ?? 0);
    this.drawDigits(ctx, skin?.score, `${accuracy.toFixed(2)}%`, canvas.width - pad, pad + 38 * unit, 18 * unit, 'right', skin?.scoreOverlap ?? 0);
    const keys = this.cursorAt(time)?.[2] ?? 0;
    [[keys & 1, 0], [keys & 2, 1]].forEach(([active, i]) => {
      ctx.fillStyle = active ? this.color : 'rgba(255,255,255,0.16)';
      ctx.fillRect(canvas.width - 22 * unit, 200 * unit + i * 34 * unit, 14 * unit, 28 * unit);
    });
  }

  draw(time) {
    const { ctx, canvas, prepared } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!prepared) return;
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

    const { objects, preempt } = prepared;
    while (this.first < objects.length - 1 && objects[this.first].end + 260 < time) {
      this.bodies.delete(this.first);
      this.first++;
    }
    if (this.first > 0 && objects[this.first - 1].end + 260 >= time) this.first = 0;
    let last = this.first;
    while (last < objects.length && objects[last].t - preempt <= time) last++;
    this.drawFollowPoints(ctx, time);
    for (let i = last - 1; i >= this.first; i--) this.drawObject(ctx, objects[i], i, time);

    this.drawMarks(ctx, time);
    this.drawCursor(ctx, time);
    this.drawHud(ctx, time);
  }

  /** Fehlen frische Daten für dieses Feld? Die Anzeige bleibt lokal, die anderen laufen weiter. */
  stalled(time) {
    if (this.cut) return true;
    const newest = this.frames.at(-1);
    return time > 0 && (!newest || newest[0] < time - STALE_MS) && time < (this.prepared?.length ?? 0);
  }
}
