// Bancho-IRC-Client mit automatischem Wiederverbinden und gedrosselter Sendewarteschlange.

import { EventEmitter } from 'node:events';
import net from 'node:net';

const SEND_SPACING_MS = 600;
const SILENCE_LIMIT_MS = 150_000;
const MAX_BACKOFF_MS = 30_000;

// Bancho verwirft identische Nachrichten in Folge. Diese Befehle vertragen ein zusätzliches Wort,
// deshalb hängt ein zufälliges an, genau wie die Bibliothek bancho.js es macht.
const NONCE_COMMANDS = new Set(['map', 'mods', 'set', 'size', 'lock', 'unlock', 'settings', 'start', 'timer', 'aborttimer', 'abort', 'close', 'clearhost']);

function randomWord() {
  let word = '0';
  while (!Number.isNaN(Number(word))) word = Math.random().toString(36).slice(2);
  return word;
}

export function withNonce(text) {
  const [prefix, command] = text.split(' ');
  return prefix === '!mp' && NONCE_COMMANDS.has(command) ? `${text} ${randomWord()}` : text;
}

export function parseIrcLine(line) {
  let rest = line;
  let prefix = '';
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }
  const trailingAt = rest.indexOf(' :');
  const trailing = trailingAt >= 0 ? rest.slice(trailingAt + 2) : null;
  const parts = (trailingAt >= 0 ? rest.slice(0, trailingAt) : rest).split(' ').filter(Boolean);
  const command = parts.shift();
  if (trailing !== null) parts.push(trailing);
  return { nick: prefix.split('!')[0], command, params: parts };
}

export class BanchoIrc extends EventEmitter {
  constructor({ username, password, host = 'irc.ppy.sh', port = 6667 }) {
    super();
    this.nick = username.replaceAll(' ', '_');
    this.password = password;
    this.host = host;
    this.port = port;
    this.status = 'getrennt';
    this.channels = new Set();
    this.queue = [];
    this.stopped = false;
    this.attempt = 0;
    this.lastData = 0;
    this.lastSend = 0;
  }

  setStatus(status, detail) {
    this.status = status;
    this.emit('status', status, detail);
  }

  connect() {
    this.stopped = false;
    this.setStatus('verbindet');
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      this.lastData = Date.now();
      this.raw(`PASS ${this.password}`);
      this.raw(`NICK ${this.nick}`);
      this.raw(`USER ${this.nick} 0 * :${this.nick}`);
    });
    socket.on('data', (chunk) => {
      this.lastData = Date.now();
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) this.handle(line);
    });
    socket.on('error', (error) => this.emit('problem', error.message));
    socket.on('close', () => this.onClose(socket));
    this.watchdog ??= setInterval(() => {
      if (this.status === 'verbunden' && Date.now() - this.lastData > SILENCE_LIMIT_MS) this.socket?.destroy();
    }, 10_000);
    this.pump ??= setInterval(() => this.flush(), 100);
  }

  onClose(socket) {
    if (socket !== this.socket) return;
    if (this.stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt++);
    this.setStatus('wiederverbinden', `in ${Math.round(delay / 1000)} s`);
    this.retryTimer = setTimeout(() => !this.stopped && this.connect(), delay);
  }

  handle(line) {
    const { nick, command, params } = parseIrcLine(line);
    switch (command) {
      case 'PING':
        this.raw(`PONG :${params.at(-1)}`);
        break;
      case '001':
        this.attempt = 0;
        this.setStatus('verbunden');
        for (const channel of this.channels) this.raw(`JOIN ${channel}`);
        break;
      case '464':
        this.stopped = true;
        this.setStatus('anmeldung abgelehnt', 'IRC-Passwort prüfen');
        this.socket.destroy();
        break;
      case '403':
        this.channels.delete(params[1]);
        this.emit('noChannel', params[1]);
        break;
      case 'PRIVMSG':
        this.emit('message', { from: nick, target: params[0], text: params.at(-1) });
        break;
      default:
    }
  }

  raw(line) {
    if (this.socket?.writable) this.socket.write(`${line}\r\n`);
  }

  join(channel) {
    this.channels.add(channel);
    if (this.status === 'verbunden') this.raw(`JOIN ${channel}`);
  }

  part(channel) {
    this.channels.delete(channel);
    if (this.status === 'verbunden') this.raw(`PART ${channel}`);
  }

  say(target, text) {
    this.queue.push({ target, text: withNonce(text) });
  }

  flush() {
    if (this.status !== 'verbunden' || !this.queue.length) return;
    if (Date.now() - this.lastSend < SEND_SPACING_MS) return;
    const { target, text } = this.queue.shift();
    this.lastSend = Date.now();
    this.raw(`PRIVMSG ${target} :${text}`);
    this.emit('sent', { target, text });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearInterval(this.pump);
    clearTimeout(this.retryTimer);
    this.watchdog = this.pump = null;
    this.raw('QUIT');
    this.socket?.destroy();
    this.setStatus('getrennt');
  }
}
