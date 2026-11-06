// Demo-Betrieb ohne Internet: Eine simulierte Lobby spricht dieselben Textzeilen wie BanchoBot,
// also läuft der echte Parser und die echte Automatik. Maps und Spieler sind frei erfunden.

import { EventEmitter } from 'node:events';
import { parseOsu, prepareMap, sliderBall, MODS } from '../shared/beatmap.js';
import { judge } from '../shared/judge.js';
import { generateBracket, newTournament } from '../shared/tournament.js';

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gaussian = (random) => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

/** Erzeugt eine kurze, spielbare Map als .osu-Text und nutzt damit den echten Parser. */
export function demoOsu({ seed, seconds, bpm = 170, cs = 4, ar = 9.3, od = 8.5, title, version }) {
  const random = randomSource(seed);
  const beat = 60000 / bpm;
  const lines = [];
  const clampX = (x) => Math.round(Math.max(30, Math.min(482, x)));
  const clampY = (y) => Math.round(Math.max(30, Math.min(354, y)));
  let x = 256;
  let y = 192;
  let angle = random() * Math.PI * 2;
  let time = 1000;
  let index = 0;
  const end = 1000 + (seconds - 4) * 1000;

  while (time < end) {
    const phrase = index % 16 === 0;
    const flag = phrase ? 5 : 1;
    const style = random();
    if (style < 0.28) {
      const length = 100 + Math.floor(random() * 3) * 40;
      angle += (random() - 0.5) * 2.4;
      const toX = clampX(x + Math.cos(angle) * length);
      const toY = clampY(y + Math.sin(angle) * length);
      const midX = clampX((x + toX) / 2 + (random() - 0.5) * 120);
      const midY = clampY((y + toY) / 2 + (random() - 0.5) * 120);
      const flagSlider = phrase ? 6 : 2;
      lines.push(`${x},${y},${Math.round(time)},${flagSlider},0,B|${midX}:${midY}|${toX}:${toY},1,${length}`);
      x = toX;
      y = toY;
      time += (length / 140) * beat + beat / 2;
    } else if (style < 0.5) {
      for (let i = 0; i < 5 && time < end; i++) {
        lines.push(`${x},${y},${Math.round(time)},${i === 0 && phrase ? 5 : 1},0`);
        angle += 0.3;
        x = clampX(x + Math.cos(angle) * 32);
        y = clampY(y + Math.sin(angle) * 32);
        time += beat / 4;
      }
      time += beat / 4;
    } else {
      lines.push(`${x},${y},${Math.round(time)},${flag},0`);
      angle += Math.PI * (0.45 + random() * 0.6);
      const reach = 150 + random() * 120;
      x = clampX(x + Math.cos(angle) * reach);
      y = clampY(y + Math.sin(angle) * reach);
      time += beat / 2;
    }
    index++;
  }
  lines.push(`256,192,${Math.round(time + beat)},12,0,${Math.round(time + beat + 2200)}`);

  return `osu file format v14

[General]
StackLeniency: 0.3
Mode: 0

[Metadata]
Title:${title}
Artist:Matchdeck Demo
Creator:Matchdeck
Version:${version}
BeatmapID:${seed}

[Difficulty]
HPDrainRate:6
CircleSize:${cs}
OverallDifficulty:${od}
ApproachRate:${ar}
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,${beat},4,2,1,60,1,0

[HitObjects]
${lines.join('\n')}
`;
}

