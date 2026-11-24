const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopTraffic', {
  aiDemoVersion: 1,
  onAiPause: callback => {
    const listener = () => callback();
    ipcRenderer.on('traffic:pause-ai', listener);
    return () => ipcRenderer.removeListener('traffic:pause-ai', listener);
  },
  request: (base, path, body) => ipcRenderer.invoke('traffic:request', base, path, body),
  clearSession: () => ipcRenderer.invoke('traffic:clear-session'),
  stopCameraMedia: () => ipcRenderer.invoke('traffic:stop-camera'),
});
