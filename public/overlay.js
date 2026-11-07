// Ein Overlay für alle Szenen. Passt sich jeder Auflösung selbst an,
// es gibt also keine Höhe, die an drei Stellen gleich eingetragen werden muss.

import { modNames } from '/shared/beatmap.js';
import { winsNeeded } from '/shared/match.js';
import { MOD_ORDER } from '/shared/tournament.js';
import { loadSkinAssets, Playfield } from '/playfield.js';

const params = new URLSearchParams(location.search);
const fixedScene = params.get('scene');
const muted = params.has('mute');

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value) => Math.round(value ?? 0).toLocaleString('de-DE');
const sideName = { a: 'team-a', b: 'team-b' };
const MOD_COLOR = { NM: '#cfd4de', HD: '#ffd24a', HR: '#ff7a59', DT: '#b58cff', FM: '#58e6a9', EZ: '#7fe0ff', FL: '#ffffff', TB: '#d7ff3f' };

let app = null;
let live = null;
let clockOffset = 0;
let stage = null;
let fields = [];
let mapData = null;
let fieldKey = '';
const shown = { a: 0, b: 0 };
let freshSlot = null;
let skinAssets = null;
let skinName = null;

function fit() {
  const scale = Math.min(innerWidth / 1920, innerHeight / 1080);
  const box = $('stage');
  box.style.transform = `translate(${(innerWidth - 1920 * scale) / 2}px, ${(innerHeight - 1080 * scale) / 2}px) scale(${scale})`;
}
addEventListener('resize', () => {
  fit();
  fields.forEach((field) => field.view.resize());
});
fit();

const teamsOf = () => app?.match?.config.teams ?? null;
const pips = (side, state) => {
  const need = winsNeeded(state.rules.bestOf);
  return Array.from({ length: need }, (_, i) => `<i class="pip ${i < state.points[side] ? 'on' : ''}"></i>`).join('');
};

function renderHead() {
  const teams = teamsOf();
  const state = app?.match?.state;
  const names = (side) => teams?.[side].name ?? (stage?.slots ?? []).filter((slot) => slot.side === side).map((slot) => slot.name).join(', ');
  const stars = (side) => (state ? pips(side, state) : '');
  $('scoreHead').innerHTML = `
    <div class="hside a team-a"><div class="hrow"><span class="teamlabel">TEAM RED</span><span class="pips">${stars('a')}</span></div><div class="teamname">${esc(names('a'))}</div></div>
    <div class="hcenter"><div class="logo">${esc(app?.tournament?.acronym ?? '')}</div><div class="roundbox">${esc(app?.match?.round ?? 'Replay')}</div></div>
    <div class="hside b team-b"><div class="hrow"><span class="pips">${stars('b')}</span><span class="teamlabel">TEAM BLUE</span></div><div class="teamname">${esc(names('b'))}</div></div>`;
}

