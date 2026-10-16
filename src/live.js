import { frame } from './midi.js';
import { findEffect, validateForSend } from './model.js';

// Compare editable sound settings, allowing the pedal's selected screen to differ.
export function soundState(patch) {
  return JSON.stringify({ name: patch.name.trim(), tempo: patch.tempo, volume: patch.prm2PatchVolume,
    effects: patch.effectSettings.map(s => ({ id: s.id, enabled: s.enabled, parameters: s.parameters })) });
}
export function parameterMessage(slot, parameter, value) {
  if (!Number.isInteger(slot) || !Number.isInteger(parameter) || !Number.isInteger(value) || slot < 0 || slot > 100 || parameter < 0 || parameter > 127 || value < 0 || value > 16383) throw Error('パラメーター送信値が不正です');
  return frame([0x64, 0x20, 0, slot, parameter, value & 127, value >>> 7, 0, 0, 0]);
}
export class LiveSession {
  constructor(midi, notify = () => {}, onRemote = null) {
    this.midi = midi; this.notify = notify; this.active = false; this.generation = 0;
    this.onRemote = onRemote; this.bidirectional = typeof onRemote === 'function';
    this.revision = 0; this.needsSync = false; this.pendingWrites = new Map();
    this.queue = new Map(); this.recent = new Map(); this.flight = null; this.timer = null; this.heartbeat = null;
    midi.listeners.add(data => this.observe(data));
    midi.dspListeners.add(report => { if (this.active && report.blocked) this.stop(report.message); });
  }
  stop(reason = '') {
    const wasActive = this.active;
    this.active = false; this.generation++; this.queue.clear(); this.recent.clear();
    this.pendingWrites.clear(); this.needsSync = false;
    clearTimeout(this.timer); clearInterval(this.heartbeat); this.timer = null; this.heartbeat = null;
    if (wasActive) this.notify(reason || 'リアルタイム調整をOFFにしました');
  }
  async stopAndWait(reason = '') { this.stop(reason); if (this.flight) await this.flight; }
  async start(patch) {
    await this.stopAndWait(); validateForSend(patch);
    const program = await this.midi.readProgram();
    const current = await this.midi.readCurrent();
    const after = await this.midi.readProgram();
    if (program !== after) throw Error('本体のパッチが切り替わりました。もう一度開始してください');
    if (soundState(patch) !== soundState(current.patch)) throw Error('本体とPCの設定が一致しません。「現在のパッチを読む」または「本体に反映」の後、開始してください');
    const health = await this.midi.checkDsp(current.patch);
    if (health.blocked) throw Error(health.message);
    if (program !== await this.midi.readProgram()) throw Error('本体のパッチが切り替わりました。もう一度開始してください');
    this.program = program; this.expected = current.patch.clone(); this.lastEdit = Date.now(); this.lastVerify = Date.now();
    this.midi.output.send(frame([0x50]));
    this.active = true;
    this.heartbeat = setInterval(() => this.flush(), this.bidirectional ? 200 : 400);
    this.notify(this.bidirectional ? '双方向同期 ON · PCと本体の操作を互いに反映します' : 'リアルタイム調整ON · スライダー・ON/OFF・テンポ・音量を本体に即時反映します');
  }
  observe(data) {
    if (!this.active) return;
    if (!data) { this.stop('USB接続が切れたため、リアルタイム調整を停止しました'); return; }
    if (this.pollingProgram && (data[0] & 0xf0) === 0xc0) return;
    const notifiedProgram = this.midi.memorySlotFromMessage(data);
    if (notifiedProgram !== undefined && notifiedProgram !== this.program) {
      if (this.bidirectional) this.requestSync(); else this.stop('本体のパッチが切り替わったため、リアルタイム調整を停止しました'); return;
    }
    if ((this.midi.matches(data, [0, 1]) || this.midi.matches(data, [0, 10])) && !this.midi.dspQuery) { this.stop('本体が変更を拒否したため、リアルタイム調整を停止しました'); return; }
    if (this.midi.matches(data, [0x64, 0x12]) && !this.checking) { if (this.bidirectional) this.requestSync(); else this.stop('本体の構成変更を検出しました。パッチを読み直してください'); return; }
    if (this.midi.matches(data, [0x64, 0x20, 0]) && data.length === 15) {
      const slot = data[7], parameter = data[8], value = data[9] + data[10] * 128;
      if (this.bidirectional) {
        if (this.needsSync) { this.revision++; return; }
        if (slot === 95 || parameter === 1 && slot !== 100) { this.requestSync(); return; }
        if (slot === 100 && ![0, 1, 2].includes(parameter)) return;
        const current = this.valueFor(this.expected, slot, parameter);
        if (current === undefined || !this.validValue(slot, parameter, value)) { this.requestSync(); return; }
        // Accepted-PC replies use 64 20 01. Some devices also echo 64 20 00.
        // Only an exact current-value echo is ignored; returning to an older value is a real edit.
        if (current === value && !this.queue.has(`${slot}:${parameter}`)) return;
        this.queue.delete(`${slot}:${parameter}`); this.pendingWrites.delete(`${slot}:${parameter}`);
        if (slot !== 100) this.queue.delete('100:1');
        this.setValue(this.expected, slot, parameter, value);
        this.revision++; this.lastEdit = Date.now();
        this.onRemote({ type: 'parameter', slot, parameter, value, program: this.program });
        return;
      }
      // Moving the display cursor does not alter the sound.
      if (slot === 100 && parameter === 1) return;
      const echo = this.recent.get(`${slot}:${parameter}:${value}`);
      if (!echo || Date.now() - echo > 2000) this.stop('本体側の操作を検出しました。パッチを読み直すと再開できます');
    }
  }
  requestSync() {
    this.needsSync = true; this.revision++; this.queue.clear(); this.pendingWrites.clear();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 20);
  }
  async readProgram() {
    this.pollingProgram = true;
    try { return await this.midi.readProgram(); } finally { this.pollingProgram = false; }
  }
  valueFor(patch, slot, parameter) {
    if (slot === 100) return parameter === 0 ? patch.prm2PatchVolume : parameter === 1 ? patch.currentEffectSlot : parameter === 2 ? patch.tempo : undefined;
    const s = patch.effectSettings[slot];
    return s ? parameter === 0 ? Number(s.enabled) : parameter >= 2 ? s.parameters[parameter - 2] : undefined : undefined;
  }
  setValue(patch, slot, parameter, value) {
    if (slot === 100) { if (parameter === 0) patch.prm2PatchVolume = value; else if (parameter === 1) patch.currentEffectSlot = value; else patch.tempo = value; }
    else if (parameter === 0) patch.effectSettings[slot].enabled = !!value;
    else patch.effectSettings[slot].parameters[parameter - 2] = value;
  }
  validValue(slot, parameter, value) {
    if (!Number.isInteger(value)) return false;
    if (slot === 100) return parameter === 0 ? value >= 0 && value <= 120 : parameter === 1 ? value >= 0 && value < this.expected.effectSettings.length : parameter === 2 && value >= 40 && value <= 250;
    const def = findEffect(this.expected.effectSettings[slot]?.id);
    const max = parameter === 0 ? 1 : def?.parameters[parameter - 2]?.max;
    return !!def && max !== undefined && value >= 0 && value <= max;
  }
  selectSlot(slot) { if (this.active && this.bidirectional && slot < this.expected.effectSettings.length) this.queueValue(100, 1, slot); }
  queueValue(slot, parameter, value) {
    if (!this.active) return;
    if (this.needsSync) return;
    if (slot === 100) {
      if (!((parameter === 0 && value >= 0 && value <= 120) || (parameter === 2 && value >= 40 && value <= 250) || (this.bidirectional && parameter === 1 && this.validValue(slot, parameter, value)))) throw Error('全体設定の値が不正です');
    } else {
      const s = this.expected.effectSettings[slot], def = s && findEffect(s.id);
      const max = parameter === 0 ? 1 : def?.parameters[parameter - 2]?.max;
      if (!s || !def || max === undefined || value < 0 || value > max) throw Error('パラメーターが範囲外です');
    }
    parameterMessage(slot, parameter, value);
    if (this.bidirectional && slot !== 100) this.queue.set('100:1', { slot: 100, parameter: 1, value: slot });
    this.queue.set(`${slot}:${parameter}`, { slot, parameter, value }); this.lastEdit = Date.now();
    this.revision++;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 30);
  }
  async synchronize(token) {
    this.checking = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = this.revision, program = await this.readProgram(), current = await this.midi.readCurrent();
        if (!this.active || token !== this.generation) return;
        const after = await this.readProgram();
        if (!this.active || token !== this.generation) return;
        if (program !== after || revision !== this.revision) continue;
        const changedProgram = program !== this.program;
        this.program = program; this.expected = current.patch.clone(); this.needsSync = false;
        this.pendingWrites.clear(); this.queue.clear();
        this.onRemote({ type: 'patch', patch: current.patch.clone(), program, changedProgram });
        validateForSend(current.patch);
        const health = await this.midi.checkDsp(current.patch); if (health.blocked) throw Error(health.message);
        this.lastEdit = Date.now(); this.lastVerify = Date.now(); return;
      }
    } finally { this.checking = false; }
  }
  update(before, after) {
    if (!this.active) return;
    if (before.name !== after.name || before.effectSettings.length !== after.effectSettings.length || before.effectSettings.some((s, i) => s.id !== after.effectSettings[i].id)) {
      this.stop('名前・エフェクト構成を変更したため停止しました。「本体に反映」の後、再開してください'); return;
    }
    if (before.tempo !== after.tempo) this.queueValue(100, 2, after.tempo);
    if (before.prm2PatchVolume !== after.prm2PatchVolume) this.queueValue(100, 0, after.prm2PatchVolume);
    after.effectSettings.forEach((s, slot) => {
      if (s.enabled !== before.effectSettings[slot].enabled) this.queueValue(slot, 0, s.enabled ? 1 : 0);
      const def = findEffect(s.id);
      def?.parameters.forEach((p, i) => { if (s.parameters[i] !== before.effectSettings[slot].parameters[i]) this.queueValue(slot, i + 2, s.parameters[i]); });
    });
  }
  flush() {
    if (!this.active || this.flight) return this.flight;
    const token = this.generation;
    this.flight = this.process(token).catch(e => this.stop('リアルタイム調整を停止しました: ' + e.message)).finally(() => {
      this.flight = null;
      if (this.active && this.queue.size && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 30);
    });
    return this.flight;
  }
  async process(token) {
    const program = await this.readProgram();
    if (!this.active || token !== this.generation) return;
    if (this.bidirectional && (this.needsSync || program !== this.program)) { this.needsSync = true; this.queue.clear(); this.pendingWrites.clear(); await this.synchronize(token); return; }
    if (program !== this.program) { this.stop('本体のパッチが切り替わったため停止しました'); return; }
    const batch = [...this.queue.values()]; this.queue.clear();
    for (const { slot, parameter, value } of batch) {
      if (!this.active || token !== this.generation || this.needsSync) return;
      this.recent.set(`${slot}:${parameter}:${value}`, Date.now());
      for (const [key, time] of this.recent) if (Date.now() - time > 2000) this.recent.delete(key);
      this.setValue(this.expected, slot, parameter, value);
      if (this.bidirectional && !(slot === 100 && parameter === 1)) this.pendingWrites.set(`${slot}:${parameter}`, { slot, parameter, value });
      this.midi.output.send(parameterMessage(slot, parameter, value));
      // Re-select the displayed effect after a PC edit so the pedal redraws its values.
      if (this.bidirectional && slot !== 100) this.midi.output.send(parameterMessage(100, 1, slot));
    }
    // Read back when the user pauses, without reloading the pedal's patch.
    if (!batch.length && Date.now() - this.lastEdit > 500 && Date.now() - this.lastVerify > 1500) {
      this.checking = true;
      try {
        const revision = this.revision;
        const current = await this.midi.readCurrent();
        if (this.bidirectional && (revision !== this.revision || this.needsSync)) return;
        if (this.bidirectional) {
          for (const sent of this.pendingWrites.values()) if (this.valueFor(current.patch, sent.slot, sent.parameter) !== sent.value) throw Error('送信した値の読み戻しが一致しません。現在のパッチを読み直してください');
          this.pendingWrites.clear();
        }
        if (this.active && token === this.generation) await this.midi.checkDsp(current.patch);
        if (this.bidirectional && (revision !== this.revision || this.needsSync)) return;
        if (this.active && token === this.generation && soundState(current.patch) !== soundState(this.expected)) {
          if (this.bidirectional) { this.expected = current.patch.clone(); this.onRemote({ type: 'patch', patch: current.patch.clone(), program: this.program, changedProgram: false }); }
          else this.stop('読み戻しが一致しません。現在のパッチを読み直してください');
        }
        this.lastVerify = Date.now();
      } finally { this.checking = false; }
    }
  }
}