/** Simulierter Spieler: bewegt den Cursor mit Zielfehler, Timingfehler und gelegentlichen Patzern. */
export function botFrames(prepared, { aim = 12, timing = 14, slip = 0.012, seed = 1 }) {
  const random = randomSource(seed);
  const { objects, radius } = prepared;
  const targets = objects.map((object) => {
    const slipped = random() < slip;
    const spread = slipped ? radius * 1.8 : aim * (radius / 40);
    return {
      x: object.x + gaussian(random) * spread,
      y: object.y + gaussian(random) * spread,
      offset: gaussian(random) * timing,
      noClick: slipped && random() < 0.5,
    };
  });

  const presses = [];
  objects.forEach((object, index) => {
    const target = targets[index];
    if (target.noClick) return;
    const hold = object.type === 'circle' ? 45 : object.end - object.t + 20;
    presses.push({ from: object.t + target.offset, to: object.t + target.offset + hold, key: index % 2 ? 10 : 5 });
  });

  const frames = [];
  const last = objects.at(-1)?.end ?? 0;
  let pointer = 0;
  for (let time = -800; time <= last + 400; time += 1000 / 60) {
    while (pointer < objects.length - 1 && objects[pointer].end < time) pointer++;
    const object = objects[pointer];
    let x;
    let y;
    if (time >= object.t && time <= object.end && object.type === 'slider') {
      [x, y] = sliderBall(object, time);
    } else if (time >= object.t && time <= object.end && object.type === 'spinner') {
      const turn = (time / 1000) * Math.PI * 2 * 7;
      x = 256 + Math.cos(turn) * 70;
      y = 192 + Math.sin(turn) * 70;
    } else {
      const before = objects[pointer - 1];
      const start = before
        ? (before.type === 'slider' ? sliderBall(before, before.end) : [before.x, before.y])
        : [256, 192];
      const target = targets[pointer];
      const span = Math.min(420, object.t - (before?.end ?? object.t - 420));
      const progress = Math.max(0, Math.min(1, 1 - (object.t - time) / Math.max(40, span)));
      const eased = progress * progress * (3 - 2 * progress);
      x = start[0] + (target.x - start[0]) * eased;
      y = start[1] + (target.y - start[1]) * eased;
    }
    let keys = 0;
    for (const press of presses) {
      if (press.from > time) break;
      if (time <= press.to) keys |= press.key;
    }
    frames.push([Math.round(time), Math.round(x * 10) / 10, Math.round(y * 10) / 10, keys]);
  }
  return frames;
}

const ROSTER = [
  { name: 'Nordlicht', acronym: 'NORD', theme: 'Nordlicht', skill: 0.75, players: ['Kaya Frost', 'Mo Lund', 'Sasha Berg', 'Ilo Winter'] },
  { name: 'Ostwind', acronym: 'OST', skill: 0.9, players: ['Remi Wolke', 'Toni Falk', 'Juno Hart', 'Alex Sturm'] },
  { name: 'Sonnenwerk', acronym: 'SON', skill: 1.05, players: ['Pia Sol', 'Noa Licht', 'Kim Rot', 'Lian Glut'] },
  { name: 'Eisbrecher', acronym: 'EIS', skill: 1.2, players: ['Sam Kalt', 'Yuki Weiß', 'Ari Fels', 'Dani Blau'] },
];

const POOL = [
  ['NM1', 'Erste Schicht'], ['NM2', 'Hafenlicht'], ['NM3', 'Kupferdraht'], ['NM4', 'Nachtbus'],
  ['HD1', 'Nebelbank'], ['HD2', 'Schattenwurf'], ['HR1', 'Glasboden'], ['HR2', 'Steilkurve'],
  ['DT1', 'Überholspur'], ['DT2', 'Stromschnelle'], ['FM1', 'Freigang'], ['FM2', 'Leerlauf'], ['TB', 'Letzte Runde'],
];

