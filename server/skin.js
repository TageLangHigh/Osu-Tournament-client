// Liest Skins aus dem lokalen osu!-Ordner des Nutzers. Matchdeck liefert selbst keine osu!-Grafiken mit.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_DEPTH = 3;

export function findOsuFolder(configured) {
  const candidates = [configured, process.env.MATCHDECK_OSU, join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'osu!')];
  return candidates.find((path) => path && existsSync(join(path, 'Skins'))) ?? null;
}

export function listSkins(osuFolder) {
  if (!osuFolder) return [];
  return readdirSync(join(osuFolder, 'Skins'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.trim().localeCompare(b.trim()));
}

/** Der im Spiel gewählte Skin steht in osu!.<Name>.cfg. */
export function activeSkinName(osuFolder) {
  if (!osuFolder) return null;
  for (const file of readdirSync(osuFolder)) {
    if (!/^osu!\..+\.cfg$/i.test(file) || /^osu!\.cfg$/i.test(file)) continue;
    const line = readFileSync(join(osuFolder, file), 'utf8').match(/^Skin\s*=\s*(.+?)\s*$/m);
    if (line) return line[1];
  }
  return null;
}

const toColor = (text) => {
  const parts = text.split(',').map((part) => Number(part.trim()));
  return parts.length >= 3 && parts.every(Number.isFinite) ? `rgb(${parts[0]},${parts[1]},${parts[2]})` : null;
};

export function parseSkinIni(text) {
  const ini = {
    colours: [], sliderBorder: null, sliderTrack: null,
    hitCirclePrefix: 'default', hitCircleOverlap: -2, scorePrefix: 'score', scoreOverlap: 0,
    comboPrefix: 'score', comboOverlap: 0, cursorCentre: true, cursorRotate: true, cursorExpand: true,
    overlayAboveNumber: true, animationFramerate: 0, sliderBallFlip: false,
  };
  const combos = {};
  let section = '';
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.split('//')[0].trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      section = line.slice(1, line.indexOf(']'));
      continue;
    }
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    const flag = value === '1';
    if (section === 'Colours') {
      const combo = key.match(/^Combo(\d)$/);
      if (combo) combos[combo[1]] = toColor(value);
      else if (key === 'SliderBorder') ini.sliderBorder = toColor(value);
      else if (key === 'SliderTrackOverride') ini.sliderTrack = toColor(value);
    } else if (section === 'Fonts') {
      if (key === 'HitCirclePrefix') ini.hitCirclePrefix = value.replaceAll('\\', '/');
      else if (key === 'HitCircleOverlap') ini.hitCircleOverlap = Number(value);
      else if (key === 'ScorePrefix') ini.scorePrefix = value.replaceAll('\\', '/');
      else if (key === 'ScoreOverlap') ini.scoreOverlap = Number(value);
      else if (key === 'ComboPrefix') ini.comboPrefix = value.replaceAll('\\', '/');
      else if (key === 'ComboOverlap') ini.comboOverlap = Number(value);
    } else if (section === 'General') {
      if (key === 'CursorCentre') ini.cursorCentre = flag;
      else if (key === 'CursorRotate') ini.cursorRotate = flag;
      else if (key === 'CursorExpand') ini.cursorExpand = flag;
      else if (key === 'HitCircleOverlayAboveNumber' || key === 'HitCircleOverlayAboveNumer') ini.overlayAboveNumber = flag;
      else if (key === 'AnimationFramerate') ini.animationFramerate = Number(value);
      else if (key === 'SliderBallFlip') ini.sliderBallFlip = flag;
    }
  }
  ini.colours = Object.keys(combos).sort().map((key) => combos[key]).filter(Boolean);
  return ini;
}

function indexImages(directory, prefix = '', depth = 0, found = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory() && depth < MAX_DEPTH) indexImages(join(directory, entry.name), `${relative}/`, depth + 1, found);
    else if (entry.isFile() && /\.png$/i.test(entry.name)) found.set(relative.toLowerCase(), relative);
  }
  return found;
}

export function loadSkin(osuFolder, name) {
  const directory = join(osuFolder, 'Skins', name);
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return null;
  const iniName = readdirSync(directory).find((file) => file.toLowerCase() === 'skin.ini');
  const ini = parseSkinIni(iniName ? readFileSync(join(directory, iniName), 'utf8') : '');
  const images = indexImages(directory);
  const url = (relative) => `/skin/${encodeURIComponent(name)}/${relative.split('/').map(encodeURIComponent).join('/')}`;

  const single = (base) => {
    const key = base.toLowerCase();
    const hd = images.get(`${key}@2x.png`);
    if (hd) return { url: url(hd), hd: true };
    const sd = images.get(`${key}.png`);
    return sd ? { url: url(sd), hd: false } : null;
  };
  const frames = (base, separator = '-') => {
    const list = [];
    for (let i = 0; i < 240; i++) {
      const frame = single(`${base}${separator}${i}`);
      if (!frame) break;
      list.push(frame);
    }
    if (list.length) return list;
    const plain = single(base);
    return plain ? [plain] : [];
  };
  const digits = (prefix) => {
    const table = {};
    for (let i = 0; i < 10; i++) table[i] = single(`${prefix}-${i}`);
    table.x = single(`${prefix}-x`);
    table['%'] = single(`${prefix}-percent`);
    table['.'] = single(`${prefix}-dot`);
    table[','] = single(`${prefix}-comma`);
    return table;
  };

  return {
    name,
    ...ini,
    assets: {
      hitcircle: single('hitcircle'),
      hitcircleoverlay: single('hitcircleoverlay'),
      sliderendcircle: single('sliderendcircle'),
      sliderendcircleoverlay: single('sliderendcircleoverlay'),
      approachcircle: single('approachcircle'),
      reversearrow: single('reversearrow'),
      sliderscorepoint: single('sliderscorepoint'),
      cursor: single('cursor'),
      cursormiddle: single('cursormiddle'),
      cursortrail: single('cursortrail'),
      spinnerCircle: single('spinner-circle'),
      spinnerTop: single('spinner-top'),
      spinnerMiddle: single('spinner-middle'),
      spinnerApproach: single('spinner-approachcircle'),
      sliderball: frames('sliderb', ''),
      followcircle: frames('sliderfollowcircle'),
      followpoint: frames('followpoint'),
      hit0: frames('hit0'),
      hit50: frames('hit50'),
      hit100: frames('hit100'),
    },
    numbers: digits(ini.hitCirclePrefix),
    score: digits(ini.scorePrefix),
    combo: digits(ini.comboPrefix),
  };
}
