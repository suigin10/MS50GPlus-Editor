import test from 'node:test';
import assert from 'node:assert/strict';
import { newPatch, effects, settingsFor, patchBytes, parsePatch, serializeProject, parseProject, validateForSend } from '../src/model.js';
import { PedalConnection, frame, crcBytes, decodeDump } from '../src/midi.js';
import { eight2seven, seven2eight } from '../vendor/tools.ts';
import { LiveSession, soundState, parameterMessage } from '../src/live.js';
import { estimateDsp, screenDspReport, invalidSlotReport } from '../src/dsp.js';
import { ReadOnlyCatalogReader, parseCatalog, parseZd2Info } from '../src/catalog-reader.js';
import { installedCount, unavailableEffects } from '../src/inventory.js';
import officialMetadata from './official-metadata.json';
import catalogFixture from './catalog-fixture.json';
import { loadCurrentForLive } from '../src/connection-flow.js';
import { saveSelectedMemory } from '../src/memory-save.js';
import { translate } from '../src/i18n.js';

test('saving uses the selected PATCH MEMORY and checks the hardware before and after confirmation', async () => {
  const calls = [], p = newPatch('Saved'), midi = { count: 100, requireConnection() {}, readProgram: async () => 10, readSlot: async slot => { calls.push(['read', slot]); return { patch: newPatch('Previous') }; }, writeSlot: async (patch, slot) => calls.push(['write', slot, patch.name.trim()]) };
  let question;
  assert(await saveSelectedMemory({ midi, patch: p, slot: 10, confirm: async q => { question = q; return true; } }));
  assert.equal(question.name, 'Previous'); assert.equal(question.slot, 10);
  assert.deepEqual(calls, [['read', 10], ['write', 10, 'Saved']]);
  calls.length = 0;
  assert.equal(await saveSelectedMemory({ midi, patch: p, slot: 10, confirm: async () => false }), false);
  assert(!calls.some(c => c[0] === 'write'));
  await assert.rejects(() => saveSelectedMemory({ midi, patch: p, slot: null, confirm: async () => true }), /保存先/);
  await assert.rejects(() => saveSelectedMemory({ midi, patch: p, slot: 11, confirm: async () => true }), /番号が変わりました/);
  await assert.rejects(() => saveSelectedMemory({ midi, patch: p, slot: 10, confirm: async () => { midi.readProgram = async () => 11; return true; } }), /番号が変わりました/);
  assert(!calls.some(c => c[0] === 'write'));
});

test('English UI translates fixed labels, numbered save buttons and hardware errors', () => {
  assert.equal(translate('PCに保存', 'en'), 'Save to PC');
  assert.equal(translate('011 に保存', 'en'), '011 · Save');
  assert.equal(translate('本体のパッチ番号が変わりました。「現在のパッチを読む」で確認してから保存してください', 'en'), 'The pedal patch number changed. Use Read current patch before saving.');
  assert.equal(translate('PCに保存', 'ja'), 'PCに保存');
  assert.equal(translate('KRAMPUS / GAIN / 51', 'en'), 'KRAMPUS / GAIN / 51');
});

test('default connection loads the pedal sound and starts live without sending a patch or parameter', async () => {
  const { midi, sent } = fakeConnection();
  const live = new LiveSession(midi); let editor = newPatch('PC work');
  const start = sent.length;
  try {
    await loadCurrentForLive({ midi, live, install: p => { editor = p; } });
    assert.equal(editor.name.trim(), 'From pedal'); assert(live.active);
    assert(!sent.slice(start).some(d => d[4] === 0x28 || d[4] === 0x45 || (d[4] === 0x64 && d[5] === 0x20)));
    await live.stopAndWait();
    await loadCurrentForLive({ midi, live, install: p => { editor = p; }, enabled: false });
    assert(!live.active);
  } finally { await live.stopAndWait(); }
});
test('connection rejects a patch switch and failed editor installation before enabling live', async () => {
  const { midi } = fakeConnection(); const live = new LiveSession(midi); let installed = false, reads = 0;
  midi.readProgram = async () => reads++;
  await assert.rejects(() => loadCurrentForLive({ midi, live, install: () => { installed = true; } }), /切り替わり/);
  assert(!installed && !live.active);
  midi.readProgram = async () => 0;
  await assert.rejects(() => loadCurrentForLive({ midi, live, install: () => { throw Error('Storage full'); } }), /Storage full/);
  assert(!live.active);
});

