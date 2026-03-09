#!/usr/bin/env node
// ============================================================================
// ESP32 Web Tester — TCP/UDP Relay Server
// ============================================================================
// Ce serveur Node.js fait le pont entre le navigateur (WebSocket) et les
// connexions TCP/UDP brutes (client et serveur).
//
// Usage :  node relay.js [port]        (défaut: 8765)
// ============================================================================

const net       = require('net');
const dgram     = require('dgram');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

const RELAY_PORT = parseInt(process.argv[2], 10) || 8765;
const WEB_DIR   = __dirname; // Serve files from same folder as relay.js

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

// ---------------------------------------------------------------------------
// Minimal built-in WebSocket server (no dependency on 'ws')
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function createMinimalWsServer(httpServer) {
    const clients = new Set();

    httpServer.on('upgrade', (req, socket, head) => {
        const key = req.headers['sec-websocket-key'];
        if (!key) { socket.destroy(); return; }
        const accept = crypto.createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-5AB5A3F914AC')
            .digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
        );

        const ws = { socket, alive: true, _listeners: {} };
        clients.add(ws);

        ws.send = (data) => {
            const buf = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
            const frame = buildWsFrame(buf, typeof data === 'string' ? 0x01 : 0x01);
            try { socket.write(frame); } catch (_) {}
        };

        ws.on = (ev, fn) => { ws._listeners[ev] = fn; };

        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (true) {
                const parsed = parseWsFrame(buffer);
                if (!parsed) break;
                buffer = buffer.slice(parsed.totalLen);
                if (parsed.opcode === 0x08) { // close
                    clients.delete(ws);
                    socket.end();
                    if (ws._listeners.close) ws._listeners.close();
                    return;
                }
                if (parsed.opcode === 0x09) { // ping → pong
                    try { socket.write(buildWsFrame(parsed.payload, 0x0A)); } catch (_) {}
                    continue;
                }
                if (parsed.opcode === 0x0A) continue; // pong
                if (ws._listeners.message) ws._listeners.message(parsed.payload.toString('utf8'));
            }
        });
        socket.on('close', () => {
            clients.delete(ws);
            if (ws._listeners.close) ws._listeners.close();
        });
        socket.on('error', () => {
            clients.delete(ws);
            if (ws._listeners.close) ws._listeners.close();
        });

        if (ws._onconnect) ws._onconnect();
        // Emit to server-level handler
        httpServer.emit('ws-connection', ws);
    });

    return { clients };
}

function buildWsFrame(payload, opcode) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

