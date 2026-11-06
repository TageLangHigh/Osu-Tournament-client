// Prüft Parser und Judge gegen echte Replays. Die Dateien liegen außerhalb des Projekts:
// MATCHDECK_OSU zeigt auf einen osu!-Ordner. Ohne ihn werden diese Tests übersprungen.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseOsu, pathLengths, pointOnPath, prepareMap, sliderPath } from '../shared/beatmap.js';
import { judge } from '../shared/judge.js';
import { decompressLzma, md5, parseReplay, readZip } from '../server/files.js';

const osuDir = process.env.MATCHDECK_OSU;
const available = Boolean(osuDir && existsSync(osuDir));

test('Slider-Pfade treffen die geforderte Länge', () => {
  for (const [kind, points] of [
    ['L', [[0, 0], [100, 0]]],
    ['P', [[0, 0], [50, 40], [100, 0]]],
    ['B', [[0, 0], [50, 100], [100, 0]]],
    ['B', [[0, 0], [50, 0], [50, 0], [50, 50]]],
    ['C', [[0, 0], [30, 30], [60, 0]]],
  ]) {
    for (const length of [40, 120]) {
      const lengths = pathLengths(sliderPath(kind, points, length));
      assert.ok(Math.abs(lengths.at(-1) - length) < 1.5, `${kind} ${length} ergab ${lengths.at(-1)}`);
    }
  }
  assert.deepEqual(pointOnPath([[0, 0], [10, 0]], [0, 10], 5), [5, 0]);
});

test('Map-Parser: Slider-Zeit, Timing-Punkte und Combos', () => {
  const map = parseOsu(`osu file format v14
[General]
AudioFilename: a.mp3
StackLeniency: 0.5
[Metadata]
Title:T
Artist:A
Version:V
[Difficulty]
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1
SliderTickRate:1
[Events]
0,0,"bg.jpg",0,0
[TimingPoints]
0,500,4,2,1,60,1,0
1000,-50,4,2,1,60,0,0
[HitObjects]
100,100,500,5,0
100,100,1000,2,0,L|300:100,2,200
256,192,3000,12,0,4000
`);
  assert.equal(map.audioFile, 'a.mp3');
  assert.equal(map.background, 'bg.jpg');
  assert.equal(map.objects.length, 3);
  const slider = map.objects[1];
  assert.equal(slider.end, 2000); // 200px bei 2x Geschwindigkeit = 1 Beat je Richtung
  assert.equal(slider.combo, 2);
  assert.equal(slider.checks.at(-1), 2000);
  assert.equal(map.objects[2].type, 'spinner');
  assert.equal(map.objects[2].end, 4000);
});

test('HR spiegelt die Map und verschärft CS, AR, OD', () => {
  const map = parseOsu('[Difficulty]\nCircleSize:4\nOverallDifficulty:5\nApproachRate:9\n[HitObjects]\n100,100,500,1,0\n');
  const plain = prepareMap(map, 0);
  const hardRock = prepareMap(map, 16);
  assert.equal(hardRock.objects[0].y, 284);
  assert.ok(hardRock.radius < plain.radius);
  assert.ok(hardRock.preempt < plain.preempt);
  assert.ok(hardRock.windows.w300 < plain.windows.w300);
  assert.equal(prepareMap(map, 64).rate, 1.5);
  assert.equal(map.objects[0].y, 100); // Original bleibt unverändert
});

test('LZMA-Decoder stimmt mit Python überein', () => {
  const python = String.raw`
import lzma, sys, random
random.seed(7)
data = ("".join(f"{random.randint(0,40)}|{random.random()*512:.3f}|{random.random()*384:.3f}|{random.randint(0,15)}," for _ in range(4000))).encode()
sys.stdout.buffer.write(lzma.compress(data, format=lzma.FORMAT_ALONE, filters=[{"id": lzma.FILTER_LZMA1}]))
`;
  const compressed = execFileSync('python', ['-I', '-c', python], { maxBuffer: 1 << 24 });
  const text = decompressLzma(compressed).toString('latin1');
  assert.equal(text.split(',').length, 4001);
  assert.match(text, /^\d+\|[\d.]+\|[\d.]+\|\d+,/);
});

test('Echte Replays: Parser und Judge im Vergleich mit dem Replay-Kopf', { skip: !available && 'MATCHDECK_OSU nicht gesetzt' }, () => {
  const replays = readdirSync(join(osuDir, 'Replays')).filter((name) => name.endsWith('.osr'));
  const songs = join(osuDir, 'Songs');
  const index = new Map();
  for (const folder of readdirSync(songs)) {
    const path = join(songs, folder);
    let names;
    try { names = readdirSync(path); } catch { continue; }
    for (const name of names) if (name.endsWith('.osu')) index.set(name, join(path, name));
  }
  const byHash = new Map();
  for (const path of index.values()) byHash.set(md5(readFileSync(path)), path);

  const rows = [];
  for (const name of replays) {
    const replay = parseReplay(readFileSync(join(osuDir, 'Replays', name)));
    const path = byHash.get(replay.beatmapHash);
    // Reine Kopfdaten gibt es wirklich, und Relax spielt ohne Klicks: beides ist hier nicht bewertbar.
    if (replay.mode !== 0 || !path || !replay.frames.length || replay.mods & 128) continue;
    const map = parseOsu(readFileSync(path, 'utf8'));
    const { final } = judge(prepareMap(map, replay.mods), replay.frames);
    const total = replay.counts.c300 + replay.counts.c100 + replay.counts.c50 + replay.counts.miss;
    const real = (replay.counts.c300 * 300 + replay.counts.c100 * 100 + replay.counts.c50 * 50) / (total * 300);
    assert.ok(total <= map.objects.length, `Mehr Treffer als Objekte bei ${name}`);
    if (total === map.objects.length) rows.push({ name: name.slice(0, 40), real, judged: final.accuracy, mods: replay.mods });
  }
  assert.ok(rows.length > 0, 'Kein Replay mit passender Map gefunden');
  const deviation = rows.reduce((sum, row) => sum + Math.abs(row.real - row.judged), 0) / rows.length;
  console.log(`Replays verglichen: ${rows.length}, mittlere Accuracy-Abweichung: ${(deviation * 100).toFixed(2)} %`);
  for (const row of rows.sort((a, b) => Math.abs(b.real - b.judged) - Math.abs(a.real - a.judged)).slice(0, 5)) {
    console.log(`  ${(row.real * 100).toFixed(2)} real / ${(row.judged * 100).toFixed(2)} gerechnet  ${row.name}`);
  }
  assert.ok(deviation < 0.015, `Abweichung zu groß: ${deviation}`);
});

test('Echte .osz liest sich', { skip: !available && 'MATCHDECK_OSU nicht gesetzt' }, () => {
  const path = process.env.MATCHDECK_OSZ;
  if (!path || !existsSync(path)) return;
  const entries = readZip(readFileSync(path));
  const osu = [...entries.keys()].filter((name) => name.endsWith('.osu'));
  assert.ok(osu.length > 0);
  const map = parseOsu(entries.get(osu[0]).read().toString('utf8'));
  assert.ok(map.title.length > 0);
});
