// Versteht die Textmeldungen von BanchoBot und hält daraus das Lobby-Abbild aktuell.

const pattern = {
  created: /^Created the tournament match https?:\/\/osu\.ppy\.sh\/mp\/(\d+) (.+)$/,
  room: /^Room name: (.*), History: https?:\/\/osu\.ppy\.sh\/mp\/(\d+)/,
  beatmap: /^Beatmap: https?:\/\/osu\.ppy\.sh\/b\/(\d+) (.*)$/,
  mode: /^Team mode: (\S+), Win condition: (\S+)/,
  mods: /^Active mods: (.*)$/,
  players: /^Players: (\d+)$/,
  slot: /^Slot (\d+)\s+(Not Ready|Ready|No Map)\s+https?:\/\/osu\.ppy\.sh\/u\/(\d+)\s+(.+?)\s*(?:\[(.*)\])?$/,
  joined: /^(.+?) joined in slot (\d+)(?: for team (red|blue))?\.$/,
  moved: /^(.+?) moved to slot (\d+)$/,
  left: /^(.+?) left the game\.$/,
  team: /^(.+?) changed to (Red|Blue)$/,
  host: /^(.+?) became the host\.$/,
  map: /^Beatmap changed to: (.*) \(https?:\/\/osu\.ppy\.sh\/b\/(\d+)\)$/,
  refMap: /^Changed beatmap to https?:\/\/osu\.ppy\.sh\/b\/(\d+) (.*)$/,
  finished: /^(.+?) finished playing \(Score: (\d+), (PASSED|FAILED)\)\.$/,
  countdown: /^(Match starts in|Countdown ends in|Queued the match to start in) (\d+) (minute|second)s?(?: and (\d+) seconds?)?$/,
  settingsChanged: /^Changed match settings to (?:\d+ slots, )?(HeadToHead|TagCoop|TeamVs|TagTeamVs)(?:, (Score|Accuracy|Combo|ScoreV2))?$/,
  modsChanged: /^(?:Enabled (.+)|Disabled all mods), (disabled|enabled) FreeMod$/,
  roll: /^(.+?) rolls (\d+) point\(s\)$/,
};

const MOD_NAMES = {
  Hidden: 'HD', HardRock: 'HR', Flashlight: 'FL', Easy: 'EZ', NoFail: 'NF',
  DoubleTime: 'DT', Nightcore: 'NC', HalfTime: 'HT', SuddenDeath: 'SD', Perfect: 'PF', Relax: 'RX',
};

const shortMods = (text) => text
  .split(/[,\s]+/)
  .filter(Boolean)
  .map((name) => MOD_NAMES[name] ?? name);

export const emptyLobby = (mpId = null) => ({
  mpId,
  name: '',
  channel: mpId ? `#mp_${mpId}` : null,
  map: null,
  teamMode: null,
  winCondition: null,
  mods: [],
  freemod: false,
  host: null,
  slots: {},
  playing: false,
  allReady: false,
  results: [],
  countdown: null,
  closed: false,
  departed: [],
});

const findSlot = (lobby, name) => Object.keys(lobby.slots).find((slot) => lobby.slots[slot].name === name);

