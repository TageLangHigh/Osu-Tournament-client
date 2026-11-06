// Beatmap-Parser, Geometrie und Mod-Anwendung für osu!standard. Läuft in Node und im Browser.

export const MODS = { NF: 1, EZ: 2, HD: 8, HR: 16, SD: 32, DT: 64, RX: 128, HT: 256, NC: 512, FL: 1024 };

export const modNames = (bits) => Object.entries(MODS).filter(([, bit]) => bits & bit).map(([name]) => name);
export const rateOf = (bits) => (bits & (MODS.DT | MODS.NC) ? 1.5 : bits & MODS.HT ? 0.75 : 1);

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round1 = (value) => Math.round(value * 10) / 10;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function bezier(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  const steps = clamp(Math.ceil(length / 5), 6, 80);
  const output = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const work = points.map((point) => [...point]);
    for (let r = work.length - 1; r > 0; r--) {
      for (let i = 0; i < r; i++) {
        work[i][0] += (work[i + 1][0] - work[i][0]) * t;
        work[i][1] += (work[i + 1][1] - work[i][1]) * t;
      }
    }
    output.push(work[0]);
  }
  return output;
}

function circularArc([a, b, c]) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-3) return null;
  const sq = (p) => p[0] * p[0] + p[1] * p[1];
  const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  const radius = Math.hypot(a[0] - ux, a[1] - uy);
  const start = Math.atan2(a[1] - uy, a[0] - ux);
  let mid = Math.atan2(b[1] - uy, b[0] - ux);
  let end = Math.atan2(c[1] - uy, c[0] - ux);
  while (mid < start) mid += Math.PI * 2;
  while (end < start) end += Math.PI * 2;
  if (mid > end) end -= Math.PI * 2;
  const sweep = end - start;
  const steps = clamp(Math.ceil((Math.abs(sweep) * radius) / 5), 6, 200);
  const output = [];
  for (let s = 0; s <= steps; s++) {
    const angle = start + (sweep * s) / steps;
    output.push([ux + Math.cos(angle) * radius, uy + Math.sin(angle) * radius]);
  }
  return output;
}

function catmull(points) {
  const output = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 0; s < 20; s++) {
      const t = s / 20;
      output.push([0, 1].map((k) => 0.5 * (
        2 * p1[k] + (p2[k] - p0[k]) * t
        + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t
        + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t * t * t)));
    }
  }
  output.push(points.at(-1));
  return output;
}

/** Ergibt eine Polylinie, die genau `length` osu!-Pixel lang ist. */
export function sliderPath(kind, points, length) {
  let raw = [];
  if (kind === 'L') raw = points;
  else if (kind === 'C') raw = catmull(points);
  else if (kind === 'P' && points.length === 3) raw = circularArc(points) ?? bezier(points);
  else {
    let segment = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (points[i][0] === points[i - 1][0] && points[i][1] === points[i - 1][1]) {
        raw.push(...bezier(segment));
        segment = [points[i]];
      } else segment.push(points[i]);
    }
    raw.push(...bezier(segment));
  }

  const path = [raw[0]];
  let travelled = 0;
  for (let i = 1; i < raw.length; i++) {
    const step = distance(raw[i - 1], raw[i]);
    if (step === 0) continue;
    if (travelled + step >= length) {
      const f = (length - travelled) / step;
      path.push([raw[i - 1][0] + (raw[i][0] - raw[i - 1][0]) * f, raw[i - 1][1] + (raw[i][1] - raw[i - 1][1]) * f]);
      travelled = length;
      break;
    }
    travelled += step;
    path.push(raw[i]);
  }
  if (travelled < length && path.length > 1) {
    const a = path.at(-2);
    const b = path.at(-1);
    const step = distance(a, b) || 1;
    const f = (length - travelled) / step;
    path.push([b[0] + (b[0] - a[0]) * f, b[1] + (b[1] - a[1]) * f]);
  }
  return path.map(([x, y]) => [round1(x), round1(y)]);
}

export function pointOnPath(path, lengths, along) {
  if (along <= 0) return path[0];
  const total = lengths.at(-1);
  if (along >= total) return path.at(-1);
  let low = 0;
  let high = lengths.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (lengths[mid] <= along) low = mid;
    else high = mid;
  }
  const span = lengths[high] - lengths[low] || 1;
  const f = (along - lengths[low]) / span;
  return [path[low][0] + (path[high][0] - path[low][0]) * f, path[low][1] + (path[high][1] - path[low][1]) * f];
}

