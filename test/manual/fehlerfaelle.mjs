// Läuft gegen einen zweiten Server mit eigenem Datenordner und spielt Fehlerfälle im Demo-Betrieb durch.
import assert from 'node:assert/strict';

const base = process.argv[2];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const post = async (path, body = {}) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: ${data.error}`);
  return data;
};
const state = () => fetch(`${base}/api/state`).then((response) => response.json());
const action = (event) => post('/api/action', event);
async function until(check, label, timeout = 60000) {
  const start = Date.now();
  for (;;) {
    const current = await state();
    if (check(current)) return current;
    if (Date.now() - start > timeout) throw new Error(`Zeitüberschreitung: ${label}`);
    await wait(250);
  }
}
const log = (text) => console.log(`ok  ${text}`);

await post('/api/demo/start');
await post('/api/match/open', { matchId: 'U1-1' });
await post('/api/lobby/make');
await until((s) => Object.keys(s.lobby.slots).length === 4, 'Spieler in Lobby');
log('Lobby erstellt, vier Spieler da');

await post('/api/demo/fault', { kind: 'wrongteam' });
let s = await until((x) => x.issues.some((issue) => issue.code === 'team'), 'Falsches Team erkannt');
const fix = s.issues.find((issue) => issue.code === 'team').fix;
await post('/api/mp', { command: fix });
await until((x) => !x.issues.some((issue) => issue.code === 'team'), 'Team behoben');
log(`Falsches Team erkannt und per Knopf behoben (${fix})`);

await action({ t: 'ROLL', a: 80, b: 20 });
await action({ t: 'FIRST', pick: 'a' });
await action({ t: 'BAN', team: 'b', slot: 'NM1' });
await action({ t: 'BAN', team: 'a', slot: 'NM2' });
let rejected = false;
try { await action({ t: 'PICK', team: 'b', slot: 'NM3' }); } catch { rejected = true; }
assert.ok(rejected);
log('Pick vom falschen Team abgelehnt');

await post('/api/demo/fault', { kind: 'illegalmod' });
await action({ t: 'PICK', team: 'a', slot: 'FM1' });
s = await until((x) => x.issues.some((issue) => issue.code === 'mods'), 'Verbotene Mod erkannt');
log(`Verbotene Mod erkannt: ${s.issues.find((issue) => issue.code === 'mods').text}`);
assert.equal(s.lobby.map.id, 9000011);
assert.equal(s.scene === 'mappool' || s.scene === 'gameplay', true);

await post('/api/mp', { command: '!mp start 1' });
await until((x) => x.match.state.phase === 'playing', 'Spiel gestartet');
await wait(3000);
await post('/api/demo/fault', { kind: 'dc' });
s = await until((x) => x.alerts.some((item) => item.action?.command === '!mp abort'), 'DC-Meldung');
const lost = s.stage.slots.filter((slot) => slot.cut).length;
assert.equal(lost, 1);
log('DC gemeldet, nur ein Feld getrennt, der Rest läuft weiter');
s = await until((x) => x.match.state.phase === 'result', 'Ergebnis nach DC');
assert.equal(s.match.state.games[0].result.rows.length, 3);
await wait(7000);
s = await state();
assert.equal(s.match.state.phase, 'result', 'Mit DC darf nichts automatisch gewertet werden');
log('Ergebnis nach DC bleibt zur Prüfung stehen');
await action({ t: 'CONFIRM' });

await post('/api/demo/fault', { kind: 'mismatch' });
const pickTeam = (await state()).match.state.step.team;
await action({ t: 'PICK', team: pickTeam, slot: 'HD1' });
await wait(4000);
await post('/api/mp', { command: '!mp start 1' });
await until((x) => x.match.state.phase === 'playing', 'Zweite Map gestartet');
await wait(2500);
await action({ t: 'ABORT', team: 'b', reason: 'Test' });
await post('/api/mp', { command: '!mp abort' });
s = await until((x) => x.match.state.phase === 'ready' && x.stage === null, 'Abort');
assert.equal(s.match.state.aborts.b, 1);
log('Abort zählt fürs Team, Pick bleibt, Bühne leer');

await wait(3000);
await post('/api/mp', { command: '!mp start 1' });
await until((x) => x.match.state.phase === 'playing', 'Rematch gestartet');
s = await until((x) => x.match.state.phase === 'result', 'Ergebnis Rematch');
assert.ok(s.match.state.games.at(-1).attempts === 2);
await wait(1000);
s = await state();
const warned = s.alerts.some((item) => /weichen ab/.test(item.text));
assert.ok(warned, 'Score-Widerspruch fehlt');
log('Score-Widerspruch zwischen IRC und API gemeldet');
assert.equal(s.match.state.phase, 'result');
await action({ t: 'UNDO' });
s = await state();
assert.equal(s.match.state.phase, 'playing');
await action({ t: 'REDO' });
await action({ t: 'CONFIRM' });
s = await state();
log(`Stand: ${s.match.state.points.a}:${s.match.state.points.b}`);
console.log('ALLES GRÜN');
process.exit(0);
