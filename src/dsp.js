import costs from './dsp-costs.json';
export function estimateDsp(patch, inventory = null) {
  let known = 0; const unknown = [], slots = [];
  for (const [index, s] of patch.effectSettings.entries()) {
    if (s.id === 0) continue;
    const key = s.id.toString(16).padStart(8, '0');
    let cost = inventory?.costs?.[key] ?? costs.effects[key];
    const entry = inventory?.entries.find(e => e.id === s.id && e.installed);
    if (inventory && (!entry || cost?.catalogVersion !== entry.version)) cost = null;
    if (cost) known += cost.percent; else unknown.push(index);
    slots.push({ index, percent: cost?.percent ?? null, version: cost?.version ?? null, source: inventory?.costs?.[key] ? 'device' : 'bundled' });
  }
  const percent = Math.round(known * 100) / 100;
  return { percent, complete: !unknown.length, unknown, slots, over: percent > 100, near: percent >= 90 };
}
export function invalidSlotReport(patch) {
  const mask = patch.prm2InvalidEffectSlot ?? 0;
  const slots = patch.effectSettings.map((_, i) => i).filter(i => (mask & (1 << i)) !== 0);
  return slots.length ? { blocked: true, type: 'invalid', slots, message: `本体で利用不可のスロット: ${slots.map(i => i + 1).join(', ')}。DSP容量や未導入エフェクトなどを本体で確認し、削除・置換してください。` } : null;
}
// MS+ screen records: screen, parameter, type, invert, ten ASCII bytes.
// Only explicit screen text is classified as a DSP overflow; invalid bits are not a DSP meter.
export function screenDspReport(data) {
  if (data.length < 7 || data[0] !== 0xf0 || data[1] !== 0x52 || data[3] !== 0x6e || data[4] !== 0x64 || data[5] !== 1 || data.at(-1) !== 0xf7 || (data.length - 7) % 14) throw Error('本体の画面情報を解釈できません');
  const screens = new Map();
  for (let pos = 6; pos < data.length - 1; pos += 14) {
    const screen = data[pos];
    if (screen > 12) throw Error('画面番号が不正です');
    const text = String.fromCharCode(...data.slice(pos + 4, pos + 14)).replaceAll('\0', '').trim();
    if (!screens.has(screen)) screens.set(screen, []);
    screens.get(screen).push(text);
  }
  const slots = [...screens].filter(([, fields]) => /DSPFULL|DSPOVER(?:FLOW|LOAD)?|PROCESSOVERFLOW/.test(fields.join('').toUpperCase().replace(/[^A-Z]/g, ''))).map(([slot]) => slot);
  if (!screens.size) return { blocked: false, type: 'unknown', slots: [], message: '本体の画面情報が空のため、DSP状態は未確認です' };
  return slots.length ? { blocked: true, type: 'overflow', slots, message: `本体の画面情報にDSP容量超過の表示を検出しました（画面 ${slots.map(i => i + 1).join(', ')}）。送信を停止し、エフェクトを削除・置換してください。` }
    : { blocked: false, type: 'screen', slots: [], message: '本体の画面情報に容量超過表示なし（DSP実測値は取得できません）' };
}
