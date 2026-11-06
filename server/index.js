// Matchdeck: Ein Prozess für Regie, Overlay und Spectate. Keine Fremdpakete.

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLobby, applyBanchoLine, emptyLobby } from './banchobot.js';
import { DemoBancho, demoTournament } from './demo.js';
import { md5, parseReplay, readZip } from './files.js';
import { BanchoIrc } from './irc.js';
import { OsuApi } from './osuapi.js';
import { mergeResults } from './results.js';
import { activeSkinName, findOsuFolder, listSkins, loadSkin } from './skin.js';
import { Stage } from './stage.js';
import { dataPath, matchLog, readJson, safeId, secretStore, settingsStore, tournamentStore, writeJson } from './store.js';
import { TosuLink } from './tosu.js';
import { defaultTourneyFolder, inspectTourney, launchTourney, prepareTourney } from './tourney.js';
import { MODS, parseOsu, prepareMap } from '../shared/beatmap.js';
import { judge } from '../shared/judge.js';
import { commandsForPick, MatchError, replayMatch, roomName, sceneFor, teamOfPlayer, validateEvent } from '../shared/match.js';
import { advance, formatPool, formatTeams, generateBracket, newTournament, parsePool, parseTeams } from '../shared/tournament.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MATCHDECK_PORT ?? 7270);
const HOST = process.env.MATCHDECK_HOST ?? '127.0.0.1';
const PICK_HOLD_MS = 4500; // So lange bleibt der Pick im Mappool sichtbar.
const MAX_UPLOAD = 300 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;

const defaultSettings = {
  activeTournament: null,
  activeMatch: null,
  autoSend: true,
  autoStart: false,
  autoConfirm: true,
  gameplaySource: 'builtin',
  ircUser: '',
};

const rt = {
  settings: { ...defaultSettings, ...settingsStore.load() },
  secrets: secretStore.load(),
  tournament: null,
  match: null,
  lobby: emptyLobby(),
  chat: [],
  commands: [],
  bancho: null,
  api: null,
  demo: false,
  tosu: new TosuLink(),
  stage: new Stage(),
  ircStatus: 'getrennt',
  apiStatus: 'nicht eingerichtet',
  live: null,
  liveTosu: null,
  scene: 'intro',
  scenePin: null,
  sceneHold: null,
  alerts: [],
  issues: [],
  memoryMaps: new Map(),
};

const clients = new Set();

