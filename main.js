// ============================================================================
// ESP32 Web Tester — Electron Main Process
// ============================================================================
// Embarque : fenêtre principale + relay TCP/UDP natif + auto-update
// ============================================================================

const { app, BrowserWindow, ipcMain, dialog, Menu, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const net   = require('net');
const dgram = require('dgram');
const path  = require('path');

let mainWindow = null;
const plotterWindows = new Map(); // deviceIdx → BrowserWindow

// ---------------------------------------------------------------------------
// Auto-updater config
// ---------------------------------------------------------------------------
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
    autoUpdater.on('checking-for-update', () => {
        sendToRenderer('update-status', 'Recherche de mises à jour...');
    });
    autoUpdater.on('update-available', (info) => {
        sendToRenderer('update-status', `Mise à jour ${info.version} disponible, téléchargement...`);
    });
    autoUpdater.on('update-not-available', () => {
        sendToRenderer('update-status', 'Application à jour.');
    });
    autoUpdater.on('download-progress', (progress) => {
        sendToRenderer('update-progress', Math.round(progress.percent));
    });
    autoUpdater.on('update-downloaded', (info) => {
        sendToRenderer('update-status', `Mise à jour ${info.version} prête. Redémarrage...`);
        // Ask user or auto-restart
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Mise à jour disponible',
            message: `La version ${info.version} a été téléchargée.\nL'application va redémarrer pour appliquer la mise à jour.`,
            buttons: ['Redémarrer maintenant', 'Plus tard']
        }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall();
        });
    });
    autoUpdater.on('error', (err) => {
        sendToRenderer('update-status', 'Erreur mise à jour: ' + err.message);
    });
}

function sendToRenderer(channel, data) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(channel, data);
    }
}

// ---------------------------------------------------------------------------
// TCP/UDP Relay (intégré dans le process principal)
// ---------------------------------------------------------------------------

let connIdCounter = 0;
const connections = new Map(); // id → { type, socket/server, ... }

function relayAction(msg) {
    let response = null;

    switch (msg.action) {
        // === TCP CLIENT ===
        case 'tcp-client': {
            const id = ++connIdCounter;
            const sock = new net.Socket();
            connections.set(id, { type: 'tcp-client', socket: sock });

            sock.connect(msg.port, msg.host, () => {
                sendToRenderer('relay-event', { event: 'connected', id, remote: `${msg.host}:${msg.port}` });
            });
            sock.on('data', (data) => {
                sendToRenderer('relay-event', { event: 'data', id, data: data.toString('utf8'), hex: data.toString('hex') });
            });
            sock.on('close', () => {
                connections.delete(id);
                sendToRenderer('relay-event', { event: 'closed', id });
            });
            sock.on('error', (err) => {
                sendToRenderer('relay-event', { event: 'error', id, message: err.message });
            });
            sendToRenderer('relay-event', { event: 'creating', id, info: `TCP client → ${msg.host}:${msg.port}` });
            break;
        }

        // === TCP SERVER ===
        case 'tcp-server': {
            const id = ++connIdCounter;
            const server = net.createServer({ allowHalfOpen: false });
            server.maxConnections = 10;
            const serverClients = new Map();
            connections.set(id, { type: 'tcp-server', server, clients: serverClients });

            server.on('connection', (clientSock) => {
                const subId = ++connIdCounter;
                serverClients.set(subId, clientSock);
                const remote = `${clientSock.remoteAddress}:${clientSock.remotePort}`;
                sendToRenderer('relay-event', { event: 'client-connected', id, subId, remote });

                clientSock.on('data', (data) => {
                    sendToRenderer('relay-event', { event: 'data', id, subId, data: data.toString('utf8'), hex: data.toString('hex'), remote });
                });
                clientSock.on('close', () => {
                    serverClients.delete(subId);
                    sendToRenderer('relay-event', { event: 'client-disconnected', id, subId, remote });
                });
                clientSock.on('error', () => { serverClients.delete(subId); });
            });

            server.on('error', (err) => {
                sendToRenderer('relay-event', { event: 'error', id, message: err.message });
                connections.delete(id);
            });

            server.listen(msg.port, '0.0.0.0', () => {
                sendToRenderer('relay-event', { event: 'listening', id, port: msg.port });
            });
            break;
        }

        // === UDP BIND ===
        case 'udp-bind': {
            const id = ++connIdCounter;
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            connections.set(id, { type: 'udp', socket: sock, remoteHost: msg.remoteHost, remotePort: msg.remotePort });

            sock.on('message', (data, rinfo) => {
                sendToRenderer('relay-event', { event: 'data', id, data: data.toString('utf8'), hex: data.toString('hex'), remote: `${rinfo.address}:${rinfo.port}` });
            });
            sock.on('error', (err) => {
                sendToRenderer('relay-event', { event: 'error', id, message: err.message });
                // Cleanup zombie socket on bind failure
                try { sock.close(); } catch (_) {}
                connections.delete(id);
                sendToRenderer('relay-event', { event: 'closed', id });
            });

            const bindPort = msg.localPort || 0;
            sock.bind(bindPort, () => {
                const addr = sock.address();
                sendToRenderer('relay-event', { event: 'listening', id, port: addr.port, info: `UDP bound on :${addr.port}` });
            });
            break;
        }

        // === SEND DATA ===
        case 'send': {
            const conn = connections.get(msg.id);
            if (!conn) { sendToRenderer('relay-event', { event: 'error', id: msg.id, message: 'Connexion introuvable' }); break; }

            const buf = msg.hex ? Buffer.from(msg.hex, 'hex') : Buffer.from(msg.data || '', 'utf8');

            if (conn.type === 'tcp-client') {
                conn.socket.write(buf);
            } else if (conn.type === 'tcp-server') {
                if (msg.subId && conn.clients.has(msg.subId)) {
                    conn.clients.get(msg.subId).write(buf);
                } else {
                    for (const [, clientSock] of conn.clients) clientSock.write(buf);
                }
            } else if (conn.type === 'udp') {
                const host = msg.remoteHost || conn.remoteHost;
                const port = msg.remotePort || conn.remotePort;
                if (host && port) {
                    conn.socket.send(buf, port, host);
                } else {
                    sendToRenderer('relay-event', { event: 'error', id: msg.id, message: 'Hôte/port distant requis pour UDP' });
                }
            }
            break;
        }

        // === CLOSE ===
        case 'close': {
            const conn = connections.get(msg.id);
            if (!conn) break;

            if (conn.type === 'tcp-client') conn.socket.destroy();
            else if (conn.type === 'tcp-server') {
                for (const [, clientSock] of conn.clients) clientSock.destroy();
                conn.server.close();
            }
            else if (conn.type === 'udp') { try { conn.socket.close(); } catch (_) {} }

            connections.delete(msg.id);
            sendToRenderer('relay-event', { event: 'closed', id: msg.id });
            break;
        }
    }
}