test('official library covers every installed MS-50G+ effect with verified added parameter ranges', () => {
  assert.equal(effects.length, 131);
  assert.equal(effects.filter(e => e.addedAfterLaunch).length, 27);
  assert.equal(effects.filter(e => e.utility).length, 2);
  assert(catalogFixture.entries.every(entry => effects.some(e => e.id === entry.id)));
  for (const meta of officialMetadata) {
    const e = effects.find(e => e.id === parseInt(meta.id, 16));
    assert.equal(e.filename, meta.filename);
    assert.equal(e.parameters.length, meta.parameters.length);
    e.parameters.forEach((p, i) => {
      assert.equal(p.max, meta.parameters[i].max, `${e.name} / ${p.name}`);
      assert.equal(p.default, meta.parameters[i].default);
      assert.equal(p.values.length, p.max + 1);
      assert.equal(!!p.hidden, meta.parameters[i].hidden);
    });
  }
  const inventory = { entries: catalogFixture.entries };
  assert.equal(installedCount(effects, inventory), 131);
  assert.equal(installedCount(effects, inventory, 1), 10);
  assert.equal(installedCount(effects, null, 1), null);
  const missing = { entries: inventory.entries.filter(e => e.id !== 0x01000040) };
  const p = newPatch(); p.changeEffectInSlot(0, settingsFor(0x01000040));
  assert.deepEqual(unavailableEffects(p, missing), [0x01000040]);
  assert.deepEqual(unavailableEffects(p, inventory), []);
});

test('parse the physical catalog and reject corrupt/duplicate/truncated catalog records', () => {
  const bytes = Uint8Array.from(catalogFixture.bytes);
  assert.deepEqual(parseCatalog(bytes), catalogFixture.entries);
  assert.throws(() => parseCatalog(bytes.slice(0, 120)));
  const invalid = bytes.slice(); invalid[104 + 18] = 3; assert.throws(() => parseCatalog(invalid));
  const duplicate = bytes.slice(); duplicate.set(duplicate.slice(104, 130), 130); assert.throws(() => parseCatalog(duplicate));
});

function infoFile(dspload = 25) {
  const bytes = new Uint8Array(156), view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('ZDLF')); bytes.set(new TextEncoder().encode('1.10'), 89);
  view.setUint32(96, 0x01000010, true); bytes.set(new TextEncoder().encode('INFO'), 128);
  view.setUint32(132, 20, true); view.setFloat32(152, dspload, true); return bytes;
}
test('DSP metadata accepts only valid INFO, and version mismatch remains unknown', () => {
  assert.equal(parseZd2Info(infoFile()).percent, 10);
  assert.equal(parseZd2Info(infoFile().slice(0, 155)), null);
  assert.throws(() => parseZd2Info(infoFile(NaN)));
  const p = newPatch(); p.changeEffectInSlot(0, settingsFor(0x01000010));
  const inventory = { entries: [{ id: 0x01000010, installed: true, version: '9.99' }], costs: {} };
  assert(!estimateDsp(p, inventory).complete);
  inventory.costs['01000010'] = { ...parseZd2Info(infoFile()), catalogVersion: '9.99' };
  assert.equal(estimateDsp(p, inventory).percent, 10);
  assert.equal(estimateDsp(p, inventory).slots[0].source, 'device');
});