/** Wendet eine Zeile an. Liefert erkannte Ereignisse für die Automatik zurück. */
export function applyBanchoLine(lobby, text, now = Date.now()) {
  const events = [];
  let m;

  if ((m = text.match(pattern.created))) {
    Object.assign(lobby, emptyLobby(Number(m[1])), { name: m[2] });
    events.push({ type: 'created', mpId: Number(m[1]) });
  } else if ((m = text.match(pattern.room))) {
    lobby.name = m[1];
    lobby.mpId = Number(m[2]);
  } else if ((m = text.match(pattern.beatmap))) {
    lobby.map = { id: Number(m[1]), title: m[2] };
  } else if ((m = text.match(pattern.mode))) {
    lobby.teamMode = m[1];
    lobby.winCondition = m[2];
  } else if ((m = text.match(pattern.mods))) {
    lobby.freemod = /Freemod/.test(m[1]);
    lobby.mods = shortMods(m[1].replace('Freemod', '')).filter((mod) => mod !== 'None');
  } else if ((m = text.match(pattern.players))) {
    // Erst echte Slot-Zeilen ersetzen die Liste. Sonst leert ein unbekanntes Format die Anzeige.
    lobby.refreshing = true;
    if (m[1] === '0') lobby.slots = {};
  } else if ((m = text.match(pattern.slot))) {
    if (lobby.refreshing) {
      lobby.slots = {};
      lobby.refreshing = false;
    }
    const details = m[5] ?? '';
    const team = details.match(/Team (Red|Blue)/)?.[1]?.toLowerCase() ?? null;
    const modPart = details.split('/').map((part) => part.trim()).filter((part) => part !== 'Host' && !/^Team (Red|Blue)$/.test(part)).join(', ');
    lobby.slots[m[1]] = {
      name: m[4],
      id: Number(m[3]),
      ready: m[2] === 'Ready',
      noMap: m[2] === 'No Map',
      team,
      mods: shortMods(modPart),
      host: /Host/.test(details),
    };
    if (/Host/.test(details)) lobby.host = m[4];
  } else if ((m = text.match(pattern.joined))) {
    lobby.slots[m[2]] = { name: m[1], ready: false, noMap: false, team: m[3] ?? null, mods: [] };
    lobby.departed = lobby.departed.filter((name) => name !== m[1]);
    events.push({ type: 'joined', name: m[1] });
  } else if ((m = text.match(pattern.moved))) {
    const from = findSlot(lobby, m[1]);
    if (from) {
      lobby.slots[m[2]] = lobby.slots[from];
      delete lobby.slots[from];
    }
  } else if ((m = text.match(pattern.left))) {
    const slot = findSlot(lobby, m[1]);
    if (slot) delete lobby.slots[slot];
    if (lobby.playing) lobby.departed.push(m[1]);
    events.push({ type: 'left', name: m[1], duringPlay: lobby.playing });
  } else if ((m = text.match(pattern.team))) {
    const slot = findSlot(lobby, m[1]);
    if (slot) lobby.slots[slot].team = m[2].toLowerCase();
  } else if ((m = text.match(pattern.host))) {
    lobby.host = m[1];
  } else if ((m = text.match(pattern.map))) {
    lobby.map = { id: Number(m[2]), title: m[1] };
    lobby.allReady = false;
    events.push({ type: 'map', id: Number(m[2]) });
  } else if ((m = text.match(pattern.refMap))) {
    lobby.map = { id: Number(m[1]), title: m[2] };
    lobby.allReady = false;
    events.push({ type: 'map', id: Number(m[1]) });
  } else if (text === 'All players are ready') {
    lobby.allReady = true;
    events.push({ type: 'allReady' });
  } else if (text === 'The match has started!') {
    lobby.playing = true;
    lobby.allReady = false;
    lobby.results = [];
    lobby.departed = [];
    lobby.countdown = null;
    events.push({ type: 'started' });
  } else if ((m = text.match(pattern.finished))) {
    lobby.results.push({ name: m[1], score: Number(m[2]), passed: m[3] === 'PASSED' });
  } else if (text === 'The match has finished!') {
    lobby.playing = false;
    events.push({ type: 'finished', results: [...lobby.results], departed: [...lobby.departed] });
  } else if (text === 'Aborted the match') {
    lobby.playing = false;
    lobby.results = [];
    events.push({ type: 'aborted' });
  } else if (text === 'Countdown finished') {
    lobby.countdown = null;
    events.push({ type: 'timerDone' });
  } else if (text === 'Countdown aborted') {
    lobby.countdown = null;
  } else if (text === 'Closed the match') {
    lobby.closed = true;
    lobby.playing = false;
    events.push({ type: 'closed' });
  } else if ((m = text.match(pattern.roll))) {
    events.push({ type: 'roll', name: m[1], value: Number(m[2]) });
  } else if ((m = text.match(pattern.countdown))) {
    const seconds = Number(m[2]) * (m[3] === 'minute' ? 60 : 1) + Number(m[4] ?? 0);
    lobby.countdown = { endsAt: now + seconds * 1000, starts: !m[1].startsWith('Countdown') };
  } else if ((m = text.match(pattern.settingsChanged))) {
    lobby.teamMode = m[1];
    if (m[2]) lobby.winCondition = m[2];
  } else if ((m = text.match(pattern.modsChanged))) {
    lobby.freemod = m[2] === 'enabled';
    lobby.mods = m[1] ? shortMods(m[1]) : [];
  } else if (text === 'Aborted the match start timer') {
    lobby.countdown = null;
  } else if (text === 'Invalid map ID provided' || text.startsWith('User not found')) {
    events.push({ type: 'problem', text });
  }
  return events;
}

