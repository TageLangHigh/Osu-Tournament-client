import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { activeSkinName, listSkins, loadSkin, parseSkinIni } from '../server/skin.js';
import { parseOsu } from '../shared/beatmap.js';
import { mergeResults } from '../server/results.js';
import { applyBanchoLine, emptyLobby } from '../server/banchobot.js';

test('skin.ini: Farben, Schriften, Schalter', () => {
  const ini = parseSkinIni(`[General]
CursorCentre: 0
CursorRotate: 0 // Kommentar
HitCircleOverlayAboveNumer: 0
[Colours]
Combo2: 1,2,3
Combo1: 4,5,6
SliderBorder: 9,9,9
[Fonts]
HitCirclePrefix: fonts\\num
HitCircleOverlap: 5
[Mania]
Combo1: 7,7,7
`);
  assert.deepEqual(ini.colours, ['rgb(4,5,6)', 'rgb(1,2,3)']);
  assert.equal(ini.sliderBorder, 'rgb(9,9,9)');
  assert.equal(ini.hitCirclePrefix, 'fonts/num');
  assert.equal(ini.hitCircleOverlap, 5);
  assert.equal(ini.cursorCentre, false);
  assert.equal(ini.overlayAboveNumber, false);
});

test('Skin-Ordner: @2x bevorzugt, Animationen, Unterordner, Groß-/Kleinschreibung', () => {
  const root = mkdtempSync(join(tmpdir(), 'matchdeck-skin-'));
  const skin = join(root, 'Skins', '  Mein Skin');
  mkdirSync(join(skin, 'fonts'), { recursive: true });
  writeFileSync(join(root, 'osu!.Spieler.cfg'), 'Skin =   Mein Skin\r\n');
  writeFileSync(join(skin, 'skin.ini'), '[Fonts]\nHitCirclePrefix: fonts/num\n');
  for (const file of ['HitCircle.png', 'hitcircle@2x.png', 'hit100-0.png', 'hit100-1.png', 'sliderb0.png', 'sliderb1.png', 'fonts/num-7.png']) writeFileSync(join(skin, file), '');
  assert.deepEqual(listSkins(root), ['  Mein Skin']);
  const loaded = loadSkin(root, '  Mein Skin');
  assert.equal(loaded.assets.hitcircle.hd, true);
  assert.equal(loaded.assets.hit100.length, 2);
  assert.equal(loaded.assets.sliderball.length, 2);
  assert.ok(loaded.numbers[7].url.endsWith('fonts/num-7.png'));
  assert.equal(loaded.numbers[6], null);
  assert.equal(activeSkinName(root).trim(), 'Mein Skin');
  rmSync(root, { recursive: true, force: true });
});

test('Beatmap-Farben kommen aus [Colours]', () => {
  const map = parseOsu('[Colours]\nCombo2 : 1,2,3\nCombo1 : 9,8,7\n[HitObjects]\n1,1,1,1,0\n');
  assert.deepEqual(map.colours, ['rgb(9,8,7)', 'rgb(1,2,3)']);
});

test('Ergebnisse: Widersprüche werden gemeldet, nicht verschluckt', () => {
  const clean = mergeResults({
    irc: [{ name: 'Ann', score: 100, passed: true }],
    api: [{ name: 'Ann', score: 100, accuracy: 98, combo: 5, misses: 0 }],
  });
  assert.deepEqual(clean.warnings, []);
  assert.equal(clean.rows[0].accuracy, 98);

  const conflict = mergeResults({
    irc: [{ name: 'Ann', score: 900000, passed: true }],
    api: [{ name: 'Ann', score: 639000, accuracy: 98, combo: 5, misses: 0 }, { name: 'Bob', score: 5, accuracy: 90, combo: 1, misses: 1, passed: true }],
    live: [{ name: 'Ann', score: 500000 }],
    departed: ['Cid'],
  });
  assert.equal(conflict.warnings.length, 4);
  assert.equal(conflict.rows.find((row) => row.name === 'Ann').score, 900000, 'IRC bleibt maßgeblich');
  assert.equal(conflict.rows.length, 2);
});

test('BanchoBot: !roll wird erkannt', () => {
  const [event] = applyBanchoLine(emptyLobby(1), 'Some Player rolls 57 point(s)');
  assert.deepEqual(event, { type: 'roll', name: 'Some Player', value: 57 });
});