test('file reader validates CRC, closes files, forbids writes, and bounds interim polls', async () => {
  const raw = infoFile(), sent = [];
  let corrupted = false, interim = false, polls = 0;
  const midi = { matches: () => true, request: async payload => {
    sent.push(payload);
    if (payload[1] === 5 && ++polls > 1) {
      if (interim) return frame([0x60, 3, 0, 0, 0, 127, 127, 127, 127, 15]);
      const data = frame([0x60, 4, 0x22, 1, 0, raw.length & 127, raw.length >>> 7, ...eight2seven(raw), ...crcBytes(raw)]);
      if (corrupted) data[data.length - 2] ^= 1;
      return data;
    }
    return frame([0x60, 3, 0, 0, 0, 0, 0, 0, 0, 0]);
  } };
  const reader = new ReadOnlyCatalogReader(midi);
  assert.deepEqual(await reader.readFile('COMP.ZD2', true), raw);
  assert(sent.some(p => p[1] === 0x21) && sent.some(p => p[1] === 9));
  assert(sent.every(p => p[1] !== 0x20 || p[2] === 2));
  const count = sent.length; await assert.rejects(() => reader.command([0x60, 0x24]), /禁止/); assert.equal(sent.length, count);
  polls = 0; corrupted = true; await assert.rejects(() => reader.readFile('COMP.ZD2', true), /CRC/);
  polls = 0; interim = true; await assert.rejects(() => reader.readFile('COMP.ZD2', true), /上限/);
  assert.equal(sent.at(-1)[1], 9);
});
test('every mapped effect: default and maximum values survive PTCF serialization', () => {
  for (const e of effects) {
    const p = newPatch('Roundtrip'); p.changeEffectInSlot(0, settingsFor(e.id));
    const bytes = validateForSend(p), parsed = parsePatch(bytes);
    assert.equal(parsed.effectSettings[0].id, e.id);
    assert.deepEqual(parsed.effectSettings[0].parameters, p.effectSettings[0].parameters);
    e.parameters.forEach((parameter, i) => { p.effectSettings[0].parameters[i] = parameter.max; });
    const max = parsePatch(validateForSend(p));
    assert.deepEqual(max.effectSettings[0].parameters, p.effectSettings[0].parameters, e.name);
  }
});
test('six effect add, reorder, delete, bypass, tempo, level, project and Japanese note', () => {
  const p = newPatch('Six effects');
  effects.slice(0, 6).forEach((e, i) => p.addEffectInSlot(i, settingsFor(e.id)));
  p.swapEffectsInSlots(0, 5); p.effectSettings[1].enabled = false; p.tempo = 143; p.prm2PatchVolume = 73;
  let result = parseProject(serializeProject(p, '日本語メモ 🎸'));
  assert.equal(result.note, '日本語メモ 🎸'); assert.equal(result.patch.tempo, 143); assert.equal(result.patch.prm2PatchVolume, 73);
  assert.equal(result.patch.effectSettings.length, 6); assert.equal(result.patch.effectSettings[0].id, effects[5].id); assert.equal(result.patch.effectSettings[1].enabled, false);
  p.deleteEffectInSlot(2); result = parsePatch(patchBytes(p)); assert.equal(result.effectSettings.length, 5);
  while (p.effectSettings.length > 1) p.deleteEffectInSlot(0);
  p.deleteEffectInSlot(0); assert.equal(parsePatch(patchBytes(p)).effectSettings[0].id, 0);
});
test('reject corrupt/foreign/truncated project and patch data', () => {
  const bytes = patchBytes(newPatch());
  assert.throws(() => parsePatch(bytes.slice(0, 40)));
  const badLength = bytes.slice(); new DataView(badLength.buffer).setUint32(4, 10000, true); assert.throws(() => parsePatch(badLength));
  const foreign = bytes.slice(); new DataView(foreign.buffer).setUint32(16, 0x80000, true); assert.throws(() => parsePatch(foreign));
  const malformed = JSON.parse(serializeProject(newPatch(), '')); malformed.patch[4] = 999; assert.throws(() => parseProject(JSON.stringify(malformed)));
  const p = newPatch(); p.changeEffectInSlot(0, settingsFor(effects[0].id)); p.effectSettings[0].parameters[0] = 100000; assert.throws(() => validateForSend(p));
});
function dump(raw, slot = null) {
  return frame([...(slot === null ? [0x64, 0x12, 1] : [0x45, 0, 0, 0, 0, slot, 0]), raw.length & 127, raw.length >>> 7, ...eight2seven(raw), ...crcBytes(raw)]);
}
test('SysEx roundtrip, CRC rejection and no-CRC response', () => {
  const raw = new Uint8Array(1024); raw.set(patchBytes(newPatch('MIDI test')));
  assert.deepEqual(seven2eight(eight2seven(raw)), raw);
  assert.deepEqual(decodeDump(dump(raw)).raw, raw);
  assert.equal(decodeDump(dump(raw, 7), true).patch.name.trim(), 'MIDI test');
  const broken = dump(raw); broken[20] ^= 1; assert.throws(() => decodeDump(broken), /CRC/);
  const noCrc = frame([0x64, 0x12, 1, 0, 8, ...eight2seven(raw)]); assert.deepEqual(decodeDump(noCrc).raw, raw);
});
function fakeConnection() {
  const midi = new PedalConnection(); midi.connected = true; midi.length = 1024; midi.timeout = 25;
  midi.testProgram = 0; midi.dropEdits = false;
  const sent = []; let bank = 0, stored = new Uint8Array(1024); stored.set(patchBytes(newPatch('From pedal')));
  const applyParameter = data => {
    const p = parsePatch(stored), slot = data[7], parameter = data[8], value = data[9] + data[10] * 128;
    if (slot === 100) { if (parameter === 0) p.prm2PatchVolume = value; else if (parameter === 1) p.currentEffectSlot = value; else p.tempo = value; }
    else if (parameter === 0) p.effectSettings[slot].enabled = !!value;
    else p.effectSettings[slot].parameters[parameter - 2] = value;
    stored = new Uint8Array(1024); stored.set(patchBytes(p));
  };
  midi.output = { send: data => {
    sent.push(Uint8Array.from(data));
    queueMicrotask(() => {
      if ((data[0] & 0xf0) === 0xb0 && data[1] === 32) bank = data[2];
      else if ((data[0] & 0xf0) === 0xc0) midi.testProgram = bank * midi.perBank + data[1];
      else if (data[4] === 0x33) {
        midi.receive(Uint8Array.from([0xb0, 0, 0]));
        midi.receive(Uint8Array.from([0xb0, 32, Math.floor(midi.testProgram / midi.perBank)]));
        midi.receive(Uint8Array.from([0xc0, midi.testProgram % midi.perBank]));
      }
      else if (data[4] === 0x64 && data[5] === 0x20 && !midi.dropEdits) {
        applyParameter(data); midi.receive(Uint8Array.from(data));
      }
      else if (data[4] === 0x46) {
        // Deliberately deliver an unsolicited different-slot dump before the actual response.
        midi.receive(dump(stored, (data[9] + 1) % 100)); midi.receive(dump(stored, data[9]));
      } else if (data[4] === 0x64 && data[5] === 0x13) midi.receive(dump(stored));
      else if (data[4] === 0x45) { stored = seven2eight(data, 13, data.length - 7); midi.receive(frame([0, 0])); }
      else if (data[4] === 0x28) stored = seven2eight(data, 5, data.length - 2);
    });
  } };
  return { midi, sent, nativeEdit: (slot, parameter, value) => { const data = parameterMessage(slot, parameter, value); applyParameter(data); midi.receive(data); }, setCurrent: p => { stored = new Uint8Array(1024); stored.set(patchBytes(p)); } };
}

