const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let win;
let uiLanguage = 'ja';
const smoke = process.argv.includes('--smoke-test');
if (smoke) app.disableHardwareAcceleration();
const smokeDir = process.env.MS50G_TEST_DIR || __dirname;
let smokeSavedPath;
app.setPath('userData', smoke ? path.join(smokeDir, '.smoke-profile') : process.defaultApp ? path.join(__dirname, '.dev-profile') : path.join(path.dirname(process.execPath), 'data'));
const saveTypes = {
  project: { name: 'MS-50G+ Editor project', extensions: ['ms50g.json'] },
  patch: { name: 'Zoom MS+ patch', extensions: ['zptc'] },
  backup: { name: 'MS-50G+ backup', extensions: ['ms50g-backup.json'] }
};
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1440, height: 940, minWidth: 1050, minHeight: 720,
    show: !smoke, backgroundColor: '#11191d', title: 'MS-50G+ Editor',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: smoke } });
  win.removeMenu();
  const trusted = wc => wc === win.webContents && wc.getURL().startsWith(pathToFileURL(path.join(__dirname, 'dist')).href + '/');
  win.webContents.session.setPermissionCheckHandler((wc, permission) => trusted(wc) && ['midi', 'midiSysex'].includes(permission));
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => callback(trusted(wc) && ['midi', 'midiSysex'].includes(permission)));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  ipcMain.on('language', (event, language) => { if (event.sender === win.webContents && ['ja', 'en'].includes(language)) uiLanguage = language; });
    win.webContents.on('will-prevent-unload', event => {
    const response = dialog.showMessageBoxSync(win, { type: 'question', message: uiLanguage === 'en' ? 'There are unsaved PC edits. Quit?' : 'PCに保存していない変更があります。終了しますか？', detail: uiLanguage === 'en' ? 'Your session can be recovered next time. Use Save to PC to keep a file copy.' : '作業内容は次回起動時に復旧できます。確実に残すには「PCに保存」を使用してください。', buttons: uiLanguage === 'en' ? ['Keep editing', 'Quit'] : ['編集を続ける', '終了する'], defaultId: 0, cancelId: 0 });
    if (response === 1) event.preventDefault();
  });
  ipcMain.handle('save-file', async (event, request) => {
    if (event.sender !== win.webContents || !request || !saveTypes[request.kind]) throw Error('Invalid request');
    const data = request.binary ? Buffer.from(request.data) : String(request.data);
    if (data.length > 32 * 1024 * 1024) throw Error('ファイルが大きすぎます');
    const defaultPath = String(request.name || 'patch').replace(/[<>:"/\\|?*]/g, '_');
    if (smoke) {
      const folder = path.join(smokeDir, '.smoke-data'); await fs.mkdir(folder, { recursive: true });
      smokeSavedPath = path.join(folder, defaultPath); await fs.writeFile(smokeSavedPath, data); return path.basename(smokeSavedPath);
    }
    const result = await dialog.showSaveDialog(win, { defaultPath, filters: [saveTypes[request.kind]] });
    if (result.canceled) return null;
    await fs.writeFile(result.filePath, data);
    return path.basename(result.filePath);
  });
  ipcMain.handle('open-file', async event => {
    if (event.sender !== win.webContents) throw Error('Invalid request');
    if (smoke && smokeSavedPath) return { name: path.basename(smokeSavedPath), data: Array.from(await fs.readFile(smokeSavedPath)) };
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'パッチ・プロジェクト・バックアップ', extensions: ['json', 'zptc'] }] });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw Error('ファイルが大きすぎます');
    return { name: path.basename(file), data: Array.from(await fs.readFile(file)) };
  });
  ipcMain.handle('confirm', async (event, request) => {
    if (event.sender !== win.webContents) return false;
    if (smoke) return true;
    const result = await dialog.showMessageBox(win, { type: 'question', title: 'MS-50G+ Editor',
      message: String(request.message), detail: String(request.detail || ''), buttons: request.language === 'en' ? ['Cancel', 'Continue'] : ['キャンセル', '実行'], defaultId: 0, cancelId: 0 });
    return result.response === 1;
  });
  await win.loadFile('dist/index.html');
  if (smoke) {
    try {
      const result = await win.webContents.executeJavaScript(`window.runSmokeTests()`);
      console.log(JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 200));
      const img = await win.webContents.capturePage();
      await fs.writeFile(path.join(smokeDir, 'smoke.png'), img.toPNG());
      app.exit(result.ok ? 0 : 1);
    } catch (e) { console.error(e); app.exit(1); }
  }
});
app.on('window-all-closed', () => app.quit());
