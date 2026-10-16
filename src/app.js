import { effects, groups, findEffect, newPatch, settingsFor, patchBytes, parsePatch, serializeProject, parseProject } from './model.js';
import { PedalConnection, frame } from './midi.js';
import { LiveSession } from './live.js';
import { estimateDsp, invalidSlotReport } from './dsp.js';
import { ReadOnlyCatalogReader } from './catalog-reader.js';
import { installedCount, unavailableEffects } from './inventory.js';
import { loadCurrentForLive } from './connection-flow.js';
import { saveSelectedMemory } from './memory-save.js';
import { initLanguage, translate, getLanguage } from './i18n.js';
const $ = id => document.getElementById(id);
let patch = newPatch(), note = '', selected = 0, busy = false, cancelBackup = false;
let undo = [], redo = [], baseline = '', loadedBackup = null;
let inventory = null;
let livePreferred = true;
let lastRemoteCheckpoint = 0;
let activeProgram = null, memoryEntries = [], memoryListOpen = false;
const dspEstimate = () => estimateDsp(patch, inventory);
const colors = { 1: '#e9be78', 2: '#c8cb85', 3: '#e8998b', 4: '#ecb083', 6: '#9ba7dd', 7: '#c995c5', 8: '#78bdc9', 9: '#93b9ac' };
const midi = new PedalConnection(message, renderConnection);
const live = new LiveSession(midi, text => { message(text); renderConnection(); }, receiveRemote);
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const snapshot = () => serializeProject(patch, note);
const confirmDialog = request => window.desktop.confirm({ ...request, message: translate(request.message), detail: translate(request.detail), language: getLanguage() });
function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function changed() {
  document.title = `${patch.name.trim()} · MS-50G+ Editor`;
  try { localStorage.setItem('ms50g-draft-v1', snapshot()); } catch { message('作業内容の自動復旧データを保存できません。PCに保存してください', true); }
  $('undo').disabled = busy || !undo.length; $('redo').disabled = busy || !redo.length;
}
function checkpoint() { undo.push(snapshot()); if (undo.length > 80) undo.shift(); redo = []; }
function mutate(action) { const before = patch.clone(); checkpoint(); action(); live.update(before, patch); render(); }
function restore(text) { const before = patch; ({ patch, note } = parseProject(text)); live.update(before, patch); selected = Math.min(selected, patch.effectSettings.length - 1); render(); }
async function discardIfNeeded() { return snapshot() === baseline || await confirmDialog({ message: 'PCに保存していない変更があります。別のパッチを開きますか？', detail: '現在の編集を残す場合は、キャンセルして「PCに保存」を押してください。' }); }
function install(p, n = '') { live.stop(); patch = p; note = n; selected = 0; undo = []; redo = []; baseline = ''; render(); }
async function run(task, { keepLive = false, drainLive = false } = {}) {
  if (busy) return;
  const resume = keepLive && live.active;
  busy = true; setBusy();
  try {
    if (resume || drainLive && live.active) { await live.flush(); if (live.queue.size) await live.flush(); }
    await live.stopAndWait(); await task();
    if (resume && livePreferred && midi.connected) {
      requireInstalled(); await live.start(patch);
    }
  } catch (e) { message(e.message || String(e), true); }
  finally { busy = false; setBusy(); }
}
function setBusy() {
  document.querySelectorAll('button').forEach(b => { b.disabled = busy && !['cancelBackup', 'closeHelp', 'closeConnection'].includes(b.id); });
  document.querySelectorAll('main input, main textarea, #category, #search').forEach(el => { el.disabled = busy; });
  if (!busy) { renderConnection(); renderChain(); renderParameters(); changed(); renderMemoryState(); }
}
function renderConnection() {
  if (!midi.connected && (activeProgram !== null || memoryEntries.length)) { activeProgram = null; memoryEntries = []; renderMemoryList(); }
  if (!midi.connected && inventory) { inventory = null; renderCategories(); renderLibrary(); }
  $('connectionDot').classList.toggle('online', midi.connected);
  $('connectionText').textContent = midi.connected ? `MS-50G+ · FW ${midi.version}` : 'オフラインで編集中';
  document.querySelectorAll('[data-device]').forEach(b => { b.disabled = busy || !midi.connected; });
  $('liveToggle').textContent = live.active ? '● 双方向同期 ON' : '双方向同期 OFF';
  $('liveToggle').classList.toggle('live-on', live.active);
  $('liveHint').textContent = live.active ? 'PC ⇄ 本体の操作を同期中 · AUTO SAVEがONなら本体にも保存されます' : midi.connected ? livePreferred ? '現在のパッチを読むと、本体の音色から調整を再開できます。' : 'OFF時はPC内で編集します。リアルタイムをONにすると本体へ反映します。' : 'USB接続すると本体の音色を読み込み、リアルタイム調整をONにします。';
  renderMemoryState();
  renderDsp();
}
function renderDsp() {
  const estimate = dspEstimate(), el = $('dspMeter');
  $('dspEstimate').textContent = `${estimate.complete ? '約 ' : '既知分 '}${estimate.percent.toFixed(1)}%${estimate.complete ? '' : ' ＋ 不明 ' + estimate.unknown.length + '件'}`;
  el.style.setProperty('--dsp-width', `${Math.min(100, estimate.percent)}%`);
  el.classList.toggle('over', estimate.over); el.classList.toggle('near', estimate.near); el.classList.toggle('partial', !estimate.complete);
  el.setAttribute('aria-valuenow', String(Math.min(100, estimate.percent))); el.setAttribute('aria-valuetext', $('dspEstimate').textContent + '、エフェクトの負荷基準値を合計した推定値');
  $('dspHint').textContent = estimate.over ? '推定使用量が100%を超えています。エフェクトの削除・置換を検討してください。' : 'OFFを含む搭載エフェクトの負荷基準値を合計しています。';
  const health = midi.dspReport;
  $('dspStatus').textContent = '本体の現在パッチ: ' + health.message;
  $('dspStatus').classList.toggle('dsp-error', health.blocked);
}
function dspWarning() {
  const estimate = dspEstimate();
  return estimate.over ? `\n推定DSP合計 ${estimate.percent.toFixed(1)}%。容量超過の可能性があります。` : !estimate.complete ? '\nDSP負荷が不明のエフェクトが含まれています。' : '';
}
function renderLibrary() {
  const query = $('search').value.toLowerCase(), category = $('category').value;
  const found = effects.filter(e => e.name.toLowerCase().includes(query) && (category === 'all' || String(e.id >>> 24) === category));
  $('effectCount').textContent = `${found.length} / ${effects.length}`;
  const installed = inventory && new Set(inventory.entries.filter(e => e.installed).map(e => e.id));
  $('effectLibrary').innerHTML = found.map(e => `<button class="effect-entry" data-id="${e.id}"><span><i class="dot"></i>${esc(e.name)}${e.addedAfterLaunch ? `<b class="added-badge" title="発売後の公式追加 · ${esc(e.release)}">追加</b>` : ''}</span><small>${groups[e.id >>> 24] || 'FX'}${installed ? installed.has(e.id) ? ' · Installed' : ' · Not installed' : ''}</small></button>`).join('') || '<p class="aside-hint">該当するエフェクトがありません</p>';
  // Inline custom properties are assigned through CSSOM to keep the document CSP restrictive.
  $('effectLibrary').querySelectorAll('button').forEach(b => {
    b.style.setProperty('--effect-color', colors[Number(b.dataset.id) >>> 24] || '#9ab5b3');
    b.disabled = busy;
    b.onclick = () => {
      if (busy) return;
      mutate(() => {
        const settings = settingsFor(Number(b.dataset.id));
        if (selected < patch.effectSettings.length) patch.changeEffectInSlot(selected, settings);
        else patch.addEffectInSlot(selected, settings);
        patch.prm2InvalidEffectSlot &= ~(1 << selected);
      });
      message('PC内で編集しました。「本体に反映」で音を確認できます');
    };
  });
}
function renderCategories() {
  const current = $('category').value;
  $('category').innerHTML = [['all', 'すべてのカテゴリー'], ...Object.entries(groups)].map(([value, title]) => {
    const count = installedCount(effects, inventory, value);
    return `<option value="${value}">${title} (${count === null ? '—' : count})</option>`;
  }).join('');
  $('category').value = current || 'all';
  $('inventoryStatus').textContent = inventory ? `本体の導入済み ${inventory.entries.filter(e => e.installed).length}件 · 「追加」は発売後に配信（${effects.filter(e => e.addedAfterLaunch).length}種類） · SFXは補助2モジュールを含む` : 'USB接続で導入数を確認 · 「追加」は発売後の公式配信';
}
async function scanInventory(includeDsp = false) {
  message(includeDsp ? '本体からDSP負荷基準値を読み取っています…' : '導入済みエフェクトを確認しています…');
  const result = await new ReadOnlyCatalogReader(midi).scan({ includeDsp, progress: (n, total) => message(`DSP情報を読み取り中: ${n} / ${total}`) });
  inventory = { ...result, costs: { ...(inventory?.costs || {}), ...result.costs } };
  renderCategories(); renderLibrary(); renderDsp();
  const unsupported = result.entries.filter(e => e.installed && !findEffect(e.id));
  message(`導入済み ${result.entries.filter(e => e.installed).length}件を確認しました${includeDsp ? ` · DSP値 ${Object.keys(result.costs).length}件取得` : ''}${result.errors.length ? ` · 読み取り失敗 ${result.errors.length}件` : ''}${unsupported.length ? ` · 編集未対応 ${unsupported.length}件` : ''}`);
}
function requireInstalled() {
  const missing = unavailableEffects(patch, inventory);
  if (missing.length) throw Error('Not installed: ' + missing.map(id => findEffect(id)?.name || id.toString(16)).join(', '));
}
function installConnectedPatch(p, program) {
  activeProgram = program;
  install(p);
  updateMemoryName(program, p.name.trim());
}
function updateMemoryName(slot, name) {
  if (!Number.isInteger(slot)) return;
  const entry = memoryEntries.find(e => e.slot === slot);
  if (entry) entry.name = name; else memoryEntries.push({ slot, name });
  renderMemoryList();
}
function renderMemoryState() {
  $('currentMemory').textContent = activeProgram === null ? '—' : String(activeProgram + 1).padStart(3, '0');
  $('writeSlot').textContent = activeProgram === null ? '選択中の番号に保存' : `${String(activeProgram + 1).padStart(3, '0')} に保存`;
  $('writeSlot').disabled = busy || !midi.connected || activeProgram === null;
  $('previousMemory').disabled = busy || !midi.connected || activeProgram === null;
  $('nextMemory').disabled = busy || !midi.connected || activeProgram === null;
  $('memoryListStatus').textContent = midi.connected ? `${memoryEntries.filter(e => e.name !== null).length} / ${midi.count}` : 'USB接続で本体の一覧を表示';
  $('showMemoryList').textContent = memoryListOpen ? '一覧を閉じる' : 'パッチ一覧';
  $('showMemoryList').setAttribute('aria-expanded', String(memoryListOpen));
  document.querySelectorAll('[data-memory]').forEach(b => {
    const current = Number(b.dataset.memory) === activeProgram;
    b.classList.toggle('current', current); b.setAttribute('aria-current', current ? 'true' : 'false'); b.disabled = busy || !midi.connected;
  });
}
function renderMemoryList() {
  const query = $('memorySearch').value.trim().toLowerCase();
  const entries = Array.from({ length: midi.count }, (_, slot) => ({ slot, name: memoryEntries.find(e => e.slot === slot)?.name ?? null }));
  $('memoryList').innerHTML = entries.filter(e => `${String(e.slot + 1).padStart(3, '0')} ${e.name ?? ''}`.toLowerCase().includes(query)).map(e => `<button data-memory="${e.slot}" class="memory-entry"><span>${String(e.slot + 1).padStart(3, '0')}</span><strong>${esc(e.name === null ? '—' : e.name || '(Empty)')}</strong></button>`).join('') || '<p class="aside-hint">該当するパッチがありません</p>';
  $('memoryList').querySelectorAll('[data-memory]').forEach(b => { b.onclick = () => switchMemory(Number(b.dataset.memory)); });
  renderMemoryState();
}
async function refreshMemoryList() {
  midi.requireConnection(); memoryEntries = Array.from({ length: midi.count }, (_, slot) => ({ slot, name: null }));
  renderMemoryList();
  for (let slot = 0; slot < midi.count; slot++) {
    message(`パッチ一覧を読み込み中: ${slot + 1} / ${midi.count}`);
    const result = await midi.readSlot(slot); memoryEntries[slot].name = result.patch.name.trim();
    if (slot % 10 === 9) renderMemoryList();
  }
  renderMemoryList(); message('本体のパッチ一覧を更新しました');
}
function switchMemory(target, direction = 0) {
  const wasLive = live.active;
  return run(async () => {
    const current = await midi.readProgram();
    const slot = direction ? (current + direction + midi.count) % midi.count : target;
    if (slot === current && activeProgram === current) { if (wasLive) await live.start(patch); return; }
    await midi.selectProgram(slot);
    await readCurrentAndStart();
  }, { drainLive: true });
}
function receiveRemote(event) {
  if (event.type === 'patch') {
    activeProgram = event.program;
    if (event.changedProgram) {
      note = ''; undo = []; redo = [];
    } else {
      const structureChanged = patch.effectSettings.length !== event.patch.effectSettings.length || patch.effectSettings.some((s, i) => s.id !== event.patch.effectSettings[i]?.id);
      if (structureChanged) { undo = []; redo = []; } else checkpoint();
    }
    patch = event.patch.clone(); selected = Math.min(patch.currentEffectSlot, patch.effectSettings.length - 1);
    updateMemoryName(event.program, patch.name.trim());
    render(); message(event.changedProgram ? '本体のパッチ変更を同期しました' : '本体の変更を同期しました'); return;
  }
  const { slot, parameter, value } = event;
  if (slot === 100 && parameter === 1) {
    patch.currentEffectSlot = value; selected = value; renderChain(); renderParameters(); return;
  }
  if (Date.now() - lastRemoteCheckpoint > 350) checkpoint();
  lastRemoteCheckpoint = Date.now();
  if (slot === 100) {
    if (parameter === 0) { patch.prm2PatchVolume = value; $('volume').value = value; }
    else { patch.tempo = value; $('tempo').value = value; }
  } else {
    const s = patch.effectSettings[slot]; if (!s) return;
    if (parameter === 0) s.enabled = !!value; else s.parameters[parameter - 2] = value;
    if (selected !== slot || parameter === 0) { selected = slot; renderChain(); renderParameters(); }
    else {
      const i = parameter - 2, control = $(`param-${i}`), definition = findEffect(s.id)?.parameters[i];
      if (control && definition) {
        control.value = value;
        const output = control.closest('.parameter').querySelector('.value-text');
        if (output.tagName === 'INPUT') output.value = definition.values[value]; else output.textContent = definition.values[value];
      }
    }
  }
  changed(); renderDsp();
}
async function readCurrentAndStart() {
  await loadCurrentForLive({ midi, live, install: installConnectedPatch, validate: requireInstalled, enabled: livePreferred });
  if (!livePreferred) message('本体の現在のパッチを読み込みました · リアルタイム OFF');
}
function renderChain() {
  const chain = patch.effectSettings;
  $('slotCount').textContent = `${chain.filter(s => s.id !== 0).length} / 6 EFFECTS`;
  $('chain').innerHTML = Array.from({ length: 6 }, (_, i) => {
    const s = chain[i], empty = !s || s.id === 0;
    return `<button class="slot ${empty ? 'empty' : ''} ${selected === i ? 'active' : ''} ${s && !s.enabled ? 'bypassed' : ''}" data-slot="${i}" aria-label="スロット ${i + 1}${empty ? ' 空き' : ' ' + esc(findEffect(s.id)?.name || 'Unknown')}" aria-pressed="${selected === i}">${empty ? '+' : `<span class="slot-number">${String(i + 1).padStart(2, '0')}</span><i class="led"></i><span class="slot-name">${esc(findEffect(s.id)?.name || s.id.toString(16))}</span>`}</button>`;
  }).join('');
  $('chain').querySelectorAll('button').forEach(b => {
    const i = Number(b.dataset.slot);
    b.style.setProperty('--effect-color', colors[chain[i]?.id >>> 24] || '#65847f');
    b.disabled = busy || i > chain.length;
    b.onclick = () => { selected = i; live.selectSlot(i); renderChain(); renderParameters(); };
  });
  $('moveLeft').disabled = busy || selected < 1 || selected >= chain.length;
  $('moveRight').disabled = busy || selected >= chain.length - 1;
  $('removeEffect').disabled = busy || !chain[selected] || chain[selected].id === 0;
  renderDsp();
}
function renderParameters() {
  const s = patch.effectSettings[selected], def = s && findEffect(s.id);
  $('selectedSlot').textContent = `SLOT ${String(selected + 1).padStart(2, '0')} / ${s?.id ? groups[s.id >>> 24] || 'FX' : 'EMPTY'}`;
  $('effectTitle').textContent = def ? def.name + (def.addedAfterLaunch ? ' · 追加' : '') : (s?.id ? `Unknown ${s.id.toString(16)}` : 'エフェクトを追加');
  $('effectToggle').hidden = !s?.id;
  $('effectToggle').disabled = busy;
  $('effectToggle').textContent = s?.enabled ? '● ON' : '○ OFF';
  $('effectToggle').classList.toggle('off', !s?.enabled);
  $('emptyState').hidden = !!s?.id;
  $('parameters').innerHTML = '';
  if (s?.id && !def) { $('parameters').innerHTML = '<p class="unknown">未登録のエフェクトです。値を保持したまま保存できますが、本体送信はできません。</p>'; return; }
  if (!def) return;
  def.parameters.forEach((p, i) => {
    if (p.hidden) return;
    const value = s.parameters[i], displayed = p.values[value] ?? `? (${value})`;
    const numeric = p.values.length > 16 || p.values.every(v => /^-?\d+(\.\d+)?$/.test(v));
    const container = document.createElement('div'); container.className = 'parameter';
    container.innerHTML = `<div class="param-top"><label for="param-${i}">${esc(p.name)}</label>${numeric ? `<input class="value-text" id="numeric-${i}" aria-label="${esc(p.name)} 数値" value="${esc(displayed)}">` : `<span class="value-text">${esc(displayed)}</span>`}</div>${numeric ? `<input id="param-${i}" aria-label="${esc(p.name)}" type="range" min="0" max="${p.max}" step="1" value="${value}"><div class="param-range"><span>${esc(p.values[0])}</span><span>${esc(p.values[p.max])}</span></div>` : `<select id="param-${i}" aria-label="${esc(p.name)}">${p.values.map((v, j) => `<option value="${j}" ${j === value ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`}`;
    const control = container.querySelector(`#param-${i}`);
    control.disabled = busy;
    let before = null;
    control.oninput = () => {
      if (busy) return;
      if (before === null) { before = true; checkpoint(); }
      s.parameters[i] = Number(control.value);
      live.queueValue(selected, i + 2, s.parameters[i]);
      if (numeric) container.querySelector('.value-text').value = p.values[s.parameters[i]];
      else container.querySelector('.value-text').textContent = p.values[s.parameters[i]];
      changed();
    };
    control.onchange = () => { before = null; };
    if (numeric) {
      const input = container.querySelector('.value-text'); input.disabled = busy;
      input.onchange = () => {
        const index = p.values.findIndex(v => v === input.value.trim() || (!isNaN(Number(v)) && Number(v) === Number(input.value)));
        if (input.value.trim() === '' || index < 0) { input.value = p.values[s.parameters[i]]; message(`${p.name}: 有効な設定値を入力してください`, true); return; }
        mutate(() => { s.parameters[i] = index; });
      };
    }
    $('parameters').append(container);
  });
}
function render() {
  $('patchName').value = patch.name.trim(); $('tempo').value = patch.tempo;
  $('volume').value = patch.prm2PatchVolume; $('notes').value = note;
  renderChain(); renderParameters(); renderConnection(); changed();
}
function numberChange(id, field, min, max) {
  $(id).onchange = () => {
    const n = Number($(id).value);
    if (!$(id).value || !Number.isInteger(n) || n < min || n > max) { message(`${min}〜${max}の整数で指定してください`, true); render(); return; }
    mutate(() => { patch[field] = n; });
  };
}
numberChange('tempo', 'tempo', 40, 250); numberChange('volume', 'prm2PatchVolume', 0, 120);
$('patchName').onchange = () => {
  if (!/^[\x20-\x7e]{1,28}$/.test($('patchName').value)) { message('パッチ名は半角英数字・記号の1〜28文字で入力してください。日本語はメモ欄に保存できます', true); render(); return; }
  mutate(() => { patch.name = $('patchName').value; });
};
$('notes').maxLength = 20000;
$('notes').onchange = () => mutate(() => { note = $('notes').value; });
$('effectToggle').onclick = () => mutate(() => { patch.effectSettings[selected].enabled = !patch.effectSettings[selected].enabled; });
$('moveLeft').onclick = () => mutate(() => { patch.swapEffectsInSlots(selected, selected - 1); selected--; });
$('moveRight').onclick = () => mutate(() => { patch.swapEffectsInSlots(selected, selected + 1); selected++; });
$('removeEffect').onclick = () => mutate(() => { patch.deleteEffectInSlot(selected); selected = Math.max(0, Math.min(selected, patch.effectSettings.length - 1)); });
$('undo').onclick = () => { if (!undo.length || busy) return; redo.push(snapshot()); restore(undo.pop()); };
$('redo').onclick = () => { if (!redo.length || busy) return; undo.push(snapshot()); restore(redo.pop()); };
$('newPatch').onclick = () => run(async () => { if (await discardIfNeeded()) { install(newPatch()); message('新しいパッチを作成しました'); } });
$('emptyPatch').onclick = () => {
  const wasLive = live.active;
  return run(async () => {
    if (!(await confirmDialog({ message: '編集中のパッチをEmptyに戻しますか？', detail: '名前・エフェクト・テンポ・音量・メモを初期化します。本体へ保存するには、番号付きの保存ボタンを押してください。' }))) {
      if (wasLive && livePreferred) await live.start(patch);
      return;
    }
    mutate(() => { patch = newPatch('Empty'); note = ''; selected = 0; });
    message('PCのパッチをEmptyに戻しました。本体へ保存するには番号付きの保存ボタンを押してください');
  });
};
$('save').onclick = () => run(async () => {
  const data = snapshot();
  const name = await window.desktop.save({ kind: 'project', name: patch.name.trim() + '.ms50g.json', data });
  if (name) { baseline = data; changed(); message('PCに保存しました: ' + name); }
}, { keepLive: true });
$('export').onclick = () => run(async () => {
  const name = await window.desktop.save({ kind: 'patch', name: patch.name.trim() + '.zptc', data: Array.from(patchBytes(patch)), binary: true });
  if (name) message('Zoomパッチを書き出しました: ' + name + '（日本語メモはプロジェクトに保存してください）');
}, { keepLive: true });
$('open').onclick = () => run(async () => {
  if (!(await discardIfNeeded())) return;
  const file = await window.desktop.open(); if (!file) return;
  const bytes = Uint8Array.from(file.data);
  if (file.name.toLowerCase().endsWith('.zptc')) { install(parsePatch(bytes)); message('パッチを読み込みました: ' + file.name); return; }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const json = JSON.parse(text);
  if (json.format === 'ms50g-plus-backup') {
    if (json.version !== 1 || json.model !== 'MS-50G+' || !Array.isArray(json.patches) || json.patches.length > 100 || json.patches.length < 1) throw Error('バックアップ形式が不正です');
    const slots = new Set();
    const validated = json.patches.map(entry => {
      if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot > 99 || slots.has(entry.slot) || !Array.isArray(entry.patch) || entry.patch.some(b => !Number.isInteger(b) || b < 0 || b > 255)) throw Error('バックアップのパッチ情報が不正です');
      slots.add(entry.slot); return { slot: entry.slot, patch: parsePatch(entry.patch) };
    });
    loadedBackup = validated; $('backupSelect').innerHTML = validated.map((e, i) => `<option value="${i}">${String(e.slot + 1).padStart(3, '0')} · ${esc(e.patch.name.trim())}</option>`).join('');
    $('backupBrowser').hidden = false; document.querySelector('.device-tools').open = true;
    message(`${validated.length}件のバックアップを開きました。下の一覧からパッチを選択できます`);
  } else {
    const parsed = parseProject(text); install(parsed.patch, parsed.note); baseline = snapshot(); changed(); message('プロジェクトを読み込みました: ' + file.name);
  }
});
$('loadBackupPatch').onclick = () => run(async () => { if (!(await discardIfNeeded())) return; const e = loadedBackup[Number($('backupSelect').value)]; install(e.patch.clone()); $('memorySlot').value = e.slot + 1; message('バックアップのパッチをPC内で開きました'); });
async function scanPorts() {
  const ports = await midi.accessPorts();
  for (const [id, list] of [['midiInput', ports.inputs], ['midiOutput', ports.outputs]]) {
    $(id).innerHTML = list.map(p => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.manufacturer || 'MIDI')})</option>`).join('');
    const candidate = list.find(p => /MS.?50G/i.test(p.name || ''));
    if (candidate) $(id).value = candidate.id;
  }
  $('portHint').textContent = ports.inputs.length && ports.outputs.length ? 'MS-50G+の入力・出力を選択してください。' : 'ポートが見つかりません。USBケーブルと本体の電源を確認してください。';
}
$('connectPanel').onclick = () => { $('connectionDialog').showModal(); run(scanPorts, { keepLive: true }); };
$('scanPorts').onclick = () => run(scanPorts, { keepLive: true });
$('closeConnection').onclick = () => $('connectionDialog').close();
$('connect').onclick = () => run(async () => {
  const ports = await midi.accessPorts();
  await midi.connect(ports.inputs.find(p => p.id === $('midiInput').value), ports.outputs.find(p => p.id === $('midiOutput').value));
  $('connectionDialog').close();
  inventory = null;
  livePreferred = true;
  try { await scanInventory(); } catch (e) { message('導入一覧を取得できませんでした: ' + e.message, true); }
  try { await refreshMemoryList(); } catch (e) { message('一覧の読み込みを中断しました: ' + e.message, true); }
  await readCurrentAndStart();
});
$('previousMemory').onclick = () => switchMemory(null, -1);
$('nextMemory').onclick = () => switchMemory(null, 1);
$('showMemoryList').onclick = () => { memoryListOpen = !memoryListOpen; $('memoryPanel').hidden = !memoryListOpen; renderMemoryState(); };
$('memorySearch').oninput = renderMemoryList;
$('refreshMemoryList').onclick = () => run(refreshMemoryList, { keepLive: true });
$('scanEffects').onclick = () => run(() => scanInventory(), { keepLive: true });
$('refreshDsp').onclick = () => run(() => scanInventory(true), { keepLive: true });
$('disconnect').onclick = () => run(async () => { await midi.disconnect(); message('MIDI接続を解除しました'); });
$('readCurrent').onclick = () => run(readCurrentAndStart);
const memorySlot = () => {
  const n = Number($('memorySlot').value);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw Error('パッチ番号は001〜100で指定してください');
  return n - 1;
};
$('readSlot').onclick = () => run(async () => { if (!(await discardIfNeeded())) return; const result = await midi.readSlot(memorySlot()); install(result.patch); message('指定番号のパッチを読み込みました'); });
$('apply').onclick = () => run(async () => {
  requireInstalled();
  if (!(await confirmDialog({ message: 'PCの編集内容を、本体の現在のパッチに反映しますか？', detail: '本体のAUTO SAVEがONの場合、現在のパッチに保存されます。必要なパッチは先にバックアップしてください。' + dspWarning() }))) return;
  await midi.apply(patch);
  if (livePreferred) await live.start(patch);
});
$('liveToggle').onclick = () => {
  if (live.active) { livePreferred = false; live.stop('リアルタイム調整をOFFにしました'); return; }
  run(async () => {
    requireInstalled();
    await live.start(patch);
    livePreferred = true;
  });
};
$('checkDsp').onclick = () => run(async () => { const health = await midi.checkDsp(null, true); message(health.message, health.blocked); }, { keepLive: true });
$('writeSlot').onclick = () => run(async () => {
  requireInstalled();
  const slot = activeProgram;
  const saved = await saveSelectedMemory({ midi, patch, slot, detail: dspWarning(),
    confirm: ({ name, patchName, detail }) => confirmDialog({ message: `${String(slot + 1).padStart(3, '0')}「${name}」を上書きしますか？`, detail: `書き込むパッチ: ${patchName}\nこの操作はPATCH MEMORYで選択中の保存済みパッチを置き換えます。` + detail }) });
  if (saved) updateMemoryName(slot, patch.name.trim());
});
$('cancelBackup').onclick = () => { cancelBackup = true; message('現在の読み込みが完了したらバックアップを中止します'); };
$('backup').onclick = () => run(async () => {
  cancelBackup = false; $('cancelBackup').hidden = false;
  const entries = [];
  try {
    for (let slot = 0; slot < midi.count && !cancelBackup; slot++) {
      message(`バックアップを取得中: ${slot + 1} / ${midi.count}`);
      const result = await midi.readSlot(slot);
      entries.push({ slot, patch: Array.from(result.raw) });
      $('backupProgress').textContent = `${entries.length} / ${midi.count}`;
    }
  } catch (e) { message(`読み込みを中断: ${e.message}。取得済みの${entries.length}件を保存できます`, true); }
  finally { $('cancelBackup').hidden = true; }
  if (!entries.length) return;
  const data = { format: 'ms50g-plus-backup', version: 1, model: 'MS-50G+', firmware: midi.version, complete: entries.length === 100, createdAt: new Date().toISOString(), patches: entries };
  const name = await window.desktop.save({ kind: 'backup', name: `MS50G-backup-${new Date().toISOString().slice(0, 10)}${data.complete ? '' : '-partial'}.ms50g-backup.json`, data: JSON.stringify(data, null, 2) });
  if (name) message(`${entries.length}パッチの${data.complete ? '完全' : '部分'}バックアップを保存しました: ${name}`);
});
$('showHelp').onclick = () => $('helpDialog').showModal(); $('closeHelp').onclick = () => $('helpDialog').close();
$('search').oninput = renderLibrary; $('category').onchange = renderLibrary;
renderCategories();
document.addEventListener('keydown', event => {
  if (!event.ctrlKey || busy || document.querySelector('dialog[open]')) return;
  const id = ({ s: 'save', o: 'open', z: event.shiftKey ? 'redo' : 'undo', y: 'redo' })[event.key.toLowerCase()];
  if (id && (!['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) || ['save', 'open'].includes(id))) { event.preventDefault(); $(id).click(); }
});
window.addEventListener('beforeunload', event => { if (snapshot() !== baseline) { event.preventDefault(); event.returnValue = ''; } });
// Electron handles close confirmation explicitly, including browser-native beforeunload cancellation.
initLanguage();
baseline = snapshot();
try {
  const draft = localStorage.getItem('ms50g-draft-v1');
  if (draft) { ({ patch, note } = parseProject(draft)); baseline = ''; message('前回の作業を復旧しました。必要に応じてPCに保存してください'); }
} catch { message('前回の復旧データを読み込めませんでした。新規パッチから開始します', true); }
renderLibrary(); renderMemoryList(); render();
window.runSmokeTests = async () => {
  const assert = (ok, text) => { if (!ok) throw Error(text); };
  assert($('category').options[1].textContent === 'DYNAMICS (—)', 'offline inventory is unknown');
  inventory = { entries: effects.map(e => ({ id: e.id, installed: e.id !== 0x01000040, version: '1.00' })), costs: {} };
  renderCategories(); renderLibrary();
  assert($('category').options[1].textContent === 'DYNAMICS (9)', 'category installed count');
  assert(document.querySelectorAll('.added-badge').length === 27, 'post-launch badges');
  assert(document.querySelector('[data-id="16777280"]').textContent.includes('Not installed'), 'uninstalled label');
  inventory = null; renderCategories(); renderLibrary();
  for (const e of effects.filter(e => e.addedAfterLaunch)) {
    patch = newPatch(); patch.changeEffectInSlot(0, settingsFor(e.id)); selected = 0; render();
    assert(document.querySelectorAll('.parameter').length === e.parameters.filter(p => !p.hidden).length, e.name + ' visible parameters');
    assert($('effectTitle').textContent.endsWith('追加'), e.name + ' added title');
  }
  patch = newPatch('Glass Horizon'); note = 'クリーン〜アンビエント。テスト用サンプル。'; baseline = snapshot(); undo = []; redo = [];
  const pick = name => { const e = effects.find(e => e.name === name); assert(e, name + ' not found'); document.querySelector(`[data-id="${e.id}"]`).click(); };
  pick('Comp'); assert(patch.effectSettings[0].id === 0x01000010, 'effect add');
  const range = $('param-0'); range.value = '9'; range.dispatchEvent(new Event('input')); range.dispatchEvent(new Event('change'));
  assert(patch.effectSettings[0].parameters[0] === 9, 'parameter edit'); $('undo').click(); assert(patch.effectSettings[0].parameters[0] !== 9, 'undo'); $('redo').click(); assert(patch.effectSettings[0].parameters[0] === 9, 'redo');
  selected = 1; render(); pick('AnalogCho'); selected = 2; render(); pick('Delay'); selected = 3; render(); pick('Hall REV');
  $('moveLeft').click(); assert(findEffect(patch.effectSettings[2].id).name === 'Hall REV', 'move'); $('undo').click();
  selected = 0; render(); $('effectToggle').click(); assert(!patch.effectSettings[0].enabled, 'bypass'); $('effectToggle').click();
  $('search').value = 'Delay'; renderLibrary(); assert([...document.querySelectorAll('.effect-entry')].every(b => b.textContent.toLowerCase().includes('delay')), 'search');
  $('search').value = ''; renderLibrary(); selected = 2; render();
  assert(document.querySelectorAll('.slot').length === 6, 'six slots');
  assert($('apply').disabled && $('writeSlot').disabled, 'offline write disabled');
  assert(document.documentElement.scrollWidth <= window.innerWidth, 'horizontal overflow');
  assert(serializeProject(parseProject(snapshot()).patch, note) === snapshot(), 'project roundtrip');
  const waitIdle = async () => { for (let i = 0; busy && i < 100; i++) await new Promise(r => setTimeout(r, 20)); assert(!busy, 'IPC completion'); };
  const beforeSave = snapshot();
  $('save').click(); await waitIdle(); assert(snapshot() === baseline, 'native project save');
  $('newPatch').click(); await waitIdle(); assert(patch.name === 'New Patch', 'new patch');
  $('open').click(); await waitIdle(); assert(snapshot() === beforeSave, 'native project open');
  $('export').click(); await waitIdle(); $('newPatch').click(); await waitIdle(); $('open').click(); await waitIdle();
  assert(patch.name.trim() === 'Glass Horizon' && patch.effectSettings.length === 4, 'native zptc roundtrip');
  note = 'クリーン〜アンビエント。Comp → AnalogCho → Delay → Hall REV'; selected = 2; render();
  assert($('liveToggle').disabled, 'offline live disabled');
  const savedMidi = { connected: midi.connected, output: midi.output, readProgram: midi.readProgram, readCurrent: midi.readCurrent, readSlot: midi.readSlot, writeSlot: midi.writeSlot, checkDsp: midi.checkDsp };
  const transmissions = []; let mockPatch = patch.clone(), mockProgram = 0;
  const mockMemories = new Map([[0, mockPatch.clone()], [1, newPatch('Crunch Two')], [99, newPatch('Last Patch')]]);
  try {
    midi.connected = true;
    midi.readProgram = async () => mockProgram;
    midi.readCurrent = async () => ({ patch: mockPatch.clone(), raw: patchBytes(mockPatch) });
    midi.readSlot = async slot => ({ patch: (mockMemories.get(slot) || newPatch(`Patch ${slot + 1}`)).clone() });
    const savedSlots = [];
    midi.writeSlot = async (p, slot) => { savedSlots.push(slot); mockMemories.set(slot, p.clone()); };
    midi.checkDsp = async () => ({ blocked: false, type: 'screen', slots: [], message: '模擬本体' });
    midi.output = { send: data => {
      transmissions.push(Array.from(data));
      if (data[0] === 0xc0) { mockProgram = data[1]; mockPatch = (mockMemories.get(mockProgram) || newPatch(`Patch ${mockProgram + 1}`)).clone(); }
      if (data[4] === 0x64 && data[5] === 0x20) {
        const slot = data[7], param = data[8], value = data[9] + data[10] * 128;
        if (slot === 100) { if (param === 0) mockPatch.prm2PatchVolume = value; else if (param === 1) mockPatch.currentEffectSlot = value; else mockPatch.tempo = value; }
        else if (param === 0) mockPatch.effectSettings[slot].enabled = !!value;
        else mockPatch.effectSettings[slot].parameters[param - 2] = value;
      }
    } };
    livePreferred = true;
    await run(readCurrentAndStart); assert(live.active, 'default live UI enable');
    assert(!transmissions.some(d => d[4] === 0x28 || d[4] === 0x45 || (d[4] === 0x64 && d[5] === 0x20)), 'connect sends no patch or parameters');
    selected = 2; render();
    const slider = $('param-0'); slider.value = '25'; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change'));
    await live.flush(); assert(mockPatch.effectSettings[selected].parameters[0] === 25, 'live UI slider transmission');
    const existingSlider = $('param-0');
    mockPatch.effectSettings[selected].parameters[0] = 30;
    midi.receive(frame([0x64, 0x20, 0, selected, 2, 30, 0, 0, 0, 0]));
    assert(live.active && $('param-0') === existingSlider && $('param-0').value === '30', 'native knob updates existing slider without stopping');
    assert(patch.effectSettings[selected].parameters[0] === 30, 'native knob updates PC patch');
    $('effectToggle').click(); await live.flush(); assert(!mockPatch.effectSettings[selected].enabled, 'live UI bypass');
    $('undo').click(); await live.flush(); assert(mockPatch.effectSettings[selected].enabled, 'live UI undo');
    assert(transmissions.some(d => d[4] === 0x64 && d[5] === 0x20) && !transmissions.some(d => d[4] === 0x28), 'incremental edits without patch reload');
    $('save').click(); await waitIdle(); assert(live.active, 'save keeps live enabled');
    $('liveToggle').click(); assert(!live.active, 'live UI disable');
    $('readCurrent').click(); await waitIdle(); assert(!live.active, 'manual OFF survives read current');
    assert($('dspMeter').getAttribute('aria-valuetext').includes('推定値'), 'DSP estimate label');
    livePreferred = true; await run(readCurrentAndStart);
    const beforeEmpty = snapshot(), beforeEmptyPackets = transmissions.length;
    $('emptyPatch').click(); await waitIdle();
    assert(patch.name.trim() === 'Empty' && patch.effectSettings.every(s => s.id === 0) && patch.tempo === 120 && patch.prm2PatchVolume === 100 && note === '', 'Empty resets the patch and memo');
    assert(!live.active && activeProgram === 0 && $('writeSlot').textContent === '001 に保存', 'Empty pauses live and preserves the save destination');
    assert(!transmissions.slice(beforeEmptyPackets).some(d => [0x28, 0x45].includes(d[4]) || d[4] === 0x64 && d[5] === 0x20), 'Empty does not write to the pedal');
    $('undo').click(); assert(snapshot() === beforeEmpty, 'undo restores the PC patch after Empty');
    await run(readCurrentAndStart);
    await run(refreshMemoryList, { keepLive: true });
    assert(memoryEntries.length === 100 && memoryEntries[1].name === 'Crunch Two', '100 patch memory names');
    assert(live.active && mockProgram === 0, 'memory list reads without changing program');
    $('showMemoryList').click(); assert(!$('memoryPanel').hidden, 'memory panel opens');
    $('memorySearch').value = 'Crunch Two'; $('memorySearch').dispatchEvent(new Event('input'));
    assert(document.querySelectorAll('[data-memory]').length === 1, 'patch name filter');
    const beforeSwitch = transmissions.length; document.querySelector('[data-memory="1"]').click(); await waitIdle();
    assert(mockProgram === 1 && activeProgram === 1 && $('currentMemory').textContent === '002' && live.active, 'select memory and resume live');
    assert(!transmissions.slice(beforeSwitch).some(d => [0x28, 0x45].includes(d[4])), 'memory selection does not overwrite a patch');
    note = '編集中のメモ'; const sameMemory = snapshot();
    document.querySelector('[data-memory="1"]').click(); await waitIdle();
    assert(snapshot() === sameMemory && live.active, 'selecting current memory preserves the editor');
    assert($('writeSlot').textContent === '002 に保存', 'save button shows PATCH MEMORY number');
    $('memorySlot').value = 100; $('writeSlot').click(); await waitIdle();
    assert(savedSlots.length === 1 && savedSlots[0] === 1, 'save uses PATCH MEMORY rather than read-memory input');
    await run(readCurrentAndStart);
    const beforeLanguage = snapshot(), beforeLanguagePackets = transmissions.length;
    $('language').value = 'en'; $('language').dispatchEvent(new Event('change'));
    assert($('writeSlot').textContent === '002 · Save' && $('showHelp').textContent === 'Help & About', 'English controls');
    assert(document.documentElement.lang === 'en' && localStorage.getItem('ms50g-language') === 'en', 'language preference saved');
    renderMemoryState(); await new Promise(resolve => setTimeout(resolve, 0));
    assert($('writeSlot').textContent === '002 · Save', 'dynamic render keeps English');
    $('language').value = 'ja'; $('language').dispatchEvent(new Event('change'));
    assert($('writeSlot').textContent === '002 に保存' && $('showHelp').textContent === '使い方・情報', 'Japanese restored');
    assert(snapshot() === beforeLanguage && live.active && transmissions.length === beforeLanguagePackets, 'language switch preserves edits and live sync without sending MIDI');
    $('previousMemory').click(); await waitIdle(); assert(mockProgram === 0 && !$('previousMemory').disabled, 'previous memory remains available at 001');
    $('nextMemory').click(); await waitIdle(); assert(mockProgram === 1, 'next memory');
    $('memorySearch').value = '100'; $('memorySearch').dispatchEvent(new Event('input'));
    document.querySelector('[data-memory="99"]').click(); await waitIdle();
    assert(mockProgram === 99 && !$('nextMemory').disabled && $('currentMemory').textContent === '100', 'next memory remains available at 100');
    $('nextMemory').click(); await waitIdle(); assert(mockProgram === 0 && $('currentMemory').textContent === '001', 'next wraps from 100 to 001');
    $('previousMemory').click(); await waitIdle(); assert(mockProgram === 99 && $('currentMemory').textContent === '100', 'previous wraps from 001 to 100');
    mockProgram = 0; mockPatch = mockMemories.get(0).clone(); midi.receive(Uint8Array.from([0xc0, 0])); await live.flush();
    assert(activeProgram === 0 && $('currentMemory').textContent === '001', 'physical memory changes update navigation');
    $('memorySearch').value = ''; renderMemoryList(); $('showMemoryList').click();
  } finally { await live.stopAndWait(); Object.assign(midi, savedMidi); renderConnection(); }
  let midiAccess;
  try { await scanPorts(); midiAccess = { sysexEnabled: midi.access.sysexEnabled, inputs: midi.access.inputs.size, outputs: midi.access.outputs.size }; }
  catch (e) { midiAccess = { unavailable: e.message }; }
  return { ok: true, effects: effects.length, added: effects.filter(e => e.addedAfterLaunch).length, inventoryUI: true, defaultLive: true, bidirectionalUI: true, memoryNavigationUI: true, slots: patch.effectSettings.length, parameters: document.querySelectorAll('.parameter').length, width: innerWidth, nativeFileRoundtrip: true, liveParameterUI: true, dspEstimate: estimateDsp(patch), midiAccess };
};