function renderNowPlaying() {
  const box = $('nowPlaying');
  const game = app?.match?.state.games.at(-1);
  const entry = game && app.match.config.pool.find((item) => item.slot === game.slot);
  const chat = (app?.chat ?? []).filter((line) => line.from !== 'BanchoBot').slice(-3);
  const ticker = `<div class="ticker">${chat.map((line) => `<div><b>${esc(line.from)}</b> ${esc(line.text)}</div>`).join('')}</div>`;
  const background = mapData?.media?.background ?? entry?.cover;
  const cover = background ? `style="background-image:linear-gradient(90deg, rgba(8,9,12,.82), rgba(8,9,12,.35)), url('${esc(background)}')"` : '';
  const title = entry ? `${entry.artist ? `${entry.artist} – ` : ''}${entry.title ?? `Map ${entry.mapId}`}` : stage?.title ?? app?.tournament?.name ?? '';
  const minutes = entry?.length ? `${Math.floor(entry.length / 60)}:${String(Math.round(entry.length % 60)).padStart(2, '0')}` : '';
  const by = game ? (game.team ? `Pick von ${app.match.config.teams[game.team].name}` : 'Tiebreaker') : '';
  const html = `
    <div class="mapbanner ${game?.team ? sideName[game.team] : ''}" ${cover}><div class="title">${esc(title)}</div><div class="sub">${entry?.creator ? `mapper <b>${esc(entry.creator)}</b>` : ''} ${entry?.version ? `difficulty <b>${esc(entry.version)}</b>` : ''}</div></div>
    <div class="mapstats">${entry?.cs ? `<div>CS <b>${entry.cs}</b> / AR <b>${entry.ar}</b> / OD <b>${entry.od}</b></div>` : '<div></div>'}<div>${minutes ? `Length <b>${minutes}</b>` : ''}</div><div>${entry?.stars ? `Star Rating <b>${entry.stars.toFixed(2)}*</b>` : ''}</div><div>${entry?.bpm ? `BPM <b>${Math.round(entry.bpm)}</b>` : ''}</div></div>
    <div class="pickinfo ${game?.team ? sideName[game.team] : ''}">${entry ? `<div class="pslot">${esc(entry.slot)}</div><div class="pby">${esc(by)}</div>` : ''}</div>${ticker}`;
  if (box.renderedHtml !== html) {
    box.renderedHtml = html;
    box.innerHTML = html;
  }
}

function renderResultCard() {
  const card = $('resultCard');
  const game = app?.match?.state.games.at(-1);
  if (game?.status !== 'result' || !game.result) {
    card.hidden = true;
    return;
  }
  const { rows, winner, tie } = game.result;
  const teams = teamsOf();
  card.hidden = false;
  card.className = winner ? sideName[winner] : '';
  const sorted = [...rows].filter((row) => row.team).sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
  card.innerHTML = `<div class="kicker">${esc(game.slot)} Ergebnis</div><h2>${tie ? 'Gleichstand' : `${esc(teams[winner].name)} holt die Map`}</h2>
    <div class="rows">${sorted.map((row) => `<div class="row ${sideName[row.team]}"><span>${esc(row.name)}</span><b>${number(row.score)}</b><span>${row.accuracy != null ? `${row.accuracy.toFixed(2)} %` : ''}</span><span>${row.combo != null ? `${row.combo}x` : ''}</span><span>${row.misses != null ? `${row.misses} ✕` : ''}</span></div>`).join('')}</div>`;
}

function renderMappool() {
  const box = $('sceneMappool');
  const match = app?.match;
  if (!match) {
    box.innerHTML = '';
    return;
  }
  const { state, config } = match;
  const { step } = state;
  const team = step.team;
  const verb = { protect: 'schützt', ban: 'bannt', pick: 'pickt' }[step.kind];
  const prompt = verb && team ? `${config.teams[team].name} ${verb}` : step.forced ? 'Tiebreaker' : state.games.at(-1)?.slot ? `${state.games.at(-1).slot} gewählt` : 'Mappool';
  const groups = [...new Set(config.pool.map((entry) => entry.mod))].sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const mark = (slot) => {
    const find = (list) => list.find((entry) => entry.slot === slot);
    const ban = find(state.bans);
    if (ban) return { cls: 'ban', label: 'BAN', team: ban.team };
    const game = state.games.find((entry) => entry.slot === slot);
    if (game) return { cls: `pick ${game.winner ? `done-${game.winner}` : ''}`, label: game.winner ? `WIN ${config.teams[game.winner].acronym}` : 'PICK', team: game.winner ?? game.team };
    const protect = find(state.protects);
    if (protect) return { cls: 'protect', label: 'SCHUTZ', team: protect.team };
    return null;
  };
  box.innerHTML = `
    <div class="poolhead">
      <div class="tname a team-a"><span></span>${esc(config.teams.a.name)} · ${state.points.a}</div>
      <div class="prompt ${team ? sideName[team] : ''}"><div class="kicker">${esc(match.round)}</div><div class="what">${esc(prompt)}</div></div>
      <div class="tname b team-b">${state.points.b} · ${esc(config.teams.b.name)}<span></span></div>
    </div>
    <div class="poolgrid">${groups.map((mod) => `
      <div class="modrow" style="--mod:${MOD_COLOR[mod] ?? '#fff'}"><div class="modlabel">${mod}</div><div class="modcards">
      ${config.pool.filter((entry) => entry.mod === mod).map((entry) => {
        const info = mark(entry.slot);
        const cover = entry.cover ? `<div class="cover" style="background-image:url('${esc(entry.cover)}')"></div>` : '';
        return `<div class="card ${info?.cls ?? ''} ${info ? sideName[info.team] ?? '' : ''} ${entry.slot === freshSlot ? 'fresh' : ''}">${cover}<div class="slot">${esc(entry.slot)}</div><div class="t">${esc(entry.title ?? `Map ${entry.mapId}`)}</div><div class="a">${esc(entry.artist ?? '')}</div>${info ? `<div class="state">${esc(info.label)}</div>` : ''}</div>`;
      }).join('')}</div></div>`).join('')}</div>`;
}

