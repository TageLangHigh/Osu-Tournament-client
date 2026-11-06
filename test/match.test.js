import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandsForPick, MatchError, replayMatch, sceneFor, scoreGame, validateEvent, roomName } from '../shared/match.js';

const pool = ['NM1', 'NM2', 'NM3', 'HD1', 'HR1', 'DT1', 'FM1'].map((slot, i) => ({ slot, mod: slot.slice(0, 2), mapId: 100 + i }));
pool.push({ slot: 'TB', mod: 'TB', mapId: 999 });
const config = (rules = {}) => ({
  rules: { bestOf: 5, bans: 1, ...rules },
  pool,
  teams: {
    a: { name: 'Alpha', players: [{ name: 'Ann' }, { name: 'Ari Two' }] },
    b: { name: 'Beta', players: [{ name: 'Bob' }, { name: 'Bea' }] },
  },
});

const opening = [
  { t: 'ROLL', a: 90, b: 12 },
  { t: 'FIRST', pick: 'a', ban: 'b' },
  { t: 'BAN', team: 'b', slot: 'NM1' },
  { t: 'BAN', team: 'a', slot: 'HR1' },
];
const win = (team, slot, scoreA, scoreB) => [
  { t: 'PICK', team, slot },
  { t: 'START' },
  { t: 'RESULT', scores: [{ name: 'Ann', score: scoreA, passed: true }, { name: 'Bob', score: scoreB, passed: true }] },
  { t: 'CONFIRM' },
];

test('Reihenfolge: Roll, Bans, abwechselnde Picks', () => {
  const state = replayMatch(config(), opening);
  assert.deepEqual(state.step, { kind: 'pick', team: 'a' });
  assert.equal(state.phase, 'draft');
  assert.ok(!state.available.includes('NM1'));
  assert.ok(!state.available.includes('TB'));
});

test('Falsches Team und verbrauchte Maps werden abgelehnt', () => {
  assert.throws(() => validateEvent(config(), opening, { t: 'PICK', team: 'b', slot: 'NM2' }), MatchError);
  assert.throws(() => validateEvent(config(), opening, { t: 'PICK', team: 'a', slot: 'NM1' }), MatchError);
  assert.throws(() => validateEvent(config(), opening, { t: 'PICK', team: 'a', slot: 'XX9' }), MatchError);
});

test('Geschützte Maps können nicht gebannt werden', () => {
  const cfg = config({ protects: 1 });
  const events = [opening[0], opening[1], { t: 'PROTECT', team: 'b', slot: 'NM1' }, { t: 'PROTECT', team: 'a', slot: 'NM2' }];
  assert.equal(replayMatch(cfg, events).step.kind, 'ban');
  assert.throws(() => validateEvent(cfg, events, { t: 'BAN', team: 'b', slot: 'NM2' }), MatchError);
});

test('Tiebreaker wird automatisch erzwungen und das Match endet', () => {
  const events = [...opening,
    ...win('a', 'NM2', 900, 100), ...win('b', 'HD1', 100, 900),
    ...win('a', 'NM3', 900, 100), ...win('b', 'DT1', 100, 900)];
  const state = replayMatch(config(), events);
  assert.deepEqual(state.points, { a: 2, b: 2 });
  assert.deepEqual(state.step, { kind: 'pick', team: null, forced: 'TB' });
  const done = replayMatch(config(), [...events, ...win(null, 'TB', 700, 100)]);
  assert.equal(done.winner, 'a');
  assert.equal(done.phase, 'finished');
  assert.equal(sceneFor(done), 'winner');
});

test('Undo und Redo stellen den Zustand exakt wieder her', () => {
  const events = [...opening, { t: 'PICK', team: 'a', slot: 'NM2' }];
  const before = replayMatch(config(), events);
  const undone = replayMatch(config(), [...events, { t: 'UNDO' }]);
  assert.equal(undone.picks.length, 0);
  assert.equal(undone.canRedo, true);
  const redone = replayMatch(config(), [...events, { t: 'UNDO' }, { t: 'REDO' }]);
  assert.deepEqual(redone.picks, before.picks);
});

