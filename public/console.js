// Regie-Konsole. Sämtliche Regeln liegen im Server, hier wird nur angezeigt und ausgelöst.

import { MOD_ORDER } from '/shared/tournament.js';
import { modNames } from '/shared/beatmap.js';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value) => Math.round(value ?? 0).toLocaleString('de-DE');

let app = null;
let selected = new Set();
const SCENES = [['intro', 'Intro'], ['mappool', 'Mappool'], ['gameplay', 'Gameplay'], ['winner', 'Sieger'], ['bracket', 'Bracket'], ['schedule', 'Spielplan']];

async function post(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    toast(data.error ?? 'Das hat nicht geklappt');
    return null;
  }
  return data;
}

let toastTimer;
function toast(text, ok = false) {
  const box = $('toast');
  box.textContent = text;
  box.className = ok ? 'ok' : '';
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4200);
}

const action = (event) => post('/api/action', event);

/* Statuszeile */

function renderChips() {
  const { conn, overlayViewers } = app;
  const level = (value, good = ['verbunden', 'bereit', 'Demo-Lobby', 'Demo-Daten']) => (good.includes(value) ? 'ok' : /Fehler|abgelehnt/.test(value) ? 'bad' : /verbindet|wiederverbinden|wartet/.test(value) ? 'warn' : '');
  const chip = (label, value, cls) => `<span class="chip ${cls}" title="${esc(value)}"><i></i>${esc(label)}</span>`;
  $('chips').innerHTML = [
    chip('Bancho', conn.irc, level(conn.irc)),
    chip('API', conn.api, level(conn.api)),
    chip('tosu', conn.tosu, level(conn.tosu)),
    chip(`OBS ${overlayViewers}`, 'Offene Overlay-Quellen', overlayViewers ? 'ok' : ''),
  ].join('');
}

/* Match-Ansicht */

function nextStepHtml() {
  const { state, config } = app.match;
  const { step, rules } = state;
  const teams = config.teams;
  const name = (team) => esc(teams[team].name);
  const hasLobby = Boolean(app.lobby.channel);
  switch (step.kind) {
    case 'roll': return { cls: '', html: `<div class="what">Roll eintragen</div>
      <div class="muted small">Wird automatisch erkannt, sobald beide Teams in der Lobby !roll schreiben.</div>
      <div class="row"><input id="rollA" type="number" min="0" max="100" placeholder="${name('a')}" aria-label="Roll ${name('a')}" style="width:46%"><input id="rollB" type="number" min="0" max="100" placeholder="${name('b')}" aria-label="Roll ${name('b')}" style="width:46%"></div>
      <button class="btn primary" data-do="roll">Übernehmen</button>` };
    case 'first': return { cls: step.team, html: `<div class="what">${name(step.team)} gewinnt den Roll</div><div class="muted small">Wer pickt zuerst?</div>
      <div class="row"><button class="btn a" data-do="first" data-pick="a">${name('a')}</button><button class="btn b" data-do="first" data-pick="b">${name('b')}</button></div>` };
    case 'protect': case 'ban': case 'pick': {
      if (step.forced) return { cls: '', html: `<div class="what">Tiebreaker</div><button class="btn primary" data-slot="${esc(step.forced)}">${esc(step.forced)} ansetzen</button>` };
      const verb = { protect: 'schützt', ban: 'bannt', pick: 'pickt' }[step.kind];
      return { cls: step.team, html: `<div class="what">${name(step.team)} ${verb}</div><div class="muted small">Map im Pool anklicken.</div>${hasLobby ? `<button class="btn" data-mp="!mp timer ${rules.pickTimer}">Timer ${rules.pickTimer} s</button>` : ''}` };
    }
    case 'start': {
      const blocking = app.issues.filter((issue) => issue.level === 'error').length;
      return { cls: '', html: `<div class="what">${esc(step.slot)} bereit</div>
        ${blocking ? `<div class="small" style="color:var(--bad)">${blocking} Problem${blocking > 1 ? 'e' : ''} im Regelcheck</div>` : ''}
        <div class="row">${hasLobby ? `<button class="btn primary" data-mp="!mp start ${rules.startTimer}">Start in ${rules.startTimer} s</button><button class="btn" data-mp="!mp timer ${rules.readyTimer}">Bereit-Timer</button><button class="btn" data-mp="!mp settings">Prüfen</button>` : '<button class="btn primary" data-do="start">Als gestartet markieren</button>'}</div>` };
    }
    case 'playing': return { cls: '', html: `<div class="what">${esc(step.slot)} läuft</div>
      <div class="muted small">Abort für: (Limit ${rules.abortLimit} je Team)</div>
      <div class="row"><button class="btn a" data-abort="a" ${state.aborts.a >= rules.abortLimit ? 'title="Limit erreicht"' : ''}>${esc(teams.a.acronym)} ${state.aborts.a}/${rules.abortLimit}</button><button class="btn b" data-abort="b">${esc(teams.b.acronym)} ${state.aborts.b}/${rules.abortLimit}</button><button class="btn danger" data-abort="">Ohne Wertung</button></div>
      ${hasLobby ? '' : '<button class="btn" data-do="manual">Ergebnis von Hand</button>'}` };
    case 'confirm': {
      const game = state.games.at(-1);
      const { result } = game;
      return { cls: result.winner ?? '', html: `<div class="what">${result.tie ? 'Gleichstand' : `${name(result.winner)} gewinnt ${esc(game.slot)}`}</div>
        <div class="small muted">${number(result.totals.a)} : ${number(result.totals.b)} · Quelle: ${esc(result.source)}</div>
        <div class="row">${result.tie ? '' : '<button class="btn primary" data-do="confirm">Bestätigen</button>'}<button class="btn a" data-do="override" data-team="a">${esc(teams.a.acronym)} gewinnt</button><button class="btn b" data-do="override" data-team="b">${esc(teams.b.acronym)} gewinnt</button><button class="btn danger" data-do="rematch">Rematch</button></div>` };
    }
    default: return { cls: state.winner, html: `<div class="what">${name(state.winner)} gewinnt ${state.points.a}:${state.points.b}</div><div class="muted small">Das Bracket ist aktualisiert.</div><div class="row">${hasLobby ? '<button class="btn" data-mp="!mp close">Lobby schließen</button>' : ''}<button class="btn" data-tabjump="tournament">Nächstes Match</button></div>` };
  }
}