test('bidirectional edits update the PC without echo loops, including returns to recently sent values', async () => {
  const { midi, sent, nativeEdit } = fakeConnection(), events = [];
  const p = newPatch('Bidi'); p.changeEffectInSlot(0, settingsFor(effects[0].id)); await midi.apply(p);
  const live = new LiveSession(midi, () => {}, e => events.push(e));
  try {
    await live.start(p); live.queueValue(0, 2, 7); await live.flush();
    assert(sent.some(d => d[4] === 0x64 && d[7] === 100 && d[8] === 1), 'selects physical display');
    const start = sent.length;
    nativeEdit(0, 2, 3); nativeEdit(0, 2, 7);
    assert.deepEqual(events.map(e => e.value), [3, 7]); assert.equal(live.expected.effectSettings[0].parameters[0], 7);
    assert(live.active); await live.flush();
    assert(!sent.slice(start).some(d => d[4] === 0x64 && d[5] === 0x20));
    nativeEdit(100, 0, 75); nativeEdit(100, 2, 135); nativeEdit(0, 0, 0);
    assert.equal(live.expected.prm2PatchVolume, 75); assert.equal(live.expected.tempo, 135); assert(!live.expected.effectSettings[0].enabled);
  } finally { await live.stopAndWait(); }
});
test('bidirectional patch changes cancel pending old edits and adopt new effects without writing them', async () => {
  const { midi, sent, setCurrent } = fakeConnection(), events = [];
  const p = newPatch('First'); p.changeEffectInSlot(0, settingsFor(effects[0].id)); await midi.apply(p);
  const live = new LiveSession(midi, () => {}, e => events.push(e));
  try {
    await live.start(p); live.queueValue(0, 2, 7);
    const other = newPatch('Second'); other.changeEffectInSlot(0, settingsFor(0x03000010)); setCurrent(other);
    midi.testProgram = 1; midi.receive(Uint8Array.from([0xc0, 1])); const start = sent.length;
    await live.flush(); assert(live.active); assert.equal(live.program, 1); assert.equal(live.expected.name.trim(), 'Second'); assert(events.at(-1).changedProgram);
    assert(!sent.slice(start).some(d => [0x28, 0x45].includes(d[4]) || d[4] === 0x64 && d[5] === 0x20));
    other.changeEffectInSlot(0, settingsFor(0x01000040)); setCurrent(other); midi.receive(dump(patchBytes(other)));
    await live.flush(); assert(live.active); assert.equal(live.expected.effectSettings[0].id, 0x01000040);
  } finally { await live.stopAndWait(); }
});
test('bidirectional polling adopts external changes, but rejected PC writes still stop synchronization', async () => {
  const { midi, setCurrent } = fakeConnection(), events = [];
  const p = newPatch('Bidi'); p.changeEffectInSlot(0, settingsFor(effects[0].id)); await midi.apply(p);
  const live = new LiveSession(midi, () => {}, e => events.push(e));
  try {
    await live.start(p); const other = p.clone(); other.tempo = 141; setCurrent(other);
    live.lastEdit = 0; live.lastVerify = 0; await live.flush();
    assert(live.active); assert.equal(live.expected.tempo, 141); assert.equal(events.at(-1).type, 'patch');
    midi.dropEdits = true; live.queueValue(0, 2, 9); await live.flush();
    live.lastEdit = 0; live.lastVerify = 0; await live.flush(); assert(!live.active);
  } finally { await live.stopAndWait(); }
});
test('native edits cancel a conflicting unsent PC value rather than sending it back', async () => {
  const { midi, sent, nativeEdit } = fakeConnection();
  const p = newPatch('Conflict'); p.changeEffectInSlot(0, settingsFor(effects[0].id)); await midi.apply(p);
  const live = new LiveSession(midi, () => {}, () => {});
  try {
    await live.start(p); live.queueValue(0, 2, 9); nativeEdit(0, 2, 4); const start = sent.length;
    await live.flush(); assert.equal(live.expected.effectSettings[0].parameters[0], 4); assert(live.active);
    assert(!sent.slice(start).some(d => d[4] === 0x64 && d[5] === 0x20));
  } finally { await live.stopAndWait(); }
});
test('a native edit arriving during a readback is never replaced with the stale snapshot', async () => {
  const { midi, nativeEdit } = fakeConnection(), events = [];
  const p = newPatch('Race'); p.changeEffectInSlot(0, settingsFor(effects[0].id)); await midi.apply(p);
  const live = new LiveSession(midi, () => {}, e => events.push(e));
  let release;
  try {
    await live.start(p); const original = midi.readCurrent.bind(midi);
    let ready; const started = new Promise(r => { ready = r; }), gate = new Promise(r => { release = r; });
    midi.readCurrent = async () => { const old = await original(); ready(); await gate; return old; };
    live.lastEdit = 0; live.lastVerify = 0; const flight = live.flush(); await started;
    nativeEdit(0, 2, 4); release(); await flight;
    assert(live.active); assert.equal(live.expected.effectSettings[0].parameters[0], 4);
    assert.deepEqual(events.map(e => e.type), ['parameter']);
  } finally { release?.(); await live.stopAndWait(); }
});
test('read slot ignores wrong-slot dump and never writes', async () => {
  const { midi, sent } = fakeConnection();
  const result = await midi.readSlot(7); assert.equal(result.patch.name.trim(), 'From pedal');
  assert.equal(sent.length, 1); assert.equal(sent[0][4], 0x46);
});
test('memory selection sends bank/program changes, verifies the number, and avoids reloading the current slot', async () => {
  const { midi, sent } = fakeConnection();
  assert.equal(await midi.selectProgram(0), false);
  assert(!sent.some(d => d[0] === 0xc0 || d[0] === 0xb0));
  const start = sent.length; assert.equal(await midi.selectProgram(99), true);
  assert.equal(midi.testProgram, 99);
  assert.deepEqual(sent.slice(start).filter(d => d[0] === 0xc0 || d[0] === 0xb0).map(d => Array.from(d)), [[0xb0, 0, 0], [0xb0, 32, 0], [0xc0, 99]]);
  assert(!sent.some(d => [0x28, 0x45].includes(d[4])));
  await assert.rejects(() => midi.selectProgram(-1)); await assert.rejects(() => midi.selectProgram(100));
});
test('a memory switch that is not reflected by the pedal fails instead of reporting success', async () => {
  const { midi } = fakeConnection(), original = midi.output.send;
  midi.output.send = d => { if (d[0] !== 0xc0) original(d); };
  await assert.rejects(() => midi.selectProgram(1), /切り替えを確認できません/);
});

