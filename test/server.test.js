import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { applyBanchoLine, checkLobby, emptyLobby } from '../server/banchobot.js';
import { BanchoIrc, parseIrcLine } from '../server/irc.js';
import { lastGameFrom, OsuApi } from '../server/osuapi.js';
import { liveFromTosu } from '../server/tosu.js';
import { generateBracket, newTournament, parsePool, parseTeams, seedOrder } from '../shared/tournament.js';

const feed = (lobby, lines) => lines.flatMap((line) => applyBanchoLine(lobby, line));

test('BanchoBot: Lobby-Status aus !mp settings', () => {
  const lobby = emptyLobby(99);
  feed(lobby, [
    'Room name: BSC: (A) vs (B), History: https://osu.ppy.sh/mp/99',
    'Beatmap: https://osu.ppy.sh/b/1234 Artist - Title [Diff]',
    'Team mode: TeamVs, Win condition: ScoreV2',
    'Active mods: Freemod',
    'Players: 2',
    'Slot 1  Not Ready https://osu.ppy.sh/u/10 Some Player    [Team Red  / Hidden, HardRock]',
    'Slot 2  Ready     https://osu.ppy.sh/u/11 Other         [Host / Team Blue]',
  ]);
  assert.equal(lobby.map.id, 1234);
  assert.equal(lobby.freemod, true);
  assert.deepEqual(lobby.slots[1].mods, ['HD', 'HR']);
  assert.equal(lobby.slots[1].team, 'red');
  assert.equal(lobby.slots[2].ready, true);
  assert.equal(lobby.slots[2].team, 'blue');
  assert.deepEqual(lobby.slots[2].mods, []);
  assert.equal(lobby.host, 'Other');
});

test('BanchoBot: kompletter Ablauf einer Map', () => {
  const lobby = emptyLobby(1);
  const events = feed(lobby, [
    'Ann joined in slot 1 for team red.',
    'Bob joined in slot 2 for team blue.',
    'Beatmap changed to: A - T [D] (https://osu.ppy.sh/b/55)',
    'All players are ready',
    'The match has started!',
    'Bob left the game.',
    'Ann finished playing (Score: 12345, PASSED).',
    'The match has finished!',
  ]).map((event) => event.type);
  assert.deepEqual(events, ['joined', 'joined', 'map', 'allReady', 'started', 'left', 'finished']);
  assert.deepEqual(lobby.results, [{ name: 'Ann', score: 12345, passed: true }]);
  assert.deepEqual(lobby.departed, ['Bob']);
  assert.equal(lobby.slots[2], undefined);
});

test('BanchoBot: Created, Timer, Abbruch', () => {
  const lobby = emptyLobby();
  const [created] = applyBanchoLine(lobby, 'Created the tournament match https://osu.ppy.sh/mp/777 BSC: (A) vs (B)');
  assert.equal(created.mpId, 777);
  assert.equal(lobby.channel, '#mp_777');
  applyBanchoLine(lobby, 'Countdown ends in 2 minutes', 1000);
  assert.equal(lobby.countdown.endsAt, 121000);
  applyBanchoLine(lobby, 'Match starts in 10 seconds', 1000);
  assert.equal(lobby.countdown.starts, true);
  applyBanchoLine(lobby, 'The match has started!');
  assert.equal(lobby.countdown, null);
  assert.equal(applyBanchoLine(lobby, 'Aborted the match')[0].type, 'aborted');
});

test('Regelcheck erkennt falsches Team, Fremde, verbotene Mods, falsche Map', () => {
  const lobby = emptyLobby(1);
  lobby.teamMode = 'TeamVs';
  lobby.freemod = true;
  lobby.map = { id: 1 };
  lobby.slots = {
    1: { name: 'Ann', team: 'blue', mods: ['DT'] },
    2: { name: 'Bob', team: 'blue', mods: ['HD'] },
    3: { name: 'Lurker', team: 'red', mods: [] },
  };
  const issues = checkLobby(lobby, {
    config: { teams: { a: { name: 'A' }, b: { name: 'B' } } },
    entry: { slot: 'FM1', mapId: 2 },
    rules: { teamSize: 1, forceNF: true },
    teamOf: (name) => ({ Ann: 'a', Bob: 'b' }[name] ?? null),
  });
  const codes = issues.map((issue) => issue.code).sort();
  assert.deepEqual(codes, ['fremd', 'map', 'mods', 'nf', 'nf', 'team'].sort());
  assert.equal(issues.find((issue) => issue.code === 'team').fix, '!mp team Ann red');
});

test('IRC-Zeilen', () => {
  assert.deepEqual(parseIrcLine(':BanchoBot!cho@ppy.sh PRIVMSG #mp_1 :hello there'), { nick: 'BanchoBot', command: 'PRIVMSG', params: ['#mp_1', 'hello there'] });
  assert.equal(parseIrcLine('PING :cho.ppy.sh').params[0], 'cho.ppy.sh');
});