function poolHtml() {
  const { state, config } = app.match;
  const groups = [...new Set(config.pool.map((entry) => entry.mod))].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const open = new Set(state.available);
  const statusOf = (slot) => {
    const ban = state.bans.find((entry) => entry.slot === slot);
    if (ban) return { cls: `ban side-${ban.team}`, text: `Ban ${config.teams[ban.team].acronym}` };
    const game = state.games.find((entry) => entry.slot === slot);
    if (game) return { cls: game.team ? `side-${game.team}` : '', text: game.winner ? `Gewinn ${config.teams[game.winner].acronym}` : game.team ? `Pick ${config.teams[game.team].acronym}` : 'Tiebreaker' };
    const protect = state.protects.find((entry) => entry.slot === slot);
    if (protect) return { cls: `side-${protect.team}`, text: `Schutz ${config.teams[protect.team].acronym}` };
    return null;
  };
  return groups.map((mod) => `<div class="poolgroup"><div class="m">${mod}</div><div class="poolcards">${config.pool.filter((entry) => entry.mod === mod).map((entry) => {
    const info = statusOf(entry.slot);
    const clickable = open.has(entry.slot);
    return `<button class="poolcard ${clickable ? 'open' : ''} ${info?.cls ?? ''}" ${clickable ? `data-slot="${esc(entry.slot)}"` : 'tabindex="-1" aria-disabled="true"'}><b>${esc(entry.slot)}</b><span>${esc(info?.text ?? entry.title ?? `Map ${entry.mapId}`)}</span></button>`;
  }).join('')}</div></div>`).join('');
}

function gamesHtml() {
  const { state, config } = app.match;
  const list = state.games.filter((game) => game.result).reverse();
  if (!list.length) return '<div class="muted small">Noch keine Map gespielt.</div>';
  return list.map((game) => {
    const rows = game.result.rows.map((row) => `<tr><td style="color:var(--team-${row.team ?? 'x'})">${esc(row.name)}</td><td class="n">${number(row.score)}</td><td class="n">${row.accuracy != null ? `${row.accuracy.toFixed(2)} %` : ''}</td><td class="n">${row.combo != null ? `${row.combo}x` : ''}</td><td class="n">${row.misses ?? ''}</td></tr>`).join('');
    return `<div class="game ${game.winner ?? game.result.winner ?? ''}"><b>${esc(game.slot)}</b> <span class="muted small">${game.winner ? `${esc(config.teams[game.winner].name)} gewinnt${game.overridden ? ' (von Hand)' : ''}` : 'offen'}${game.attempts > 1 ? ` · Versuch ${game.attempts}` : ''}</span><table>${rows}</table></div>`;
  }).join('');
}

function issuesHtml() {
  if (!app.lobby.channel) return '<div class="muted small">Keine Lobby verbunden.</div>';
  if (!app.issues.length) return '<div class="clean">Alles in Ordnung</div>';
  return app.issues.map((issue) => `<div class="issue ${issue.level}"><span>${esc(issue.text)}</span>${issue.fix ? `<button class="btn" data-mp="${esc(issue.fix)}">Beheben</button>` : ''}</div>`).join('');
}

function lobbyHtml() {
  const { lobby } = app;
  if (!lobby.channel) {
    return `<div class="row"><button class="btn primary" data-do="makeLobby">Lobby erstellen</button></div>
      <div class="row"><input id="attachId" placeholder="mp-Link oder ID" aria-label="mp-Link oder ID" class="grow" style="width:auto"><button class="btn" data-do="attach">Verbinden</button></div>`;
  }
  const slots = Object.entries(lobby.slots).sort((a, b) => a[0] - b[0]).map(([slot, player]) => `<div class="slot ${player.team ?? ''}"><span class="muted">${esc(slot)}</span><span>${esc(player.name)}</span><span class="muted">${esc(player.mods.join(' '))}</span><span class="${player.ready ? 'ready' : 'muted'}">${player.ready ? 'bereit' : ''}</span></div>`).join('');
  return `<div class="small muted">mp ${esc(lobby.mpId)}${lobby.map ? ` · ${esc(lobby.map.title)}` : ''}</div>${slots || '<div class="muted small">Niemand da.</div>'}
    <div class="row"><button class="btn" data-mp="!mp settings">Aktualisieren</button><button class="btn" data-mp="!mp timer 60">Timer 60</button><button class="btn" data-mp="!mp aborttimer">Timer weg</button></div>`;
}

