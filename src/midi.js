import { eight2seven, seven2eight, crc32 } from '../vendor/tools.ts';
import { parsePatch, validateForSend } from './model.js';
import { invalidSlotReport, screenDspReport } from './dsp.js';
export const frame = payload => Uint8Array.from([0xf0, 0x52, 0, 0x6e, ...payload, 0xf7]);
export function crcBytes(bytes) {
  const crc = (crc32(bytes) ^ 0xffffffff) >>> 0;
  return [crc & 127, (crc >>> 7) & 127, (crc >>> 14) & 127, (crc >>> 21) & 127, (crc >>> 28) & 15];
}
export function decodeDump(data, memory = false) {
  const offset = memory ? 13 : 9;
  if (data[0] !== 0xf0 || data[1] !== 0x52 || data[3] !== 0x6e || data.at(-1) !== 0xf7 || data[4] !== (memory ? 0x45 : 0x64) || data[5] !== (memory ? 0 : 0x12) || data[6] !== (memory ? 0 : 1)) throw Error('想定外のパッチ応答です');
  const len = data[offset - 2] + data[offset - 1] * 128;
  if (len < 44 || len > 4096) throw Error('パッチ長が不正です');
  const packedLength = len + Math.ceil(len / 7);
  const extra = data.length - offset - packedLength - 1;
  if (![0, 5].includes(extra)) throw Error('USB受信データの長さが一致しません');
  if (data.slice(1, -1).some(b => b > 127)) throw Error('SysExデータが壊れています');
  const raw = seven2eight(data, offset, offset + packedLength - 1);
  if (extra === 5 && crcBytes(raw).some((b, i) => b !== data[offset + packedLength + i])) throw Error('CRCが一致しません。読み込み直してください');
  return { raw, patch: parsePatch(raw) };
}
export class PedalConnection {
  constructor(log = () => {}, stateChanged = () => {}) {
    this.log = log; this.stateChanged = stateChanged; this.connected = false; this.pending = null;
    this.length = 0; this.count = 100; this.perBank = 100; this.currentBank = 0; this.timeout = 3000;
    this.listeners = new Set();
    this.dspListeners = new Set(); this.dspReport = { type: 'unknown', blocked: false, slots: [], message: '本体の状態は未確認です' };
  }
  async accessPorts() {
    if (!navigator.requestMIDIAccess) throw Error('この環境ではMIDIに接続できません');
    if (!this.access) {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.access.onstatechange = () => {
        if (this.connected && (this.input?.state !== 'connected' || this.output?.state !== 'connected')) this.disconnect();
        this.stateChanged();
      };
    }
    return { inputs: [...this.access.inputs.values()].filter(p => p.state === 'connected'), outputs: [...this.access.outputs.values()].filter(p => p.state === 'connected') };
  }
  async connect(input, output) {
    await this.disconnect();
    if (!input || !output) throw Error('MIDI入力・出力を選択してください');
    this.input = input; this.output = output;
    try {
      await input.open(); await output.open();
      input.onmidimessage = event => this.receive(Uint8Array.from(event.data));
      const id = await this.request(Uint8Array.from([0xf0, 0x7e, 0x7f, 6, 1, 0xf7]), d => d.length >= 15 && d[0] === 0xf0 && d[1] === 0x7e && d[3] === 6 && d[4] === 2, true);
      if (id[5] !== 0x52 || id[6] !== 0x6e || id[7] !== 0 || id[8] !== 0x23 || id.at(-1) !== 0xf7) throw Error('MS-50G+以外の機器です。接続を中止しました');
      this.version = String.fromCharCode(...id.slice(10, 14));
      const info = await this.request([7], d => this.matches(d, [6]) && d.length >= 10);
      this.count = info[5] + info[6] * 128; this.length = info[7] + info[8] * 128;
      if (this.count !== 100 || this.length < 44 || this.length > 4096) throw Error('本体のメモリー構成を確認できません');
      // Firmware 1.40 reports ten programs per bank. Query the actual layout.
      this.perBank = this.count;
      try {
        const info2 = await this.request([0x44], d => this.matches(d, [0x43]) && d.length >= 14);
        const perBank = info2[11] + info2[12] * 128;
        if (perBank > 0 && perBank <= 100) this.perBank = perBank;
      } catch (e) { this.log('バンク情報: ' + e.message + '。100パッチ構成を使用'); }
      this.connected = true;
      this.setDspReport({ type: 'unknown', blocked: false, slots: [], message: '接続済み · DSP状態は未確認です' });
      this.log(`接続: MS-50G+ / FW ${this.version} / ${this.length} bytes`); this.stateChanged();
    } catch (e) { await this.disconnect(); throw e; }
  }
  async disconnect() {
    this.connected = false;
    this.currentBank = 0;
    this.dspSupported = undefined;
    this.setDspReport({ type: 'unknown', blocked: false, slots: [], message: '本体未接続' });
    for (const listener of this.listeners) listener(null);
    if (this.pending) { this.pending.reject(Error('MIDI接続が解除されました')); this.pending = null; }
    const input = this.input, output = this.output;
    this.input = null; this.output = null;
    if (input) input.onmidimessage = null;
    await Promise.allSettled([input?.close(), output?.close()]);
    this.stateChanged();
  }
  matches(data, command) { return data[0] === 0xf0 && data[1] === 0x52 && data[2] === 0 && data[3] === 0x6e && data.at(-1) === 0xf7 && command.every((b, i) => data[4 + i] === b); }
  receive(data) {
    if (data.length === 3 && (data[0] & 0xf0) === 0xb0) {
      if (data[1] === 0) this.currentBank = (this.currentBank & 127) | (data[2] << 7);
      else if (data[1] === 32) this.currentBank = (this.currentBank & (127 << 7)) | data[2];
    } else if (this.matches(data, [0x64, 0x26, 0, 0]) && data.length === 13) {
      this.currentBank = data[8] + data[9] * 128;
    }
    if (this.matches(data, [0x64, 1])) {
      try { const report = screenDspReport(data); if (report.blocked) this.setDspReport(report); } catch { /* An explicit check will report unsupported screen data. */ }
    }
    for (const listener of this.listeners) listener(data);
    if (!this.pending) return;
    if (this.matches(data, [0, 1]) || this.matches(data, [0, 10])) { this.pending.reject(Error('本体が操作を拒否しました')); return; }
    if (this.pending.match(data)) this.pending.resolve(data);
  }
  request(payload, match, raw = false) {
    if (this.pending) return Promise.reject(Error('MIDI通信中です。完了後に再操作してください'));
    if (!this.output) return Promise.reject(Error('本体に接続してください'));
    return new Promise((resolve, reject) => {
      const done = (callback, value) => { clearTimeout(timer); this.pending = null; callback(value); };
      const timer = setTimeout(() => done(reject, Error('本体の応答がありません。USB接続とMIDIポートを確認してください')), this.timeout);
      this.pending = { match, resolve: d => done(resolve, d), reject: e => done(reject, e) };
      try { this.output.send(raw ? payload : frame(payload)); } catch (e) { this.pending.reject(e); }
    });
  }
  requireConnection() { if (!this.connected) throw Error('MS-50G+に接続してください'); }
  setDspReport(report) { this.dspReport = report; for (const listener of this.dspListeners) listener(report); this.stateChanged(); }
  async checkDsp(patch = null, force = false) {
    this.requireConnection();
    const current = patch || (await this.readCurrent()).patch;
    const invalid = invalidSlotReport(current);
    if (invalid) { this.setDspReport(invalid); return invalid; }
    if (this.dspSupported === false && !force) {
      const report = { blocked: false, type: 'unknown', slots: [], message: '本体の画面情報を取得できないため、DSP状態は未確認です' };
      this.setDspReport(report); return report;
    }
    try {
      this.dspQuery = true;
      const data = await this.request([0x64, 2, 0, 6, 0], d => this.matches(d, [0x64, 1]));
      const report = screenDspReport(data); this.dspSupported = true; this.setDspReport(report); return report;
    } catch (e) {
      this.dspSupported = false;
      const report = { blocked: false, type: 'unknown', slots: [], message: '本体のDSP状態は未確認: ' + e.message };
      this.setDspReport(report); return report;
    } finally { this.dspQuery = false; }
  }
  async readProgram() {
    this.requireConnection();
    const data = await this.request([0x33], d => d.length === 2 && this.memorySlotFromMessage(d) !== undefined);
    return this.memorySlotFromMessage(data);
  }
  memorySlotFromMessage(data) {
    let bank, program;
    if (data.length === 2 && (data[0] & 0xf0) === 0xc0) { bank = this.currentBank; program = data[1]; }
    else if (this.matches(data, [0x64, 0x26, 0, 0]) && data.length === 13) { bank = data[8] + data[9] * 128; program = data[10] + data[11] * 128; }
    else return undefined;
    const slot = bank * this.perBank + program;
    return program < this.perBank && slot < this.count ? slot : undefined;
  }
  async selectProgram(slot) {
    this.requireConnection();
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.count) throw Error('パッチ番号は001〜100です');
    if (await this.readProgram() === slot) return false;
    const bank = Math.floor(slot / this.perBank), program = slot % this.perBank;
    this.output.send(Uint8Array.from([0xb0, 0, 0]));
    this.output.send(Uint8Array.from([0xb0, 32, bank]));
    this.output.send(Uint8Array.from([0xc0, program]));
    for (let attempt = 0; attempt < 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (await this.readProgram() === slot) { await new Promise(resolve => setTimeout(resolve, 100)); return true; }
    }
    throw Error('本体のパッチ切り替えを確認できません。「現在のパッチを読む」で確認してください');
  }
  async readCurrent() {
    this.requireConnection();
    const result = decodeDump(await this.request([0x64, 0x13], d => this.matches(d, [0x64, 0x12])));
    const invalid = invalidSlotReport(result.patch); if (invalid) this.setDspReport(invalid);
    return result;
  }
  slotHeader(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.count) throw Error('パッチ番号は001〜100です');
    const bank = Math.floor(slot / this.perBank), program = slot % this.perBank;
    return [bank & 127, bank >>> 7, program & 127, program >>> 7];
  }
  async readSlot(slot) {
    this.requireConnection(); const header = this.slotHeader(slot);
    const result = await this.request([0x46, 0, 0, ...header], d => this.matches(d, [0x45, 0, 0]) && header.every((b, i) => d[7 + i] === b));
    return decodeDump(result, true);
  }
  padded(patch) {
    this.requireConnection();
    const bytes = validateForSend(patch);
    if (bytes.length > this.length) throw Error(`パッチが本体の容量を超えています (${bytes.length}/${this.length} bytes)`);
    const padded = new Uint8Array(this.length); padded.set(bytes); return padded;
  }
  verify(expected, actual) {
    if (actual.length !== expected.length || actual.some((b, i) => b !== expected[i])) throw Error('送信後の読み戻しが一致しません。本体の状態を確認してください');
  }
  async apply(patch) {
    const padded = this.padded(patch);
    const program = await this.readProgram();
    await this.readCurrent();
    if (program !== await this.readProgram()) throw Error('本体のパッチが切り替わりました。もう一度操作してください');
    // Enable parameter editing only for an explicitly requested write. Never send firmware/file-system commands.
    this.output.send(frame([0x50]));
    this.output.send(frame([0x28, ...eight2seven(padded)]));
    const actual = await this.readCurrent();
    const health = await this.checkDsp(actual.patch);
    if (health.blocked) throw Error(health.message);
    this.verify(padded, actual.raw);
    this.log('本体への反映を読み戻して確認しました');
  }
  async writeSlot(patch, slot) {
    const padded = this.padded(patch), header = this.slotHeader(slot);
    await this.request([0x45, 0, 0, ...header, padded.length & 127, padded.length >>> 7, ...eight2seven(padded), ...crcBytes(padded)], d => this.matches(d, [0, 0]));
    const actual = await this.readSlot(slot);
    this.verify(padded, actual.raw);
    this.log(`${String(slot + 1).padStart(3, '0')}への保存を読み戻して確認しました`);
  }
}
