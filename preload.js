const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallboardApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getState: () => ipcRenderer.invoke('get-state'),
  getDetectedDisplays: () => ipcRenderer.invoke('get-detected-displays'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  reloadScreens: () => ipcRenderer.invoke('reload-screens'),
  toggleRotation: () => ipcRenderer.invoke('toggle-rotation'),
  identifyDisplays: () => ipcRenderer.invoke('identify-displays'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  showAdmin: () => ipcRenderer.invoke('show-admin'),
  previewDashboard: (dashboard) => ipcRenderer.invoke('preview-dashboard', dashboard),
  onAppState: (callback) => ipcRenderer.on('app-state', (_, data) => callback(data))
});