function renderMatchIdle() {
  const { tournament } = app;
  $('sideTitle').textContent = 'Match öffnen';
  put('board', '<div class="t">Kein Match offen</div>');
  $('roundLine').textContent = tournament?.name ?? '';
  $('next').className = 'next';
  put('next', '<div class="what">Bereit</div><div class="row"><button class="btn primary" data-do="demo">Demo starten</button><button class="btn" data-tabjump="tournament">Turnier anlegen</button></div>');
  $('undo').disabled = true;
  $('redo').disabled = true;
  put('issues', '<div class="muted small">Keine Lobby verbunden.</div>');
  put('games', '');
  put('lobby', '<div class="muted small">Erst ein Match öffnen.</div>');
  put('log', '');
  const teamName = (id) => esc(tournament?.teams.find((team) => team.id === id)?.name ?? 'Offen');
  const open = (tournament?.matches ?? []).filter((match) => match.teamA && match.teamB && !match.result?.winner);
  put('pool', open.map((match) => `<button class="poolcard open" data-open="${esc(match.id)}"><b>${teamName(match.teamA)} gegen ${teamName(match.teamB)}</b><span>${esc(match.title ?? match.id)}</span></button>`).join('') || '<div class="muted small">Kein offenes Match. Lege im Tab Turnier Teams und ein Bracket an.</div>');
}

const put = (id, html) => {
  const node = $(id);
  if (node && node.renderedHtml !== html) {
    node.renderedHtml = html;
    node.innerHTML = html;
  }
};

function ensureDeck() {
  if ($('deck')) return;
  $('matchView').innerHTML = `<div class="deck" id="deck">
    <div class="stagebox"><div class="stagefit" id="stageFit"><video id="liveVideo" autoplay muted playsinline hidden></video><iframe id="previewFrame" src="/overlay?preview" title="Spielansicht"></iframe></div></div>
    <aside class="side">
      <div class="pane" id="alertsPane" hidden><div id="alerts" class="stack"></div></div>
      <div class="pane"><h2 id="sideTitle">Mappool</h2><div id="pool" class="stack"></div></div>
      <div class="pane"><h2>Regelcheck</h2><div id="issues" class="stack"></div></div>
      <div class="pane"><h2>Ergebnisse</h2><div class="games" id="games"></div></div>
      <div class="pane"><h2>Automatik</h2><div id="autos" class="stack"></div></div>
      <div class="pane"><h2>Protokoll</h2><div class="log" id="log"></div></div>
    </aside>
    <div class="control">
      <div class="cell score"><div class="board" id="board"></div><div class="small muted" id="roundLine"></div><div class="row"><button class="btn" id="undo" data-do="undo" title="Strg+Z">Rückgängig</button><button class="btn" id="redo" data-do="redo" title="Strg+Y">Wiederholen</button></div></div>
      <div class="cell"><div class="next" id="next"></div></div>
      <div class="cell"><h2>Lobby</h2><div id="lobby" class="stack"></div></div>
      <div class="cell chat"><div class="chatbox" id="chatBox"></div><form id="chatForm" class="row"><input id="chatInput" class="grow" style="width:auto" placeholder="Nachricht oder !mp Befehl" aria-label="Nachricht an die Lobby" autocomplete="off"><button class="btn">Senden</button></form></div>
      <div class="cell"><h2>Szene</h2><div class="scenes" id="scenes"></div></div>
    </div></div>`;
  const stage = document.querySelector('.stagebox');
  new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    const scale = Math.min(width / 16, height / 9);
    $('stageFit').style.width = `${scale * 16}px`;
    $('stageFit').style.height = `${scale * 9}px`;
  }).observe(stage);
}

let captureTried = 0;
async function syncLiveVideo() {
  const video = $('liveVideo');
  const wanted = app.settings.gameplaySource === 'capture' && navigator.userAgent.includes('Electron');
  if (!wanted) {
    video.srcObject?.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
    video.hidden = true;
    return;
  }
  if (video.srcObject?.active || Date.now() - captureTried < 5000) return;
  captureTried = Date.now();
  try {
    video.srcObject = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false });
    video.hidden = false;
  } catch {
    video.hidden = true; // osu!tourney läuft noch nicht, der nächste Versuch kommt von selbst.
  }
}

