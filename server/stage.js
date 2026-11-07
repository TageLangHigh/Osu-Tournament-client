// Die Bühne verteilt Cursor-Daten aller Spieler an eine gemeinsame Uhr.
// Fällt ein Spieler aus, friert nur sein Feld ein. Niemand sonst wartet auf ihn.

import { EventEmitter } from 'node:events';

const TICK_MS = 250;
const BUFFER_MS = 1200; // So weit liegen die Daten dem sichtbaren Bild voraus.
const LEAD_IN_MS = 1500;

export class Stage extends EventEmitter {
  constructor() {
    super();
    this.current = null;
  }

  load({ hash, mods = 0, rate = 1, length, slots, audio = null, title = '', firstObject = 0 }) {
    this.stop();
    this.current = {
      hash, mods, rate, length, audio, title,
      startAt: Date.now() + LEAD_IN_MS - firstObject / rate,
      slots: slots.map((slot) => ({
        ...slot, sentFrame: 0, sentMark: 0, sentTimeline: 0, sentPoint: 0, cut: false,
      })),
    };
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.emit('load', this.describe());
    this.tick();
  }

  describe() {
    const stage = this.current;
    if (!stage) return null;
    return {
      hash: stage.hash, mods: stage.mods, rate: stage.rate, startAt: stage.startAt, audio: stage.audio, title: stage.title,
      slots: stage.slots.map(({ name, team, side, cut, mods }) => ({ name, team, side, cut, mods: mods ?? stage.mods })),
    };
  }

  /** Alles bisher Gesendete, damit ein neu geladenes Overlay sofort stimmt. */
  backlog() {
    const stage = this.current;
    if (!stage) return null;
    return stage.slots.map((slot) => ({ frames: slot.frames.slice(0, slot.sentFrame), marks: slot.marks.slice(0, slot.sentMark), points: slot.timeline.slice(0, slot.sentPoint) }));
  }

  songTime(now = Date.now()) {
    const stage = this.current;
    return stage ? (now - stage.startAt) * stage.rate : 0;
  }

  /** Trennt einen Spieler vom Datenstrom, zum Beispiel nach einem Verbindungsabbruch. */
  cut(name) {
    const slot = this.current?.slots.find((entry) => entry.name === name);
    if (!slot) return;
    slot.cut = true;
    this.emit('describe', this.describe());
  }

  tick() {
    const stage = this.current;
    if (!stage) return;
    const song = this.songTime();
    const horizon = song + BUFFER_MS * stage.rate;
    const chunk = [];
    stage.slots.forEach((slot, index) => {
      if (slot.cut) return;
      let frameEnd = slot.sentFrame;
      while (frameEnd < slot.frames.length && slot.frames[frameEnd][0] <= horizon) frameEnd++;
      let markEnd = slot.sentMark;
      while (markEnd < slot.marks.length && slot.marks[markEnd].t <= horizon) markEnd++;
      let pointEnd = slot.sentPoint;
      while (pointEnd < slot.timeline.length && slot.timeline[pointEnd].t <= horizon) pointEnd++;
      if (frameEnd > slot.sentFrame || markEnd > slot.sentMark || pointEnd > slot.sentPoint) {
        chunk.push({ index, frames: slot.frames.slice(slot.sentFrame, frameEnd), marks: slot.marks.slice(slot.sentMark, markEnd), points: slot.timeline.slice(slot.sentPoint, pointEnd) });
        slot.sentFrame = frameEnd;
        slot.sentMark = markEnd;
        slot.sentPoint = pointEnd;
      }
      while (slot.sentTimeline < slot.timeline.length && slot.timeline[slot.sentTimeline].t <= song) slot.sentTimeline++;
    });
    if (chunk.length) this.emit('frames', chunk);

    this.emit('live', stage.slots.map((slot) => {
      const point = slot.timeline[slot.sentTimeline - 1] ?? { score: 0, combo: 0, accuracy: 1, miss: 0 };
      return {
        name: slot.name, side: slot.side, score: point.score, accuracy: point.accuracy * 100,
        combo: point.combo, misses: point.miss, failed: false, cut: slot.cut,
      };
    }));

    if (song > stage.length + 1200) {
      this.emit('end');
      this.stop();
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.current) {
      this.current = null;
      this.emit('load', null);
    }
  }
}
