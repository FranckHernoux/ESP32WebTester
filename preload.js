// ============================================================================
// ESP32 Web Tester — Preload (bridge renderer ↔ main process)
// ============================================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronRelay', {
    // Send a relay action (tcp-client, tcp-server, udp-bind, send, close)
    send: (msg) => ipcRenderer.send('relay-action', msg),

    // Receive relay events (connected, data, closed, error, etc.)
    onEvent: (callback) => {
        ipcRenderer.on('relay-event', (event, data) => callback(data));
    },

    // Auto-update
    onUpdateStatus: (callback) => {
        ipcRenderer.on('update-status', (event, msg) => callback(msg));
    },
    onUpdateProgress: (callback) => {
        ipcRenderer.on('update-progress', (event, percent) => callback(percent));
    },
    checkUpdate: () => ipcRenderer.invoke('check-update'),
    getVersion: () => ipcRenderer.invoke('get-version'),

    // Plotter popup window
    openPlotterWindow: (deviceIdx, query) => ipcRenderer.invoke('open-plotter-window', { deviceIdx, query }),
    closePlotterWindow: (deviceIdx) => ipcRenderer.invoke('close-plotter-window', deviceIdx),
    plotterFeed: (deviceIdx, line) => ipcRenderer.send('plotter-feed', { deviceIdx, line }),
    onPlotterWindowClosed: (callback) => {
        ipcRenderer.on('plotter-window-closed', (event, deviceIdx) => callback(deviceIdx));
    },

    // Detached panel windows
    openDetachedPanel: (type, deviceIdx, title) => ipcRenderer.invoke('open-detached-panel', { type, deviceIdx, title }),
    closeDetachedPanel: (type, deviceIdx) => ipcRenderer.invoke('close-detached-panel', { type, deviceIdx }),
    detachedPanelData: (type, deviceIdx, data) => ipcRenderer.send('detached-panel-data', { type, deviceIdx, data }),
    onDetachedPanelClosed: (callback) => {
        ipcRenderer.on('detached-panel-closed', (event, info) => callback(info));
    },

    // Serial port info (sent when user selects a port in the dialog)
    onSerialPortSelected: (callback) => {
        ipcRenderer.on('serial-port-selected', (event, info) => callback(info));
    },

    // App closing event (cleanup serial ports)
    onAppClosing: (callback) => {
        ipcRenderer.on('app-closing', () => callback());
    },

    // Generic message listener (for child windows)
    onMessage: (channel, callback) => {
        ipcRenderer.on(channel, (event, data) => callback(data));
    },

    // Flag to detect Electron environment
    isElectron: true,
});
