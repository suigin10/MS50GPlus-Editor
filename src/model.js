import { ZoomPatch, EffectSettings } from '../vendor/ZoomPatch.ts';
import effectMap from './effects.json';
import officialCatalog from './official-catalog.json';
import { setLogLevel, LogLevel } from '../vendor/Logger.ts';
import { invalidSlotReport } from './dsp.js';
setLogLevel(LogLevel.Error | LogLevel.Warning);
export const effects = Object.entries(effectMap).map(([key, data]) => ({ ...data, ...officialCatalog[key], id: parseInt(key, 16),
  parameters: data.parameters.map(p => ({ ...p, hidden: p.hidden || /^Hidden-/i.test(p.name), values: p.values.map(v => v.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))) }))
}));
export const groups = { 1: 'DYNAMICS', 2: 'FILTER', 3: 'DRIVE', 4: 'AMP', 6: 'MODULATION', 7: 'SFX', 8: 'DELAY', 9: 'REVERB' };
export const findEffect = id => effects.find(e => e.id === id);
export function newPatch(name = 'New Patch') {
  const p = ZoomPatch.createEmptyPTCFPatch(32);
  p.name = name;
  return p;
}
export function settingsFor(id) {
  const def = findEffect(id);
  if (!def) throw Error('対応していないエフェクトです');
  const s = new EffectSettings(19);
  s.id = id; s.enabled = true;
  def.parameters.forEach((p, i) => { s.parameters[i] = p.default ?? 0; });
  return s;
}
export function patchBytes(patch) {
  const bytes = patch.buildPTCFChunk(32);
  if (!bytes || bytes.length > 4096) throw Error('パッチを生成できません。メモを短くしてください。');
  return bytes;
}
export function parsePatch(bytes) {
  bytes = Uint8Array.from(bytes);
  if (bytes.length < 44 || bytes.length > 4096 || String.fromCharCode(...bytes.slice(0, 4)) !== 'PTCF') throw Error('MS+用のPTCFパッチではありません');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(4, true), count = view.getUint32(12, true), target = view.getUint32(16, true);
  if (length < 44 || length > bytes.length || count < 1 || count > 6 || target !== 0x40000) throw Error('MS-50G+用のパッチではないか、データが壊れています');
  let pos = 36 + count * 4;
  const chunks = new Map();
  while (pos < length) {
    if (pos + 8 > length) throw Error('チャンクヘッダーが壊れています');
    const tag = String.fromCharCode(...bytes.slice(pos, pos + 4));
    const size = view.getUint32(pos + 4, true);
    if (pos + 8 + size > length || chunks.has(tag)) throw Error('チャンク長が不正です');
    chunks.set(tag, size); pos += 8 + size;
  }
  if (chunks.get('EDTB') !== count * 24 || chunks.get('PRM2') !== 32 || chunks.get('NAME') !== 32) throw Error('必要なパッチ情報が不足しています');
  const patch = ZoomPatch.fromPatchData(bytes.slice(0, length));
  if (!patch.effectSettings || patch.effectSettings.length !== count) throw Error('エフェクト情報が壊れています');
  return patch;
}
export function serializeProject(patch, note) {
  return JSON.stringify({ format: 'ms50g-plus-editor', version: 1, model: 'MS-50G+', note, patch: Array.from(patchBytes(patch)) }, null, 2);
}
export function parseProject(text) {
  const data = JSON.parse(text);
  if (data.format !== 'ms50g-plus-editor' || data.version !== 1 || data.model !== 'MS-50G+' || !Array.isArray(data.patch) || data.patch.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw Error('対応していないプロジェクトです');
  return { patch: parsePatch(data.patch), note: typeof data.note === 'string' ? data.note.slice(0, 20000) : '' };
}
export function validateForSend(patch) {
  const invalid = invalidSlotReport(patch);
  if (invalid) throw Error(invalid.message);
  for (const s of patch.effectSettings) {
    if (s.id === 0) continue;
    const def = findEffect(s.id);
    if (!def) throw Error('未知のエフェクトが含まれるため送信できません');
    def.parameters.forEach((p, i) => {
      const v = s.parameters[i];
      if (!Number.isInteger(v) || v < 0 || v > p.max) throw Error(`${def.name} / ${p.name} の値が範囲外です`);
    });
  }
  return patchBytes(patch);
}