const FREEMOD_ALLOWED = new Set(['HD', 'HR', 'EZ', 'FL', 'NF']);
const ircName = (name) => name.replaceAll(' ', '_');

/** Regelcheck der Lobby gegen Roster und aktuellen Pick. Team a ist Rot, Team b ist Blau. */
export function checkLobby(lobby, { config, entry, rules, teamOf }) {
  const issues = [];
  const seen = { a: 0, b: 0 };
  const required = rules.teamSize ?? 1;
  for (const [slot, player] of Object.entries(lobby.slots)) {
    const team = teamOf(player.name);
    if (!team) {
      issues.push({ level: 'error', code: 'fremd', player: player.name, text: `${player.name} steht in keinem Roster`, fix: `!mp kick ${ircName(player.name)}` });
      continue;
    }
    seen[team]++;
    const colour = team === 'a' ? 'red' : 'blue';
    if (lobby.teamMode?.includes('Team') && player.team && player.team !== colour) {
      issues.push({ level: 'error', code: 'team', player: player.name, text: `${player.name} ist im falschen Team (Slot ${slot})`, fix: `!mp team ${ircName(player.name)} ${colour}` });
    }
    // osu!tourney geht nur nach Slots: Links sitzen Slot 1 bis TeamSize, rechts die nächsten.
    const first = team === 'a' ? 1 : required + 1;
    const last = first + required - 1;
    if (Number(slot) < first || Number(slot) > last) {
      let free = null;
      for (let wanted = first; wanted <= last && free === null; wanted++) if (!lobby.slots[wanted]) free = wanted;
      issues.push({ level: 'error', code: 'slot', player: player.name, text: `${player.name} sitzt in Slot ${slot}, gehört auf ${first}–${last}`, fix: free ? `!mp move ${ircName(player.name)} ${free}` : undefined });
    }
    if (player.noMap) issues.push({ level: 'warn', code: 'nomap', player: player.name, text: `${player.name} hat die Map nicht` });
    if (lobby.freemod && entry) {
      const illegal = player.mods.filter((mod) => !FREEMOD_ALLOWED.has(mod));
      if (illegal.length) issues.push({ level: 'error', code: 'mods', player: player.name, text: `${player.name} nutzt verbotene Mods: ${illegal.join(', ')}` });
      if (rules.forceNF && !player.mods.includes('NF')) {
        issues.push({ level: 'warn', code: 'nf', player: player.name, text: `${player.name} hat kein NF aktiv` });
      }
    }
  }
  for (const team of ['a', 'b']) {
    if (seen[team] > required) issues.push({ level: 'error', code: 'anzahl', text: `Team ${config.teams[team].name} hat ${seen[team]} statt ${required} Spieler` });
    if (seen[team] < required) issues.push({ level: 'warn', code: 'anzahl', text: `Team ${config.teams[team].name}: ${seen[team]} von ${required} Spielern da` });
  }
  if (entry && lobby.map && lobby.map.id !== entry.mapId) {
    issues.push({ level: 'error', code: 'map', text: `Lobby-Map ${lobby.map.id} passt nicht zu ${entry.slot}`, fix: `!mp map ${entry.mapId}` });
  }
  return issues;
}
