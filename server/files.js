// Einlesen von .osz (ZIP) und .osr (Replay mit LZMA-Daten) ohne Fremdpakete.

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export function readZip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('Keine gültige ZIP-Datei');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, {
      name,
      read() {
        const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const raw = buffer.subarray(start, start + compressed);
        return method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
      },
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Kleiner LZMA-Decoder für das "lzma alone"-Format, das osu!-Replays benutzen.
export function decompressLzma(input) {
  const props = input[0];
  const lc = props % 9;
  const remainder = Math.floor(props / 9);
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);
  const declared = Number(input.readBigInt64LE(5));
  let position = 13;

  const PROB_INIT = 1024;
  const probs = (count) => new Uint16Array(count).fill(PROB_INIT);
  let range = 0xffffffff;
  let code = 0;
  position++; // erstes Byte des Range-Coders ist immer 0
  for (let i = 0; i < 4; i++) code = ((code << 8) | input[position++]) >>> 0;

  const normalize = () => {
    if (range < 0x1000000) {
      range = (range * 256) >>> 0;
      code = ((code << 8) | (position < input.length ? input[position++] : 0)) >>> 0;
    }
  };
  const bit = (table, index) => {
    normalize();
    const bound = ((range >>> 11) * table[index]) >>> 0;
    if (code < bound) {
      range = bound;
      table[index] += (2048 - table[index]) >> 5;
      return 0;
    }
    range = (range - bound) >>> 0;
    code = (code - bound) >>> 0;
    table[index] -= table[index] >> 5;
    return 1;
  };
  const direct = (count) => {
    let result = 0;
    for (; count > 0; count--) {
      normalize();
      range >>>= 1;
      const t = code >= range ? 1 : 0;
      if (t) code = (code - range) >>> 0;
      result = (result * 2 + t) >>> 0;
    }
    return result;
  };
  const tree = (table, base, bits) => {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) + bit(table, base + m);
    return m - (1 << bits);
  };
  const reverseTree = (table, base, bits) => {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < bits; i++) {
      const b = bit(table, base + m);
      m = (m << 1) + b;
      symbol |= b << i;
    }
    return symbol;
  };

  const lengthCoder = () => ({ choice: probs(2), low: probs(16 << 3), mid: probs(16 << 3), high: probs(256) });
  const decodeLength = (coder, posState) => {
    if (!bit(coder.choice, 0)) return tree(coder.low, posState << 3, 3);
    if (!bit(coder.choice, 1)) return 8 + tree(coder.mid, posState << 3, 3);
    return 16 + tree(coder.high, 0, 8);
  };

  const literal = probs(0x300 << (lc + lp));
  const isMatch = probs(12 << 4);
  const isRep = probs(12);
  const isRepG0 = probs(12);
  const isRepG1 = probs(12);
  const isRepG2 = probs(12);
  const isRep0Long = probs(12 << 4);
  const posSlot = probs(4 << 6);
  const posSpecial = probs(115);
  const align = probs(16);
  const lenCoder = lengthCoder();
  const repCoder = lengthCoder();

  let output = Buffer.allocUnsafe(declared > 0 ? declared : 1 << 20);
  let size = 0;
  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  const posMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;
  const put = (byte) => {
    if (size === output.length) output = Buffer.concat([output, Buffer.allocUnsafe(output.length)]);
    output[size++] = byte;
  };

  while (declared < 0 || size < declared) {
    const posState = size & posMask;
    if (!bit(isMatch, (state << 4) + posState)) {
      const previous = size ? output[size - 1] : 0;
      const base = 0x300 * (((size & lpMask) << lc) + (previous >> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let match = output[size - rep0 - 1];
        do {
          const matchBit = (match >> 7) & 1;
          match = (match << 1) & 0xff;
          const b = bit(literal, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | b;
          if (matchBit !== b) break;
        } while (symbol < 0x100);
      }
      while (symbol < 0x100) symbol = (symbol << 1) | bit(literal, base + symbol);
      put(symbol & 0xff);
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }

    let length;
    if (bit(isRep, state)) {
      if (!bit(isRepG0, state)) {
        if (!bit(isRep0Long, (state << 4) + posState)) {
          state = state < 7 ? 9 : 11;
          put(output[size - rep0 - 1]);
          continue;
        }
      } else {
        let distance;
        if (!bit(isRepG1, state)) distance = rep1;
        else {
          if (!bit(isRepG2, state)) distance = rep2;
          else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      length = decodeLength(repCoder, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      length = decodeLength(lenCoder, posState);
      state = state < 7 ? 7 : 10;
      const lenState = Math.min(length, 3);
      const slot = tree(posSlot, lenState << 6, 6);
      if (slot < 4) rep0 = slot;
      else {
        const direct_bits = (slot >> 1) - 1;
        rep0 = (2 | (slot & 1)) * 2 ** direct_bits;
        if (slot < 14) rep0 += reverseTree(posSpecial, rep0 - slot, direct_bits);
        else {
          rep0 += direct(direct_bits - 4) * 16;
          rep0 += reverseTree(align, 0, 4);
        }
        if (rep0 === 0xffffffff) break; // Endmarke
      }
    }
    length += 2;
    for (let i = 0; i < length && (declared < 0 || size < declared); i++) put(output[size - rep0 - 1]);
  }
  return output.subarray(0, size);
}

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.at = 0;
  }
  u8() { return this.buffer[this.at++]; }
  u16() { this.at += 2; return this.buffer.readUInt16LE(this.at - 2); }
  u32() { this.at += 4; return this.buffer.readUInt32LE(this.at - 4); }
  u64() { this.at += 8; return this.buffer.readBigUInt64LE(this.at - 8); }
  uleb() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.u8();
      result |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7;
    }
  }
  string() {
    if (this.u8() !== 0x0b) return '';
    const length = this.uleb();
    this.at += length;
    return this.buffer.toString('utf8', this.at - length, this.at);
  }
}

export function parseFrames(text) {
  const frames = [];
  let time = 0;
  for (const part of text.split(',')) {
    if (!part) continue;
    const [delta, x, y, keys] = part.split('|').map(Number);
    if (delta === -12345) continue; // Seed-Eintrag am Ende
    time += delta;
    frames.push([time, x, y, keys]);
  }
  // Einzelne Spieler haben negative Sprünge am Anfang: Reihenfolge für die Suche sichern.
  frames.sort((a, b) => a[0] - b[0]);
  return frames;
}

export function parseReplay(buffer) {
  const reader = new Reader(buffer);
  const mode = reader.u8();
  const version = reader.u32();
  const beatmapHash = reader.string();
  const player = reader.string();
  const replayHash = reader.string();
  const c300 = reader.u16();
  const c100 = reader.u16();
  const c50 = reader.u16();
  const geki = reader.u16();
  const katu = reader.u16();
  const miss = reader.u16();
  const score = reader.u32();
  const maxCombo = reader.u16();
  const perfect = reader.u8() === 1;
  const mods = reader.u32();
  reader.string(); // Lebensbalken
  const ticks = reader.u64();
  const length = reader.u32();
  const compressed = buffer.subarray(reader.at, reader.at + length);
  const frames = length ? parseFrames(decompressLzma(compressed).toString('latin1')) : [];
  return {
    mode, version, beatmapHash, player, replayHash,
    counts: { c300, c100, c50, geki, katu, miss },
    score, maxCombo, perfect, mods,
    playedAt: Number((ticks - 621355968000000000n) / 10000n),
    frames,
  };
}

export const md5 = (data) => createHash('md5').update(data).digest('hex');
