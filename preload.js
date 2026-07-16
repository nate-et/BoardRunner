const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallboardApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getState: () => ipcRenderer.invoke('get-state'),
  getDetectedDisplays: () => ipcRenderer.invoke('get-detected-displays'),
  captureScreenSnapshot: (screenId) => ipcRenderer.invoke('capture-screen-snapshot', screenId),

  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  reloadScreens: () => ipcRenderer.invoke('reload-screens'),
  toggleRotation: () => ipcRenderer.invoke('toggle-rotation'),
  identifyDisplays: () => ipcRenderer.invoke('identify-displays'),

  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  openConfigFolder: () => ipcRenderer.invoke('open-config-folder'),

  createConfigBackup: () => ipcRenderer.invoke('create-config-backup'),
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),

  showAdmin: () => ipcRenderer.invoke('show-admin'),
  previewDashboard: (dashboard) => ipcRenderer.invoke('preview-dashboard', dashboard),

  onAppState: (callback) => ipcRenderer.on('app-state', (_, data) => callback(data))
});