export function demoTournament(teamSize = 2, mapSeconds = 26) {
  const tournament = newTournament('Matchdeck Demo Cup', 'MDC');
  tournament.id = 'demo';
  tournament.teamSize = teamSize;
  tournament.timezone = 'Europe/Berlin';
  tournament.teams = ROSTER.map((team, index) => ({
    id: `demo-${index + 1}`,
    name: team.name,
    acronym: team.acronym,
    flag: '',
    seed: index + 1,
    players: team.players.slice(0, teamSize).map((name) => ({ name })),
  }));
  const pool = POOL.map(([slot, title], index) => ({
    slot,
    mod: slot.slice(0, 2),
    mapId: 9000001 + index,
    title,
    artist: 'Matchdeck Demo',
    creator: 'Matchdeck',
    version: slot === 'TB' ? 'Finale' : 'Turnier',
    stars: 5.4 + index * 0.08,
    bpm: 150 + index * 6,
    length: mapSeconds,
    cs: 4, ar: 9.3, od: 8.5,
  }));
  tournament.rounds = [
    { id: 'r-semi', name: 'Halbfinale', rules: { bestOf: 7, bans: 1, protects: 0, banOrder: 'ABAB', winCondition: 'score', countFailed: true, abortLimit: 1, forceNF: true, pickTimer: 120, readyTimer: 90, startTimer: 5 }, pool },
    { id: 'r-final', name: 'Finale', rules: { bestOf: 9, bans: 2, protects: 1, banOrder: 'ABBA', winCondition: 'score', countFailed: true, abortLimit: 1, forceNF: true, pickTimer: 120, readyTimer: 90, startTimer: 5 }, pool },
  ];
  generateBracket(tournament, 'single');
  tournament.matches.forEach((match, index) => {
    match.schedule = new Date(Date.UTC(2026, 10, 14, 17 + index, 0)).toISOString();
  });
  return tournament;
}

const skillOf = (tournament, teamId) => ROSTER[tournament.teams.findIndex((team) => team.id === teamId)]?.skill ?? 1;

export class DemoBancho extends EventEmitter {
  constructor({ tournament, stage, playerDelay = 450, reactionMs = 1800, onMapReady = () => {} }) {
    super();
    this.tournament = tournament;
    this.stage = stage;
    this.playerDelay = playerDelay;
    this.reactionMs = reactionMs;
    this.onMapReady = onMapReady;
    this.status = 'verbunden';
    this.nick = 'Regie';
    this.mp = 100000 + Math.floor(Math.random() * 899999);
    this.lobby = { players: [], map: null, mods: [], freemod: false, teamMode: 'TeamVs' };
    this.maps = new Map();
    this.timers = new Set();
    this.lastResult = null;
    this.tamperScore = false;
  }

  connect() { this.emit('status', 'verbunden'); }
  stop() { for (const timer of this.timers) clearTimeout(timer); this.status = 'getrennt'; }
  join() {}
  part() {}

  later(ms, action) {
    const timer = setTimeout(() => { this.timers.delete(timer); action(); }, ms);
    this.timers.add(timer);
    return timer;
  }

  bot(text, target = `#mp_${this.mp}`) {
    this.emit('message', { from: 'BanchoBot', target, text });
  }

  chat(from, text) {
    this.emit('message', { from, target: `#mp_${this.mp}`, text });
  }

  mapFor(id) {
    if (this.maps.has(id)) return this.maps.get(id);
    const entry = this.tournament.rounds[0].pool.find((slot) => slot.mapId === id) ?? { title: 'Unbekannt', version: 'X', length: 26, bpm: 170 };
    const text = demoOsu({ seed: id, seconds: entry.length ?? 26, bpm: entry.bpm ?? 170, title: entry.title, version: entry.version });
    const map = { ...parseOsu(text), hash: `demo-${id}`, audioFile: null };
    this.maps.set(id, map);
    return map;
  }

  /** Teams für die Lobby festlegen. Wird beim Öffnen eines Matches gesetzt. */
  seat(teamA, teamB) {
    this.teamA = teamA;
    this.teamB = teamB;
  }

  say(target, text) {
    this.emit('sent', { target, text });
    if (!text.startsWith('!mp')) return;
    const [, command, ...args] = text.split(' ');
    const handler = {
      make: () => this.make(args.join(' ')),
      settings: () => this.settings(),
      set: () => this.bot(`Changed match settings to ${args[2]} slots, TeamVs, ScoreV2`),
      lock: () => this.bot('Locked the match'),
      invite: () => {},
      map: () => this.changeMap(Number(args[0])),
      mods: () => this.changeMods(args),
      timer: () => this.timer(Number(args[0]) || 30),
      start: () => this.start(Number(args[0]) || 0),
      abort: () => this.abort(),
      team: () => this.moveTeam(args[0], args[1]),
      kick: () => this.bot(`Kicked ${args[0]} from the match`),
      close: () => this.bot('Closed the match'),
    }[command];
    handler?.();
  }

