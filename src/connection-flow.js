// Start from the pedal's current sound. Connecting never sends the PC's patch.
export async function loadCurrentForLive({ midi, live, install, validate = () => {}, enabled = true }) {
  const program = await midi.readProgram();
  const current = await midi.readCurrent();
  if (program !== await midi.readProgram()) throw Error('本体のパッチが切り替わりました。「現在のパッチを読む」で読み直してください');
  install(current.patch, program);
  if (enabled) { validate(); await live.start(current.patch); }
  return current;
}
