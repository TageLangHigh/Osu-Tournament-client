// Reine Match-Logik. Keine Ein-/Ausgabe, damit Server, Tests und Konsole dasselbe rechnen.
// Der Zustand entsteht immer aus der Ereignisliste: das macht Undo trivial und
// sorgt dafür, dass nach einem Absturz nichts verloren geht.

export const WIN_CONDITIONS = ['score', 'accuracy', 'combo', 'misses'];

export const DEFAULT_RULES = Object.freeze({
  bestOf: 7,
  bans: 1,
  protects: 0,
  banOrder: 'ABAB',
  winCondition: 'score',
  countFailed: true,
  abortLimit: 1,
  forceNF: true,
  pickTimer: 120,
  readyTimer: 120,
  startTimer: 10,
});

export class MatchError extends Error {}

export const otherTeam = (team) => (team === 'a' ? 'b' : 'a');
export const winsNeeded = (bestOf) => Math.ceil(bestOf / 2);
export const normName = (name) => String(name ?? '').trim().toLowerCase().replaceAll(' ', '_');

/** Löst UNDO/REDO auf und liefert die wirksamen Ereignisse. */
export function effectiveEvents(events) {
  const applied = [];
  const undone = [];
  for (const event of events) {
    if (event.t === 'UNDO') {
      if (applied.length) undone.push(applied.pop());
    } else if (event.t === 'REDO') {
      if (undone.length) applied.push(undone.pop());
    } else {
      undone.length = 0;
      applied.push(event);
    }
  }
  return { applied, redoable: undone.length };
}

function initialState(config) {
  return {
    phase: 'roll',
    step: null,
    roll: null,
    first: null,
    protects: [],
    bans: [],
    picks: [],
    games: [],
    points: { a: 0, b: 0 },
    aborts: { a: 0, b: 0 },
    adjustments: [],
    winner: null,
    rules: { ...DEFAULT_RULES, ...config.rules },
  };
}

const slotOf = (config, name) => config.pool.find((entry) => entry.slot === name);
const isTiebreaker = (entry) => entry?.mod === 'TB';
const activeGame = (state) => {
  const game = state.games.at(-1);
  return game && game.status !== 'done' ? game : null;
};

function banSequence(state) {
  const a = state.first.ban;
  const b = otherTeam(a);
  const order = state.rules.banOrder === 'ABBA' ? [a, b, b, a] : [a, b];
  const sequence = [];
  for (let i = 0; i < state.rules.bans * 2; i++) sequence.push(order[i % order.length]);
  return sequence;
}

function protectSequence(state) {
  const a = state.first.ban;
  const sequence = [];
  for (let i = 0; i < state.rules.protects * 2; i++) sequence.push(i % 2 ? otherTeam(a) : a);
  return sequence;
}

function computeStep(state, config) {
  if (state.winner) return { kind: 'done' };
  if (!state.roll) return { kind: 'roll' };
  if (!state.first) return { kind: 'first', team: state.roll.a > state.roll.b ? 'a' : 'b' };

  const protects = protectSequence(state);
  if (state.protects.length < protects.length) return { kind: 'protect', team: protects[state.protects.length] };

  const bans = banSequence(state);
  if (state.bans.length < bans.length) return { kind: 'ban', team: bans[state.bans.length] };

  const game = activeGame(state);
  if (game) return { kind: game.status === 'result' ? 'confirm' : game.status === 'playing' ? 'playing' : 'start', slot: game.slot };

  const needed = winsNeeded(state.rules.bestOf);
  if (state.points.a === needed - 1 && state.points.b === needed - 1) {
    const tiebreaker = config.pool.find(isTiebreaker);
    if (tiebreaker && !state.picks.some((pick) => pick.slot === tiebreaker.slot)) {
      return { kind: 'pick', team: null, forced: tiebreaker.slot };
    }
  }
  const played = state.picks.filter((pick) => !isTiebreaker(slotOf(config, pick.slot))).length;
  return { kind: 'pick', team: played % 2 === 0 ? state.first.pick : otherTeam(state.first.pick) };
}

function computePhase(state) {
  const { kind } = state.step;
  if (kind === 'done') return 'finished';
  if (kind === 'roll' || kind === 'first') return 'roll';
  if (kind === 'protect' || kind === 'ban' || kind === 'pick') return 'draft';
  if (kind === 'start') return 'ready';
  if (kind === 'playing') return 'playing';
  return 'result';
}