function send(client, event, data) {
  client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const broadcast = (event, data) => {
  for (const client of clients) send(client, event, data);
};

let snapshotQueued = false;
function pushState() {
  if (snapshotQueued) return;
  snapshotQueued = true;
  setTimeout(() => {
    snapshotQueued = false;
    broadcast('state', snapshot());
  }, 40);
}

function matchTitle() {
  const { match } = rt;
  return match ? `${match.config.teams.a.name} gegen ${match.config.teams.b.name}` : '';
}

function snapshot() {
  const { match, tournament } = rt;
  return {
    now: Date.now(),
    tournaments: tournamentStore.list(),
    tournament,
    teamsText: tournament ? formatTeams(tournament.teams) : '',
    poolTexts: tournament ? Object.fromEntries(tournament.rounds.map((round) => [round.id, formatPool(round.pool)])) : {},
    match: match && {
      id: match.id,
      title: matchTitle(),
      round: match.roundName,
      config: match.config,
      state: match.state,
      log: match.events.slice(-60),
    },
    lobby: rt.lobby,
    issues: rt.issues,
    alerts: rt.alerts.slice(-6),
    scene: rt.scene,
    scenePin: rt.scenePin,
    chat: rt.chat.slice(-120),
    commands: rt.commands.slice(-24),
    conn: { irc: rt.ircStatus, api: rt.apiStatus, tosu: rt.tosu.status, demo: rt.demo, hasIrcPassword: Boolean(rt.secrets.ircPassword), hasApiSecret: Boolean(rt.secrets.apiSecret), apiClientId: rt.secrets.apiClientId ?? '' },
    settings: { autoSend: rt.settings.autoSend, autoStart: rt.settings.autoStart, autoConfirm: rt.settings.autoConfirm, gameplaySource: rt.settings.gameplaySource, ircUser: rt.settings.ircUser },
    stage: rt.stage.describe(),
    skin: rt.skin,
    skins: rt.skins,
    tourney: rt.tourney ?? null,
    replays: listReplays(),
    overlayViewers: [...clients].filter((client) => client.kind === 'overlay').length,
  };
}

function alert(level, text, action = null) {
  rt.alerts.push({ id: randomUUID(), level, text, action, at: Date.now() });
  pushState();
}

const saveSettings = () => settingsStore.save(rt.settings);

function refreshSkin() {
  rt.osuFolder = findOsuFolder(rt.settings.osuFolder);
  rt.skins = listSkins(rt.osuFolder);
  const wanted = rt.settings.skinName ?? activeSkinName(rt.osuFolder) ?? rt.skins[0];
  const name = rt.skins.includes(wanted) ? wanted : rt.skins[0];
  rt.skin = name ? loadSkin(rt.osuFolder, name) : null;
}

function updateScene() {
  if (rt.scenePin) {
    rt.scene = rt.scenePin;
  } else if (rt.match) {
    if (rt.sceneHold && Date.now() < rt.sceneHold) rt.scene = 'mappool';
    else rt.scene = sceneFor(rt.match.state);
  }
  pushState();
}

/* ------------------------------- Match ------------------------------- */

function teamById(id) {
  return rt.tournament?.teams.find((team) => team.id === id);
}

function configFor(tournament, roundId, teamA, teamB) {
  const round = tournament.rounds.find((entry) => entry.id === roundId) ?? tournament.rounds[0];
  return {
    roundName: round.name,
    config: {
      rules: { ...round.rules, teamSize: tournament.teamSize },
      pool: round.pool,
      teams: {
        a: { id: teamA.id, name: teamA.name, acronym: teamA.acronym, players: teamA.players },
        b: { id: teamB.id, name: teamB.name, acronym: teamB.acronym, players: teamB.players },
      },
    },
  };
}

function refreshIssues() {
  if (!rt.match) {
    rt.issues = [];
    return;
  }
  const { config, state } = rt.match;
  const slot = state.games.at(-1)?.status === 'pending' ? state.games.at(-1).slot : null;
  const entry = config.pool.find((item) => item.slot === slot) ?? null;
  rt.issues = checkLobby(rt.lobby, { config, entry, rules: config.rules, teamOf: (name) => teamOfPlayer(config, name) });
}

function openMatch(entry) {
  const teamA = teamById(entry.teamA);
  const teamB = teamById(entry.teamB);
  if (!teamA || !teamB) throw new MatchError('Für dieses Match stehen noch nicht beide Teams fest');
  const { config, roundName } = configFor(rt.tournament, entry.roundId, teamA, teamB);
  const events = matchLog.read(rt.tournament.id, entry.id);
  rt.match = { id: entry.id, config, roundName, events, state: replayMatch(config, events) };
  rt.settings.activeMatch = entry.id;
  rt.lobby = entry.mpId ? { ...emptyLobby(entry.mpId) } : emptyLobby();
  rt.scenePin = null;
  rt.sceneHold = null;
  rt.alerts = [];
  rt.chat = [];
  saveSettings();
  if (rt.demo) rt.bancho.seat(teamA, teamB);
  if (entry.mpId) attachLobby(entry.mpId);
  refreshIssues();
  updateScene();
}

function persistTournament() {
  tournamentStore.save(rt.tournament);
}

function applyMatchEvent(event, by = 'regie') {
  if (!rt.match) throw new MatchError('Kein Match geöffnet');
  const stamped = { ...event, at: Date.now(), by };
  const { config, events, id } = rt.match;
  const next = validateEvent(config, events, stamped);
  matchLog.append(rt.tournament.id, id, stamped);
  events.push(stamped);
  rt.match.state = next;
  afterEvent(stamped);
  refreshIssues();
  updateScene();
  return next;
}

function afterEvent(event) {
  const { config, state } = rt.match;
  if (event.t === 'PICK') {
    rt.sceneHold = Date.now() + PICK_HOLD_MS;
    setTimeout(updateScene, PICK_HOLD_MS + 20);
    const entry = config.pool.find((item) => item.slot === event.slot);
    if (rt.settings.autoSend && rt.lobby.channel) {
      for (const command of commandsForPick(entry, config.rules, rt.tournament.gameMode)) sendLobby(command);
    }
  }
  if (event.t === 'CONFIRM' && state.winner) finishBracketMatch();
}

function finishBracketMatch() {
  const { state, config, id } = rt.match;
  const entry = rt.tournament.matches.find((item) => item.id === id);
  if (!entry) return;
  const winner = config.teams[state.winner].id;
  const loser = config.teams[state.winner === 'a' ? 'b' : 'a'].id;
  entry.result = { points: state.points };
  advance(rt.tournament.matches, entry, winner, loser);
  persistTournament();
}

function reopenBracketEntry() {
  // Nach Undo eines Match-Endes muss die Turnieransicht wieder stimmen.
  const entry = rt.tournament?.matches.find((item) => item.id === rt.match?.id);
  if (!entry?.result?.winner || rt.match.state.winner) return;
  const clear = (link) => {
    const target = rt.tournament.matches.find((item) => item.id === link?.id);
    if (target) target[link.side === 'a' ? 'teamA' : 'teamB'] = null;
  };
  clear(entry.winnerTo);
  clear(entry.loserTo);
  delete entry.result;
  persistTournament();
}

/* ------------------------------- Lobby ------------------------------- */

function logCommand(text, status) {
  rt.commands.push({ id: randomUUID(), text, status, at: Date.now() });
  pushState();
}

function sendLobby(text) {
  if (!rt.bancho || !rt.lobby.channel) throw new MatchError('Keine Lobby verbunden');
  rt.bancho.say(rt.lobby.channel, text);
  logCommand(text, 'gesendet');
}

function attachLobby(mpId) {
  rt.lobby = { ...emptyLobby(mpId) };
  rt.bancho?.join(rt.lobby.channel);
  const entry = rt.tournament?.matches.find((item) => item.id === rt.match?.id);
  if (entry) {
    entry.mpId = mpId;
    persistTournament();
  }
  if (rt.bancho) sendLobby('!mp settings');
}

function makeLobby() {
  if (!rt.bancho) throw new MatchError('Erst mit Bancho verbinden oder den Demo-Betrieb starten');
  if (!rt.match) throw new MatchError('Erst ein Match öffnen');
  const { teams } = rt.match.config;
  const name = roomName(rt.tournament, teams.a.name, teams.b.name);
  rt.bancho.say('BanchoBot', `!mp make ${name}`);
  logCommand(`!mp make ${name}`, 'gesendet');
}

const scoreModeFor = { score: 3, accuracy: 1, combo: 2, misses: 3 };

function onLobbyCreated() {
  const { config } = rt.match;
  rt.bancho.join(rt.lobby.channel);
  const entry = rt.tournament.matches.find((item) => item.id === rt.match.id);
  if (entry) {
    entry.mpId = rt.lobby.mpId;
    persistTournament();
  }
  sendLobby(`!mp set 2 ${scoreModeFor[config.rules.winCondition] ?? 3} ${config.rules.teamSize * 2}`);
  sendLobby('!mp lock');
  for (const team of [config.teams.a, config.teams.b]) {
    for (const player of team.players) sendLobby(`!mp invite ${player.name.replaceAll(' ', '_')}`);
  }
  sendLobby('!mp settings'); // Ohne das kennt der Regelcheck den Team-Modus nicht.
}

async function collectResults(irc, departed) {
  if (!rt.match || rt.match.state.phase !== 'playing') return;
  const source = rt.demo ? rt.bancho : rt.api;
  let api = null;
  if (source && rt.lobby.mpId) {
    // Die API braucht nach Kartenende oft ein paar Sekunden.
    for (let attempt = 0; attempt < 6 && !api; attempt++) {
      try {
        const game = await source.lastGame(rt.lobby.mpId);
        if (game?.rows?.length && game.id !== rt.lastGameId) {
          rt.lastGameId = game.id;
          api = game.rows;
        }
      } catch (error) {
        rt.apiStatus = `Fehler: ${error.message}`;
      }
      if (!api) await new Promise((done) => setTimeout(done, 1500));
    }
  }
  const merged = mergeResults({ irc, api, live: rt.liveTosu?.players ?? null, departed });
  if (!merged.rows.length) {
    alert('error', 'Keine Ergebnisse angekommen. Bitte von Hand eintragen oder Rematch.');
    return;
  }
  const state = applyMatchEvent({ t: 'RESULT', scores: merged.rows, source: merged.sources.join(' + '), warnings: merged.warnings }, 'auto');
  const game = state.games.at(-1);
  const problems = [...merged.warnings, ...game.result.warnings];
  for (const text of problems) alert('warn', text);
  if (game.result.tie) {
    alert('error', 'Gleichstand: Bitte Gewinner wählen oder Rematch ansetzen.');
  } else if (rt.settings.autoConfirm && !problems.length) {
    setTimeout(() => {
      if (rt.match?.state.step.kind === 'confirm') applyMatchEvent({ t: 'CONFIRM' }, 'auto');
    }, 6000);
  }
}

function handleLobbyEvent(event) {
  const phase = rt.match?.state.phase;
  switch (event.type) {
    case 'created':
      if (rt.match) onLobbyCreated();
      break;
    case 'allReady': {
      sendLobby('!mp settings');
      if (rt.settings.autoStart && phase === 'ready') {
        setTimeout(() => {
          refreshIssues();
          if (rt.issues.some((issue) => issue.level === 'error')) {
            alert('warn', 'Autostart angehalten: Regelcheck meldet Probleme.');
          } else sendLobby(`!mp start ${rt.match.config.rules.startTimer}`);
        }, 1500);
      }
      break;
    }
    case 'started':
      if (phase === 'ready') applyMatchEvent({ t: 'START' }, 'auto');
      break;
    case 'aborted':
      if (phase === 'playing') applyMatchEvent({ t: 'ABORT', reason: 'Lobby-Abbruch' }, 'auto');
      break;
    case 'left':
      if (event.duringPlay) {
        alert('error', `${event.name} hat die Map verlassen.`, { label: 'Map abbrechen', command: '!mp abort' });
      }
      break;
    case 'finished':
      collectResults(event.results, event.departed);
      break;
    case 'closed':
      alert('warn', 'Die Lobby wurde geschlossen.');
      break;
    case 'problem':
      alert('error', `BanchoBot: ${event.text}`);
      break;
    case 'roll': {
      if (rt.match?.state.step.kind !== 'roll') break;
      const team = teamOfPlayer(rt.match.config, event.name);
      if (!team) break;
      rt.rolls = { ...rt.rolls, [team]: rt.rolls?.[team] ?? event.value };
      if (rt.rolls.a !== undefined && rt.rolls.b !== undefined) {
        if (rt.rolls.a === rt.rolls.b) alert('warn', 'Roll ist gleich, bitte neu würfeln.');
        else applyMatchEvent({ t: 'ROLL', ...rt.rolls }, 'auto');
        rt.rolls = {};
      }
      break;
    }
    default:
  }
}

function onBanchoMessage({ from, target, text }) {
  const isLobby = target === rt.lobby.channel;
  const isPrivateBot = from === 'BanchoBot' && !target.startsWith('#');
  if (from === 'BanchoBot' && (isLobby || isPrivateBot)) {
    const events = applyBanchoLine(rt.lobby, text);
    refreshIssues();
    for (const event of events) {
      try {
        handleLobbyEvent(event);
      } catch (error) {
        alert('error', error.message);
      }
    }
  }
  if (isLobby || isPrivateBot) {
    rt.chat.push({ from, text, at: Date.now() });
    pushState();
  }
}

function wireBancho(client) {
  client.on('message', onBanchoMessage);
  client.on('status', (status, detail) => {
    rt.ircStatus = detail ? `${status} (${detail})` : status;
    pushState();
  });
  client.on('problem', (message) => alert('warn', `IRC: ${message}`));
  client.on('noChannel', (channel) => alert('error', `Lobby ${channel} gibt es nicht mehr.`));
}

function connectIrc() {
  const username = rt.settings.ircUser;
  const password = rt.secrets.ircPassword;
  if (!username || !password) throw new MatchError('IRC-Name und Passwort fehlen');
  rt.bancho?.stop();
  rt.demo = false;
  rt.bancho = new BanchoIrc({ username, password });
  wireBancho(rt.bancho);
  if (rt.lobby.channel) rt.bancho.join(rt.lobby.channel);
  rt.bancho.connect();
}

function setupApi() {
  const { apiClientId, apiSecret } = rt.secrets;
  if (!apiClientId || !apiSecret) return;
  rt.api = new OsuApi({ clientId: apiClientId, clientSecret: apiSecret });
  rt.apiStatus = 'bereit';
}

function startDemo() {
  rt.bancho?.stop();
  const tournament = demoTournament();
  tournamentStore.save(tournament);
  rt.settings.activeTournament = tournament.id;
  rt.settings.activeMatch = null;
  rt.settings.gameplaySource = 'builtin';
  saveSettings();
  rt.tournament = tournament;
  rt.match = null;
  rt.lobby = emptyLobby();
  rt.demo = true;
  rt.stage.stop();
  rt.bancho = new DemoBancho({ tournament, stage: rt.stage });
  wireBancho(rt.bancho);
  rt.ircStatus = 'Demo-Lobby';
  rt.apiStatus = 'Demo-Daten';
  for (const match of tournament.matches) matchLog.clear(tournament.id, match.id);
  updateScene();
}

/* ------------------------------ Bibliothek --------------------------- */

const REPLAY_DIR = dataPath('replays');
const MAP_DIR = dataPath('maps');
const MEDIA_DIR = dataPath('media');

function storeMap(text, entries, folderHash) {
  const hash = md5(text);
  const map = { ...parseOsu(text.toString('utf8')), hash };
  if (map.mode !== 0) return null;
  const media = {};
  const find = (name) => name && [...entries.keys()].find((key) => key.toLowerCase() === name.toLowerCase());
  for (const [kind, name] of [['audio', map.audioFile], ['background', map.background]]) {
    const key = find(name);
    if (!key) continue;
    const file = `${kind}${extname(key).toLowerCase()}`;
    const target = join(MEDIA_DIR, folderHash, file);
    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, entries.get(key).read());
    }
    media[kind] = `/media/${folderHash}/${file}`;
  }
  writeJson(join(MAP_DIR, `${hash}.json`), { ...map, media });
  return { hash, title: `${map.artist} - ${map.title} [${map.version}]` };
}

