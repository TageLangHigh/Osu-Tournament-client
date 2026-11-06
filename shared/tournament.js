// Turnier-Modell, Bracket-Erzeugung und Einlesen von Tabellen-Text.

import { DEFAULT_RULES } from './match.js';

export const MOD_ORDER = ['NM', 'HD', 'HR', 'DT', 'FM', 'EZ', 'FL', 'TB'];

export function newTournament(name = 'Neues Turnier', acronym = 'CUP') {
  return {
    id: `t-${Date.now().toString(36)}`,
    name,
    acronym,
    theme: { accent: '#d7ff3f', teamA: '#ff5a5f', teamB: '#35a7ff' },
    teamSize: 1,
    gameMode: 0,
    timezone: 'Europe/Berlin',
    teams: [],
    rounds: [{ id: 'r1', name: 'Runde 1', rules: { ...DEFAULT_RULES }, pool: [] }],
    matches: [],
  };
}

/** Standard-Setzliste, damit sich die Topseeds erst im Finale treffen. */
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const next = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, next - seed]);
  }
  return order;
}

const roundTitle = (matchCount) => ({ 1: 'Finale', 2: 'Halbfinale', 4: 'Viertelfinale', 8: 'Achtelfinale' }[matchCount] ?? `Runde der ${matchCount * 2}`);

function assignRound(tournament, name, index) {
  return tournament.rounds.find((round) => round.name === name)?.id ?? tournament.rounds[Math.min(index, tournament.rounds.length - 1)]?.id;
}

export function advance(matches, match, winnerId, loserId) {
  match.result = { ...(match.result ?? {}), winner: winnerId };
  const target = matches.find((entry) => entry.id === match.winnerTo?.id);
  if (target) target[match.winnerTo.side === 'a' ? 'teamA' : 'teamB'] = winnerId;
  const dropTo = matches.find((entry) => entry.id === match.loserTo?.id);
  if (dropTo && loserId) dropTo[match.loserTo.side === 'a' ? 'teamA' : 'teamB'] = loserId;
}

/** Erzeugt Matches für Single oder Double Elimination. Kein Teamlimit, Freilose laufen automatisch weiter. */
export function generateBracket(tournament, format = 'single') {
  const teams = [...tournament.teams].sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9));
  if (teams.length < 2) throw new Error('Mindestens zwei Teams nötig');
  const size = 2 ** Math.ceil(Math.log2(teams.length));
  const order = seedOrder(size);
  const matches = [];
  const add = (match) => {
    const entry = { teamA: null, teamB: null, winnerTo: null, loserTo: null, schedule: null, ...match };
    matches.push(entry);
    return entry;
  };

  const upper = [];
  let count = size / 2;
  for (let depth = 0; count >= 1; depth++, count /= 2) {
    const title = format === 'double' && count === 1 ? 'Upper Finale' : roundTitle(count);
    upper.push(Array.from({ length: count }, (_, i) => add({
      id: `U${depth + 1}-${i + 1}`, bracket: 'upper', depth, index: i, title,
      roundId: assignRound(tournament, title, depth),
    })));
  }
  upper.forEach((round, depth) => round.forEach((match, i) => {
    const next = upper[depth + 1]?.[i >> 1];
    if (next) match.winnerTo = { id: next.id, side: i % 2 ? 'b' : 'a' };
  }));
  upper[0].forEach((match, i) => {
    match.teamA = teams[order[i * 2] - 1]?.id ?? null;
    match.teamB = teams[order[i * 2 + 1] - 1]?.id ?? null;
  });

  if (format === 'double' && size >= 4) {
    const lower = [];
    let width = size / 4;
    for (let depth = 0; width >= 1; depth++) {
      lower.push(Array.from({ length: width }, (_, i) => add({
        id: `L${depth + 1}-${i + 1}`, bracket: 'lower', depth, index: i,
        title: `Lower Runde ${depth + 1}`,
        roundId: assignRound(tournament, `Lower Runde ${depth + 1}`, Math.ceil(depth / 2) + 1),
      })));
      if (depth % 2 === 1) width /= 2;
    }
    upper[0].forEach((match, i) => { match.loserTo = { id: lower[0][i >> 1].id, side: i % 2 ? 'b' : 'a' }; });
    for (let u = 1; u < upper.length; u++) {
      const target = lower[u * 2 - 1];
      if (!target) continue;
      // Gespiegelt einsortieren, damit Rematches möglichst spät kommen.
      upper[u].forEach((match, i) => { match.loserTo = { id: target[target.length - 1 - i].id, side: 'b' }; });
    }
    lower.forEach((round, depth) => round.forEach((match, i) => {
      const next = lower[depth + 1];
      if (!next) return;
      if (depth % 2 === 0) match.winnerTo = { id: next[i].id, side: 'a' };
      else match.winnerTo = { id: next[i >> 1].id, side: i % 2 ? 'b' : 'a' };
    }));
    const finale = add({ id: 'GF', bracket: 'final', depth: upper.length, index: 0, title: 'Grand Finale', roundId: tournament.rounds.at(-1)?.id });
    upper.at(-1)[0].winnerTo = { id: finale.id, side: 'a' };
    lower.at(-1)[0].winnerTo = { id: finale.id, side: 'b' };
  }

  // Freilose: Wer keinen Gegner hat, rückt sofort weiter.
  for (const match of upper[0]) {
    if (Boolean(match.teamA) !== Boolean(match.teamB)) {
      match.bye = true;
      advance(matches, match, match.teamA ?? match.teamB, null);
    }
  }
  tournament.matches = matches;
  return matches;
}

const cells = (line) => line.split(/\t|\s*\|\s*|\s*;\s*/).map((cell) => cell.trim());

/** Zeilen: Name | KÜRZEL | Spieler1, Spieler2 | Seed. Tabs aus Google Sheets gehen genauso. */
export function parseTeams(text, previous = []) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [name, acronym, players = '', seed] = cells(line);
    const old = previous.find((team) => team.name === name);
    return {
      id: old?.id ?? `team${index + 1}-${Date.now().toString(36)}`,
      name,
      acronym: acronym || name.slice(0, 4).toUpperCase(),
      flag: old?.flag ?? '',
      seed: Number(seed) || index + 1,
      players: (players || name).split(',').map((player) => player.trim()).filter(Boolean)
        .map((playerName) => old?.players.find((p) => p.name === playerName) ?? { name: playerName }),
    };
  });
}

export const formatTeams = (teams) => teams.map((team) => [team.name, team.acronym, team.players.map((p) => p.name).join(', '), team.seed].join(' | ')).join('\n');

/** Zeilen: NM1 | 12345. Akzeptiert auch ganze Beatmap-Links. */
export function parsePool(text, previous = []) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [slotRaw, mapRaw] = cells(line);
    const slot = slotRaw.toUpperCase();
    const mapId = Number(String(mapRaw ?? '').match(/(\d+)\s*$/)?.[1]);
    if (!/^[A-Z]{2}\d*$/.test(slot) || !mapId) throw new Error(`Pool-Zeile nicht lesbar: ${line}`);
    const old = previous.find((entry) => entry.mapId === mapId);
    return { ...old, slot, mod: slot.slice(0, 2), mapId };
  });
}

export const formatPool = (pool) => pool.map((entry) => `${entry.slot} | ${entry.mapId}`).join('\n');
