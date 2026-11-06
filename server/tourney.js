// Richtet das offizielle osu!tourney ein: eigener Ordner, tournament.cfg, Start per Knopf.
// Matchdeck spielt und schaut selbst nicht auf Bancho zu, das bleibt beim offiziellen Client.

import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';

const EXE = 'osu!.exe';
const CONFIG = 'tournament.cfg';
export const MIN_HEIGHT = 568;
export const MAX_HEIGHT = 2160;

export const defaultTourneyFolder = () => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'osu!-tourney');

export function parseCfg(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

/** Ersetzt nur unsere Schlüssel. Puffer-Werte und "privateserver" bleiben, wie sie sind. */
export function renderCfg(existing, { teamSize, acronym, height }) {
  const wanted = { TeamSize: String(teamSize), acronym: acronym.replace(/[\r\n=]/g, ' ').trim(), Height: String(height) };
  const seen = new Set();
  const lines = existing.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const at = line.indexOf('=');
    const key = at > 0 ? line.slice(0, at).trim() : null;
    if (key === null || !(key in wanted)) return line;
    seen.add(key);
    return `${key} = ${wanted[key]}`;
  });
  for (const [key, value] of Object.entries(wanted)) {
    if (!seen.has(key)) lines.push(`${key} = ${value}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function validateHeight(height) {
  const value = Number(height);
  if (!Number.isInteger(value) || value < MIN_HEIGHT || value > MAX_HEIGHT) {
    throw new Error(`Höhe muss zwischen ${MIN_HEIGHT} und ${MAX_HEIGHT} liegen`);
  }
  return value;
}

function runningPaths() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((done) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process 'osu!' -ErrorAction SilentlyContinue).Path"], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      done(error ? [] : stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

const samePath = (a, b) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

/** Vergleicht den Ordner mit dem aktiven Turnier und meldet, was noch fehlt. */
export async function inspectTourney(folder, tournament) {
  const exe = join(folder, EXE);
  const hasExe = existsSync(exe);
  const hasConfig = existsSync(join(folder, CONFIG));
  const cfg = hasConfig ? parseCfg(readFileSync(join(folder, CONFIG), 'utf8')) : {};
  const running = (await runningPaths()).some((path) => samePath(path, exe));
  const teamSizeOk = Boolean(tournament) && Number(cfg.TeamSize) === tournament.teamSize;
  const acronymOk = Boolean(tournament) && cfg.acronym === tournament.acronym;
  const privateServerEmpty = !cfg.privateserver;
  return {
    folder, hasExe, hasConfig, running, teamSizeOk, acronymOk, privateServerEmpty,
    height: Number(cfg.Height) || 720,
    ready: hasExe && hasConfig && teamSizeOk && acronymOk && privateServerEmpty,
  };
}

/** Legt den Ordner an und schreibt die Konfiguration. Nur bei geschlossenem Client erlaubt. */
export async function prepareTourney({ folder, sourceFolder, tournament, height }) {
  const status = await inspectTourney(folder, tournament);
  if (status.running) throw new Error('osu!tourney läuft noch. Bitte erst schließen, die Konfiguration darf nur bei geschlossenem Client geändert werden.');
  const checkedHeight = validateHeight(height);
  mkdirSync(folder, { recursive: true });
  const exe = join(folder, EXE);
  if (!existsSync(exe)) {
    const source = sourceFolder && join(sourceFolder, EXE);
    if (!source || !existsSync(source)) throw new Error('Keine osu!.exe zum Kopieren gefunden');
    copyFileSync(source, exe);
  }
  const path = join(folder, CONFIG);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, renderCfg(existing, { teamSize: tournament.teamSize, acronym: tournament.acronym, height: checkedHeight }));
  return inspectTourney(folder, tournament);
}

export function launchTourney(folder) {
  const exe = join(folder, EXE);
  if (!existsSync(exe)) throw new Error('Erst den Ordner einrichten');
  spawn(exe, [], { cwd: folder, detached: true, stdio: 'ignore' }).unref();
}