function loadMap(hash) {
  if (hash.startsWith('demo-')) {
    return rt.demo ? rt.bancho.mapFor(Number(hash.slice(5))) : null;
  }
  return readJson(join(MAP_DIR, `${safeId(hash)}.json`));
}

function listReplays() {
  if (!existsSync(REPLAY_DIR)) return [];
  return readdirSync(REPLAY_DIR).filter((name) => name.endsWith('.meta.json')).map((name) => readJson(join(REPLAY_DIR, name))).filter(Boolean);
}

function importFile(name, buffer) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.osz')) {
    const entries = readZip(buffer);
    const folderHash = md5(buffer);
    const maps = [];
    for (const [entryName, entry] of entries) {
      if (entryName.endsWith('.osu')) {
        const stored = storeMap(entry.read(), entries, folderHash);
        if (stored) maps.push(stored);
      }
    }
    if (!maps.length) throw new MatchError('In dieser .osz liegt keine osu!standard-Map');
    return { kind: 'maps', maps };
  }
  if (lower.endsWith('.osr')) {
    const replay = parseReplay(buffer);
    if (replay.mode !== 0) throw new MatchError('Replays werden bisher nur für osu!standard dargestellt');
    if (!replay.frames.length) throw new MatchError('Dieses Replay enthält keine Bewegungsdaten');
    const id = md5(buffer);
    const { counts } = replay;
    const total = counts.c300 + counts.c100 + counts.c50 + counts.miss;
    const meta = {
      id, player: replay.player, beatmapHash: replay.beatmapHash, mods: replay.mods, score: replay.score,
      maxCombo: replay.maxCombo, accuracy: total ? ((counts.c300 * 300 + counts.c100 * 100 + counts.c50 * 50) / (total * 300)) * 100 : 0,
      miss: counts.miss, playedAt: replay.playedAt, hasMap: existsSync(join(MAP_DIR, `${replay.beatmapHash}.json`)),
    };
    writeJson(join(REPLAY_DIR, `${id}.meta.json`), meta);
    writeJson(join(REPLAY_DIR, `${id}.frames.json`), replay.frames);
    return { kind: 'replay', replay: meta };
  }
  throw new MatchError('Bitte eine .osz oder .osr wählen');
}