/** Welche Pool-Slots sind für den aktuellen Schritt noch wählbar? */
export function availableSlots(state, config) {
  const { kind, forced } = state.step;
  if (forced) return [forced];
  if (kind !== 'protect' && kind !== 'ban' && kind !== 'pick') return [];
  const banned = new Set(state.bans.map((entry) => entry.slot));
  const picked = new Set(state.picks.map((entry) => entry.slot));
  const protectedSlots = new Set(state.protects.map((entry) => entry.slot));
  return config.pool
    .filter((entry) => {
      if (isTiebreaker(entry) || banned.has(entry.slot) || picked.has(entry.slot)) return false;
      if (kind === 'ban' && protectedSlots.has(entry.slot)) return false;
      if (kind === 'protect' && protectedSlots.has(entry.slot)) return false;
      return true;
    })
    .map((entry) => entry.slot);
}

function requireStep(state, kinds, event) {
  if (!kinds.includes(state.step.kind)) {
    throw new MatchError(`${event.t} geht gerade nicht, erwartet wird: ${state.step.kind}`);
  }
}

function requireChoice(state, config, event) {
  if (!slotOf(config, event.slot)) throw new MatchError(`Slot ${event.slot} gibt es in diesem Pool nicht`);
  if (!availableSlots(state, config).includes(event.slot)) throw new MatchError(`${event.slot} ist nicht mehr wählbar`);
  if (state.step.team && event.team !== state.step.team) {
    throw new MatchError(`Team ${state.step.team.toUpperCase()} ist an der Reihe`);
  }
}

/** Ordnet Spieler dem Roster zu. Fremde Spieler zählen nie mit, werden aber gemeldet. */
export function teamOfPlayer(config, name) {
  const wanted = normName(name);
  for (const team of ['a', 'b']) {
    if (config.teams[team].players.some((player) => normName(player.name ?? player) === wanted)) return team;
  }
  return null;
}

export function scoreGame(scores, rules, config) {
  const condition = rules.winCondition ?? DEFAULT_RULES.winCondition;
  const countFailed = rules.countFailed ?? DEFAULT_RULES.countFailed;
  const totals = { a: 0, b: 0 };
  const counted = { a: 0, b: 0 };
  const warnings = [];
  const rows = scores.map((row) => {
    const team = teamOfPlayer(config, row.name) ?? null;
    if (!team) warnings.push(`${row.name} steht in keinem Roster und zählt nicht`);
    return { ...row, team };
  });

  for (const row of rows) {
    if (!row.team) continue;
    const dropped = !row.passed && !countFailed;
    const value = dropped ? 0 : {
      score: row.score ?? 0,
      accuracy: row.accuracy ?? 0,
      combo: row.combo ?? 0,
      misses: row.misses ?? 0,
    }[condition];
    if (condition === 'combo') totals[row.team] = Math.max(totals[row.team], value);
    else totals[row.team] += value;
    counted[row.team]++;
  }
  if (condition === 'accuracy') {
    for (const team of ['a', 'b']) totals[team] = counted[team] ? totals[team] / counted[team] : 0;
  }

  for (const team of ['a', 'b']) {
    if (!counted[team]) warnings.push(`Kein Ergebnis für Team ${team.toUpperCase()}`);
  }

  const lowerWins = condition === 'misses';
  let winner = null;
  if (totals.a !== totals.b) {
    winner = (totals.a > totals.b) !== lowerWins ? 'a' : 'b';
  }
  if (!counted.a && counted.b) winner = 'b';
  if (!counted.b && counted.a) winner = 'a';
  if (!counted.a && !counted.b) winner = null;
  return { rows, totals, winner, tie: winner === null, warnings };
}

function refreshPoints(state) {
  const points = { a: 0, b: 0 };
  for (const game of state.games) if (game.status === 'done' && game.winner) points[game.winner]++;
  for (const adjustment of state.adjustments) points[adjustment.team] += adjustment.delta;
  state.points = points;
  const needed = winsNeeded(state.rules.bestOf);
  state.winner = points.a >= needed ? 'a' : points.b >= needed ? 'b' : null;
}