  make(name) {
    this.later(250, () => {
      this.bot(`Created the tournament match https://osu.ppy.sh/mp/${this.mp} ${name}`, this.nick);
      this.seatPlayers();
    });
  }

  attach() { this.seatPlayers(); }

  seatPlayers() {
    this.lobby.players = [];
    const roster = [
      ...this.teamA.players.map((player) => ({ name: player.name, team: 'red', skill: skillOf(this.tournament, this.teamA.id) })),
      ...this.teamB.players.map((player) => ({ name: player.name, team: 'blue', skill: skillOf(this.tournament, this.teamB.id) })),
    ];
    roster.forEach((player, index) => this.later(this.playerDelay * (index + 1), () => {
      const slot = index + 1;
      this.lobby.players.push({ ...player, slot, mods: [] });
      this.bot(`${player.name} joined in slot ${slot} for team ${player.team}.`);
      if (index === 0) this.later(600, () => this.chat(player.name, 'gl hf'));
    }));
  }

  settings() {
    const map = this.lobby.map;
    this.bot(`Room name: ${this.tournament.acronym}: Demo, History: https://osu.ppy.sh/mp/${this.mp}`);
    if (map) this.bot(`Beatmap: https://osu.ppy.sh/b/${map.mapId || map.id} ${map.artist} - ${map.title} [${map.version}]`);
    this.bot(`Team mode: ${this.lobby.teamMode}, Win condition: ScoreV2`);
    this.bot(`Active mods: ${this.lobby.freemod ? 'Freemod' : this.lobby.mods.join(', ') || 'None'}`);
    this.bot(`Players: ${this.lobby.players.length}`);
    for (const player of this.lobby.players) {
      const mods = player.mods.length ? ` / ${player.mods.join(', ')}` : '';
      const padded = player.name.padEnd(16);
      this.bot(`Slot ${player.slot}  Ready     https://osu.ppy.sh/u/${1000 + player.slot} ${padded} [Team ${player.team === 'red' ? 'Red ' : 'Blue'}${mods}]`);
    }
  }

  changeMap(id) {
    const map = this.mapFor(id);
    this.lobby.map = map;
    this.bot(`Changed beatmap to https://osu.ppy.sh/b/${id} ${map.artist} - ${map.title} [${map.version}]`);
    this.scheduleReady();
  }

  changeMods(args) {
    this.lobby.freemod = args[0] === 'Freemod';
    this.lobby.mods = this.lobby.freemod || args[0] === 'None' ? [] : args;
    this.bot(this.lobby.freemod ? 'Disabled all mods, enabled FreeMod' : this.lobby.mods.length ? `Enabled ${args.join(', ')}, disabled FreeMod` : 'Disabled all mods, disabled FreeMod');
    if (this.lobby.freemod) {
      for (const player of this.lobby.players) player.mods = ['NoFail', ...(player.slot % 2 ? ['Hidden'] : ['HardRock'])];
      if (this.illegalNext) {
        this.lobby.players[0].mods = ['DoubleTime'];
        this.illegalNext = false;
      }
    } else for (const player of this.lobby.players) player.mods = [];
  }

  scheduleReady() {
    clearTimeout(this.readyTimer);
    this.readyTimer = this.later(this.reactionMs, () => {
      if (!this.playing) this.bot('All players are ready');
    });
  }

  timer(seconds) {
    this.bot(`Countdown ends in ${seconds} seconds`);
  }

  start(seconds) {
    if (seconds > 0) this.bot(`Queued the match to start in ${seconds} seconds`);
    this.startTimer = this.later(seconds * 1000, () => this.play());
  }