function startTheater(ids) {
  const replays = ids.map((id) => ({ meta: readJson(join(REPLAY_DIR, `${safeId(id)}.meta.json`)), frames: readJson(join(REPLAY_DIR, `${safeId(id)}.frames.json`)) }));
  if (!replays.length || replays.some((replay) => !replay.meta)) throw new MatchError('Replay nicht gefunden');
  const { beatmapHash } = replays[0].meta;
  if (replays.some((replay) => replay.meta.beatmapHash !== beatmapHash)) throw new MatchError('Alle Replays müssen zur selben Map gehören');
  const map = loadMap(beatmapHash);
  if (!map) throw new MatchError('Die passende .osz wurde noch nicht importiert');
  const speed = replays[0].meta.mods & (MODS.DT | MODS.NC | MODS.HT);
  if (replays.some((replay) => (replay.meta.mods & (MODS.DT | MODS.NC | MODS.HT)) !== speed)) {
    throw new MatchError('Replays mit unterschiedlichem Tempo lassen sich nicht synchron zeigen');
  }
  const slots = replays.map(({ meta, frames }, index) => {
    const prepared = prepareMap(map, meta.mods);
    const { marks, timeline } = judge(prepared, frames);
    return { name: meta.player, team: index % 2 ? 'blue' : 'red', side: index % 2 ? 'b' : 'a', frames, marks, timeline, mods: meta.mods };
  });
  const prepared = prepareMap(map, replays[0].meta.mods);
  rt.stage.load({
    hash: map.hash, mods: replays[0].meta.mods, rate: prepared.rate, length: map.length,
    firstObject: Math.max(0, (map.objects[0]?.t ?? 0) - 2500), slots,
    audio: map.media?.audio ?? null, title: `${map.artist} - ${map.title} [${map.version}]`,
  });
  rt.scenePin = 'gameplay';
  updateScene();
}