test('Issue 24857: Bans wechseln die Szene nie auf Gameplay', () => {
  for (let i = 3; i <= opening.length; i++) assert.equal(sceneFor(replayMatch(config(), opening.slice(0, i))), 'mappool');
  assert.equal(sceneFor(replayMatch(config(), [...opening, { t: 'PICK', team: 'a', slot: 'NM2' }])), 'gameplay');
});

test('Rematch: Abort hält Pick, zählt Team-Abort und löscht Wertung', () => {
  const events = [...opening, { t: 'PICK', team: 'a', slot: 'NM2' }, { t: 'START' }, { t: 'ABORT', team: 'b', reason: 'DC' }];
  const state = replayMatch(config(), events);
  assert.equal(state.step.kind, 'start');
  assert.equal(state.aborts.b, 1);
  assert.equal(replayMatch(config(), [...events, { t: 'START' }]).games[0].attempts, 2);
});

test('Punktkorrektur braucht Begründung', () => {
  assert.throws(() => validateEvent(config(), [], { t: 'ADJUST', team: 'a', delta: 1 }), MatchError);
  assert.equal(replayMatch(config(), [{ t: 'ADJUST', team: 'a', delta: 1, reason: 'Nichtantritt' }]).points.a, 1);
});

test('Issue 1227: Nur Spieler dieser Map zählen, Fremde nie', () => {
  const cfg = config();
  const result = scoreGame([
    { name: 'Ann', score: 500, passed: true },
    { name: 'ari_two', score: 400, passed: true },
    { name: 'Bob', score: 800, passed: true },
    { name: 'Lurker', score: 999999, passed: true },
  ], cfg.rules, cfg);
  assert.deepEqual(result.totals, { a: 900, b: 800 });
  assert.equal(result.winner, 'a');
  assert.equal(result.warnings.length, 1);
});

test('Siegbedingungen: Accuracy im Schnitt, Misses wenig gewinnt, Fails optional', () => {
  const cfg = config();
  const rows = [
    { name: 'Ann', accuracy: 98, misses: 4, score: 1, passed: true },
    { name: 'Ari Two', accuracy: 90, misses: 4, score: 1, passed: true },
    { name: 'Bob', accuracy: 95, misses: 3, score: 5, passed: false },
  ];
  assert.equal(scoreGame(rows, { winCondition: 'accuracy', countFailed: true }, cfg).winner, 'b');
  assert.equal(scoreGame(rows, { winCondition: 'misses', countFailed: true }, cfg).winner, 'b');
  assert.equal(scoreGame(rows, { winCondition: 'score', countFailed: false }, cfg).winner, 'a');
});

test('Gleichstand braucht eine Entscheidung', () => {
  const events = [...opening, { t: 'PICK', team: 'a', slot: 'NM2' }, { t: 'START' },
    { t: 'RESULT', scores: [{ name: 'Ann', score: 5, passed: true }, { name: 'Bob', score: 5, passed: true }] }];
  assert.throws(() => validateEvent(config(), events, { t: 'CONFIRM' }), MatchError);
  assert.equal(validateEvent(config(), events, { t: 'CONFIRM', winner: 'b' }).points.b, 1);
});

test('Lobby-Befehle je Mod', () => {
  const rules = { forceNF: true, readyTimer: 120 };
  assert.deepEqual(commandsForPick({ mapId: 5, mod: 'HR' }, rules), ['!mp map 5 0', '!mp mods NF HR', '!mp timer 120']);
  assert.deepEqual(commandsForPick({ mapId: 5, mod: 'FM' }, rules), ['!mp map 5 0', '!mp mods Freemod', '!mp timer 120']);
  assert.deepEqual(commandsForPick({ mapId: 5, mod: 'NM' }, { readyTimer: 0 }), ['!mp map 5 0', '!mp mods None']);
  assert.equal(roomName({ acronym: 'BSC' }, 'A', 'B'), 'BSC: (A) vs (B)');
});