export const pathLengths = (path) => {
  const lengths = [0];
  for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + distance(path[i - 1], path[i]));
  return lengths;
};

/** Ball-Position eines Sliders zur Zeit `time`. */
export function sliderBall(object, time) {
  const span = (object.end - object.t) / object.slides;
  const progress = clamp((time - object.t) / span, 0, object.slides);
  const slide = Math.min(Math.floor(progress), object.slides - 1);
  const f = progress - slide;
  const lengths = object.lengths ?? (object.lengths = pathLengths(object.path));
  const total = lengths.at(-1);
  return pointOnPath(object.path, lengths, total * (slide % 2 ? 1 - f : f));
}

function buildTimingLookup(points) {
  const sorted = [...points].sort((a, b) => a.time - b.time);
  const firstBeat = sorted.find((point) => point.beatLength > 0)?.beatLength ?? 500;
  return (time) => {
    let beat = firstBeat;
    let velocity = 1;
    for (const point of sorted) {
      if (point.time > time + 1) break;
      if (point.beatLength > 0) {
        beat = point.beatLength;
        velocity = 1;
      } else velocity = clamp(-100 / point.beatLength, 0.1, 10);
    }
    return { beat, velocity };
  };
}

export function parseOsu(text) {
  const map = {
    title: '', artist: '', version: '', creator: '', mapId: 0, setId: 0,
    cs: 5, ar: null, od: 5, hp: 5, sliderMultiplier: 1.4, tickRate: 1,
    stackLeniency: 0.7, mode: 0, audioFile: null, background: null, objects: [],
  };
  const timing = [];
  const rawObjects = [];
  const comboColours = {};
  let section = '';
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('//')) continue;
    if (line.startsWith('[')) {
      section = line.trim().slice(1, -1);
      continue;
    }
    if (['General', 'Metadata', 'Difficulty'].includes(section)) {
      const at = line.indexOf(':');
      if (at < 0) continue;
      const key = line.slice(0, at).trim();
      const value = line.slice(at + 1).trim();
      const number = Number.parseFloat(value);
      if (key === 'AudioFilename') map.audioFile = value;
      else if (key === 'Mode') map.mode = number;
      else if (key === 'StackLeniency') map.stackLeniency = number;
      else if (key === 'Title') map.title = value;
      else if (key === 'Artist') map.artist = value;
      else if (key === 'Version') map.version = value;
      else if (key === 'Creator') map.creator = value;
      else if (key === 'BeatmapID') map.mapId = number;
      else if (key === 'BeatmapSetID') map.setId = number;
      else if (key === 'CircleSize') map.cs = number;
      else if (key === 'ApproachRate') map.ar = number;
      else if (key === 'OverallDifficulty') map.od = number;
      else if (key === 'HPDrainRate') map.hp = number;
      else if (key === 'SliderMultiplier') map.sliderMultiplier = number;
      else if (key === 'SliderTickRate') map.tickRate = number;
    } else if (section === 'Events') {
      const match = line.match(/^0,0,"([^"]+)"/);
      if (match && !map.background) map.background = match[1];
    } else if (section === 'TimingPoints') {
      const parts = line.split(',');
      if (parts.length < 2) continue;
      const uninherited = parts.length < 7 || parts[6].trim() === '1';
      const beatLength = Number.parseFloat(parts[1]);
      timing.push({ time: Number.parseFloat(parts[0]), beatLength: uninherited ? Math.abs(beatLength) : Math.min(beatLength, -1e-3) });
    } else if (section === 'Colours') {
      const match = line.match(/^Combo(\d+)\s*:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
      if (match) comboColours[match[1]] = `rgb(${match[2]},${match[3]},${match[4]})`;
    } else if (section === 'HitObjects') rawObjects.push(line.split(','));
  }
  map.colours = Object.keys(comboColours).sort((a, b) => a - b).map((key) => comboColours[key]);
  map.ar ??= map.od;

  const lookup = buildTimingLookup(timing);
  let comboNumber = 0;
  let comboIndex = -1;
  for (const parts of rawObjects) {
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const t = Number(parts[2]);
    const type = Number(parts[3]);
    const startsCombo = Boolean(type & 4) || !map.objects.length || map.objects.at(-1).type === 'spinner';
    if (startsCombo) {
      comboNumber = 0;
      comboIndex += 1 + ((type >> 4) & 7);
    }
    comboNumber++;
    const object = { x, y, t, end: t, combo: comboNumber, comboIndex, type: 'circle' };

    if (type & 2) {
      const curve = parts[5].split('|');
      const kind = curve[0];
      const points = [[x, y], ...curve.slice(1).map((pair) => pair.split(':').map(Number))];
      const slides = Number(parts[6]);
      const length = Number(parts[7]);
      const { beat, velocity } = lookup(t);
      const pxPerBeat = 100 * map.sliderMultiplier * velocity;
      object.type = 'slider';
      object.slides = slides;
      object.path = sliderPath(kind, points, length);
      object.pixelLength = length;
      object.end = t + (length / pxPerBeat) * beat * slides;
      const tickSpacing = pxPerBeat / map.tickRate;
      const span = (object.end - t) / slides;
      const ticks = [];
      for (let distanceAlong = tickSpacing; distanceAlong < length - 10; distanceAlong += tickSpacing) ticks.push(distanceAlong / length);
      object.checks = [];
      for (let slide = 0; slide < slides; slide++) {
        const forward = slide % 2 === 0;
        for (const tick of ticks) object.checks.push(t + span * (slide + (forward ? tick : 1 - tick)));
        object.checks.push(t + span * (slide + 1));
      }
      object.checks.sort((a, b) => a - b);
    } else if (type & 8) {
      object.type = 'spinner';
      object.x = 256;
      object.y = 192;
      object.end = Number(parts[5]);
    } else if (!(type & 1)) continue;
    map.objects.push(object);
  }
  map.length = map.objects.at(-1)?.end ?? 0;
  return map;
}