/* ------------------------------- Turnier ----------------------------- */

function activateTournament(id) {
  const tournament = tournamentStore.load(id);
  if (!tournament) throw new MatchError('Turnier nicht gefunden');
  rt.tournament = tournament;
  rt.match = null;
  rt.lobby = emptyLobby();
  rt.settings.activeTournament = id;
  rt.settings.activeMatch = null;
  saveSettings();
  if (rt.demo && id !== 'demo') {
    rt.bancho.stop();
    rt.bancho = null;
    rt.demo = false;
    rt.ircStatus = 'getrennt';
    rt.apiStatus = rt.api ? 'bereit' : 'nicht eingerichtet';
  }
  rt.scenePin = null;
  rt.scene = 'intro';
  pushState();
}

function requireTournament() {
  if (!rt.tournament) throw new MatchError('Erst ein Turnier anlegen oder wählen');
  return rt.tournament;
}

async function enrichPool(round) {
  const source = rt.demo ? rt.bancho : rt.api;
  if (!source) throw new MatchError('Dafür braucht es die osu!-API (Verbindungen)');
  let failed = 0;
  for (const entry of round.pool) {
    try {
      const data = await source.beatmap(entry.mapId);
      if (data) Object.assign(entry, data, { slot: entry.slot, mod: entry.mod });
    } catch {
      failed++;
    }
  }
  persistTournament();
  return { failed };
}

