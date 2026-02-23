// Preload script can expose safe APIs to renderer via contextBridge
// For now it's empty but kept for future IPC

// const { contextBridge, ipcRenderer } = require('electron');

// contextBridge.exposeInMainWorld('electron', {
//   ipcRenderer: {
//     send: (channel, data) => ipcRenderer.send(channel, data),
//     on: (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args))
//   }
// });
