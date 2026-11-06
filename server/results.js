// Führt die Ergebnisquellen zusammen und meldet Widersprüche, statt still eine Quelle zu glauben.
// Hintergrund: Bei der MWC 2021 zeigten Stream, mp-Link und IRC unterschiedliche Scores.

import { normName } from '../shared/match.js';

const key = (row) => normName(row.name);

/**
 * irc: Endstand aus BanchoBot-Zeilen (maßgeblich für den Score)
 * api: Zeilen der API mit Accuracy, Combo und Misses (kann fehlen)
 * live: letzter Live-Stand von tosu oder der Bühne (kann fehlen)
 * departed: Namen, die während der Map gegangen sind
 */
export function mergeResults({ irc = [], api = null, live = null, departed = [] }) {
  const warnings = [];
  const merged = new Map();
  const liveByName = new Map((live ?? []).map((row) => [key(row), row]));
  const apiByName = new Map((api ?? []).map((row) => [key(row), row]));

  for (const row of irc) {
    merged.set(key(row), { name: row.name, score: row.score, passed: row.passed });
  }

  for (const row of api ?? []) {
    const known = merged.get(key(row));
    if (!known) {
      merged.set(key(row), { ...row });
      warnings.push(`${row.name}: nur in der API vorhanden, Score von dort übernommen`);
      continue;
    }
    if (known.score !== row.score) warnings.push(`${row.name}: IRC ${known.score.toLocaleString('de-DE')} und API ${row.score.toLocaleString('de-DE')} weichen ab`);
    known.accuracy = row.accuracy;
    known.combo = row.combo;
    known.misses = row.misses;
    known.mods = row.mods;
  }

  for (const row of merged.values()) {
    const liveRow = liveByName.get(key(row));
    if (liveRow) {
      row.accuracy ??= liveRow.accuracy;
      row.combo ??= liveRow.maxCombo ?? liveRow.combo;
      row.misses ??= liveRow.misses;
      const spread = Math.abs((liveRow.score ?? 0) - row.score) / Math.max(1, row.score);
      if (spread > 0.01) warnings.push(`${row.name}: Live-Anzeige zeigte ${Number(liveRow.score).toLocaleString('de-DE')}, Endstand ${row.score.toLocaleString('de-DE')}`);
    }
  }

  for (const name of departed) {
    if (!merged.has(normName(name))) warnings.push(`${name} hat die Map verlassen und kein Ergebnis`);
  }
  if (!api && !irc.length) warnings.push('Keine Ergebnisquelle verfügbar');
  return { rows: [...merged.values()], warnings, sources: [irc.length ? 'IRC' : null, apiByName.size ? 'API' : null, liveByName.size ? 'Live' : null].filter(Boolean) };
}