  modBits(player) {
    const names = { Hidden: 'HD', HardRock: 'HR', NoFail: 'NF', DoubleTime: 'DT' };
    const list = this.lobby.freemod ? player.mods.map((mod) => names[mod] ?? mod) : this.lobby.mods;
    return list.reduce((bits, mod) => bits | (MODS[mod] ?? 0), 0);
  }

  play() {
    const map = this.lobby.map ?? this.mapFor(9000001);
    this.playing = true;
    this.bot('The match has started!');
    const sharedMods = this.modBits(this.lobby.players[0] ?? {}) & (MODS.DT | MODS.HT);
    const slots = this.lobby.players.map((player, index) => {
      const mods = this.modBits(player);
      const prepared = prepareMap(map, mods);
      const skill = player.skill * (1 + (Math.random() - 0.5) * 0.25);
      const frames = botFrames(prepared, { aim: 7 * skill, timing: 10 * skill, slip: 0.008 * skill, seed: map.mapId * 31 + index + Date.now() % 9973 });
      const { marks, timeline, final } = judge(prepared, frames);
      return { name: player.name, team: player.team, side: player.team === 'red' ? 'a' : 'b', frames, marks, timeline, final, mods };
    });
    this.currentSlots = slots;
    this.stage.load({
      hash: map.hash,
      mods: slots[0]?.mods ?? 0,
      rate: sharedMods & MODS.DT ? 1.5 : 1,
      length: map.length,
      firstObject: map.objects[0]?.t ?? 0,
      slots,
      title: `${map.artist} - ${map.title}`,
    });
    this.stage.once('end', () => this.finish());
  }

  finish() {
    if (!this.playing) return;
    this.playing = false;
    const rows = [];
    for (const slot of this.currentSlots) {
      if (slot.cut) continue;
      const { final } = slot;
      this.bot(`${slot.name} finished playing (Score: ${final.score}, PASSED).`);
      rows.push({ name: slot.name, score: final.score, accuracy: final.accuracy * 100, combo: final.maxCombo, misses: final.miss, passed: true, mods: [] });
    }
    if (this.tamperScore && rows[0]) {
      rows[0] = { ...rows[0], score: Math.round(rows[0].score * 0.71) };
      this.tamperScore = false;
    }
    this.lastResult = { id: Date.now(), rows };
    this.bot('The match has finished!');
  }

  abort() {
    clearTimeout(this.startTimer);
    this.timers.delete(this.startTimer);
    if (!this.playing) return;
    this.playing = false;
    this.stage.removeAllListeners('end');
    this.stage.stop();
    this.bot('Aborted the match');
    this.scheduleReady();
  }

  moveTeam(name, colour) {
    const player = this.lobby.players.find((entry) => entry.name.replaceAll(' ', '_') === name);
    if (!player) return;
    player.team = colour;
    this.bot(`${player.name} changed to ${colour === 'red' ? 'Red' : 'Blue'}`);
  }

  /** Fehlerfälle zum Üben. Sie laufen durch dieselben Wege wie im Ernstfall. */
  fault(kind) {
    const [first, second] = this.lobby.players;
    if (kind === 'dc' && this.playing && second) {
      const slot = this.currentSlots.find((entry) => entry.name === second.name);
      if (slot) slot.cut = true;
      this.stage.cut(second.name);
      this.bot(`${second.name} left the game.`);
    } else if (kind === 'wrongteam' && first) {
      first.team = first.team === 'red' ? 'blue' : 'red';
      this.bot(`${first.name} changed to ${first.team === 'red' ? 'Red' : 'Blue'}`);
    } else if (kind === 'illegalmod') {
      this.illegalNext = true;
    } else if (kind === 'mismatch') {
      this.tamperScore = true;
    }
  }

  /** Ersatz für die osu!-API im Demo-Betrieb. */
  async lastGame() {
    return this.lastResult;
  }

  async beatmap(id) {
    return this.tournament.rounds[0].pool.find((slot) => slot.mapId === id) ?? null;
  }
}
