import { frame, crcBytes } from './midi.js';
import { seven2eight } from '../vendor/tools.ts';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const join = chunks => { const bytes = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0)); let pos = 0; for (const b of chunks) { bytes.set(b, pos); pos += b.length; } return bytes; };
// INFO is before the executable DATA chunk; partial reads never execute effect code.
export function parseZd2Info(bytes) {
  if (bytes.length < 128) return null;
  if (String.fromCharCode(...bytes.slice(0, 4)) !== 'ZDLF') throw Error('ZD2の形式が不正です');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = 128; pos + 8 <= bytes.length;) {
    const tag = String.fromCharCode(...bytes.slice(pos, pos + 4)), length = view.getUint32(pos + 4, true);
    if (length > 5 * 1024 * 1024) throw Error('ZD2のチャンク長が不正です');
    if (pos + 8 + length > bytes.length) return null;
    if (tag === 'INFO') {
      if (length !== 20) throw Error('未対応のDSP情報形式です');
      const dspload = view.getFloat32(pos + 24, true), percent = dspload / 2.5;
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw Error('DSP情報が不正です');
      return { id: view.getUint32(96, true), version: String.fromCharCode(...bytes.slice(89, 93)), dspload, percent };
    }
    pos += 8 + length;
  }
  return null;
}
export function parseCatalog(bytes) {
  if (bytes.length < 78 || bytes[0] !== 62 || bytes[1] !== 62 || bytes[2] !== 62 || bytes[3] !== 0) throw Error('エフェクトカタログの形式が不正です');
  const entries = [], ids = new Set(), filenames = new Set(); let pos = 78;
  const text = (offset, n) => String.fromCharCode(...bytes.slice(offset, offset + n)).replace(/\0.*$/s, '').trim();
  while (pos + 26 <= bytes.length && bytes[pos] === 62) {
    const group = bytes[pos + 4]; pos += 26;
    while (pos + 26 <= bytes.length && bytes[pos] !== 60) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 26);
      const entry = { filename: text(pos, 12), version: text(pos + 13, 4), installed: bytes[pos + 18] === 1, id: view.getUint32(19, true), group };
      if (!/^[A-Z0-9_]{1,8}\.ZD2$/.test(entry.filename) || ids.has(entry.id) || filenames.has(entry.filename) || entry.id >>> 24 !== group || ![0, 1].includes(bytes[pos + 18])) throw Error('カタログの項目が不正です');
      entries.push(entry); ids.add(entry.id); filenames.add(entry.filename);
      pos += 26;
      if (entries.length > 1024) throw Error('カタログの項目数が多すぎます');
    }
    if (bytes[pos] !== 60) throw Error('カタログの終端がありません');
    pos += 26;
  }
  if (!entries.length) throw Error('エフェクト一覧が空です');
  return entries;
}
export class ReadOnlyCatalogReader {
  constructor(midi) { this.midi = midi; }
  async command(payload) {
    // This interface deliberately exposes no file write/delete command.
    if (payload[0] !== 0x60 || ![5, 9, 0x20, 0x21, 0x22].includes(payload[1]) || (payload[1] === 0x20 && payload[2] !== 2)) throw Error('読み取り以外のコマンドは禁止されています');
    return this.midi.request(payload, d => this.midi.matches(d, [0x60]));
  }
  async readFile(filename, metadataOnly = false) {
    if (!/^[A-Z0-9_.-]{1,12}$/.test(filename)) throw Error('ファイル名が不正です');
    const open = [0x60, 0x20, 2, ...new Array(9).fill(0), ...Array.from(filename, c => c.charCodeAt(0)), 0];
    const chunks = []; let total = 0, ended = false;
    try {
      await this.command(open); await this.command(open); await this.command([0x60, 5, 0]);
      for (let step = 0; step < 4096; step++) {
        await this.command([0x60, 0x22, 0x14, 0x2f, 0x60, 0, 0x0c, 0, 4, 0, 0, 0]);
        let data, ready = false;
        for (let poll = 0; poll < 64; poll++) {
          data = await this.command([0x60, 5, 0]);
          const tail = Array.from(data.slice(-6, -1));
          if (data[5] === 3 && tail.every((v, i) => v === [127, 127, 127, 127, 15][i])) continue;
          if (data[5] === 4 && data[7] !== 1 && (data[9] + data[10] * 128) > 0) continue;
          ready = true; break;
        }
        if (!data || !ready) throw Error('エフェクト情報の受信回数が上限を超えました');
        if (data[5] === 3) {
          const tail = Array.from(data.slice(-6, -1));
          if (![ [0, 0, 0, 0, 0], [120, 127, 127, 127, 15] ].some(expected => expected.every((b, i) => b === tail[i]))) throw Error('ファイルの終端応答が不正です');
          ended = true; break;
        }
        if (data[5] !== 4 || data[6] !== 0x22 || data[7] !== 1) throw Error('ファイル読み込み応答が不正です');
        const len = data[9] + data[10] * 128;
        if (!len) { ended = true; break; }
        if (len > 4096) throw Error('チャンクが大きすぎます');
        const packed = len + Math.ceil(len / 7), raw = seven2eight(data, 11, 11 + packed - 1);
        if (data.length !== 11 + packed + 6) throw Error('ファイルの受信長が不正です');
        if (raw.length !== len || crcBytes(raw).some((v, i) => v !== data[data.length - 6 + i])) throw Error('ファイルのCRCが一致しません');
        chunks.push(raw); total += raw.length;
        if (total > 5 * 1024 * 1024) throw Error('ファイルが大きすぎます');
        if (metadataOnly && parseZd2Info(join(chunks))) { ended = true; break; }
      }
      if (!ended) throw Error('ファイルの受信回数が上限を超えました');
    } finally {
      try { await this.command([0x60, 0x21, 0x40, 0, 0, 0, 0]); await this.command([0x60, 9]); } catch { /* Retain the original read error. */ }
    }
    return join(chunks);
  }
  async scan({ includeDsp = false, progress = () => {} } = {}) {
    this.midi.requireConnection();
    const before = await this.midi.readCurrent();
    let bytes, entries, costs = {}, errors = [];
    try {
      this.midi.output.send(frame([0x50])); await wait(100);
      this.midi.output.send(frame([0x52])); await wait(100);
      bytes = await this.readFile('FLST_SEQ.ZT2');
      entries = parseCatalog(bytes);
      if (includeDsp) {
        const installed = entries.filter(e => e.installed);
        for (const [i, entry] of installed.entries()) {
          progress(i + 1, installed.length, entry.filename);
          if (entry.filename === 'BPM_MDL.ZD2') continue;
          try {
            const info = parseZd2Info(await this.readFile(entry.filename, true));
            if (!info || info.id !== entry.id) throw Error('エフェクトIDまたはDSP情報を確認できません');
            costs[entry.id.toString(16).padStart(8, '0')] = { ...info, catalogVersion: entry.version, file: entry.filename };
          } catch (e) { errors.push({ filename: entry.filename, message: e.message }); }
        }
      }
    } finally {
      this.midi.output.send(frame([0x53])); await wait(100);
      this.midi.output.send(frame([0x51])); await wait(100);
    }
    const after = await this.midi.readCurrent(); this.midi.verify(before.raw, after.raw);
    return { firmware: this.midi.version, entries, costs, errors, currentPatchUnchanged: true };
  }
}
