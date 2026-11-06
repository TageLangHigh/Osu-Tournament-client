// Absturztest: Server hart beenden, halbe Logzeile anhängen, neu starten, Zustand vergleichen.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 7272;
const base = `http://127.0.0.1:${port}`;
const data = mkdtempSync(join(tmpdir(), 'matchdeck-crash-'));
const env = { ...process.env, MATCHDECK_PORT: String(port), MATCHDECK_DATA: data };
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const boot = async () => {
  const child = spawn('node', ['server/index.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/state`); return child; } catch { await wait(100); }
  }
  throw new Error('Server startet nicht');
};
const post = async (path, body = {}) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.ok(response.ok, result.error);
  return result;
};
const state = () => fetch(`${base}/api/state`).then((response) => response.json());

let child = await boot();
await post('/api/tournament/new', { name: 'Absturz Cup', acronym: 'AC' });
await post('/api/tournament/update', { teamsText: 'Rot | R | Ann\nBlau | B | Bob' });
const first = await state();
const roundId = first.tournament.rounds[0].id;
await post('/api/round/save', { id: roundId, poolText: 'NM1 | 11\nNM2 | 22\nHD1 | 33\nHR1 | 44\nTB | 99' });
const { teams } = (await state()).tournament;
await post('/api/match/quick', { teamA: teams[0].id, teamB: teams[1].id, roundId });
for (const event of [{ t: 'ROLL', a: 9, b: 2 }, { t: 'FIRST', pick: 'a' }, { t: 'BAN', team: 'b', slot: 'NM1' }, { t: 'BAN', team: 'a', slot: 'NM2' }, { t: 'PICK', team: 'a', slot: 'HD1' }]) {
  await post('/api/action', event);
}
const before = await state();
child.kill('SIGKILL');
await wait(300);
const matchDir = join(data, 'tournaments', before.tournament.id, 'matches');
appendFileSync(join(matchDir, readdirSync(matchDir)[0]), '{"t":"START","at":12');

child = await boot();
const after = await state();
assert.equal(after.match?.id, before.match.id, 'Match wurde nicht wieder geöffnet');
assert.deepEqual(after.match.state.bans, before.match.state.bans);
assert.deepEqual(after.match.state.picks, before.match.state.picks);
assert.equal(after.match.state.phase, 'ready');
assert.equal(after.scene, 'gameplay');

const secret = 'geheim-12345';
await post('/api/connect/api', { clientId: '1', clientSecret: secret });
const text = await fetch(`${base}/api/state`).then((response) => response.text());
assert.ok(!text.includes(secret), 'Secret im Status');

const foreign = await fetch(`${base}/api/scene`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://boese.example' }, body: '{}' });
assert.equal(foreign.status, 403);
const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
assert.notEqual(traversal.status, 200);
const skinEscape = await fetch(`${base}/shared/..%2f..%2f..%2fpackage.json`);
assert.notEqual(skinEscape.status, 200);
child.kill('SIGKILL');
console.log('Absturz ok: Match wiederhergestellt, halbe Zeile verworfen. Secret bleibt privat, fremde Seiten geblockt.');
process.exit(0);