function renderMatch() {
  ensureDeck();
  syncLiveVideo();
  put('scenes', SCENES.map(([id, label]) => `<button class="btn ${app.scenePin === id ? 'pinned' : app.scene === id ? 'live' : ''}" data-scene="${id}">${label}</button>`).join(''));
  put('autos', [['autoSend', 'Map und Mods beim Pick setzen'], ['autoStart', 'Bei allen bereit automatisch starten'], ['autoConfirm', 'Saubere Ergebnisse automatisch werten']].map(([key, label]) => `<label class="check small"><input type="checkbox" data-setting="${key}" ${app.settings[key] ? 'checked' : ''}>${label}</label>`).join(''));
  $('alertsPane').hidden = !app.alerts.length;
  put('alerts', app.alerts.map((item) => `<div class="alert ${item.level}"><span class="grow">${esc(item.text)}</span>${item.action ? `<button class="btn danger" data-alert="${esc(item.id)}">${esc(item.action.label)}</button>` : ''}<button class="btn" data-dismiss="${esc(item.id)}" aria-label="Schließen">✕</button></div>`).join(''));

  const chat = $('chatBox');
  const follow = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 30;
  put('chatBox', app.chat.map((line) => `<div class="line ${line.from === 'BanchoBot' ? 'bot' : ''}"><b>${esc(line.from)}</b> ${esc(line.text)}</div>`).join(''));
  if (follow) chat.scrollTop = chat.scrollHeight;

  if (!app.match) {
    renderMatchIdle();
    return;
  }
  const { state, config, round } = app.match;
  const step = nextStepHtml();
  $('sideTitle').textContent = 'Mappool';
  put('board', `<div class="t a">${esc(config.teams.a.name)}</div><div class="p">${state.points.a} : ${state.points.b}</div><div class="t b">${esc(config.teams.b.name)}</div>`);
  $('roundLine').textContent = `${round} · Best of ${state.rules.bestOf} · ${{ score: 'Score', accuracy: 'Accuracy', combo: 'Combo', misses: 'Misses' }[state.rules.winCondition]}`;
  $('next').className = `next ${step.cls ?? ''}`;
  put('next', step.html);
  $('undo').disabled = !state.canUndo;
  $('redo').disabled = !state.canRedo;
  put('issues', issuesHtml());
  put('pool', poolHtml());
  put('games', gamesHtml());
  put('lobby', lobbyHtml());
  put('log', app.match.log.slice(-14).reverse().map((event) => `<div>${new Date(event.at).toLocaleTimeString('de-DE')} ${esc(event.by)} ${esc(event.t)} ${esc(event.slot ?? event.team ?? '')}</div>`).join(''));
}

/* Turnier-Ansicht */