function renderIntro() {
  const box = $('sceneIntro');
  const teams = teamsOf();
  const { tournament } = app ?? {};
  if (!teams) {
    box.innerHTML = `<div class="kicker">${esc(tournament?.acronym ?? 'Matchdeck')}</div><div class="eventname">${esc(tournament?.name ?? 'Noch kein Turnier')}</div><div class="idle">Gleich geht es los</div>`;
    return;
  }
  const seed = (id) => tournament.teams.find((team) => team.id === id)?.seed;
  const card = (side) => `<div class="vsteam ${sideName[side]}"><h2>${esc(teams[side].name)}</h2><div class="seed">Seed ${seed(teams[side].id) ?? '–'}</div><ul>${teams[side].players.map((player) => `<li>${esc(player.name)}</li>`).join('')}</ul></div>`;
  box.innerHTML = `<div class="kicker">${esc(tournament.name)} · ${esc(app.match.round)}</div><div class="vs">${card('a')}<div class="vsmark">VS</div>${card('b')}</div>`;
}

function renderWinner() {
  const box = $('sceneWinner');
  const match = app?.match;
  if (!match?.state.winner) {
    box.innerHTML = '';
    return;
  }
  const { state, config } = match;
  box.innerHTML = `<div class="kicker">Sieger · ${esc(match.round)}</div><div class="winner-name ${sideName[state.winner]}">${esc(config.teams[state.winner].name)}</div><div class="winner-score">${state.points.a} : ${state.points.b}</div>`;
}