/* -------------------------------- HTTP ------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function serveFile(res, base, relative, req = null) {
  const target = normalize(join(base, relative));
  if (target !== base && !target.startsWith(base + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404).end('Nicht gefunden');
    return;
  }
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const { size } = statSync(target);
  // Ohne Range kann der Browser in der Musik nicht springen, dann läuft der Ton aus dem Takt.
  const range = req?.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(target, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': 'no-cache' });
  createReadStream(target).pipe(res);
}

function readBody(req, limit) {
  return new Promise((done, fail) => {
    const parts = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new MatchError('Datei ist zu groß'));
        req.destroy();
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

function isAllowedOrigin(req) {
  // Fremde Webseiten dürfen die lokale Regie nicht fernsteuern.
  const host = req.headers.host ?? '';
  if (HOST === '127.0.0.1' && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const { origin } = req.headers;
  return !origin || origin === `http://${host}`;
}

const actions = {
  '/api/action': (body) => {
    const before = rt.match?.state.winner;
    const state = applyMatchEvent(body);
    if (before && !state.winner) reopenBracketEntry();
  },
  '/api/mp': ({ command }) => {
    if (typeof command !== 'string' || !command.trim()) throw new MatchError('Leerer Befehl');
    sendLobby(command.trim());
  },
  '/api/chat': ({ text }) => {
    if (!text?.trim()) return;
    sendLobby(text.trim());
    rt.chat.push({ from: rt.demo ? 'Regie' : rt.settings.ircUser, text: text.trim(), at: Date.now(), self: true });
  },
  '/api/scene': ({ scene }) => {
    rt.scenePin = scene ?? null;
    rt.sceneHold = null;
    updateScene();
  },
  '/api/settings': (body) => {
    for (const key of ['autoSend', 'autoStart', 'autoConfirm', 'gameplaySource']) {
      if (key in body) rt.settings[key] = body[key];
    }
    if ('skinName' in body) {
      rt.settings.skinName = body.skinName || null;
      refreshSkin();
    }
    saveSettings();
  },
  '/api/connect/irc': ({ username, password }) => {
    if (username) rt.settings.ircUser = username;
    if (password) rt.secrets.ircPassword = password;
    secretStore.save(rt.secrets);
    saveSettings();
    connectIrc();
  },
  '/api/connect/api': ({ clientId, clientSecret }) => {
    if (clientId) rt.secrets.apiClientId = clientId;
    if (clientSecret) rt.secrets.apiSecret = clientSecret;
    secretStore.save(rt.secrets);
    setupApi();
  },
  '/api/connect/forget': () => {
    rt.bancho?.stop();
    rt.bancho = null;
    rt.api = null;
    rt.secrets = {};
    secretStore.save({});
    rt.ircStatus = 'getrennt';
    rt.apiStatus = 'nicht eingerichtet';
  },
  '/api/demo/start': () => startDemo(),
  '/api/demo/fault': ({ kind }) => {
    if (!rt.demo) throw new MatchError('Nur im Demo-Betrieb');
    rt.bancho.fault(kind);
  },
  '/api/lobby/make': () => makeLobby(),
  '/api/lobby/attach': ({ mpId }) => {
    const id = Number(String(mpId).match(/(\d+)\s*$/)?.[1]);
    if (!id) throw new MatchError('mp-Link oder ID nicht lesbar');
    if (!rt.bancho) throw new MatchError('Erst mit Bancho verbinden');
    attachLobby(id);
  },
  '/api/match/open': ({ matchId }) => {
    const entry = requireTournament().matches.find((item) => item.id === matchId);
    if (!entry) throw new MatchError('Match nicht gefunden');
    openMatch(entry);
  },
  '/api/match/quick': ({ teamA, teamB, roundId }) => {
    const tournament = requireTournament();
    if (!teamA || !teamB || teamA === teamB) throw new MatchError('Zwei verschiedene Teams wählen');
    const entry = { id: `M-${Date.now().toString(36)}`, title: 'Einzelmatch', bracket: 'extra', depth: 0, index: 0, roundId, teamA, teamB, winnerTo: null, loserTo: null, schedule: null };
    tournament.matches.push(entry);
    persistTournament();
    openMatch(entry);
  },
  '/api/match/alert-action': ({ id }) => {
    const item = rt.alerts.find((entry) => entry.id === id);
    if (item?.action?.command) sendLobby(item.action.command);
    rt.alerts = rt.alerts.filter((entry) => entry.id !== id);
  },
  '/api/match/dismiss': ({ id }) => {
    rt.alerts = rt.alerts.filter((entry) => entry.id !== id);
  },
  '/api/tournament/new': ({ name, acronym }) => {
    const tournament = newTournament(name || 'Neues Turnier', acronym || 'CUP');
    tournamentStore.save(tournament);
    activateTournament(tournament.id);
  },
  '/api/tournament/select': ({ id }) => activateTournament(id),
  '/api/tournament/update': (patch) => {
    const tournament = requireTournament();
    for (const key of ['name', 'acronym', 'teamSize', 'gameMode', 'timezone']) if (key in patch) tournament[key] = patch[key];
    if (patch.theme) tournament.theme = { ...tournament.theme, ...patch.theme };
    if ('teamsText' in patch) tournament.teams = parseTeams(patch.teamsText, tournament.teams);
    persistTournament();
  },
  '/api/round/save': ({ id, name, rules, poolText }) => {
    const tournament = requireTournament();
    let round = tournament.rounds.find((entry) => entry.id === id);
    if (!round) {
      round = { id: `r-${Date.now().toString(36)}`, name: 'Neue Runde', rules: { ...tournament.rounds[0]?.rules }, pool: [] };
      tournament.rounds.push(round);
    }
    if (name) round.name = name;
    if (rules) round.rules = { ...round.rules, ...rules };
    if (poolText !== undefined) round.pool = parsePool(poolText, round.pool);
    persistTournament();
  },
  '/api/round/enrich': async ({ id }) => {
    const round = requireTournament().rounds.find((entry) => entry.id === id);
    if (!round) throw new MatchError('Runde nicht gefunden');
    return enrichPool(round);
  },
  '/api/bracket/generate': ({ format }) => {
    const tournament = requireTournament();
    generateBracket(tournament, format === 'double' ? 'double' : 'single');
    persistTournament();
  },
  '/api/tournament/import': (data) => {
    if (!data?.name || !Array.isArray(data.teams) || !Array.isArray(data.rounds)) throw new MatchError('Das ist keine Matchdeck-Turnierdatei');
    const tournament = { ...newTournament(), ...data, id: `t-${Date.now().toString(36)}` };
    tournamentStore.save(tournament);
    activateTournament(tournament.id);
  },
  '/api/tourney/check': async ({ folder }) => {
    rt.settings.tourneyFolder = folder || rt.settings.tourneyFolder || defaultTourneyFolder();
    saveSettings();
    rt.tourney = await inspectTourney(rt.settings.tourneyFolder, rt.tournament);
  },
  '/api/tourney/prepare': async ({ folder, height }) => {
    rt.settings.tourneyFolder = folder || rt.settings.tourneyFolder || defaultTourneyFolder();
    saveSettings();
    rt.tourney = await prepareTourney({ folder: rt.settings.tourneyFolder, sourceFolder: rt.osuFolder, tournament: requireTournament(), height });
  },
  '/api/tourney/launch': async () => {
    const folder = rt.settings.tourneyFolder ?? defaultTourneyFolder();
    rt.tourney = await inspectTourney(folder, rt.tournament);
    if (rt.tourney.running) throw new MatchError('osu!tourney läuft schon');
    if (!rt.tourney.ready) throw new MatchError('Erst den Ordner einrichten');
    launchTourney(folder);
  },
  '/api/theater/start': ({ ids }) => startTheater(ids ?? []),
  '/api/theater/stop': () => {
    rt.stage.stop();
    rt.scenePin = null;
    updateScene();
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const { pathname } = url;
  try {
    if (!isAllowedOrigin(req)) {
      res.writeHead(403).end('Zugriff nur lokal');
      return;
    }
    if (req.method === 'GET') {
      if (pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.kind = url.searchParams.get('kind') ?? 'console';
        clients.add(res);
        send(res, 'hello', { serverNow: Date.now() });
        send(res, 'state', snapshot());
        const backlog = rt.stage.backlog();
        if (backlog) send(res, 'backlog', backlog);
        if (rt.live) send(res, 'live', rt.live);
        req.on('close', () => {
          clients.delete(res);
          pushState();
        });
        pushState();
        return;
      }
      if (pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(snapshot()));
        return;
      }
      if (pathname.startsWith('/api/maps/')) {
        const map = loadMap(pathname.slice('/api/maps/'.length));
        if (!map) {
          res.writeHead(404).end('{}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(map));
        return;
      }
      if (pathname === '/api/tournament/export') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${requireTournament().acronym}.json"` });
        res.end(JSON.stringify(rt.tournament, null, 2));
        return;
      }
      if (pathname === '/') return serveFile(res, join(ROOT, 'public'), 'console.html');
      if (pathname === '/overlay') return serveFile(res, join(ROOT, 'public'), 'overlay.html');
      if (pathname.startsWith('/shared/')) return serveFile(res, join(ROOT, 'shared'), pathname.slice(8));
      if (pathname.startsWith('/media/')) return serveFile(res, MEDIA_DIR, decodeURIComponent(pathname.slice(7)), req);
      if (pathname.startsWith('/skin/')) {
        const [name, ...rest] = pathname.slice(6).split('/').map(decodeURIComponent);
        if (!rt.osuFolder || !rt.skins.includes(name)) {
          res.writeHead(404).end();
          return;
        }
        return serveFile(res, join(rt.osuFolder, 'Skins', name), rest.join('/'));
      }
      return serveFile(res, join(ROOT, 'public'), pathname.slice(1));
    }

    if (req.method === 'POST' && pathname === '/api/import') {
      if (req.headers['content-type'] !== 'application/octet-stream') throw new MatchError('Falscher Dateityp');
      const name = url.searchParams.get('name') ?? '';
      const result = importFile(name, await readBody(req, MAX_UPLOAD));
      if (result.kind === 'maps') {
        for (const replay of listReplays()) {
          if (result.maps.some((map) => map.hash === replay.beatmapHash)) writeJson(join(REPLAY_DIR, `${replay.id}.meta.json`), { ...replay, hasMap: true });
        }
      }
      pushState();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      return;
    }

    if (req.method === 'POST' && actions[pathname]) {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new MatchError('JSON erwartet');
      const raw = await readBody(req, MAX_JSON);
      const result = await actions[pathname](raw.length ? JSON.parse(raw) : {});
      pushState();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, ...result }));
      return;
    }
    res.writeHead(404).end('Nicht gefunden');
  } catch (error) {
    const expected = error instanceof MatchError || /Pool-Zeile|Mindestens|osu!tourney|osu!\.exe|Höhe/.test(error.message ?? '');
    if (!expected) console.error(error);
    if (!res.headersSent) res.writeHead(expected ? 400 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
});

/* ------------------------------- Live-Daten ---------------------------- */