function applyEvent(state, event, config) {
  switch (event.t) {
    case 'ROLL': {
      requireStep(state, ['roll'], event);
      if (!(event.a >= 0 && event.b >= 0) || event.a === event.b) throw new MatchError('Roll braucht zwei verschiedene Zahlen');
      state.roll = { a: event.a, b: event.b };
      break;
    }
    case 'FIRST': {
      requireStep(state, ['first'], event);
      if (!['a', 'b'].includes(event.pick)) throw new MatchError('Erster Pick braucht Team a oder b');
      state.first = { pick: event.pick, ban: event.ban ?? otherTeam(event.pick) };
      break;
    }
    case 'PROTECT':
      requireStep(state, ['protect'], event);
      requireChoice(state, config, event);
      state.protects.push({ team: event.team, slot: event.slot });
      break;
    case 'BAN':
      requireStep(state, ['ban'], event);
      requireChoice(state, config, event);
      state.bans.push({ team: event.team, slot: event.slot });
      break;
    case 'PICK': {
      requireStep(state, ['pick'], event);
      requireChoice(state, config, event);
      const team = event.team ?? null;
      state.picks.push({ team, slot: event.slot });
      state.games.push({ slot: event.slot, team, status: 'pending', attempts: 0 });
      break;
    }
    case 'START': {
      requireStep(state, ['start'], event);
      const game = activeGame(state);
      game.status = 'playing';
      game.attempts++;
      break;
    }
    case 'ABORT': {
      const game = activeGame(state);
      if (!game || game.status === 'done') throw new MatchError('Es läuft kein Spiel');
      game.status = 'pending';
      delete game.result;
      if (event.team) {
        state.aborts[event.team]++;
        game.abortedBy = event.team;
      }
      break;
    }
    case 'RESULT': {
      requireStep(state, ['playing', 'start'], event);
      const game = activeGame(state);
      game.status = 'result';
      game.result = { ...scoreGame(event.scores, state.rules, config), source: event.source ?? 'manuell' };
      break;
    }
    case 'CONFIRM': {
      requireStep(state, ['confirm'], event);
      const game = activeGame(state);
      const winner = event.winner ?? game.result?.winner;
      if (!['a', 'b'].includes(winner)) throw new MatchError('Unentschieden: Bitte Gewinner von Hand wählen oder Rematch');
      game.status = 'done';
      game.winner = winner;
      game.overridden = Boolean(event.winner && event.winner !== game.result?.winner);
      break;
    }
    case 'VOID': {
      // Gespielte Map komplett entfernen, Pick bleibt erhalten und kann neu gestartet werden.
      const game = state.games[event.game];
      if (!game) throw new MatchError('Dieses Spiel gibt es nicht');
      game.status = 'pending';
      delete game.result;
      delete game.winner;
      if (state.games.at(-1) !== game) throw new MatchError('Nur das letzte Spiel kann neu gewertet werden');
      break;
    }
    case 'ADJUST':
      if (!['a', 'b'].includes(event.team) || !Number.isInteger(event.delta)) throw new MatchError('Punktkorrektur ungültig');
      if (!event.reason) throw new MatchError('Punktkorrektur braucht eine Begründung');
      state.adjustments.push({ team: event.team, delta: event.delta, reason: event.reason });
      break;
    default:
      throw new MatchError(`Unbekanntes Ereignis ${event.t}`);
  }
  refreshPoints(state);
  state.step = computeStep(state, config);
  state.phase = computePhase(state);
  return state;
}

export function replayMatch(config, events) {
  const { applied, redoable } = effectiveEvents(events);
  const state = initialState(config);
  state.step = computeStep(state, config);
  state.phase = computePhase(state);
  for (const event of applied) applyEvent(state, event, config);
  state.available = availableSlots(state, config);
  state.canUndo = applied.length > 0;
  state.canRedo = redoable > 0;
  return state;
}

/** Prüft ein Ereignis, ohne etwas zu speichern. Wirft MatchError bei Regelverstoß. */
export function validateEvent(config, events, event) {
  return replayMatch(config, [...events, event]);
}

/** Auto-Regie: Die Szene hängt nur am Match-Zustand, nie an der Map, die gerade in der Lobby liegt. */
export function sceneFor(state) {
  switch (state.phase) {
    case 'roll': return 'intro';
    case 'draft': return 'mappool';
    case 'ready': return 'gameplay';
    case 'playing': return 'gameplay';
    case 'result': return 'gameplay';
    case 'finished': return 'winner';
    default: return 'intro';
  }
}

/** Lobby-Befehle für einen gewählten Pool-Slot. */
export function commandsForPick(entry, rules, mode = 0) {
  const commands = [`!mp map ${entry.mapId} ${mode}`];
  if (entry.mod === 'FM' || entry.mod === 'TB') {
    commands.push('!mp mods Freemod');
  } else {
    const mods = entry.mod === 'NM' ? [] : entry.mod.match(/.{2}/g) ?? [];
    if (rules.forceNF) mods.unshift('NF');
    commands.push(mods.length ? `!mp mods ${mods.join(' ')}` : '!mp mods None');
  }
  if (rules.readyTimer > 0) commands.push(`!mp timer ${rules.readyTimer}`);
  return commands;
}

export function roomName(tournament, nameA, nameB) {
  return `${tournament.acronym}: (${nameA}) vs (${nameB})`;
}