function parseWsFrame(buf) {
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0F;
    const masked = !!(buf[1] & 0x80);
    let payloadLen = buf[1] & 0x7F;
    let offset = 2;
    if (payloadLen === 126) {
        if (buf.length < 4) return null;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
    } else if (payloadLen === 127) {
        if (buf.length < 10) return null;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    const totalLen = offset + maskLen + payloadLen;
    if (buf.length < totalLen) return null;
    let payload = buf.slice(offset + maskLen, offset + maskLen + payloadLen);
    if (masked) {
        const mask = buf.slice(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    return { opcode, payload, totalLen };
}

// ---------------------------------------------------------------------------
// Relay logic
// ---------------------------------------------------------------------------

const httpServer = http.createServer((req, res) => {
    // Serve static files from WEB_DIR
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    // Security: prevent directory traversal
    const filePath = path.join(WEB_DIR, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
    if (!filePath.startsWith(WEB_DIR)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
        });
        res.end(data);
    });
});

const wsServer = createMinimalWsServer(httpServer);
let connIdCounter = 0;

httpServer.on('ws-connection', (ws) => {
    // Map of active connections for THIS browser tab
    const connections = new Map(); // id → { type, socket/server, ... }

    function send(obj) {
        try { ws.send(JSON.stringify(obj)); } catch (_) {}
    }

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }

        switch (msg.action) {
            // =================================================================
            // TCP CLIENT
            // =================================================================
            case 'tcp-client': {
                const id = ++connIdCounter;
                const sock = new net.Socket();
                connections.set(id, { type: 'tcp-client', socket: sock });

                sock.connect(msg.port, msg.host, () => {
                    send({ event: 'connected', id, remote: `${msg.host}:${msg.port}` });
                });
                sock.on('data', (data) => {
                    send({ event: 'data', id, data: data.toString('utf8'), hex: data.toString('hex') });
                });
                sock.on('close', () => {
                    connections.delete(id);
                    send({ event: 'closed', id });
                });
                sock.on('error', (err) => {
                    send({ event: 'error', id, message: err.message });
                });
                send({ event: 'creating', id, info: `TCP client → ${msg.host}:${msg.port}` });
                break;
            }

            // =================================================================
            // TCP SERVER
            // =================================================================
            case 'tcp-server': {
                const id = ++connIdCounter;
                const server = net.createServer();
                const serverClients = new Map(); // subId → socket
                connections.set(id, { type: 'tcp-server', server, clients: serverClients });

                server.on('connection', (clientSock) => {
                    const subId = ++connIdCounter;
                    serverClients.set(subId, clientSock);
                    const remote = `${clientSock.remoteAddress}:${clientSock.remotePort}`;
                    send({ event: 'client-connected', id, subId, remote });

                    clientSock.on('data', (data) => {
                        send({ event: 'data', id, subId, data: data.toString('utf8'), hex: data.toString('hex'), remote });
                    });
                    clientSock.on('close', () => {
                        serverClients.delete(subId);
                        send({ event: 'client-disconnected', id, subId, remote });
                    });
                    clientSock.on('error', () => {
                        serverClients.delete(subId);
                    });
                });

                server.on('error', (err) => {
                    send({ event: 'error', id, message: err.message });
                    connections.delete(id);
                });

                server.listen(msg.port, '0.0.0.0', () => {
                    send({ event: 'listening', id, port: msg.port });
                });
                break;
            }

            // =================================================================
            // UDP BIND (client + server in one — send & receive)
            // =================================================================
            case 'udp-bind': {
                const id = ++connIdCounter;
                const sock = dgram.createSocket('udp4');
                connections.set(id, { type: 'udp', socket: sock, remoteHost: msg.remoteHost, remotePort: msg.remotePort });

                sock.on('message', (data, rinfo) => {
                    send({ event: 'data', id, data: data.toString('utf8'), hex: data.toString('hex'), remote: `${rinfo.address}:${rinfo.port}` });
                });
                sock.on('error', (err) => {
                    send({ event: 'error', id, message: err.message });
                });

                const bindPort = msg.localPort || 0;
                sock.bind(bindPort, () => {
                    const addr = sock.address();
                    send({ event: 'listening', id, port: addr.port, info: `UDP bound on :${addr.port}` });
                });
                break;
            }

            // =================================================================
            // SEND DATA
            // =================================================================
            case 'send': {
                const conn = connections.get(msg.id);
                if (!conn) { send({ event: 'error', id: msg.id, message: 'Connexion introuvable' }); break; }

                const buf = msg.hex ? Buffer.from(msg.hex, 'hex') : Buffer.from(msg.data || '', 'utf8');

                if (conn.type === 'tcp-client') {
                    conn.socket.write(buf);
                } else if (conn.type === 'tcp-server') {
                    // Send to a specific client or broadcast to all
                    if (msg.subId && conn.clients.has(msg.subId)) {
                        conn.clients.get(msg.subId).write(buf);
                    } else {
                        // Broadcast to all connected clients
                        for (const [, clientSock] of conn.clients) {
                            clientSock.write(buf);
                        }
                    }
                } else if (conn.type === 'udp') {
                    const host = msg.remoteHost || conn.remoteHost;
                    const port = msg.remotePort || conn.remotePort;
                    if (host && port) {
                        conn.socket.send(buf, port, host);
                    } else {
                        send({ event: 'error', id: msg.id, message: 'Hôte/port distant requis pour UDP' });
                    }
                }
                break;
            }

            // =================================================================
            // CLOSE
            // =================================================================
            case 'close': {
                const conn = connections.get(msg.id);
                if (!conn) break;

                if (conn.type === 'tcp-client') {
                    conn.socket.destroy();
                } else if (conn.type === 'tcp-server') {
                    for (const [, clientSock] of conn.clients) clientSock.destroy();
                    conn.server.close();
                } else if (conn.type === 'udp') {
                    try { conn.socket.close(); } catch (_) {}
                }
                connections.delete(msg.id);
                send({ event: 'closed', id: msg.id });
                break;
            }
        }
    });

    ws.on('close', () => {
        // Cleanup all connections for this browser tab
        for (const [id, conn] of connections) {
            if (conn.type === 'tcp-client') conn.socket.destroy();
            else if (conn.type === 'tcp-server') {
                for (const [, c] of conn.clients) c.destroy();
                conn.server.close();
            }
            else if (conn.type === 'udp') { try { conn.socket.close(); } catch (_) {} }
        }
        connections.clear();
    });

    send({ event: 'ready', message: 'Relay connecté' });
});

httpServer.listen(RELAY_PORT, () => {
    const url = `http://localhost:${RELAY_PORT}`;
    console.log(`\n  ╔══════════════════════════════════════════════════╗`);
    console.log(`  ║  ESP32 Web Tester — TCP/UDP Relay + Web Server   ║`);
    console.log(`  ║                                                  ║`);
    console.log(`  ║  Interface : ${(url + '/').padEnd(37)}║`);
    console.log(`  ║  Relay WS  : ${'ws://localhost:'.padEnd(16)}${String(RELAY_PORT).padEnd(21)}║`);
    console.log(`  ║                                                  ║`);
    console.log(`  ║  Gardez cette fenêtre ouverte.                   ║`);
    console.log(`  ║  Ctrl+C pour arrêter.                            ║`);
    console.log(`  ╚══════════════════════════════════════════════════╝\n`);

    // Auto-open browser
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32' ? `start ${url}`
              : process.platform === 'darwin' ? `open ${url}`
              : `xdg-open ${url}`;
    exec(cmd, () => {});
});
