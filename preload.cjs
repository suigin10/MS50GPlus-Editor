const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  setLanguage: language => ipcRenderer.send('language', language),
  save: request => ipcRenderer.invoke('save-file', request),
  open: () => ipcRenderer.invoke('open-file'),
  confirm: request => ipcRenderer.invoke('confirm', request)
});