// Cleanup all connections
function cleanupConnections() {
    for (const [id, conn] of connections) {
        if (conn.type === 'tcp-client') conn.socket.destroy();
        else if (conn.type === 'tcp-server') {
            for (const [, c] of conn.clients) c.destroy();
            conn.server.close();
        }
        else if (conn.type === 'udp') { try { conn.socket.close(); } catch (_) {} }
    }
    connections.clear();
}

// IPC handlers
ipcMain.on('relay-action', (event, msg) => {
    relayAction(msg);
});

ipcMain.handle('check-update', async () => {
    try { await autoUpdater.checkForUpdates(); } catch (e) { /* offline */ }
});

ipcMain.handle('get-version', () => app.getVersion());

// ---------------------------------------------------------------------------
// Plotter popup child windows
// ---------------------------------------------------------------------------

ipcMain.handle('open-plotter-window', (event, { deviceIdx, query }) => {
    if (plotterWindows.has(deviceIdx)) {
        plotterWindows.get(deviceIdx).focus();
        return;
    }
    const child = new BrowserWindow({
        width: 750,
        height: 500,
        minWidth: 400,
        minHeight: 300,
        parent: mainWindow,
        title: `Traceur — Device ${deviceIdx + 1}`,
        icon: path.join(__dirname, 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'plotter-popup-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });
    Menu.setApplicationMenu(null);
    child.loadFile('plotter-popup.html', { query: { device: String(deviceIdx), ...query } });
    plotterWindows.set(deviceIdx, child);
    child.on('closed', () => {
        plotterWindows.delete(deviceIdx);
        sendToRenderer('plotter-window-closed', deviceIdx);
    });
});

ipcMain.handle('close-plotter-window', (event, deviceIdx) => {
    const child = plotterWindows.get(deviceIdx);
    if (child) child.close();
});

ipcMain.on('plotter-feed', (event, { deviceIdx, line }) => {
    const child = plotterWindows.get(deviceIdx);
    if (child && !child.isDestroyed()) {
        child.webContents.send('plotter-feed', line);
    }
});

// ---------------------------------------------------------------------------
// Generic detached panel windows (console, data table)
// ---------------------------------------------------------------------------
const detachedWindows = new Map(); // "type-deviceIdx" → BrowserWindow

ipcMain.handle('open-detached-panel', (event, { type, deviceIdx, title }) => {
    const key = `${type}-${deviceIdx}`;
    if (detachedWindows.has(key)) {
        detachedWindows.get(key).focus();
        return;
    }
    const child = new BrowserWindow({
        width: 700,
        height: 500,
        minWidth: 350,
        minHeight: 250,
        parent: mainWindow,
        title: title || `${type} — Device ${deviceIdx + 1}`,
        icon: path.join(__dirname, 'icon.ico'),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });
    Menu.setApplicationMenu(null);
    child.loadFile('detached-panel.html', { query: { type, device: String(deviceIdx) } });
    detachedWindows.set(key, child);
    child.on('closed', () => {
        detachedWindows.delete(key);
        sendToRenderer('detached-panel-closed', { type, deviceIdx });
    });
});

ipcMain.handle('close-detached-panel', (event, { type, deviceIdx }) => {
    const key = `${type}-${deviceIdx}`;
    const child = detachedWindows.get(key);
    if (child) child.close();
});

ipcMain.on('detached-panel-data', (event, { type, deviceIdx, data }) => {
    const key = `${type}-${deviceIdx}`;
    const child = detachedWindows.get(key);
    if (child && !child.isDestroyed()) {
        child.webContents.send('panel-data', data);
    }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
    // Remove menu bar (File, Edit, View, etc.)
    Menu.setApplicationMenu(null);

    const { screen } = require('electron');
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: Math.round(screenW / 2),
        height: screenH,
        x: Math.round(screenW / 4),
        y: 0,
        minWidth: 600,
        minHeight: 400,
        title: 'ESP32 Web Tester',
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        }
    });

    mainWindow.loadFile('index.html');

    // --- Web Serial API: port selection dialog for Electron ---
    // When requestPort() is called, Electron fires this event instead of the
    // browser-native popup. We auto-select the first available port, or let
    // the user choose if multiple ports are present.
    mainWindow.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
        event.preventDefault();
        if (!portList || portList.length === 0) {
            callback('');
            return;
        }

        // Build readable label for each port
        function portLabel(p) {
            const parts = [];
            if (p.portName) parts.push(p.portName);
            if (p.displayName) parts.push(p.displayName);
            if (p.vendorId && p.productId) parts.push(`VID:${p.vendorId} PID:${p.productId}`);
            return parts.length > 0 ? parts.join(' — ') : (p.portId || 'Unknown');
        }

        // Always show the selection dialog so the user can choose/confirm
        const buttons = portList.map((p) => portLabel(p));
        buttons.push('Annuler');

        dialog.showMessageBox(mainWindow, {
            type: 'question',
            title: 'Sélection du port série',
            message: `${portList.length} port(s) série détecté(s).\nChoisissez le port à connecter :`,
            buttons,
            cancelId: buttons.length - 1,
            defaultId: 0,
        }).then(({ response }) => {
            if (response >= 0 && response < portList.length) {
                const selected = portList[response];
                // Send port info to renderer so it can display the name
                mainWindow.webContents.send('serial-port-selected', {
                    portId: selected.portId,
                    portName: selected.portName || '',
                    displayName: selected.displayName || '',
                    vendorId: selected.vendorId || '',
                    productId: selected.productId || '',
                });
                callback(selected.portId);
            } else {
                callback('');
            }
        }).catch(() => callback(''));
    });

    // Grant serial port permission automatically
    mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
        if (permission === 'serial') return true;
        return true;
    });

    mainWindow.webContents.session.setDevicePermissionHandler((details) => {
        if (details.deviceType === 'serial') return true;
        return true;
    });

    mainWindow.on('close', () => {
        // Tell renderer to close all serial ports before the window destroys
        if (mainWindow && mainWindow.webContents) {
            mainWindow.webContents.send('app-closing');
        }
    });

    mainWindow.on('closed', () => {
        cleanupConnections();
        mainWindow = null;
    });

    // Check for updates after window is ready
    mainWindow.webContents.on('did-finish-load', () => {
        setupAutoUpdater();
        if (app.isPackaged) {
            autoUpdater.checkForUpdates().catch(() => {});
        }
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    cleanupConnections();
    for (const [, win] of plotterWindows) {
        if (!win.isDestroyed()) win.close();
    }
    plotterWindows.clear();
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