test('IRC: Anmeldung, Ping, Kanal, Drosselung und Wiederverbinden', async () => {
  const received = [];
  let sockets = 0;
  const server = net.createServer((socket) => {
    sockets++;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        received.push(line);
        if (line.startsWith('USER')) socket.write(':cho 001 test :Welcome\r\nPING :abc\r\n');
        if (line.startsWith('JOIN') && sockets === 1) socket.write(':BanchoBot!c@p PRIVMSG #mp_5 :All players are ready\r\n');
      }
    });
    socket.on('error', () => {});
    if (sockets === 1) setTimeout(() => socket.destroy(), 900);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const irc = new BanchoIrc({ username: 'Some One', password: 'pw', host: '127.0.0.1', port: server.address().port });
  const messages = [];
  irc.on('message', (message) => messages.push(message));
  irc.join('#mp_5');
  irc.connect();
  irc.say('#mp_5', 'eins');
  irc.say('#mp_5', 'zwei');
  await new Promise((resolve) => setTimeout(resolve, 2600));
  irc.stop();
  server.close();
  assert.ok(received.includes('NICK Some_One'));
  assert.ok(received.includes('PONG :abc'));
  assert.equal(messages[0].text, 'All players are ready');
  assert.equal(received.filter((line) => line === 'JOIN #mp_5').length, 2, 'Kanal nach Wiederverbinden neu betreten');
  assert.ok(received.includes('PRIVMSG #mp_5 :eins'));
});

test('API: Token wird wiederverwendet, Spieldaten werden vereinheitlicht', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url.endsWith('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    return { ok: true, json: async () => ({ id: 5, beatmapset_id: 6, version: 'V', difficulty_rating: 6.1, bpm: 180, total_length: 90, cs: 4, ar: 9, accuracy: 8, beatmapset: { title: 'T', artist: 'A', creator: 'C', covers: {} } }) };
  };
  const api = new OsuApi({ clientId: 1, clientSecret: 's', fetcher });
  assert.equal((await api.beatmap(5)).stars, 6.1);
  await api.beatmap(5);
  assert.equal(calls.filter((url) => url.endsWith('/oauth/token')).length, 1);

  const game = lastGameFrom({
    users: [{ id: 1, username: 'Ann' }],
    events: [{ game: { id: 9, end_time: 'x', beatmap_id: 5, scores: [{ user_id: 1, score: 10, accuracy: 0.98, max_combo: 7, statistics: { count_miss: 2 }, match: { pass: true } }] } }, { detail: {} }],
  });
  assert.deepEqual(game.rows[0], { name: 'Ann', score: 10, accuracy: 98, combo: 7, misses: 2, passed: true, mods: [] });
});

test('tosu: Tourney-Abschnitt wird gemappt', () => {
  const live = liveFromTosu({ tourney: { ipcState: 3, chat: [{ name: 'Ann', message: 'gl', team: 'left' }], clients: [
    { ipcId: 0, team: 'left', user: { name: 'Ann' }, play: { playerName: 'Ann', score: 5, accuracy: 99, combo: { current: 3, max: 4 }, hits: { 0: 1 }, mods: { name: 'HD' } } },
    { ipcId: 1, team: 'right', user: { name: 'Bob' }, play: { playerName: '', score: 2 } },
  ] } });
  assert.equal(live.players[0].misses, 1);
  assert.equal(live.players[1].name, 'Bob');
  assert.equal(live.players[1].side, 'b');
  assert.equal(liveFromTosu({ tourney: undefined }), null);
});

test('Bracket: Setzliste, Freilose, Double Elimination, keine Teamgrenze', () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);

  const tournament = newTournament();
  tournament.teams = parseTeams(Array.from({ length: 5 }, (_, i) => `Team ${i + 1} | T${i + 1} | P${i}`).join('\n'));
  const matches = generateBracket(tournament, 'single');
  assert.equal(matches.length, 7);
  const firstRound = matches.filter((match) => match.depth === 0);
  assert.equal(firstRound.filter((match) => match.bye).length, 3);
  assert.equal(matches.find((match) => match.id === 'U2-1').teamA, tournament.teams[0].id, 'Seed 1 rückt per Freilos weiter');

  const large = newTournament();
  large.teams = parseTeams(Array.from({ length: 128 }, (_, i) => `Team ${i}`).join('\n'));
  assert.equal(generateBracket(large, 'single').length, 127);

  const double = newTournament();
  double.teams = parseTeams(Array.from({ length: 8 }, (_, i) => `Team ${i}`).join('\n'));
  const all = generateBracket(double, 'double');
  assert.equal(all.length, 14); // 7 Upper, 6 Lower, Grand Finale
  for (const match of all) {
    for (const link of [match.winnerTo, match.loserTo]) {
      if (link) assert.ok(all.some((entry) => entry.id === link.id), `${match.id} zeigt ins Leere`);
    }
  }
  const incoming = Object.fromEntries(all.map((match) => [match.id, 0]));
  for (const match of all) for (const link of [match.winnerTo, match.loserTo]) if (link) incoming[link.id]++;
  for (const match of all.filter((entry) => entry.depth > 0 || entry.bracket === 'lower')) {
    assert.equal(incoming[match.id], 2, `${match.id} bekommt ${incoming[match.id]} Zuläufe`);
  }
});

test('Einfügen aus Tabellen', () => {
  const teams = parseTeams('Rote Füchse\tRF\tAnn, Ari\t2\n東京 | TKY | 桜');
  assert.equal(teams[0].seed, 2);
  assert.equal(teams[0].players.length, 2);
  assert.equal(teams[1].players[0].name, '桜');
  const pool = parsePool('nm1 | 123\nHD1\thttps://osu.ppy.sh/beatmapsets/1#osu/456');
  assert.deepEqual(pool[1], { slot: 'HD1', mod: 'HD', mapId: 456 });
  assert.throws(() => parsePool('Quatsch'), /nicht lesbar/);
});
