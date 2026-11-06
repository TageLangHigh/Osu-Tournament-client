// Prüft die Anbindung ans offizielle Bancho. Die Textmuster stammen aus der Bibliothek bancho.js.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyBanchoLine, checkLobby, emptyLobby } from '../server/banchobot.js';
import { withNonce } from '../server/irc.js';
import { inspectTourney, parseCfg, prepareTourney, renderCfg, validateHeight } from '../server/tourney.js';

test('BanchoBot: Einstellungen, Mods und Timer im echten Wortlaut', () => {
  const lobby = emptyLobby(1);
  applyBanchoLine(lobby, 'Changed match settings to 4 slots, TeamVs, ScoreV2');
  assert.equal(lobby.teamMode, 'TeamVs');
  assert.equal(lobby.winCondition, 'ScoreV2');
  applyBanchoLine(lobby, 'Disabled all mods, enabled FreeMod');
  assert.equal(lobby.freemod, true);
  applyBanchoLine(lobby, 'Enabled Hidden, HardRock, disabled FreeMod');
  assert.equal(lobby.freemod, false);
  assert.deepEqual(lobby.mods, ['HD', 'HR']);
  applyBanchoLine(lobby, 'Countdown ends in 1 minute and 30 seconds', 0);
  assert.equal(lobby.countdown.endsAt, 90000);
  applyBanchoLine(lobby, 'Queued the match to start in 10 seconds', 0);
  assert.deepEqual(lobby.countdown, { endsAt: 10000, starts: true });
  applyBanchoLine(lobby, 'Aborted the match start timer');
  assert.equal(lobby.countdown, null);
  assert.equal(applyBanchoLine(lobby, 'Invalid map ID provided')[0].type, 'problem');
  assert.equal(applyBanchoLine(lobby, 'User not found: Niemand')[0].type, 'problem');
});

test('Slot-Zeile mit Mods ohne Team und Host', () => {
  const lobby = emptyLobby(1);
  applyBanchoLine(lobby, 'Slot 3  Ready     https://osu.ppy.sh/u/7 Solo Spieler     [Hidden, HardRock]');
  assert.deepEqual(lobby.slots[3].mods, ['HD', 'HR']);
  applyBanchoLine(lobby, 'Slot 4  Ready     https://osu.ppy.sh/u/8 Chef             [Host / Team Red / Hidden]');
  assert.deepEqual(lobby.slots[4].mods, ['HD']);
  assert.equal(lobby.slots[4].team, 'red');
  assert.equal(lobby.slots[4].host, true);
});

test('!mp settings: Unbekannte Slot-Zeilen leeren die Lobby nicht', () => {
  const lobby = emptyLobby(1);
  applyBanchoLine(lobby, 'Ann joined in slot 1 for team red.');
  for (const line of ['Room name: X, History: https://osu.ppy.sh/mp/1', 'Players: 1', 'Slot 1 ganz anderes Format']) applyBanchoLine(lobby, line);
  assert.equal(lobby.slots[1].name, 'Ann');
  applyBanchoLine(lobby, 'Bob joined in slot 2 for team blue.');
  for (const line of ['Players: 1', 'Slot 2  Ready     https://osu.ppy.sh/u/7 Bob              [Team Blue]']) applyBanchoLine(lobby, line);
  assert.deepEqual(Object.keys(lobby.slots), ['2'], 'Echte Zeilen ersetzen die alte Liste');
  applyBanchoLine(lobby, 'Players: 0');
  assert.deepEqual(lobby.slots, {});
});

test('Regelcheck: osu!tourney geht nach Slots', () => {
  const lobby = emptyLobby(1);
  lobby.slots = {
    1: { name: 'Bob', mods: [] },
    2: { name: 'Bea', mods: [] },
    3: { name: 'Ann', mods: [] },
    5: { name: 'Ari Two', mods: [] },
  };
  const issues = checkLobby(lobby, {
    config: { teams: { a: { name: 'A' }, b: { name: 'B' } } },
    entry: null,
    rules: { teamSize: 2 },
    teamOf: (name) => ({ Ann: 'a', 'Ari Two': 'a', Bob: 'b', Bea: 'b' }[name]),
  }).filter((issue) => issue.code === 'slot');
  assert.equal(issues.length, 4);
  assert.equal(issues.find((issue) => issue.player === 'Bob').fix, '!mp move Bob 4');
  assert.equal(issues.find((issue) => issue.player === 'Ari Two').fix, undefined, 'Kein freier Platz, also kein Knopf');
});

test('Bancho schluckt Wiederholungen: Befehle bekommen ein Zufallswort', () => {
  const first = withNonce('!mp settings');
  assert.notEqual(first, withNonce('!mp settings'));
  assert.match(first, /^!mp settings [a-z0-9]*[a-z][a-z0-9]*$/);
  assert.match(withNonce('!mp mods NF HR'), /^!mp mods NF HR \w+$/);
  assert.equal(withNonce('!mp make Cup: (A) vs (B)'), '!mp make Cup: (A) vs (B)');
  assert.equal(withNonce('!mp team Ann red'), '!mp team Ann red');
  assert.equal(withNonce('!mp move Ann 2'), '!mp move Ann 2');
  assert.equal(withNonce('hallo'), 'hallo');
});

test('tournament.cfg: Nur unsere Werte ändern sich', () => {
  const before = 'TeamSize = 4\nacronym = OWC\nBufferTotalTime = 3000\nprivateserver =\n';
  const parsed = parseCfg(renderCfg(before, { teamSize: 2, acronym: 'MDC', height: 1080 }));
  assert.equal(parsed.TeamSize, '2');
  assert.equal(parsed.acronym, 'MDC');
  assert.equal(parsed.Height, '1080');
  assert.equal(parsed.BufferTotalTime, '3000');
  assert.equal(parsed.privateserver, '');
  assert.equal(parseCfg(renderCfg('', { teamSize: 1, acronym: 'A=B\nC', height: 720 })).acronym, 'A B C');
  assert.throws(() => validateHeight(400));
  assert.throws(() => validateHeight('abc'));
  assert.equal(validateHeight('720'), 720);
});

test('osu!tourney einrichten: Ordner, Kopie, Prüfung', async () => {
  const root = mkdtempSync(join(tmpdir(), 'matchdeck-tourney-'));
  const source = join(root, 'osu');
  const folder = join(root, 'tourney');
  const tournament = { teamSize: 3, acronym: 'MDC' };
  await assert.rejects(prepareTourney({ folder, sourceFolder: source, tournament, height: 720 }), /osu!\.exe/);
  await import('node:fs').then(({ mkdirSync }) => mkdirSync(source));
  writeFileSync(join(source, 'osu!.exe'), 'x');

  const status = await prepareTourney({ folder, sourceFolder: source, tournament, height: 720 });
  assert.equal(status.ready, true);
  assert.ok(existsSync(join(folder, 'osu!.exe')));
  assert.match(readFileSync(join(folder, 'tournament.cfg'), 'utf8'), /acronym = MDC/);
  assert.equal((await inspectTourney(folder, { teamSize: 2, acronym: 'MDC' })).ready, false, 'Anderes Turnier passt nicht');

  writeFileSync(join(folder, 'tournament.cfg'), 'TeamSize = 3\nacronym = MDC\nprivateserver = irgendwas\n');
  assert.equal((await inspectTourney(folder, tournament)).ready, false, 'privateserver muss leer sein');
  rmSync(root, { recursive: true, force: true });
});
