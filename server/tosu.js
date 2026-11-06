// Liest Live-Daten aus dem osu!tourney-Client über tosu (/websocket/v2, Abschnitt "tourney").

import { EventEmitter } from 'node:events';

export function liveFromTosu(data) {
  const tourney = data?.tourney;
  if (!tourney?.clients?.length) return null;
  return {
    source: 'tosu',
    ipcState: tourney.ipcState,
    players: tourney.clients.map((client) => ({
      name: client.play?.playerName || client.user?.name || `Slot ${client.ipcId + 1}`,
      side: client.team === 'left' ? 'a' : 'b',
      score: client.play?.score ?? 0,
      accuracy: client.play?.accuracy ?? 0,
      combo: client.play?.combo?.current ?? 0,
      maxCombo: client.play?.combo?.max ?? 0,
      misses: client.play?.hits?.['0'] ?? 0,
      failed: Boolean(client.play?.failed),
      mods: client.play?.mods?.name ?? '',
    })),
    chat: (tourney.chat ?? []).map((line) => ({ from: line.name, text: line.message, team: line.team })),
  };
}

export class TosuLink extends EventEmitter {
  constructor(url = 'ws://127.0.0.1:24050/websocket/v2') {
    super();
    this.url = url;
    this.status = 'getrennt';
    this.stopped = false;
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.emit('status', status);
  }

  start() {
    this.stopped = false;
    this.setStatus('verbindet');
    let socket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.setStatus('verbunden');
    socket.onmessage = (message) => {
      try {
        const live = liveFromTosu(JSON.parse(message.data));
        if (live) this.emit('live', live);
      } catch { /* tosu liefert beim Start teils unvollständige Daten */ }
    };
    socket.onclose = () => this.retry();
    socket.onerror = () => {};
  }

  retry() {
    if (this.stopped) return;
    this.setStatus('wartet');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), 3000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close();
    this.setStatus('getrennt');
  }
}
