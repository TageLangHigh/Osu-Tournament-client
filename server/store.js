// Dateiablage. Turnier-Dateien werden atomar ersetzt, Match-Ereignisse nur angehängt
// und sofort auf die Platte geschrieben. So überlebt ein Match jeden Absturz.

import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(process.env.MATCHDECK_DATA ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data'));
export const dataPath = (...parts) => join(ROOT, ...parts);

export const safeId = (id) => {
  if (!/^[\w-]{1,64}$/.test(String(id))) throw new Error('Ungültige ID');
  return id;
};

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, 'w');
  writeFileSync(handle, JSON.stringify(value, null, 2));
  fsyncSync(handle);
  closeSync(handle);
  renameSync(temporary, path);
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export const settingsStore = {
  load: () => readJson(dataPath('settings.json'), {}),
  save: (settings) => writeJson(dataPath('settings.json'), settings),
};

// Zugangsdaten liegen getrennt und gehen nie an Browser oder Log.
export const secretStore = {
  load: () => readJson(dataPath('secrets.json'), {}),
  save: (secrets) => writeJson(dataPath('secrets.json'), secrets),
};

export const tournamentStore = {
  list() {
    const directory = dataPath('tournaments');
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .map((id) => readJson(join(directory, id, 'tournament.json')))
      .filter(Boolean)
      .map(({ id, name, acronym }) => ({ id, name, acronym }));
  },
  load: (id) => readJson(dataPath('tournaments', safeId(id), 'tournament.json')),
  save: (tournament) => writeJson(dataPath('tournaments', safeId(tournament.id), 'tournament.json'), tournament),
};

export const matchLog = {
  path: (tournamentId, matchId) => dataPath('tournaments', safeId(tournamentId), 'matches', `${safeId(matchId)}.jsonl`),
  read(tournamentId, matchId) {
    const path = this.path(tournamentId, matchId);
    if (!existsSync(path)) return [];
    const events = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch { /* halb geschriebene letzte Zeile nach Stromausfall verwerfen */ }
    }
    return events;
  },
  append(tournamentId, matchId, event) {
    const path = this.path(tournamentId, matchId);
    mkdirSync(dirname(path), { recursive: true });
    const handle = openSync(path, 'a');
    writeFileSync(handle, `${JSON.stringify(event)}\n`);
    fsyncSync(handle);
    closeSync(handle);
  },
  clear(tournamentId, matchId) {
    rmSync(this.path(tournamentId, matchId), { force: true });
  },
};
