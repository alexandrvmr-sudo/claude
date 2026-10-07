// Мостик между страницей пульта и приложением: окно зеркала открывает Electron,
// а не браузер, поэтому его можно сразу отправить на телевизор.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mirrorApp', {
  isApp: true,
  openMirror: () => ipcRenderer.invoke('mirror:open'),
  closeMirror: () => ipcRenderer.invoke('mirror:close'),
  state: () => ipcRenderer.invoke('mirror:state'),
});
