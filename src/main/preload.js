// Preload script exposes safe APIs to renderer via contextBridge
// This is required when contextIsolation: true (secure Electron config)

const { contextBridge } = require('electron');

// Expose a minimal API to the renderer process
// Add WebSocket/IPC methods here when implementing Go Gateway integration
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  // Placeholder for future telemetry bridge
  // telemetry: {
  //   onUpdate: (callback) => ipcRenderer.on('telemetry-update', (_, data) => callback(data)),
  //   connect: (port) => ipcRenderer.send('telemetry-connect', port)
  // }
});