test('ten-program banks verify 011 and 100 using bank plus program, including returning to 001', async () => {
  const { midi, sent } = fakeConnection(); midi.perBank = 10;
  for (const slot of [10, 99, 0]) {
    const start = sent.length;
    assert.equal(await midi.selectProgram(slot), true);
    assert.equal(await midi.readProgram(), slot);
    assert.deepEqual(sent.slice(start).filter(d => d[0] === 0xc0 || d[0] === 0xb0).map(d => Array.from(d)),
      [[0xb0, 0, 0], [0xb0, 32, Math.floor(slot / 10)], [0xc0, slot % 10]]);
  }
  assert(!sent.some(d => [0x28, 0x45].includes(d[4])));
});

test('native bank changes with the same local program synchronize the correct absolute memory', async () => {
  const { midi, setCurrent } = fakeConnection(), events = []; midi.perBank = 10;
  const first = newPatch('First'); first.changeEffectInSlot(0, settingsFor(effects[0].id)); setCurrent(first);
  const live = new LiveSession(midi, () => {}, e => events.push(e));
  try {
    await live.start(first);
    const other = first.clone(); other.name = 'Eleventh'; setCurrent(other); midi.testProgram = 10;
    midi.receive(Uint8Array.from([0xb0, 0, 0])); midi.receive(Uint8Array.from([0xb0, 32, 1])); midi.receive(Uint8Array.from([0xc0, 0]));
    assert(live.needsSync); await live.flush();
    assert(live.active); assert.equal(live.program, 10); assert.equal(events.at(-1).program, 10);
    midi.receive(frame([0x64, 0x26, 0, 0, 9, 0, 9, 0]));
    assert(live.needsSync); assert.equal(midi.memorySlotFromMessage(frame([0x64, 0x26, 0, 0, 9, 0, 9, 0])), 99);
  } finally { await live.stopAndWait(); }
});
test('apply and slot save use correct framing and verify exact readback', async () => {
  const { midi, sent } = fakeConnection();
  const p = newPatch('Saved patch'); p.changeEffectInSlot(0, settingsFor(effects[0].id));
  await midi.apply(p); assert(sent.some(d => d[4] === 0x50)); assert(sent.some(d => d[4] === 0x28));
  await midi.writeSlot(p, 99); assert(sent.some(d => d[4] === 0x45 && d[9] === 99));
  await assert.rejects(() => midi.readSlot(100));
  midi.length = 50; await assert.rejects(() => midi.apply(p), /容量/);
  midi.connected = false; await assert.rejects(() => midi.writeSlot(p, 0), /接続/);
});
test('timeout and negative acknowledgement fail instead of reporting success', async () => {
  const m = new PedalConnection(); m.output = { send: () => {} }; m.timeout = 5;
  await assert.rejects(m.request([7], () => true), /応答/); assert.equal(m.pending, null);
  m.output.send = () => queueMicrotask(() => m.receive(frame([0, 10])));
  await assert.rejects(m.request([7], () => true), /拒否/);
});
test('identity rejects another model and connect sends only read requests', async () => {
  const midi = new PedalConnection(); midi.timeout = 30;
  const commands = [], input = { open: async () => {}, close: async () => {}, onmidimessage: null };
  const output = { open: async () => {}, close: async () => {}, send: d => {
    commands.push(d);
    queueMicrotask(() => {
      const response = d[1] === 0x7e ? [0xf0, 0x7e, 0, 6, 2, 0x52, 0x6e, 0, 0x23, 0, 49, 46, 51, 48, 0xf7] : d[4] === 7 ? frame([6, 100, 0, 0, 8]) : frame([0x43, 100, 0, 0, 8, 0, 0, 100, 0]);
      input.onmidimessage?.({ data: response });
    });
  } };
  await midi.connect(input, output); assert(midi.connected); assert.equal(midi.version, '1.30');
  assert(commands.every(d => d[1] === 0x7e || [7, 0x44].includes(d[4])));
  await midi.disconnect();
  output.send = () => queueMicrotask(() => input.onmidimessage?.({ data: [0xf0, 0x7e, 0, 6, 2, 0x52, 0x6f, 0, 0x23, 0, 49, 46, 51, 48, 0xf7] }));
  await assert.rejects(() => midi.connect(input, output), /以外/); assert.equal(midi.connected, false);
});
test('live session rejects stale editor state without changing sound', async () => {
  const { midi, sent } = fakeConnection(); const live = new LiveSession(midi);
  await assert.rejects(() => live.start(newPatch('Different')), /一致/);
  assert(!live.active); assert(!sent.some(d => [0x28, 0x50, 0x45].includes(d[4])));
});
test('live slider changes coalesce and send parameters only; toggle, tempo, volume and echo', async () => {
  const { midi, sent } = fakeConnection(); const p = newPatch('Live'); p.changeEffectInSlot(0, settingsFor(effects[0].id));
  await midi.apply(p); const live = new LiveSession(midi); await live.start(p); const start = sent.length;
  for (let n = 0; n < 100; n++) live.queueValue(0, 2, n % 11);
  live.queueValue(0, 2, 7); live.queueValue(0, 0, 0); live.queueValue(100, 2, 147); live.queueValue(100, 0, 71);
  await live.flush();
  const edits = sent.slice(start).filter(d => d[4] === 0x64 && d[5] === 0x20);
  assert.equal(edits.length, 4); assert.deepEqual(Array.from(edits[0]), Array.from(parameterMessage(0, 2, 7)));
  assert(!sent.slice(start).some(d => [0x28, 0x45].includes(d[4]))); assert(live.active);
  const actual = await midi.readCurrent();
  assert.equal(actual.patch.effectSettings[0].parameters[0], 7); assert(!actual.patch.effectSettings[0].enabled);
  assert.equal(actual.patch.tempo, 147); assert.equal(actual.patch.prm2PatchVolume, 71);
  // A current-patch read from outside the session deliberately stops it.
  assert(!live.active);
});
test('live update/undo sends changed values; structural change cancels pending edits', async () => {
  const { midi, sent } = fakeConnection(); const p = newPatch('Live'); p.changeEffectInSlot(0, settingsFor(effects[0].id));
  await midi.apply(p); const live = new LiveSession(midi); await live.start(p);
  const next = p.clone(); next.effectSettings[0].parameters[0] = 9;
  live.update(p, next); await live.flush(); assert(live.active);
  live.update(next, p); await live.flush(); assert(live.active);
  live.queueValue(0, 2, 7); const changed = p.clone(); changed.changeEffectInSlot(0, settingsFor(effects[1].id));
  live.update(p, changed); const start = sent.length; await live.flush(); assert(!live.active); assert.equal(sent.length, start);
});
test('live stops on patch switch, native edits and disconnect; cancelled work sends nothing', async () => {
  for (const signal of ['switch', 'native', 'disconnect', 'cancel']) {
    const { midi, sent } = fakeConnection(); const p = newPatch('Live'); p.changeEffectInSlot(0, settingsFor(effects[0].id));
    await midi.apply(p); const live = new LiveSession(midi); await live.start(p); const start = sent.length;
    live.queueValue(0, 2, 7);
    if (signal === 'switch') midi.testProgram = 1;
    else if (signal === 'native') midi.receive(parameterMessage(0, 2, 3));
    else if (signal === 'disconnect') for (const listener of midi.listeners) listener(null);
    else { const pending = live.flush(); await live.stopAndWait(); await pending; }
    await live.flush(); assert(!live.active); assert(!sent.slice(start).some(d => d[4] === 0x64 && d[5] === 0x20));
  }
});
test('live idle readback detects ignored changes and stops', async () => {
  const { midi } = fakeConnection(); const p = newPatch('Live'); p.changeEffectInSlot(0, settingsFor(effects[0].id));
  await midi.apply(p); const live = new LiveSession(midi); await live.start(p); midi.dropEdits = true;
  live.queueValue(0, 2, 9); await live.flush(); live.lastEdit = 0; live.lastVerify = 0; await live.flush(); assert(!live.active);
});
function screenFrame(texts) {
  return frame([0x64, 1, ...texts.flatMap((text, i) => [0, i, 1, 0, ...Array.from(text.padEnd(10, '\0'), ch => ch.charCodeAt(0))])]);
}
test('DSP costs count each slot, include bypass, and expose unknown costs', () => {
  const p = newPatch(); p.changeEffectInSlot(0, settingsFor(0x01000010)); p.addEffectInSlot(1, settingsFor(0x01000010)); p.effectSettings[1].enabled = false;
  // Sum the unrounded float32 metadata before rounding the total.
  assert.equal(estimateDsp(p).percent, 11.15); assert(estimateDsp(p).complete);
  const unknown = p.clone(); unknown.effectSettings[1].id = 0x07000ff0;
  assert.equal(estimateDsp(unknown).percent, 5.58); assert(!estimateDsp(unknown).complete); assert.deepEqual(estimateDsp(unknown).unknown, [1]);
  const high = newPatch(); const expensive = effects.filter(e => estimateDsp((() => { const p = newPatch(); p.changeEffectInSlot(0, settingsFor(e.id)); return p; })()).percent > 17)[0];
  assert(expensive); for (let i = 0; i < 6; i++) high.addEffectInSlot(i, settingsFor(expensive.id)); assert(estimateDsp(high).over);
});
test('DSP screen detection distinguishes explicit overflow, unavailable slots, malformed and ordinary text', () => {
  assert(screenDspReport(screenFrame(['DSP', 'FULL!'])).blocked);
  assert(screenDspReport(screenFrame(['PROCESS', 'OVERFLOW'])).blocked);
  assert(!screenDspReport(screenFrame(['Hall REV', '100'])).blocked);
  assert.equal(screenDspReport(screenFrame([])).type, 'unknown');
  assert.throws(() => screenDspReport(frame([0x64, 1, 0])));
  const p = newPatch(); p.prm2InvalidEffectSlot = 1;
  const report = invalidSlotReport(p); assert.equal(report.type, 'invalid'); assert.deepEqual(report.slots, [0]);
  assert.throws(() => validateForSend(p), /利用不可/);
});
test('DSP report halts live edits and cancels queued writes', async () => {
  const { midi, sent } = fakeConnection(); const p = newPatch('Live'); p.changeEffectInSlot(0, settingsFor(effects[0].id));
  await midi.apply(p); const live = new LiveSession(midi); await live.start(p);
  live.queueValue(0, 2, 8); await live.flush(); live.queueValue(0, 2, 9);
  midi.receive(screenFrame(['DSP', 'FULL!'])); const start = sent.length;
  await live.flush(); assert(!live.active); assert(midi.dspReport.blocked); assert.equal(sent.length, start);
});