function renderBracket() {
  const box = $('sceneBracket');
  const tournament = app?.tournament;
  const matches = (tournament?.matches ?? []).filter((match) => match.bracket !== 'extra');
  if (!matches.length) {
    box.innerHTML = '';
    return;
  }
  const name = (id) => tournament.teams.find((team) => team.id === id)?.acronym ?? '';
  const W = 216;
  const H = 62;
  const GAP_X = 42;
  const position = new Map();
  const place = (list, top, available) => {
    const depths = [...new Set(list.map((match) => match.depth))].sort((a, b) => a - b);
    depths.forEach((depth, column) => {
      const row = list.filter((match) => match.depth === depth).sort((a, b) => a.index - b.index);
      const step = available / row.length;
      row.forEach((match, i) => position.set(match.id, { x: column * (W + GAP_X), y: top + step * i + step / 2 - H / 2 }));
    });
  };
  const upper = matches.filter((match) => match.bracket === 'upper');
  const lower = matches.filter((match) => match.bracket === 'lower');
  const finale = matches.filter((match) => match.bracket === 'final');
  place(upper, 0, lower.length ? 470 : 880);
  place(lower, 490, 400);
  finale.forEach((match) => position.set(match.id, { x: Math.max(...[...position.values()].map((p) => p.x)) + W + GAP_X, y: 300 }));
  const width = Math.max(...[...position.values()].map((p) => p.x)) + W + 10;
  const live_ = app.match?.id;
  const lines = matches.flatMap((match) => {
    const from = position.get(match.id);
    const to = position.get(match.winnerTo?.id);
    if (!to) return [];
    const midX = from.x + W + GAP_X / 2;
    return [`<path d="M${from.x + W} ${from.y + H / 2} H${midX} V${to.y + H / 2} H${to.x}" fill="none" stroke="#3a3f4c" stroke-width="2"/>`];
  });
  const cards = matches.map((match) => {
    const { x, y } = position.get(match.id);
    const line = (id, offset, side) => {
      const won = match.result?.winner && match.result.winner === id;
      const points = match.result?.points?.[side];
      return `<text x="${x + 12}" y="${y + offset}" font-size="21" font-weight="${won ? 700 : 400}" opacity="${match.result?.winner && !won ? .55 : 1}">${esc(name(id) || '–')}</text>${points != null ? `<text x="${x + W - 12}" y="${y + offset}" font-size="21" text-anchor="end" font-weight="700">${points}</text>` : ''}`;
    };
    return `<g><rect x="${x}" y="${y}" width="${W}" height="${H}" fill="#14161c" stroke="${match.id === live_ ? '#d7ff3f' : '#2b2f3a'}" stroke-width="${match.id === live_ ? 3 : 1.5}"/>${line(match.teamA, 26, 'a')}${line(match.teamB, 52, 'b')}</g>`;
  });
  box.innerHTML = `<div class="heading">${esc(tournament.name)}</div><svg id="bracketSvg" viewBox="0 0 ${width} 900" preserveAspectRatio="xMinYMin meet">${lines.join('')}${cards.join('')}</svg>`;
}

