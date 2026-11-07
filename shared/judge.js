// Bewertet Cursor-Frames gegen eine vorbereitete Map (osu!standard).
// Das ist bewusst eine Näherung für die Live-Anzeige. Maßgeblich bleiben die
// Ergebnisse von Bancho oder aus dem Replay-Kopf.

import { sliderBall } from './beatmap.js';

const BUTTONS = 3;

function frameIndexAt(frames, time) {
  let low = 0;
  let high = frames.length - 1;
  if (!frames.length || frames[0][0] > time) return -1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (frames[mid][0] <= time) low = mid;
    else high = mid - 1;
  }
  return low;
}

function headResults(prepared, frames) {
  const { windows, radius, objects } = prepared;
  const clickable = objects.map((object, index) => ({ object, index })).filter(({ object }) => object.type !== 'spinner');
  const heads = new Map();
  let pointer = 0;
  let previous = 0;
  const expire = (time) => {
    while (pointer < clickable.length && clickable[pointer].object.t + windows.w50 < time) {
      heads.set(clickable[pointer].index, { hit: false, offset: null });
      pointer++;
    }
  };

  for (const [time, x, y, keys] of frames) {
    const buttons = keys & BUTTONS;
    const pressed = buttons & ~previous;
    previous = buttons;
    expire(time);
    if (!pressed || pointer >= clickable.length) continue;
    const presses = (pressed & 1) + ((pressed >> 1) & 1);
    for (let i = 0; i < presses && pointer < clickable.length; i++) {
      const { object, index } = clickable[pointer];
      const offset = time - object.t;
      if (Math.abs(offset) > windows.w50 || Math.hypot(x - object.x, y - object.y) > radius) break;
      heads.set(index, { hit: true, offset });
      pointer++;
    }
  }
  expire(Number.POSITIVE_INFINITY);
  return heads;
}

function sliderResult(object, head, frames, radius) {
  let passed = head.hit ? 1 : 0;
  let broke = !head.hit;
  const follow = radius * 2.4;
  const final = object.checks.at(-1);
  for (const check of object.checks) {
    const isTail = check === final;
    const time = isTail ? Math.max(object.t + (object.end - object.t) / 2, check - 36) : check;
    const at = frameIndexAt(frames, time);
    const frame = at >= 0 ? frames[at] : null;
    const [bx, by] = sliderBall(object, time);
    const tracking = frame && (frame[3] & BUTTONS) && Math.hypot(frame[1] - bx, frame[2] - by) <= follow;
    if (tracking) passed++;
    else if (!isTail) broke = true;
  }
  const total = object.checks.length + 1;
  const ratio = passed / total;
  return { value: ratio === 1 ? 300 : ratio >= 0.5 ? 100 : ratio > 0 ? 50 : 0, broke };
}

function spinnerResult(object, frames, od) {
  const start = Math.max(0, frameIndexAt(frames, object.t));
  let angle = null;
  let total = 0;
  for (let i = start; i < frames.length && frames[i][0] <= object.end; i++) {
    const [, x, y, keys] = frames[i];
    if (!(keys & BUTTONS)) {
      angle = null;
      continue;
    }
    const current = Math.atan2(y - 192, x - 256);
    if (angle !== null) {
      let delta = current - angle;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      total += delta;
    }
    angle = current;
  }
  const seconds = (object.end - object.t) / 1000;
  const needed = seconds * (od > 5 ? 2.5 + 0.5 * od : 3 + 0.4 * od);
  const rotations = Math.abs(total) / (Math.PI * 2);
  return rotations >= needed ? 300 : rotations >= needed * 0.75 ? 100 : rotations >= needed * 0.5 ? 50 : 0;
}

/** Liefert Treffer-Marken und eine Zeitleiste mit Score, Combo und Accuracy. */
export function judge(prepared, frames) {
  const heads = headResults(prepared, frames);
  const marks = [];
  const timeline = [];
  const counts = { c300: 0, c100: 0, c50: 0, miss: 0 };
  const total = prepared.objects.length;
  let combo = 0;
  let maxCombo = 0;
  let comboScore = 0;
  let comboPotential = 0;
  for (let i = 1; i <= total; i++) comboPotential += i;

  prepared.objects.forEach((object, index) => {
    let value;
    let broke = false;
    let time = object.t;
    const offset = heads.get(index)?.offset ?? null;
    if (object.type === 'circle') {
      const head = heads.get(index);
      const size = head?.hit ? Math.abs(head.offset) : Infinity;
      value = size <= prepared.windows.w300 ? 300 : size <= prepared.windows.w100 ? 100 : size <= prepared.windows.w50 ? 50 : 0;
    } else if (object.type === 'slider') {
      ({ value, broke } = sliderResult(object, heads.get(index) ?? { hit: false }, frames, prepared.radius));
      time = object.end;
    } else {
      value = spinnerResult(object, frames, prepared.od);
      time = object.end;
    }

    if (value === 0 || broke) combo = 0;
    else combo++;
    maxCombo = Math.max(maxCombo, combo);
    comboScore += combo * (value / 300);
    if (value === 300) counts.c300++;
    else if (value === 100) counts.c100++;
    else if (value === 50) counts.c50++;
    else counts.miss++;

    const judged = counts.c300 + counts.c100 + counts.c50 + counts.miss;
    const accuracy = (counts.c300 * 300 + counts.c100 * 100 + counts.c50 * 50) / (judged * 300);
    const fraction = judged / total;
    const score = Math.round(700000 * (comboScore / comboPotential) + 300000 * Math.pow(accuracy, 10) * fraction);

    timeline.push({ t: time, score, combo, accuracy, miss: counts.miss, offset, ...counts });
    if (value !== 300 || broke) {
      const [x, y] = object.type === 'slider' ? object.path.at(-1) : [object.x, object.y];
      marks.push({ t: time, x, y, value, broke: value !== 0 && broke });
    }
  });

  return { marks, timeline, final: { ...counts, maxCombo, ...(timeline.at(-1) ?? { score: 0, accuracy: 1 }) } };
}