function applyStacking(objects, preempt, leniency, offsetPerStack) {
  const threshold = preempt * leniency;
  const tail = (object) => (object.type === 'slider' ? (object.slides % 2 ? object.path.at(-1) : object.path[0]) : [object.x, object.y]);
  for (const object of objects) object.stack = 0;
  for (let i = objects.length - 1; i > 0; i--) {
    let current = objects[i];
    if (current.stack !== 0 || current.type === 'spinner') continue;
    for (let n = i - 1; n >= 0; n--) {
      const earlier = objects[n];
      if (earlier.type === 'spinner') continue;
      if (current.t - earlier.end > threshold) break;
      if (distance([earlier.x, earlier.y], [current.x, current.y]) < 3) {
        earlier.stack = current.stack + 1;
        current = earlier;
      } else if (earlier.type === 'slider' && distance(tail(earlier), [current.x, current.y]) < 3) {
        break;
      }
    }
  }
  for (const object of objects) {
    if (!object.stack) continue;
    const shift = -object.stack * offsetPerStack;
    object.x += shift;
    object.y += shift;
    if (object.path) object.path = object.path.map(([x, y]) => [x + shift, y + shift]);
  }
}

/** Rechnet Mods ein und liefert alles, was Judge und Renderer brauchen. */
export function prepareMap(map, mods = 0) {
  const hardRock = Boolean(mods & MODS.HR);
  const easy = Boolean(mods & MODS.EZ);
  const adjust = (value) => (hardRock ? Math.min(10, value * 1.4) : easy ? value / 2 : value);
  const cs = hardRock ? Math.min(10, map.cs * 1.3) : easy ? map.cs / 2 : map.cs;
  const ar = adjust(map.ar);
  const od = adjust(map.od);

  const radius = 54.4 - 4.48 * cs;
  const preempt = ar < 5 ? 1200 + (600 * (5 - ar)) / 5 : 1200 - (750 * (ar - 5)) / 5;
  const fadeIn = ar < 5 ? 800 + (400 * (5 - ar)) / 5 : 800 - (500 * (ar - 5)) / 5;

  const objects = map.objects.map((object) => {
    const copy = { ...object };
    delete copy.lengths;
    if (hardRock) {
      copy.y = 384 - copy.y;
      if (copy.path) copy.path = copy.path.map(([x, y]) => [x, 384 - y]);
    }
    return copy;
  });
  applyStacking(objects, preempt, map.stackLeniency, radius / 10);

  return {
    objects, radius, preempt, fadeIn, mods,
    rate: rateOf(mods),
    hidden: Boolean(mods & MODS.HD),
    windows: { w300: 80 - 6 * od, w100: 140 - 8 * od, w50: 200 - 10 * od },
    od,
    length: map.length,
  };
}