function renderSchedule() {
  const box = $('sceneSchedule');
  const tournament = app?.tournament;
  if (!tournament) return;
  const name = (id) => tournament.teams.find((team) => team.id === id)?.name ?? 'Offen';
  const rows = tournament.matches.filter((match) => match.schedule && !match.result?.winner).sort((a, b) => a.schedule.localeCompare(b.schedule)).slice(0, 8);
  const format = new Intl.DateTimeFormat('de-DE', { timeZone: tournament.timezone || undefined, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  box.innerHTML = `<div class="kicker">${esc(tournament.timezone)}</div><div class="heading">Spielplan</div><div class="schedule">${rows.map((match) => `<div class="sched-row"><div class="time">${esc(format.format(new Date(match.schedule)))}</div><div>${esc(name(match.teamA))}</div><div class="vsx">vs</div><div class="right">${esc(name(match.teamB))}</div><div class="round">${esc(match.title ?? '')}</div></div>`).join('') || '<div class="idle">Keine offenen Termine</div>'}</div>`;
}

function applyTheme() {
  const theme = app?.tournament?.theme;
  if (!theme) return;
  const root = document.documentElement.style;
  root.setProperty('--accent', theme.accent);
  root.setProperty('--team-a', theme.teamA);
  root.setProperty('--team-b', theme.teamB);
}

let renderKey = '';
function renderAll() {
  if (!app) return;
  renderNowPlaying();
  // Chatzeilen und andere Kleinigkeiten dürfen die Szenen nicht neu aufbauen.
  const key = JSON.stringify([app.scene, app.match?.id, app.match?.state, app.settings.gameplaySource, app.tournament?.theme, app.tournament?.matches, stage?.startAt, freshSlot]);
  if (key === renderKey) return;
  renderKey = key;
  applyTheme();
  const scene = fixedScene ?? app.scene;
  document.body.classList.toggle('capture', app.settings.gameplaySource === 'capture' && scene === 'gameplay');
  document.querySelectorAll('.scene').forEach((node) => node.classList.toggle('on', node.dataset.scene === scene));
  renderHead();
  renderResultCard();
  renderMappool();
  renderIntro();
  renderWinner();
  renderBracket();
  renderSchedule();
  syncFields();
  renderLive();
}

/* Spielfelder */

const colorOf = (side) => (side === 'a' ? getComputedStyle(document.documentElement).getPropertyValue('--team-a') : getComputedStyle(document.documentElement).getPropertyValue('--team-b')).trim();

function syncFields() {
  const slots = stage?.slots ?? [];
  const key = `${stage?.hash}|${stage?.startAt}|${slots.map((slot) => slot.name).join(',')}`;
  if (key === fieldKey) {
    slots.forEach((slot, index) => {
      if (fields[index]) fields[index].view.cut = Boolean(slot.cut);
    });
    return;
  }
  fieldKey = key;
  const box = $('fields');
  box.innerHTML = '';
  fields = [];
  if (!slots.length) return;
  for (const side of ['a', 'b']) {
    const own = slots.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.side === side);
    const column = document.createElement('div');
    column.className = 'teamfields';
    // Wie im Turnier-Layout: drei Spieler stehen als einer oben, zwei unten.
    column.dataset.count = own.length;
    for (const { slot, index } of own) {
      const node = document.createElement('div');
      node.className = `field ${sideName[side]}`;
      node.innerHTML = `<div class="bg"></div><canvas></canvas><div class="tag"><span>${esc(slot.name)}</span><span class="mods"></span></div><div class="lost">Verbindung weg<br>Die anderen spielen weiter</div>`;
      column.append(node);
      fields[index] = { node, view: null, index, side };
    }
    box.append(column);
  }
  for (const field of fields) {
    if (!field) continue;
    field.view = new Playfield(field.node.querySelector('canvas'), { color: colorOf(field.side), skin: skinAssets });
    field.view.cut = false;
  }
  if (mapData) applyMap();
  if (pendingBacklog) {
    applyBacklog(pendingBacklog);
    pendingBacklog = null;
  }
}

function applyMap() {
  fields.forEach((field) => {
    const slot = stage.slots[field.index];
    // Bei Freemod hat jeder Spieler eigene Mods, HR spiegelt also nur sein Feld.
    const mods = slot?.mods ?? stage.mods;
    field.view.setMap(mapData, mods);
    field.node.querySelector('.mods').textContent = modNames(mods).join(' ');
    field.view.cut = Boolean(slot?.cut);
    const background = mapData.media?.background;
    field.node.querySelector('.bg').style.backgroundImage = background ? `url("${background}")` : '';
  });
}

async function syncSkin() {
  const wanted = app?.skin?.name ?? null;
  if (wanted === skinName) return;
  skinName = wanted;
  skinAssets = app.skin ? await loadSkinAssets(app.skin) : null;
  fields.forEach((field) => field?.view?.setSkin(skinAssets));
}

let pendingBacklog = null;
function applyBacklog(chunks) {
  chunks.forEach((chunk, index) => fields[index]?.view.push(chunk.frames, chunk.marks, chunk.points));
}

async function loadStage(description) {
  stage = description;
  fieldKey = '';
  mapData = null;
  if (description) {
    const response = await fetch(`/api/maps/${description.hash}`);
    mapData = await response.json();
    syncFields();
    applyMap();
    startAudio();
  } else {
    syncFields();
    stopAudio();
  }
}

function startAudio() {
  const audio = $('audio');
  if (!stage?.audio || muted) return;
  audio.src = stage.audio;
  audio.playbackRate = stage.rate;
  audio.preservesPitch = false;
}

function stopAudio() {
  const audio = $('audio');
  audio.pause();
  audio.removeAttribute('src');
}

function serverNow() {
  return performance.now() + clockOffset;
}

function syncAudio(time) {
  const audio = $('audio');
  if (!stage?.audio || muted || !audio.src) return;
  if (time < 0) return;
  if (audio.paused) audio.play().catch(() => {});
  // Kleine Abweichungen über das Tempo ausgleichen. Springen hört man, das hier nicht.
  const drift = audio.currentTime * 1000 - time;
  if (Math.abs(drift) > 300) audio.currentTime = time / 1000;
  else audio.playbackRate = stage.rate * (1 - Math.max(-0.03, Math.min(0.03, drift / 2000)));
}

function frame() {
  requestAnimationFrame(frame);
  const scene = fixedScene ?? app?.scene;
  if (stage && fields.length && scene === 'gameplay') {
    const time = (serverNow() - stage.startAt) * stage.rate;
    for (const field of fields) {
      if (!field?.view) continue;
      field.view.draw(time);
      field.node.classList.toggle('stalled', field.view.stalled(time));
    }
    syncAudio(time);
    showTotals();
  }
}
requestAnimationFrame(frame);

function showTotals() {
  const totals = { a: 0, b: 0 };
  for (const field of fields) if (field?.view) totals[field.side] += field.view.hud.score;
  writeTotals(totals);
}

function writeTotals(totals) {
  $('totalA').textContent = number(totals.a);
  $('totalB').textContent = number(totals.b);
  const gap = Math.abs(totals.a - totals.b);
  const leader = totals.a > totals.b ? 'a' : 'b';
  const share = Math.min(1, gap / Math.max(50000, Math.max(totals.a, totals.b) * 0.5));
  $('leadA').style.transform = `scaleX(${leader === 'a' ? share : 0})`;
  $('leadB').style.transform = `scaleX(${leader === 'b' ? share : 0})`;
  $('gapA').textContent = leader === 'a' && gap >= 1 ? `+${number(gap)}` : '';
  $('gapB').textContent = leader === 'b' && gap >= 1 ? `+${number(gap)}` : '';
}

function renderLive() {
  // Die Bühne rechnet pro Bild selbst. Von außen kommen nur die Daten aus osu!tourney.
  if (live?.source !== 'tosu') return;
  const totals = { a: 0, b: 0 };
  for (const player of live.players) totals[player.side] += player.score ?? 0;
  writeTotals(totals);
}

/* Datenstrom */

const events = new EventSource(`/events?kind=${params.has('preview') ? 'preview' : 'overlay'}`);
events.addEventListener('hello', (message) => {
  clockOffset = JSON.parse(message.data).serverNow - performance.now();
});
events.addEventListener('time', (message) => {
  const measured = JSON.parse(message.data).serverNow - performance.now();
  if (Math.abs(measured - clockOffset) > 40) clockOffset += (measured - clockOffset) * 0.2;
});
events.addEventListener('state', (message) => {
  const previous = app?.match?.state.picks.length ?? 0;
  app = JSON.parse(message.data);
  const picks = app.match?.state.picks ?? [];
  if (picks.length > previous) {
    freshSlot = picks.at(-1).slot;
    setTimeout(() => { freshSlot = null; }, 4000);
  }
  const next = app.stage;
  if ((next?.startAt ?? null) !== (stage?.startAt ?? null) || next?.hash !== stage?.hash) loadStage(next);
  else if (next) stage = next;
  syncSkin();
  renderAll();
});
events.addEventListener('stage-update', (message) => {
  stage = JSON.parse(message.data);
  syncFields();
});
events.addEventListener('backlog', (message) => {
  const chunks = JSON.parse(message.data);
  if (fields.length) applyBacklog(chunks);
  else pendingBacklog = chunks;
});
events.addEventListener('frames', (message) => {
  for (const chunk of JSON.parse(message.data)) fields[chunk.index]?.view?.push(chunk.frames, chunk.marks, chunk.points);
});
events.addEventListener('live', (message) => {
  live = JSON.parse(message.data);
  renderLive();
});
