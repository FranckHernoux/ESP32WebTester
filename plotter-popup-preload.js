// ============================================================================
// ESP32 Web Tester — Preload for Plotter popup window
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronPlotter', {
    onFeed: (callback) => {
        ipcRenderer.on('plotter-feed', (event, line) => callback(line));
    },
});
