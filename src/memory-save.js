export async function saveSelectedMemory({ midi, patch, slot, confirm, detail = '' }) {
  midi.requireConnection();
  if (!Number.isInteger(slot) || slot < 0 || slot >= midi.count) throw Error('PATCH MEMORYで保存先を選択してください');
  const verify = async () => {
    if (await midi.readProgram() !== slot) throw Error('本体のパッチ番号が変わりました。「現在のパッチを読む」で確認してから保存してください');
  };
  await verify();
  const existing = await midi.readSlot(slot);
  if (!(await confirm({ slot, name: existing.patch.name.trim(), patchName: patch.name.trim(), detail }))) return false;
  await verify();
  await midi.writeSlot(patch, slot);
  return true;
}