let editing = false;
function renderTournament() {
  const box = $('tournamentView');
  if (box.contains(document.activeElement) && document.activeElement.matches('input,textarea,select')) return;
  if (editing) return;
  const { tournament, tournaments, teamsText, poolTexts } = app;
  const picker = `<div class="card-p"><h2>Turniere</h2><div class="row">
    <select id="tournamentPick" aria-label="Turnier wählen" style="width:auto;min-width:260px">${tournaments.map((item) => `<option value="${esc(item.id)}" ${item.id === tournament?.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}${tournaments.length ? '' : '<option>Noch keins</option>'}</select>
    <button class="btn" data-do="newTournament">Neu</button>
    ${tournament ? '<a class="btn" href="/api/tournament/export" download style="text-decoration:none">Exportieren</a>' : ''}
    <label class="btn">Importieren<input id="importTournament" type="file" accept=".json" hidden></label>
    <button class="btn" data-do="demo">Demo laden</button></div>
    <div class="small muted">Jedes Turnier hat eigene Teams, Pools, Farben und Matches. Umschalten geht jederzeit, nichts muss kopiert werden.</div></div>`;
  if (!tournament) {
    box.innerHTML = `<div class="page">${picker}</div>`;
    return;
  }
  const rounds = tournament.rounds.map((round) => `<div class="card-p" data-round="${esc(round.id)}">
    <div class="row"><input data-r="name" value="${esc(round.name)}" aria-label="Rundenname" style="width:240px;font-weight:600"><span class="grow"></span><button class="btn" data-do="enrich" data-round-id="${esc(round.id)}">Map-Daten laden</button><button class="btn primary" data-do="saveRound" data-round-id="${esc(round.id)}">Runde speichern</button></div>
    <div class="grid4">
      <label class="field">Best of<input data-rule="bestOf" type="number" min="1" step="2" value="${round.rules.bestOf}"></label>
      <label class="field">Bans je Team<input data-rule="bans" type="number" min="0" value="${round.rules.bans}"></label>
      <label class="field">Protects je Team<input data-rule="protects" type="number" min="0" value="${round.rules.protects}"></label>
      <label class="field">Ban-Reihenfolge<select data-rule="banOrder"><option ${round.rules.banOrder === 'ABAB' ? 'selected' : ''}>ABAB</option><option ${round.rules.banOrder === 'ABBA' ? 'selected' : ''}>ABBA</option></select></label>
      <label class="field">Siegbedingung<select data-rule="winCondition">${[['score', 'Score'], ['accuracy', 'Accuracy'], ['combo', 'Combo'], ['misses', 'Wenigste Misses']].map(([value, label]) => `<option value="${value}" ${round.rules.winCondition === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="field">Aborts je Team<input data-rule="abortLimit" type="number" min="0" value="${round.rules.abortLimit}"></label>
      <label class="field">Bereit-Timer (s)<input data-rule="readyTimer" type="number" min="0" value="${round.rules.readyTimer}"></label>
      <label class="field">Pick-Timer (s)<input data-rule="pickTimer" type="number" min="0" value="${round.rules.pickTimer}"></label>
    </div>
    <div class="row"><label class="check small"><input type="checkbox" data-rule="forceNF" ${round.rules.forceNF ? 'checked' : ''}>NF erzwingen</label><label class="check small"><input type="checkbox" data-rule="countFailed" ${round.rules.countFailed ? 'checked' : ''}>Fails zählen</label></div>
    <label class="field">Pool: eine Zeile je Map, Slot und ID oder Link. Einfügen aus Tabellen geht direkt.<textarea data-r="pool" rows="7" placeholder="NM1 | 123456&#10;HD1 | https://osu.ppy.sh/b/654321&#10;TB | 777777">${esc(poolTexts[round.id] ?? '')}</textarea></label>
  </div>`).join('');
  const teamName = (id) => esc(tournament.teams.find((team) => team.id === id)?.name ?? 'Offen');
  const matches = tournament.matches.map((match) => `<div class="matchrow"><span class="muted">${esc(match.id)}</span><span class="muted">${esc(match.title ?? '')}</span><span>${teamName(match.teamA)}</span><span class="muted">${match.result?.points ? `${match.result.points.a}:${match.result.points.b}` : 'gegen'}</span><span>${teamName(match.teamB)}</span><span class="muted small">${match.schedule ? esc(new Date(match.schedule).toLocaleString('de-DE', { timeZone: tournament.timezone || undefined, dateStyle: 'short', timeStyle: 'short' })) : ''}</span>${match.teamA && match.teamB && !match.bye ? `<button class="btn" data-open="${esc(match.id)}">Öffnen</button>` : '<span></span>'}</div>`).join('');

  box.innerHTML = `<div class="page">${picker}
    <div class="card-p"><h2>Grunddaten</h2><div class="grid4">
      <label class="field">Name<input id="tName" value="${esc(tournament.name)}"></label>
      <label class="field">Kürzel<input id="tAcronym" value="${esc(tournament.acronym)}"></label>
      <label class="field">Spieler je Team<input id="tSize" type="number" min="1" max="8" value="${tournament.teamSize}"></label>
      <label class="field">Zeitzone<input id="tZone" value="${esc(tournament.timezone)}"></label>
      <label class="field">Akzent<input id="tAccent" type="color" value="${esc(tournament.theme.accent)}"></label>
      <label class="field">Team Rot<input id="tTeamA" type="color" value="${esc(tournament.theme.teamA)}"></label>
      <label class="field">Team Blau<input id="tTeamB" type="color" value="${esc(tournament.theme.teamB)}"></label>
    </div>
    <label class="field">Teams: Name | Kürzel | Spieler, Spieler | Seed<textarea id="tTeams" rows="7">${esc(teamsText)}</textarea></label>
    <div class="row"><button class="btn primary" data-do="saveTournament">Speichern</button></div></div>
    <h3>Runden</h3>${rounds}<div class="row"><button class="btn" data-do="addRound">Runde hinzufügen</button></div>
    <div class="card-p"><h2>Matches</h2><div class="row"><button class="btn" data-do="bracket" data-format="single">Single Elimination erzeugen</button><button class="btn" data-do="bracket" data-format="double">Double Elimination erzeugen</button><span class="small muted">Beliebig viele Teams, Freilose laufen automatisch weiter. Erzeugen ersetzt bestehende Bracket-Matches.</span></div>
    <div class="row"><select id="quickA" aria-label="Team 1" style="width:auto">${tournament.teams.map((team) => `<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('')}</select><span class="muted">gegen</span><select id="quickB" aria-label="Team 2" style="width:auto">${tournament.teams.map((team) => `<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('')}</select><select id="quickRound" aria-label="Runde" style="width:auto">${tournament.rounds.map((round) => `<option value="${esc(round.id)}">${esc(round.name)}</option>`).join('')}</select><button class="btn" data-do="quick">Einzelmatch</button></div>
    <div class="matchlist">${matches}</div></div></div>`;
}

/* Verbindungen */

function tourneyCard() {
  const status = app.tourney;
  const line = (ok, text) => `<div class="${ok ? 'check-ok' : 'check-no'}">${ok ? '✓' : '○'} ${esc(text)}</div>`;
  const size = app.tournament?.teamSize;
  return `<div class="card-p"><h2>osu!tourney</h2>
    <div class="small muted">Eigener Ordner, damit deine normale Installation unberührt bleibt. Der Client braucht osu!supporter. Melde dich beim ersten Start darin an und setze den Haken bei „Passwort merken“.</div>
    <div class="grid2"><label class="field">Ordner<input id="tourneyFolder" value="${esc(status?.folder ?? '')}" autocomplete="off"></label>
    <label class="field">Höhe des Streambereichs (Standard 720, der Monitor muss etwa 200 Pixel höher sein)<input id="tourneyHeight" type="number" min="568" max="2160" value="${esc(status?.height ?? 720)}"></label></div>
    ${status ? `<div class="small">${line(status.hasExe, 'osu!.exe im Ordner')}${line(status.hasConfig, 'tournament.cfg vorhanden')}${line(status.teamSizeOk, `TeamSize passt${size ? ` (${size})` : ''}`)}${line(status.acronymOk, `Kürzel passt${app.tournament ? ` (${app.tournament.acronym})` : ''}`)}${line(status.privateServerEmpty, 'privateserver leer')}${line(status.running, 'läuft gerade')}</div>` : ''}
    <div class="row"><button class="btn primary" data-do="tourneyPrepare">Einrichten</button><button class="btn" data-do="tourneyCheck">Prüfen</button><button class="btn" data-do="tourneyLaunch" ${status?.ready && !status.running ? '' : 'disabled'}>Starten</button></div></div>`;
}

function renderConnect() {
  const box = $('connectView');
  if (box.contains(document.activeElement) && document.activeElement.matches('input')) return;
  const { conn, settings } = app;
  const base = location.origin;
  const url = (path, label) => `<label class="field">${label}<div class="urlrow"><input readonly value="${esc(base + path)}"><button class="btn" data-copy="${esc(base + path)}">Kopieren</button></div></label>`;
  box.innerHTML = `<div class="page">
    <div class="card-p"><h2>Spielansicht</h2>
      <label class="check"><input type="radio" name="source" data-source="builtin" ${settings.gameplaySource === 'builtin' ? 'checked' : ''}>Eingebaut: Matchdeck zeichnet die Spielfelder selbst (Replays und Demo)</label>
      <label class="check"><input type="radio" name="source" data-source="capture" ${settings.gameplaySource === 'capture' ? 'checked' : ''}>osu!tourney aufnehmen: Mitte des Overlays wird durchsichtig, Live-Scores kommen über tosu</label>
      <div class="small muted">Live-Matches zeigt weiter das offizielle osu!tourney in seiner originalen Optik, Matchdeck schaut selbst nicht auf Bancho zu. Es reicht eine einzige Fensteraufnahme unter dem Overlay, ohne Chroma Key und ohne eine Quelle je Spieler.</div>
    </div>
    <div class="card-p"><h2>Skin</h2>
      <label class="field">Für die eingebaute Spielansicht. Standard ist der Skin, den du in osu! gewählt hast.
      <select id="skinPick">${(app.skins ?? []).map((name) => `<option value="${esc(name)}" ${name === app.skin?.name ? 'selected' : ''}>${esc(name.trim())}</option>`).join('')}${app.skins?.length ? '' : '<option value="">Kein osu!-Ordner gefunden</option>'}</select></label>
    </div>
    <div class="card-p"><h2>OBS</h2><div class="small muted">Browserquelle in Leinwandgröße anlegen. Die Auflösung ist egal, das Overlay passt sich selbst an.</div>
      ${url('/overlay', 'Alles in einer Quelle, Szenen schalten automatisch')}
      <div class="grid2">${url('/overlay?scene=gameplay', 'Nur Gameplay')}${url('/overlay?scene=mappool', 'Nur Mappool')}</div>
    </div>
    <div class="grid2">
      <div class="card-p"><h2>Bancho IRC</h2><div class="small muted">Status: ${esc(conn.irc)}. Passwort von osu.ppy.sh/p/irc, es bleibt nur auf diesem Rechner.</div>
        <label class="field">IRC-Name<input id="ircUser" value="${esc(settings.ircUser)}" autocomplete="off"></label>
        <label class="field">IRC-Passwort<input id="ircPass" type="password" placeholder="${conn.hasIrcPassword ? 'gespeichert' : ''}" autocomplete="off"></label>
        <button class="btn primary" data-do="connectIrc">Verbinden</button></div>
      <div class="card-p"><h2>osu! API v2</h2><div class="small muted">Status: ${esc(conn.api)}. Liefert Map-Daten, Accuracy und Combo. Client anlegen in den osu!-Kontoeinstellungen.</div>
        <label class="field">Client-ID<input id="apiId" value="${esc(conn.apiClientId)}" autocomplete="off"></label>
        <label class="field">Client-Secret<input id="apiSecret" type="password" placeholder="${conn.hasApiSecret ? 'gespeichert' : ''}" autocomplete="off"></label>
        <button class="btn primary" data-do="connectApi">Speichern</button></div>
    </div>
    ${tourneyCard()}
    <div class="card-p"><h2>tosu</h2><div class="small">Status: ${esc(conn.tosu)}. Matchdeck verbindet sich von selbst, sobald tosu neben osu!tourney läuft.</div></div>
    ${conn.demo ? `<div class="card-p"><h2>Fehler üben (Demo)</h2><div class="row"><button class="btn" data-fault="dc">Spieler fliegt raus</button><button class="btn" data-fault="wrongteam">Falsches Team</button><button class="btn" data-fault="illegalmod">Verbotene Mod</button><button class="btn" data-fault="mismatch">Score-Widerspruch</button></div></div>` : ''}
    <div class="row"><button class="btn danger" data-do="forget">Zugangsdaten löschen</button></div>
  </div>`;
}

/* Replays */

function renderReplays() {
  const box = $('replayView');
  const list = app.replays;
  const rows = list.map((replay) => `<label class="replay"><input type="checkbox" data-replay="${esc(replay.id)}" ${selected.has(replay.id) ? 'checked' : ''} ${replay.hasMap ? '' : 'disabled'}><span>${esc(replay.player)}${replay.hasMap ? '' : ' <span class="small muted">(Map fehlt)</span>'}</span><span>${number(replay.score)}</span><span>${replay.accuracy.toFixed(2)} %</span><span>${replay.miss} ✕</span><span class="muted">${esc(modNames(replay.mods).join(' '))}</span></label>`).join('');
  box.innerHTML = `<div class="page">
    <div class="card-p"><h2>Replays nebeneinander</h2><div class="small muted">Eine .osz und beliebig viele .osr hineinziehen, zum Beispiel für Qualifier, die getrennt gespielt wurden. Alle laufen an einer Uhr, ohne einen osu!-Client pro Spieler. Bisher nur osu!standard.</div>
    <div class="drop" id="drop" tabindex="0" role="button">Dateien hier ablegen oder klicken<input id="filePick" type="file" multiple accept=".osz,.osr" hidden></div>
    <div class="matchlist">${rows || '<div class="muted small">Noch keine Replays importiert.</div>'}</div>
    <div class="row"><button class="btn primary" data-do="theater" ${selected.size ? '' : 'disabled'}>Auf die Bühne</button><button class="btn" data-do="theaterStop" ${app.stage ? '' : 'disabled'}>Beenden</button></div></div></div>`;
}

async function uploadFiles(files) {
  for (const file of files) {
    const response = await fetch(`/api/import?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) toast(`${file.name}: ${data.error ?? 'Import fehlgeschlagen'}`);
    else toast(`${file.name} importiert`, true);
  }
}

/* Bedienung */

const handlers = {
  async roll() {
    const a = Number($('rollA').value);
    const b = Number($('rollB').value);
    await action({ t: 'ROLL', a, b });
  },
  first: ({ pick }) => action({ t: 'FIRST', pick }),
  start: () => action({ t: 'START' }),
  confirm: () => action({ t: 'CONFIRM' }),
  override: ({ team }) => action({ t: 'CONFIRM', winner: team }),
  rematch: () => action({ t: 'ABORT', reason: 'Rematch' }),
  undo: () => action({ t: 'UNDO' }),
  redo: () => action({ t: 'REDO' }),
  manual() {
    const { config } = app.match;
    const scores = [];
    for (const team of ['a', 'b']) {
      for (const player of config.teams[team].players) {
        const value = prompt(`Score von ${player.name}`, '0');
        if (value === null) return;
        scores.push({ name: player.name, score: Number(value) || 0, passed: true });
      }
    }
    action({ t: 'RESULT', scores, source: 'von Hand' });
  },
  demo: async () => {
    await post('/api/demo/start');
    showTab('tournament');
    toast('Demo geladen. Öffne ein Match.', true);
  },
  makeLobby: () => post('/api/lobby/make'),
  attach: () => post('/api/lobby/attach', { mpId: $('attachId').value }),
  async newTournament() {
    const name = prompt('Name des Turniers');
    if (name) await post('/api/tournament/new', { name, acronym: prompt('Kürzel', name.slice(0, 4).toUpperCase()) ?? '' });
  },
  async saveTournament() {
    editing = false;
    const ok = await post('/api/tournament/update', {
      name: $('tName').value, acronym: $('tAcronym').value, teamSize: Number($('tSize').value) || 1, timezone: $('tZone').value,
      theme: { accent: $('tAccent').value, teamA: $('tTeamA').value, teamB: $('tTeamB').value }, teamsText: $('tTeams').value,
    });
    if (ok) toast('Gespeichert', true);
  },
  async saveRound({ roundId }) {
    editing = false;
    const box = document.querySelector(`[data-round="${CSS.escape(roundId)}"]`);
    const rules = {};
    box.querySelectorAll('[data-rule]').forEach((input) => {
      rules[input.dataset.rule] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    });
    const ok = await post('/api/round/save', { id: roundId, name: box.querySelector('[data-r=name]').value, rules, poolText: box.querySelector('[data-r=pool]').value });
    if (ok) toast('Runde gespeichert', true);
  },
  async enrich({ roundId }) {
    await handlers.saveRound({ roundId });
    const result = await post('/api/round/enrich', { id: roundId });
    if (result) toast(result.failed ? `${result.failed} Maps nicht gefunden` : 'Map-Daten geladen', !result.failed);
  },
  addRound: () => post('/api/round/save', { id: '' }),
  bracket: ({ format }) => {
    if (app.tournament.matches.length && !confirm('Bestehende Matches im Bracket ersetzen?')) return null;
    return post('/api/bracket/generate', { format });
  },
  quick: () => post('/api/match/quick', { teamA: $('quickA').value, teamB: $('quickB').value, roundId: $('quickRound').value }).then((ok) => ok && showTab('match')),
  connectIrc: () => post('/api/connect/irc', { username: $('ircUser').value, password: $('ircPass').value }),
  async connectApi() {
    const ok = await post('/api/connect/api', { clientId: $('apiId').value, clientSecret: $('apiSecret').value });
    if (ok) toast('API gespeichert', true);
  },
  forget: () => confirm('IRC-Passwort und API-Secret von diesem Rechner löschen?') && post('/api/connect/forget'),
  async tourneyCheck() {
    await post('/api/tourney/check', { folder: $('tourneyFolder').value });
  },
  async tourneyPrepare() {
    const ok = await post('/api/tourney/prepare', { folder: $('tourneyFolder').value, height: Number($('tourneyHeight').value) });
    if (ok) toast('Eingerichtet', true);
  },
  tourneyLaunch: () => post('/api/tourney/launch'),
  theater: async () => {
    const ok = await post('/api/theater/start', { ids: [...selected] });
    if (ok) toast('Läuft im Overlay', true);
  },
  theaterStop: () => post('/api/theater/stop'),
};

function showTab(name) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('on', tab.id === `tab-${name}`));
  document.querySelectorAll('#tabs button').forEach((button) => button.classList.toggle('on', button.dataset.tab === name));
  render();
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button,[data-do],[data-tab]');
  if (!target) return;
  const { dataset } = target;
  if (dataset.tab) showTab(dataset.tab);
  else if (dataset.tabjump) showTab(dataset.tabjump);
  else if (dataset.do) handlers[dataset.do]?.(dataset);
  else if (dataset.slot) {
    const { step } = app.match.state;
    const type = { protect: 'PROTECT', ban: 'BAN', pick: 'PICK' }[step.kind];
    action({ t: type, team: step.team, slot: dataset.slot });
  } else if (dataset.mp) post('/api/mp', { command: dataset.mp });
  else if ('abort' in dataset) abortGame(dataset.abort);
  else if (dataset.scene) post('/api/scene', { scene: app.scenePin === dataset.scene ? null : dataset.scene });
  else if (dataset.open) post('/api/match/open', { matchId: dataset.open }).then((ok) => ok && showTab('match'));
  else if (dataset.alert) post('/api/match/alert-action', { id: dataset.alert });
  else if (dataset.dismiss) post('/api/match/dismiss', { id: dataset.dismiss });
  else if (dataset.copy) navigator.clipboard?.writeText(dataset.copy).then(() => toast('Kopiert', true));
  else if (dataset.fault) post('/api/demo/fault', { kind: dataset.fault }).then((ok) => ok && toast('Ausgelöst', true));
});

async function abortGame(team) {
  const ok = await action({ t: 'ABORT', team: team || undefined, reason: 'Abort durch Regie' });
  if (ok && app.lobby.channel) await post('/api/mp', { command: '!mp abort' });
}

document.addEventListener('submit', (event) => {
  if (event.target.id !== 'chatForm') return;
  event.preventDefault();
  const input = $('chatInput');
  if (!input.value.trim()) return;
  post('/api/chat', { text: input.value });
  input.value = '';
});

document.addEventListener('change', (event) => {
  const { target } = event;
  const { dataset } = target;
  if (dataset.setting) post('/api/settings', { [dataset.setting]: target.checked });
  else if (dataset.source) post('/api/settings', { gameplaySource: dataset.source });
  else if (target.id === 'tournamentPick') post('/api/tournament/select', { id: target.value });
  else if (target.id === 'skinPick') post('/api/settings', { skinName: target.value });
  else if (dataset.replay) {
    if (target.checked) selected.add(dataset.replay);
    else selected.delete(dataset.replay);
    render();
  } else if (target.id === 'filePick') uploadFiles(target.files);
  else if (target.id === 'importTournament') {
    target.files[0]?.text().then((text) => post('/api/tournament/import', JSON.parse(text))).catch(() => toast('Datei nicht lesbar'));
  }
});

document.addEventListener('input', (event) => {
  if (event.target.closest('#tournamentView')) editing = true;
});

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input,textarea')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && app?.match?.state.canUndo) {
    event.preventDefault();
    handlers.undo();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y' && app?.match?.state.canRedo) {
    event.preventDefault();
    handlers.redo();
  }
});

document.addEventListener('dragover', (event) => {
  if (!event.target.closest?.('#drop')) return;
  event.preventDefault();
  $('drop').classList.add('over');
});
document.addEventListener('dragleave', () => $('drop')?.classList.remove('over'));
document.addEventListener('drop', (event) => {
  if (!event.target.closest?.('#drop')) return;
  event.preventDefault();
  $('drop').classList.remove('over');
  uploadFiles(event.dataTransfer.files);
});
document.addEventListener('click', (event) => {
  if (event.target.closest('#drop') && event.target.id !== 'filePick') $('filePick').click();
});

function render() {
  if (!app) return;
  renderChips();
  const active = document.querySelector('.tab.on')?.id;
  if (active === 'tab-match') renderMatch();
  if (active === 'tab-tournament') renderTournament();
  if (active === 'tab-connect') renderConnect();
  if (active === 'tab-replays') renderReplays();
}

const events = new EventSource('/events?kind=console');
events.addEventListener('state', (message) => {
  app = JSON.parse(message.data);
  render();
});