rt.stage.on('load', (description) => {
  if (!description) rt.live = null;
  broadcast('stage', description);
  pushState();
});
rt.stage.on('describe', (description) => broadcast('stage-update', description));
rt.stage.on('frames', (chunk) => broadcast('frames', chunk));
rt.stage.on('live', (players) => {
  rt.live = { source: 'stage', players };
  broadcast('live', rt.live);
});

rt.tosu.on('status', pushState);
rt.tosu.on('live', (live) => {
  rt.liveTosu = live;
  if (rt.settings.gameplaySource === 'capture') {
    rt.live = live;
    broadcast('live', live);
  }
});

setInterval(() => {
  for (const client of clients) client.write(': ping\n\n');
  broadcast('time', { serverNow: Date.now() });
}, 5000);

/* -------------------------------- Start -------------------------------- */

function boot() {
  refreshSkin();
  setupApi();
  rt.settings.tourneyFolder ??= defaultTourneyFolder();
  inspectTourney(rt.settings.tourneyFolder, rt.tournament).then((status) => { rt.tourney = status; pushState(); }).catch(() => {});
  rt.tosu.start();
  if (rt.settings.activeTournament) {
    const tournament = tournamentStore.load(rt.settings.activeTournament);
    if (tournament) {
      rt.tournament = tournament;
      const entry = tournament.matches.find((item) => item.id === rt.settings.activeMatch);
      if (entry?.teamA && entry?.teamB && tournament.id !== 'demo') {
        if (rt.settings.ircUser && rt.secrets.ircPassword) connectIrc();
        openMatch(entry);
      }
    }
  }
  server.listen(PORT, HOST, () => {
    console.log(`Matchdeck läuft: http://${HOST}:${PORT}/`);
    console.log(`Overlay für OBS: http://${HOST}:${PORT}/overlay`);
  });
}

process.on('uncaughtException', (error) => console.error('Unerwarteter Fehler:', error));
process.on('unhandledRejection', (error) => console.error('Unerwarteter Fehler:', error));

boot();
