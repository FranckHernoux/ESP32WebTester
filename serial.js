/* ============================================================================
   ESP32 Web Tester - Multi-device + Bridge + Simulation + Console avancée
   ============================================================================ */
(function () {
    'use strict';

    // =========================================================================
    // State
    // =========================================================================

    const devices = [];
    const bridgeRules = [];
    let deviceCount = 2;

    const template       = document.getElementById('deviceTemplate');
    const container      = document.getElementById('devicesContainer');
    const bridgeSection  = document.getElementById('bridgeSection');
    const bridgeRulesEl  = document.getElementById('bridgeRules');
    const deviceCountSel = document.getElementById('deviceCount');

    // MQTT protocol object (provided by network.js)
    function getMQTT() { return window.MQTT; }

    // ANSI escape code regex
    const ANSI_RE = /\x1b\[([0-9;]*)m/g;

    // ESP-IDF log level regex: E (1234) tag: message
    const ESPIDF_RE = /^([EWIDV]) \(\d+\) .+?:/;

    // =========================================================================
    // Helpers
    // =========================================================================

    function timestamp() {
        const d = new Date();
        return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
    }

    function getLineEnding(dev) {
        return dev.els.lineEnding.value.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
    }

    // Feed plotter locally + forward to popup child window if open
    function feedPlotter(dev, line) {
        if (dev.plotter) Plotter.feed(dev.plotter, line);
        if (!dev.plotterPopup) return;
        if (isElectron && window.electronRelay.plotterFeed) {
            window.electronRelay.plotterFeed(dev.index, line);
        } else if (dev._plotterPopupWin && !dev._plotterPopupWin.closed) {
            dev._plotterPopupWin.postMessage({ type: 'plotter-feed', device: dev.index, line }, '*');
        }
    }

    // --- Persistence (localStorage + fichier) ----------------------------------
    function saveDeviceMacros(dev) {
        const key = 'esp32_device_' + dev.index;
        const data = {
            macros: dev.macros.map(m => ({ label: m.label, cmd: m.cmd })),
            sequences: dev.sequences.map(s => ({
                name: s.name,
                steps: s.steps.map(st => ({ cmd: st.cmd, delay: st.delay })),
            })),
            triggers: dev.triggers.map(t => ({ pattern: t.pattern, action: t.action, active: t.active, cmd: t.cmd || '', webhookUrl: t.webhookUrl || '' })),
            gpioPins: dev.gpioPins.map(p => ({ label: p.label, pin: p.pin, mode: p.mode, cmdOn: p.cmdOn, cmdOff: p.cmdOff })),
            dashVars: dev.dashVars.map(v => ({ name: v.name, regex: v.regex.source, unit: v.unit, min: v.min, max: v.max })),
        };
        try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
    }

    function loadDeviceMacros(dev) {
        const key = 'esp32_device_' + dev.index;
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data.macros) {
                for (const m of data.macros) {
                    const macro = { label: m.label, cmd: m.cmd };
                    dev.macros.push(macro);
                    renderQuickCommand(dev, macro);
                }
            }
            if (data.sequences) {
                for (const s of data.sequences) {
                    const seq = { name: s.name, steps: [], running: false, abortFlag: false, el: null, _dev: dev };
                    dev.sequences.push(seq);
                    renderSequence(dev, seq);
                    for (const st of s.steps) {
                        const step = { cmd: st.cmd, delay: st.delay };
                        seq.steps.push(step);
                        renderSequenceStep(seq, step);
                    }
                }
            }
            if (data.triggers) {
                for (const t of data.triggers) {
                    const trigger = { pattern: t.pattern, action: t.action, active: t.active, cmd: t.cmd || '', webhookUrl: t.webhookUrl || '', hitCount: 0 };
                    dev.triggers.push(trigger);
                    renderTrigger(dev, trigger);
                }
            }
            if (data.gpioPins) {
                for (const p of data.gpioPins) {
                    const gpioPin = { label: p.label, pin: p.pin, mode: p.mode, cmdOn: p.cmdOn, cmdOff: p.cmdOff, state: false };
                    dev.gpioPins.push(gpioPin);
                    renderGpioPin(dev, gpioPin);
                }
            }
            if (data.dashVars) {
                for (const v of data.dashVars) {
                    const dv = { name: v.name, regex: new RegExp(v.regex, 'i'), unit: v.unit, min: v.min, max: v.max, value: null };
                    dev.dashVars.push(dv);
                    renderDashVar(dev, dv);
                }
            }
        } catch (e) {}
    }

    function exportMacrosToFile() {
        const allData = {};
        for (const dev of devices) {
            allData['device_' + dev.index] = {
                macros: dev.macros.map(m => ({ label: m.label, cmd: m.cmd })),
                sequences: dev.sequences.map(s => ({
                    name: s.name,
                    steps: s.steps.map(st => ({ cmd: st.cmd, delay: st.delay })),
                })),
                triggers: dev.triggers.map(t => ({ pattern: t.pattern, action: t.action, active: t.active, cmd: t.cmd || '', webhookUrl: t.webhookUrl || '' })),
                gpioPins: dev.gpioPins.map(p => ({ label: p.label, pin: p.pin, mode: p.mode, cmdOn: p.cmdOn, cmdOff: p.cmdOff })),
                dashVars: dev.dashVars.map(v => ({ name: v.name, regex: v.regex.source, unit: v.unit, min: v.min, max: v.max })),
            };
        }
        const json = JSON.stringify(allData, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'esp32_macros_' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function importMacrosFromFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.multiple = true;
        input.addEventListener('change', async () => {
            for (const file of input.files) {
                try {
                    const text = await file.text();
                    const allData = JSON.parse(text);
                    for (const [key, data] of Object.entries(allData)) {
                        const match = key.match(/device_(\d+)/);
                        if (!match) continue;
                        const idx = parseInt(match[1], 10);
                        const dev = devices.find(d => d.index === idx);
                        if (!dev) continue;
                        if (data.macros) {
                            for (const m of data.macros) {
                                if (dev.macros.some(x => x.label === m.label && x.cmd === m.cmd)) continue;
                                const macro = { label: m.label, cmd: m.cmd };
                                dev.macros.push(macro);
                                renderQuickCommand(dev, macro);
                            }
                        }
                        if (data.sequences) {
                            for (const s of data.sequences) {
                                if (dev.sequences.some(x => x.name === s.name)) continue;
                                const seq = { name: s.name, steps: [], running: false, abortFlag: false, el: null, _dev: dev };
                                dev.sequences.push(seq);
                                renderSequence(dev, seq);
                                for (const st of s.steps) {
                                    const step = { cmd: st.cmd, delay: st.delay };
                                    seq.steps.push(step);
                                    renderSequenceStep(seq, step);
                                }
                            }
                        }
                        if (data.triggers) {
                            for (const t of data.triggers) {
                                if (dev.triggers.some(x => x.pattern === t.pattern)) continue;
                                const trigger = { pattern: t.pattern, action: t.action, active: t.active, cmd: t.cmd || '', webhookUrl: t.webhookUrl || '', hitCount: 0 };
                                dev.triggers.push(trigger);
                                renderTrigger(dev, trigger);
                            }
                        }
                        if (data.gpioPins) {
                            for (const p of data.gpioPins) {
                                if (dev.gpioPins.some(x => x.label === p.label && x.pin === p.pin)) continue;
                                const gpioPin = { label: p.label, pin: p.pin, mode: p.mode, cmdOn: p.cmdOn, cmdOff: p.cmdOff, state: false };
                                dev.gpioPins.push(gpioPin);
                                renderGpioPin(dev, gpioPin);
                            }
                        }
                        if (data.dashVars) {
                            for (const v of data.dashVars) {
                                if (dev.dashVars.some(x => x.name === v.name)) continue;
                                const dv = { name: v.name, regex: new RegExp(v.regex, 'i'), unit: v.unit, min: v.min, max: v.max, value: null };
                                dev.dashVars.push(dv);
                                renderDashVar(dev, dv);
                            }
                        }
                        saveDeviceMacros(dev);
                    }
                } catch (e) {
                    alert('Erreur lors du chargement : ' + e.message);
                }
            }
        });
        input.click();
    }

    // Expose globally
    window._esp32ExportMacros = exportMacrosToFile;
    window._esp32ImportMacros = importMacrosFromFile;

    function isActive(dev) {
        if (dev.simulated) return true;
        const type = dev.connectionType || 'serial';
        if (type === 'serial') return !!dev.port;
        if (type === 'websocket') return !!dev.netConnId;
        if (type === 'mqtt') return !!dev.mqttConnected;
        return false;
    }

    // --- ANSI parser ---------------------------------------------------------

    const ANSI_COLOR_MAP = {
        30: 'ansi-black', 31: 'ansi-red', 32: 'ansi-green', 33: 'ansi-yellow',
        34: 'ansi-blue', 35: 'ansi-magenta', 36: 'ansi-cyan', 37: 'ansi-white',
        90: 'ansi-bright-black', 91: 'ansi-bright-red', 92: 'ansi-bright-green',
        93: 'ansi-bright-yellow', 94: 'ansi-bright-blue', 95: 'ansi-bright-magenta',
        96: 'ansi-bright-cyan', 97: 'ansi-bright-white',
    };

    const ANSI_STYLE_MAP = {
        1: 'ansi-bold', 2: 'ansi-dim', 3: 'ansi-italic', 4: 'ansi-underline',
    };

    function parseAnsi(text) {
        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let classes = [];

        ANSI_RE.lastIndex = 0;
        let match;
        while ((match = ANSI_RE.exec(text)) !== null) {
            // Text before this escape
            if (match.index > lastIdx) {
                const span = document.createElement('span');
                if (classes.length) span.className = classes.join(' ');
                span.textContent = text.substring(lastIdx, match.index);
                frag.appendChild(span);
            }
            // Parse codes
            const codes = match[1].split(';').map(Number);
            for (const code of codes) {
                if (code === 0) { classes = []; }
                else if (ANSI_COLOR_MAP[code]) {
                    // Remove old color class, add new
                    classes = classes.filter(c => !c.startsWith('ansi-') || c.startsWith('ansi-bold') || c.startsWith('ansi-dim') || c.startsWith('ansi-italic') || c.startsWith('ansi-underline'));
                    classes.push(ANSI_COLOR_MAP[code]);
                }
                else if (ANSI_STYLE_MAP[code]) { classes.push(ANSI_STYLE_MAP[code]); }
            }
            lastIdx = match.index + match[0].length;
        }
        // Remaining text
        if (lastIdx < text.length) {
            const span = document.createElement('span');
            if (classes.length) span.className = classes.join(' ');
            span.textContent = text.substring(lastIdx);
            frag.appendChild(span);
        }
        return frag;
    }

    function stripAnsi(text) {
        return text.replace(ANSI_RE, '');
    }

    // --- Hex view ------------------------------------------------------------

    function textToHexDump(text) {
        const bytes = new TextEncoder().encode(text);
        const lines = [];
        for (let off = 0; off < bytes.length; off += 16) {
            const chunk = bytes.slice(off, off + 16);
            const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
            const ascii = Array.from(chunk).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
            const offset = off.toString(16).padStart(6, '0');
            lines.push({ offset, hex: hex.padEnd(48, ' '), ascii });
        }
        return lines;
    }

    // --- ESP-IDF log level detection -----------------------------------------

    function detectLogLevel(text) {
        const clean = stripAnsi(text);
        const m = clean.match(ESPIDF_RE);
        if (!m) return null;
        const map = { E: 'error', W: 'warn', I: 'info', D: 'debug', V: 'verbose' };
        return map[m[1]] || null;
    }

    // --- Append line (core) --------------------------------------------------

    function appendLine(dev, text, cls) {
        const el = dev.els.console;
        const isHex = dev.els.chkHex.checked;
        const isAnsi = dev.els.chkAnsi.checked;
        const isRx = !cls || cls === 'line-rx';

        // Store raw data for recording/export
        const rawEntry = { time: Date.now(), ts: timestamp(), text, cls: cls || 'line-rx' };
        dev.consoleData.push(rawEntry);

        // Track bytes & lines (RX only)
        if (isRx || cls === 'line-bridge') {
            dev.rxBytes += new TextEncoder().encode(text).length;
            dev.lineCount++;
            dev.els.rxLineCount.textContent = `${dev.lineCount} lignes`;
        }

        // Detect ESP-IDF log level for RX lines
        let logLevel = null;
        if (isRx) {
            logLevel = detectLogLevel(text);
        }

        if (isHex && isRx) {
            // Hex dump view
            const hexLines = textToHexDump(text);
            for (const hl of hexLines) {
                const line = document.createElement('div');
                line.className = 'hex-line';
                line.dataset.raw = text;
                line.innerHTML = `<span class="hex-offset">${hl.offset}</span><span class="hex-bytes">${hl.hex}</span><span class="hex-ascii">${hl.ascii}</span>`;
                addBookmarkHandler(line, dev);
                el.appendChild(line);
            }
        } else {
            const line = document.createElement('div');
            line.dataset.raw = text;

            // Apply class
            if (logLevel) {
                line.className = `log-${logLevel}`;
            } else {
                line.className = cls || 'line-rx';
            }

            // Timestamp
            if (dev.els.chkTimestamp.checked) {
                const ts = document.createElement('span');
                ts.className = 'timestamp';
                ts.textContent = `[${rawEntry.ts}]`;
                line.appendChild(ts);
            }

            // Log level badge
            if (logLevel) {
                const badge = document.createElement('span');
                badge.className = 'log-tag';
                badge.textContent = `[${logLevel.charAt(0).toUpperCase()}]`;
                line.appendChild(badge);
            }

            // JSON pretty-print in console (if checkbox enabled)
            const isJson = dev.els.chkJson && dev.els.chkJson.checked;
            let jsonParsed = null;
            if (isJson && isRx) {
                jsonParsed = tryParseJson(text);
            }

            if (jsonParsed !== null) {
                // Replace this line with pretty-printed JSON
                line.classList.add('line-json');
                const block = document.createElement('div');
                block.className = 'json-block';
                block.innerHTML = jsonToHtml(jsonParsed, 0);
                line.appendChild(block);
            } else {
                // Content: ANSI parsing or plain text
                ANSI_RE.lastIndex = 0;
            if (isAnsi && isRx && ANSI_RE.test(text)) {
                    line.appendChild(parseAnsi(text));
                } else {
                    line.appendChild(document.createTextNode(isAnsi ? stripAnsi(text) : text));
                }
            }

            addBookmarkHandler(line, dev);
            el.appendChild(line);

            // Apply filter
            applyFilterToLine(dev, line);

            // Apply highlight rules
            applyHighlightsToLine(dev, line);
        }

        if (dev.els.chkAutoScroll.checked) {
            el.scrollTop = el.scrollHeight;
        }

        // Recording hook
        recordEntry(dev, text, cls);

        // Feed protocol decoder for RX data
        if (isRx) feedDecoder(dev, text);

        // Triggers check
        checkTriggers(dev, text);

        // Dashboard update
        if (dev.dashVars.length > 0) updateDashboard(dev, text);

        // Logic analyzer feed
        if (window._logicAnalyzerFeed) window._logicAnalyzerFeed(dev.index, text);

        // Pin map feed
        if (window._pinmapFeed) window._pinmapFeed(text);

        // Live data table feed
        if (isRx) feedLiveTable(dev, text);

        // Feed detached console window
        if (dev._detachedConsole && isElectron && window.electronRelay.detachedPanelData) {
            window.electronRelay.detachedPanelData('console', dev.index, { text, cls: cls || 'line-rx' });
        }
    }

    // --- Bookmarks -----------------------------------------------------------

    function addBookmarkHandler(lineEl, dev) {
        lineEl.addEventListener('dblclick', (e) => {
            e.preventDefault();
            if (lineEl.classList.contains('line-bookmarked')) {
                lineEl.classList.remove('line-bookmarked');
                const ann = lineEl.querySelector('.bookmark-annotation');
                if (ann) ann.remove();
            } else {
                lineEl.classList.add('line-bookmarked');
                const note = prompt(t('prompt.annotationOpt'));
                if (note) {
                    const ann = document.createElement('span');
                    ann.className = 'bookmark-annotation';
                    ann.textContent = ' 📌 ' + note;
                    ann.title = note;
                    lineEl.appendChild(ann);
                }
            }
        });
    }

    function navigateBookmarks(dev, direction) {
        const all = dev.els.console.querySelectorAll('.line-bookmarked');
        if (all.length === 0) { showToast(t('toast.noBookmark'), 'info', 1500); return; }
        const arr = Array.from(all);
        const consoleEl = dev.els.console;
        const scrollTop = consoleEl.scrollTop;
        const consoleH = consoleEl.clientHeight;
        const center = scrollTop + consoleH / 2;

        let target;
        if (direction > 0) {
            target = arr.find(el => el.offsetTop > center + 10) || arr[0];
        } else {
            target = [...arr].reverse().find(el => el.offsetTop < center - 10) || arr[arr.length - 1];
        }
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.style.outline = '2px solid var(--accent)';
        setTimeout(() => { target.style.outline = ''; }, 1500);
    }

    // --- Export & Recording --------------------------------------------------

    function downloadFile(filename, content, mime) {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    function exportSessionHTML() {
        const now = new Date().toLocaleString('fr-FR');
        let devSections = '';
        for (const dev of devices) {
            if (dev.consoleData.length === 0) continue;
            const lines = dev.consoleData.map(e => {
                const cls = e.cls === 'line-tx' ? 'color:#4a9eff;' : e.cls === 'line-err' ? 'color:#f87171;' : '';
                const escaped = e.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                return `<div style="${cls}"><span style="color:#6b7280;font-size:10px;">[${e.ts}]</span> ${escaped}</div>`;
            }).join('');

            // Plotter data as CSV table
            let plotterTable = '';
            if (dev.plotter && dev.plotter.channels && dev.plotter.channels.length > 0) {
                const chs = dev.plotter.channels;
                const maxLen = Math.max(...chs.map(c => c.data.length));
                plotterTable = '<h3>Données traceur</h3><table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:11px;max-height:400px;overflow:auto;display:block;">';
                plotterTable += '<tr>' + chs.map((c, i) => `<th style="background:#222;color:${c.color};">C${i + 1} (${c.name || ''})</th>`).join('') + '</tr>';
                for (let r = 0; r < Math.min(maxLen, 500); r++) {
                    plotterTable += '<tr>' + chs.map(c => `<td>${r < c.data.length ? c.data[r] : ''}</td>`).join('') + '</tr>';
                }
                if (maxLen > 500) plotterTable += `<tr><td colspan="${chs.length}" style="color:#888;text-align:center;">... ${maxLen - 500} lignes supplémentaires tronquées</td></tr>`;
                plotterTable += '</table>';
            }

            // Live table data
            let liveTableHTML = '';
            if (dev.liveTable.rows.length > 0) {
                liveTableHTML = '<h3>Tableau de données</h3><table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:11px;">';
                liveTableHTML += '<tr>' + dev.liveTable.headers.map(h => `<th style="background:#222;">${h}</th>`).join('') + '</tr>';
                for (const row of dev.liveTable.rows) {
                    liveTableHTML += '<tr>' + row.map(v => `<td>${v}</td>`).join('') + '</tr>';
                }
                liveTableHTML += '</table>';
            }

            devSections += `<div style="margin-bottom:24px;">
                <h2 style="color:#4a9eff;">Device ${dev.index + 1}</h2>
                <div style="background:#1a1d23;padding:10px;border-radius:6px;font-family:Consolas,monospace;font-size:12px;max-height:600px;overflow:auto;line-height:1.5;">
                    ${lines}
                </div>
                ${plotterTable}
                ${liveTableHTML}
            </div>`;
        }

        const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>ESP32 Session — ${now}</title>
<style>
body{background:#111;color:#e5e7eb;font-family:system-ui,sans-serif;padding:20px;margin:0;}
h1{color:#4a9eff;border-bottom:2px solid #4a9eff;padding-bottom:8px;}
h2{border-bottom:1px solid #333;padding-bottom:4px;}
table{margin:8px 0;}th,td{text-align:left;color:#e5e7eb;}
.meta{color:#6b7280;font-size:12px;margin-bottom:16px;}
</style></head><body>
<h1>ESP32 Web Tester — Session Export</h1>
<div class="meta">Exporté le ${now} — ${devices.length} device(s)</div>
${devSections}
</body></html>`;

        downloadFile(`session_${dateTag()}.html`, html, 'text/html');
        showToast(t('toast.sessionExported'), 'success');
    }

    function deviceLabel(dev) {
        return `device${dev.index + 1}`;
    }

    function exportTxt(dev) {
        const lines = dev.consoleData.map(e => `[${e.ts}] [${e.cls}] ${e.text}`);
        downloadFile(`${deviceLabel(dev)}_${dateTag()}.txt`, lines.join('\n'), 'text/plain');
    }

    function exportCsv(dev) {
        let csv = 'timestamp,time_ms,type,message\n';
        for (const e of dev.consoleData) {
            const escaped = e.text.replace(/"/g, '""');
            csv += `${e.ts},${e.time},${e.cls},"${escaped}"\n`;
        }
        downloadFile(`${deviceLabel(dev)}_${dateTag()}.csv`, csv, 'text/csv');
    }

    function exportJson(dev) {
        const data = {
            device: dev.index + 1,
            exportDate: new Date().toISOString(),
            entries: dev.consoleData,
        };
        downloadFile(`${deviceLabel(dev)}_${dateTag()}.json`, JSON.stringify(data, null, 2), 'application/json');
    }

    function dateTag() {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
    }

    // --- Recording -----------------------------------------------------------

    function toggleRecord(dev) {
        dev.recording = !dev.recording;
        const btn = dev.els.btnRecord;
        if (dev.recording) {
            dev.recordStart = Date.now();
            dev.recordData = [];
            btn.classList.add('btn-record-active');
            btn.textContent = '■ Stop';
            appendLine(dev, 'Enregistrement démarré', 'line-info');
        } else {
            btn.classList.remove('btn-record-active');
            btn.textContent = '● Rec';
            const duration = ((Date.now() - dev.recordStart) / 1000).toFixed(1);
            appendLine(dev, `Enregistrement arrêté (${dev.recordData.length} entrées, ${duration}s)`, 'line-info');
            // Auto-download the recording
            const session = {
                device: dev.index + 1,
                recordDate: new Date().toISOString(),
                duration: Date.now() - dev.recordStart,
                entries: dev.recordData,
            };
            downloadFile(`${deviceLabel(dev)}_rec_${dateTag()}.json`, JSON.stringify(session, null, 2), 'application/json');
            dev.recordData = [];
        }
    }

    // Hook recording into appendLine — called after each append
    function recordEntry(dev, text, cls) {
        if (!dev.recording) return;
        dev.recordData.push({
            t: Date.now() - dev.recordStart,
            text,
            cls: cls || 'line-rx',
        });
    }

    // --- Session Replay ------------------------------------------------------

    function importAndReplay(dev) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', () => {
            const file = input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const session = JSON.parse(reader.result);
                    if (!session.entries || !Array.isArray(session.entries)) {
                        appendLine(dev, 'Fichier invalide : pas d\'entrées trouvées', 'line-err');
                        return;
                    }
                    startReplay(dev, session);
                } catch (e) {
                    appendLine(dev, 'Erreur parsing JSON : ' + e.message, 'line-err');
                }
            };
            reader.readAsText(file);
        });
        input.click();
    }

    function startReplay(dev, session) {
        const entries = session.entries;
        if (entries.length === 0) return;

        // Clear console for replay
        dev.els.console.innerHTML = '';
        dev.consoleData = [];
        dev.lineCount = 0;
        dev.rxBytes = 0;
        dev.els.rxLineCount.textContent = '0 lignes';

        const totalDuration = entries[entries.length - 1].t || 0;
        appendLine(dev, `Replay : ${entries.length} entrées, ${(totalDuration/1000).toFixed(1)}s`, 'line-info');

        // Create replay progress bar
        const bar = document.createElement('div');
        bar.className = 'replay-bar';
        bar.innerHTML = `<span>▶ Replay</span><progress value="0" max="${entries.length}"></progress><span class="replay-counter">0/${entries.length}</span><button class="btn btn-small btn-replay-stop">Stop</button>`;
        dev.els.console.parentElement.insertBefore(bar, dev.els.console);

        const progress = bar.querySelector('progress');
        const counter = bar.querySelector('.replay-counter');
        let idx = 0;
        let stopped = false;

        bar.querySelector('.btn-replay-stop').addEventListener('click', () => {
            stopped = true;
            bar.remove();
            appendLine(dev, `Replay arrêté à ${idx}/${entries.length}`, 'line-info');
        });

        function playNext() {
            if (stopped || idx >= entries.length) {
                if (!stopped) {
                    bar.remove();
                    appendLine(dev, 'Replay terminé', 'line-info');
                }
                return;
            }
            const entry = entries[idx];
            appendLine(dev, entry.text, entry.cls);
            if (entry.cls === 'line-rx' || entry.cls === 'line-bridge') {
                feedPlotter(dev, entry.text);
            }
            idx++;
            progress.value = idx;
            counter.textContent = `${idx}/${entries.length}`;

            if (idx < entries.length) {
                const delay = entries[idx].t - entry.t;
                setTimeout(playNext, Math.max(0, delay));
            } else {
                setTimeout(playNext, 0);
            }
        }

        // Start with the first entry's delay (usually 0)
        setTimeout(playNext, 0);
    }

    // --- Filtering -----------------------------------------------------------

    function applyFilterToLine(dev, lineEl) {
        const filterText = dev.els.filterInput.value.trim();
        if (!filterText) {
            lineEl.classList.remove('line-filtered');
            return;
        }
        try {
            const re = new RegExp(filterText, 'i');
            const raw = lineEl.dataset.raw || lineEl.textContent;
            const matches = re.test(raw);
            const invert = dev.els.chkFilterInvert.checked;
            if (invert ? matches : !matches) {
                lineEl.classList.add('line-filtered');
            } else {
                lineEl.classList.remove('line-filtered');
            }
        } catch (e) {
            // Invalid regex, ignore
        }
    }

    function reapplyFilter(dev) {
        const lines = dev.els.console.querySelectorAll('div');
        let visible = 0, total = 0;
        for (const line of lines) {
            total++;
            applyFilterToLine(dev, line);
            if (!line.classList.contains('line-filtered')) visible++;
        }
        const filterText = dev.els.filterInput.value.trim();
        dev.els.filterCount.textContent = filterText ? `${visible}/${total}` : '';
    }

    // --- Device Control: GPIO --------------------------------------------------

    function addGpioPin(dev) {
        const label = prompt(t('prompt.pinName'));
        if (!label) return;
        const pin = prompt(t('prompt.gpioNum'), '2');
        if (pin === null) return;
        const mode = prompt(t('prompt.gpioMode'), '1');
        const modeLabel = mode === '2' ? 'PWM' : 'Output';
        const cmdOn = prompt(t('prompt.cmdOn'), `GPIO ${pin} HIGH`);
        if (cmdOn === null) return;
        const cmdOff = prompt(t('prompt.cmdOff'), `GPIO ${pin} LOW`);
        if (cmdOff === null) return;

        const gpioPin = { label, pin, mode: modeLabel, cmdOn, cmdOff, state: false };
        dev.gpioPins.push(gpioPin);
        renderGpioPin(dev, gpioPin);
        saveDeviceMacros(dev);
    }

    function renderGpioPin(dev, gpioPin) {
        const row = document.createElement('div');
        row.className = 'gpio-pin-row';

        const lblSpan = document.createElement('span');
        lblSpan.className = 'gpio-pin-label';
        lblSpan.textContent = gpioPin.label;

        const pinSpan = document.createElement('span');
        pinSpan.className = 'gpio-pin-num';
        pinSpan.textContent = 'GPIO ' + gpioPin.pin;

        const modeSpan = document.createElement('span');
        modeSpan.className = 'gpio-pin-mode';
        modeSpan.textContent = gpioPin.mode;

        const stateWrap = document.createElement('span');
        stateWrap.className = 'gpio-pin-state';

        const stateLabel = document.createElement('span');
        stateLabel.className = 'gpio-state-label off';
        stateLabel.textContent = 'OFF';

        const toggle = document.createElement('button');
        toggle.className = 'gpio-toggle';
        toggle.addEventListener('click', () => {
            if (!isActive(dev)) { appendLine(dev, 'Device non connecté.', 'line-error'); return; }
            gpioPin.state = !gpioPin.state;
            toggle.classList.toggle('on', gpioPin.state);
            stateLabel.textContent = gpioPin.state ? 'ON' : 'OFF';
            stateLabel.className = 'gpio-state-label ' + (gpioPin.state ? 'on' : 'off');
            sendRawCommand(dev, gpioPin.state ? gpioPin.cmdOn : gpioPin.cmdOff);
        });

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-small btn-danger';
        btnDel.textContent = '×';
        btnDel.addEventListener('click', () => {
            dev.gpioPins = dev.gpioPins.filter(p => p !== gpioPin);
            row.remove();
            saveDeviceMacros(dev);
        });

        stateWrap.appendChild(stateLabel);
        stateWrap.appendChild(toggle);
        stateWrap.appendChild(btnDel);

        row.appendChild(lblSpan);
        row.appendChild(pinSpan);
        row.appendChild(modeSpan);
        row.appendChild(stateWrap);
        dev.els.gpioPins.appendChild(row);
    }

    // --- Device Control: Dashboard ---------------------------------------------

    function addDashVar(dev) {
        const name = prompt(t('prompt.varName'));
        if (!name) return;
        const regexStr = prompt(t('prompt.varRegex'), `${name}\\s*[:=]\\s*([\\d.]+)`);
        if (!regexStr) return;
        const unit = prompt(t('prompt.varUnit'), '');
        const minStr = prompt(t('prompt.varMin'), '0');
        const maxStr = prompt(t('prompt.varMax'), '100');

        const dashVar = {
            name,
            regex: new RegExp(regexStr, 'i'),
            unit: unit || '',
            min: parseFloat(minStr) || 0,
            max: parseFloat(maxStr) || 100,
            value: null,
        };
        dev.dashVars.push(dashVar);
        renderDashVar(dev, dashVar);
        saveDeviceMacros(dev);
    }

    function renderDashVar(dev, dv) {
        const row = document.createElement('div');
        row.className = 'dash-var-row';
        dv._el = row;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'dash-var-name';
        nameSpan.textContent = dv.name;

        const barWrap = document.createElement('div');
        barWrap.className = 'dash-var-bar-wrap';
        const bar = document.createElement('div');
        bar.className = 'dash-var-bar';
        barWrap.appendChild(bar);
        dv._bar = bar;

        const valSpan = document.createElement('span');
        valSpan.className = 'dash-var-value';
        valSpan.textContent = '—';
        dv._valSpan = valSpan;

        const unitSpan = document.createElement('span');
        unitSpan.className = 'dash-var-unit';
        unitSpan.textContent = dv.unit;

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-small btn-danger';
        btnDel.textContent = '×';
        btnDel.addEventListener('click', () => {
            dev.dashVars = dev.dashVars.filter(v => v !== dv);
            row.remove();
            saveDeviceMacros(dev);
        });

        row.appendChild(nameSpan);
        row.appendChild(barWrap);
        row.appendChild(valSpan);
        row.appendChild(unitSpan);
        row.appendChild(btnDel);
        dev.els.dashVars.appendChild(row);
    }

    function updateDashboard(dev, text) {
        for (const dv of dev.dashVars) {
            dv.regex.lastIndex = 0;
            const m = dv.regex.exec(text);
            if (m && m[1] !== undefined) {
                const val = parseFloat(m[1]);
                if (isNaN(val)) continue;
                dv.value = val;
                dv._valSpan.textContent = val.toFixed(2);
                const pct = Math.max(0, Math.min(100, ((val - dv.min) / (dv.max - dv.min)) * 100));
                dv._bar.style.width = pct + '%';
            }
        }
    }

    // --- Device Control: File Upload -------------------------------------------

    function uploadFile(dev) {
        if (!isActive(dev)) { appendLine(dev, 'Device non connecté.', 'line-error'); return; }
        const protocol = dev.els.uploadProtocol.value;
        const input = document.createElement('input');
        input.type = 'file';
        input.addEventListener('change', async () => {
            const file = input.files[0];
            if (!file) return;
            dev.els.uploadStatus.textContent = `Envoi de ${file.name} (${file.size} octets) via ${protocol}...`;
            appendLine(dev, `Upload: ${file.name} (${file.size} B) — ${protocol}`, 'line-info');

            try {
                if (protocol === 'raw') {
                    const text = await file.text();
                    const lines = text.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        if (!isActive(dev)) break;
                        sendRawCommand(dev, lines[i]);
                        dev.els.uploadStatus.textContent = `Envoi ligne ${i + 1}/${lines.length}...`;
                        await new Promise(r => setTimeout(r, 20));
                    }
                } else if (protocol === 'base64') {
                    const buf = await file.arrayBuffer();
                    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
                    const chunkSize = 76;
                    const chunks = Math.ceil(b64.length / chunkSize);
                    for (let i = 0; i < chunks; i++) {
                        if (!isActive(dev)) break;
                        sendRawCommand(dev, b64.slice(i * chunkSize, (i + 1) * chunkSize));
                        dev.els.uploadStatus.textContent = `Envoi chunk ${i + 1}/${chunks}...`;
                        await new Promise(r => setTimeout(r, 20));
                    }
                } else if (protocol === 'xmodem') {
                    const buf = await file.arrayBuffer();
                    await xmodemSend(dev, new Uint8Array(buf));
                }
                dev.els.uploadStatus.textContent = `${file.name} envoyé.`;
                appendLine(dev, `Upload terminé: ${file.name}`, 'line-info');
            } catch (err) {
                dev.els.uploadStatus.textContent = `Erreur: ${err.message}`;
                appendLine(dev, `Upload erreur: ${err.message}`, 'line-error');
            }
        });
        input.click();
    }

    async function xmodemSend(dev, data) {
        const SOH = 0x01, EOT = 0x04, ACK = 0x06, NAK = 0x15;
        const blockSize = 128;
        let blockNum = 1;
        for (let offset = 0; offset < data.length; offset += blockSize) {
            const block = new Uint8Array(blockSize);
            block.set(data.slice(offset, offset + blockSize));
            let checksum = 0;
            for (let i = 0; i < blockSize; i++) checksum = (checksum + block[i]) & 0xFF;
            const packet = new Uint8Array(3 + blockSize + 1);
            packet[0] = SOH;
            packet[1] = blockNum & 0xFF;
            packet[2] = 0xFF - (blockNum & 0xFF);
            packet.set(block, 3);
            packet[3 + blockSize] = checksum;
            if (dev.writer) {
                await dev.writer.write(packet);
            }
            dev.els.uploadStatus.textContent = `XModem block ${blockNum}...`;
            blockNum++;
            await new Promise(r => setTimeout(r, 100));
        }
        if (dev.writer) {
            await dev.writer.write(new Uint8Array([EOT]));
        }
    }

    // --- Macros: Quick Commands -----------------------------------------------

    function addQuickCommand(dev) {
        const label = prompt(t('prompt.macroName'));
        if (!label) return;
        const cmd = prompt(t('prompt.macroCmd'));
        if (cmd === null) return;

        const macro = { label, cmd };
        dev.macros.push(macro);
        renderQuickCommand(dev, macro);
        saveDeviceMacros(dev);
    }

    function renderQuickCommand(dev, macro) {
        const el = document.createElement('div');
        el.className = 'macro-cmd';

        const lblSpan = document.createElement('span');
        lblSpan.className = 'macro-cmd-label';
        lblSpan.textContent = macro.label;
        lblSpan.title = macro.cmd;

        const btnRun = document.createElement('button');
        btnRun.className = 'btn btn-small btn-primary';
        btnRun.textContent = '▶';
        btnRun.title = 'Exécuter une fois';
        btnRun.addEventListener('click', () => {
            if (!isActive(dev)) { appendLine(dev, 'Device non connecté — connectez ou simulez d\'abord.', 'line-error'); return; }
            sendRawCommand(dev, macro.cmd);
        });

        // Loop button
        const btnLoop = document.createElement('button');
        btnLoop.className = 'btn btn-small btn-warning macro-loop-btn';
        btnLoop.textContent = '⟳';
        btnLoop.title = 'Boucle';
        btnLoop.addEventListener('click', () => {
            if (macro._loopId) {
                clearInterval(macro._loopId);
                macro._loopId = null;
                btnLoop.classList.remove('macro-loop-active');
                btnLoop.textContent = '⟳';
                appendLine(dev, `Boucle "${macro.label}" arrêtée`, 'line-info');
            } else {
                if (!isActive(dev)) { appendLine(dev, 'Device non connecté — connectez ou simulez d\'abord.', 'line-error'); return; }
                const ms = parseInt(prompt(t('prompt.repeatInterval'), '500'), 10);
                if (!ms || ms < 10) return;
                macro._loopId = setInterval(() => {
                    if (!isActive(dev)) { clearInterval(macro._loopId); macro._loopId = null; btnLoop.classList.remove('macro-loop-active'); btnLoop.textContent = '⟳'; return; }
                    sendRawCommand(dev, macro.cmd);
                }, ms);
                btnLoop.classList.add('macro-loop-active');
                btnLoop.textContent = '■';
                appendLine(dev, `Boucle "${macro.label}" toutes les ${ms}ms`, 'line-info');
            }
        });

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-small btn-danger';
        btnDel.textContent = '×';
        btnDel.addEventListener('click', () => {
            if (macro._loopId) clearInterval(macro._loopId);
            dev.macros = dev.macros.filter(m => m !== macro);
            el.remove();
            saveDeviceMacros(dev);
        });
        el.appendChild(lblSpan);
        el.appendChild(btnRun);
        el.appendChild(btnLoop);
        el.appendChild(btnDel);
        dev.els.quickCmds.appendChild(el);
    }

    function sendRawCommand(dev, cmd) {
        if (!dev.writer) return;
        const type = dev.connectionType || 'serial';
        if (type === 'mqtt') {
            const topic = dev.els.mqttPubTopic ? dev.els.mqttPubTopic.value.trim() : '';
            serialWrite(dev, cmd);
            appendLine(dev, `PUB [${topic}] ${cmd}`, 'line-tx');
        } else {
            const ending = getLineEnding(dev);
            serialWrite(dev, cmd + ending);
            appendLine(dev, cmd, 'line-tx');
        }
    }

    // --- Macros: Sequences ----------------------------------------------------

    function addSequence(dev) {
        const name = prompt(t('prompt.seqName'));
        if (!name) return;

        const seq = { name, steps: [], running: false, abortFlag: false, el: null, _dev: dev };
        dev.sequences.push(seq);
        renderSequence(dev, seq);
        saveDeviceMacros(dev);
    }

    function renderSequence(dev, seq) {
        const el = document.createElement('div');
        el.className = 'macro-sequence';
        seq.el = el;

        const header = document.createElement('div');
        header.className = 'macro-sequence-header';
        header.innerHTML = `<span class="macro-seq-name">${escapeHtml(seq.name)}</span>`;

        const btnAddStep = document.createElement('button');
        btnAddStep.className = 'btn btn-small';
        btnAddStep.textContent = '+ Étape';
        btnAddStep.addEventListener('click', () => addSequenceStep(dev, seq));

        const btnPlay = document.createElement('button');
        btnPlay.className = 'btn btn-small btn-success btn-seq-play';
        btnPlay.textContent = '▶';
        btnPlay.addEventListener('click', () => runSequence(dev, seq, false));

        const btnLoop = document.createElement('button');
        btnLoop.className = 'btn btn-small btn-warning btn-seq-loop';
        btnLoop.textContent = '⟳';
        btnLoop.title = 'Boucle';
        btnLoop.addEventListener('click', () => runSequence(dev, seq, true));

        const btnStop = document.createElement('button');
        btnStop.className = 'btn btn-small btn-danger btn-seq-stop';
        btnStop.textContent = '■';
        btnStop.disabled = true;
        btnStop.addEventListener('click', () => { seq.abortFlag = true; });

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-small btn-danger';
        btnDel.textContent = '×';
        btnDel.addEventListener('click', () => {
            seq.abortFlag = true;
            dev.sequences = dev.sequences.filter(s => s !== seq);
            el.remove();
            saveDeviceMacros(dev);
        });

        seq._btnPlay = btnPlay;
        seq._btnStop = btnStop;

        header.appendChild(btnAddStep);
        header.appendChild(btnPlay);
        header.appendChild(btnLoop);
        header.appendChild(btnStop);
        header.appendChild(btnDel);
        el.appendChild(header);

        const stepsContainer = document.createElement('div');
        stepsContainer.className = 'macro-seq-steps';
        el.appendChild(stepsContainer);
        seq._stepsContainer = stepsContainer;

        dev.els.sequences.appendChild(el);
    }

    function addSequenceStep(dev, seq) {
        const cmd = prompt(t('prompt.seqCmd'));
        if (cmd === null) return;
        const delayStr = prompt(t('prompt.seqDelay'), '500');
        const delay = parseInt(delayStr, 10) || 0;

        const step = { cmd, delay };
        seq.steps.push(step);
        renderSequenceStep(seq, step);
        saveDeviceMacros(dev);
    }

    function renderSequenceStep(seq, step) {
        const el = document.createElement('div');
        el.className = 'macro-seq-step';
        step._el = el;

        // Drag handle — only this element triggers drag
        const grip = document.createElement('span');
        grip.className = 'step-grip';
        grip.textContent = '☰';
        grip.addEventListener('mousedown', () => { el.draggable = true; });
        el.addEventListener('dragend', () => { el.draggable = false; });

        const cmdInput = document.createElement('input');
        cmdInput.type = 'text';
        cmdInput.className = 'step-cmd-input';
        cmdInput.value = step.cmd;
        cmdInput.title = 'Commande';
        cmdInput.addEventListener('change', () => {
            step.cmd = cmdInput.value;
            if (seq._dev) saveDeviceMacros(seq._dev);
        });

        const delayInput = document.createElement('input');
        delayInput.type = 'number';
        delayInput.className = 'step-delay-input';
        delayInput.value = step.delay;
        delayInput.min = '0';
        delayInput.title = 'Délai (ms)';
        delayInput.addEventListener('change', () => {
            step.delay = parseInt(delayInput.value, 10) || 0;
            if (seq._dev) saveDeviceMacros(seq._dev);
        });
        const delayLabel = document.createElement('span');
        delayLabel.className = 'step-delay-label';
        delayLabel.textContent = 'ms';

        const btnUp = document.createElement('button');
        btnUp.className = 'btn btn-small btn-secondary step-move-btn';
        btnUp.textContent = '↑';
        btnUp.title = 'Monter';
        btnUp.addEventListener('click', () => moveStep(seq, step, -1));

        const btnDown = document.createElement('button');
        btnDown.className = 'btn btn-small btn-secondary step-move-btn';
        btnDown.textContent = '↓';
        btnDown.title = 'Descendre';
        btnDown.addEventListener('click', () => moveStep(seq, step, 1));

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-small btn-danger';
        btnDel.textContent = '×';
        btnDel.addEventListener('click', () => {
            seq.steps = seq.steps.filter(s => s !== step);
            el.remove();
            if (seq._dev) saveDeviceMacros(seq._dev);
        });

        // Drag & drop events
        el.addEventListener('dragstart', e => {
            el.classList.add('step-dragging');
            e.dataTransfer.effectAllowed = 'move';
            seq._dragStep = step;
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('step-dragging');
            seq._dragStep = null;
            seq._stepsContainer.querySelectorAll('.step-drag-over').forEach(
                n => n.classList.remove('step-drag-over')
            );
        });
        el.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (seq._dragStep && seq._dragStep !== step) {
                el.classList.add('step-drag-over');
            }
        });
        el.addEventListener('dragleave', () => {
            el.classList.remove('step-drag-over');
        });
        el.addEventListener('drop', e => {
            e.preventDefault();
            el.classList.remove('step-drag-over');
            if (!seq._dragStep || seq._dragStep === step) return;
            const fromIdx = seq.steps.indexOf(seq._dragStep);
            const toIdx = seq.steps.indexOf(step);
            // Reorder array
            seq.steps.splice(fromIdx, 1);
            seq.steps.splice(toIdx, 0, seq._dragStep);
            // Reorder DOM
            const container = seq._stepsContainer;
            const draggedEl = seq._dragStep._el;
            if (fromIdx < toIdx) {
                container.insertBefore(draggedEl, el.nextSibling);
            } else {
                container.insertBefore(draggedEl, el);
            }
            if (seq._dev) saveDeviceMacros(seq._dev);
        });

        el.appendChild(grip);
        el.appendChild(cmdInput);
        el.appendChild(delayInput);
        el.appendChild(delayLabel);
        el.appendChild(btnUp);
        el.appendChild(btnDown);
        el.appendChild(btnDel);
        seq._stepsContainer.appendChild(el);
    }

    function moveStep(seq, step, direction) {
        const idx = seq.steps.indexOf(step);
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= seq.steps.length) return;
        seq.steps[idx] = seq.steps[newIdx];
        seq.steps[newIdx] = step;
        const container = seq._stepsContainer;
        const children = Array.from(container.children);
        const elA = children[idx];
        const elB = children[newIdx];
        if (direction === -1) {
            container.insertBefore(elA, elB);
        } else {
            container.insertBefore(elB, elA);
        }
        if (seq._dev) saveDeviceMacros(seq._dev);
    }

    async function runSequence(dev, seq, loop) {
        if (seq.running || !isActive(dev)) return;
        seq.running = true;
        seq.abortFlag = false;
        seq._btnPlay.disabled = true;
        seq._btnStop.disabled = false;

        let iteration = 0;
        do {
            iteration++;
            if (loop && iteration > 1) {
                appendLine(dev, `Séquence "${seq.name}" — itération ${iteration}`, 'line-info');
            }
            for (let i = 0; i < seq.steps.length; i++) {
                if (seq.abortFlag || !isActive(dev)) break;
                const step = seq.steps[i];
                if (step._el) step._el.classList.add('step-active');
                sendRawCommand(dev, step.cmd);
                if (step.delay > 0) {
                    await new Promise(r => setTimeout(r, step.delay));
                }
                if (step._el) step._el.classList.remove('step-active');
            }
        } while (loop && !seq.abortFlag && isActive(dev));

        seq.running = false;
        seq._btnPlay.disabled = false;
        seq._btnStop.disabled = true;
        for (const step of seq.steps) {
            if (step._el) step._el.classList.remove('step-active');
        }
        if (loop) appendLine(dev, `Boucle séquence "${seq.name}" arrêtée (${iteration} itérations)`, 'line-info');
    }

    // --- Macros: Triggers (UI-connected) --------------------------------------

    function addTriggerUI(dev) {
        const pattern = prompt(t('prompt.triggerPattern'));
        if (!pattern) return;

        // Validate regex
        try { new RegExp(pattern, 'i'); } catch (e) {
            alert('Regex invalide : ' + e.message);
            return;
        }

        const actionStr = prompt(t('prompt.triggerAction'), '1');
        const actionMap = { '1': 'sound', '2': 'notify', '3': 'highlight', '4': 'alarm', '5': 'success', '6': 'banner', '7': 'sendcmd', '8': 'webhook' };
        const action = actionMap[actionStr] || 'sound';

        let triggerCmd = '';
        if (action === 'sendcmd') {
            triggerCmd = prompt(t('prompt.triggerCmd')) || '';
        }
        let webhookUrl = '';
        if (action === 'webhook') {
            webhookUrl = prompt(t('prompt.webhookUrl')) || '';
            if (!webhookUrl) return;
        }

        // Request notification permission if needed
        if (action === 'notify' && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        const trigger = { pattern, action, active: true, cmd: triggerCmd, webhookUrl, hitCount: 0 };
        dev.triggers.push(trigger);
        renderTrigger(dev, trigger);
        saveDeviceMacros(dev);
    }

    function renderTrigger(dev, trigger) {
        const el = document.createElement('div');
        el.className = 'macro-trigger';
        trigger._el = el;

        const patternSpan = document.createElement('span');
        patternSpan.className = 'trigger-pattern';
        patternSpan.textContent = '/' + trigger.pattern + '/';

        const actionLabels = { sound: 'Beep', notify: 'Notif', highlight: 'Flash', alarm: 'Alarme', success: 'Succès', banner: 'Bannière', sendcmd: 'Cmd', webhook: 'Webhook' };
        const actionSpan = document.createElement('span');
        actionSpan.className = 'trigger-action';
        actionSpan.textContent = actionLabels[trigger.action] || trigger.action;
        if (trigger.cmd) actionSpan.title = 'Cmd: ' + trigger.cmd;

        const hitSpan = document.createElement('span');
        hitSpan.className = 'trigger-hit-count';
        hitSpan.textContent = trigger.hitCount || 0;
        hitSpan.title = 'Nombre de déclenchements';
        trigger._hitSpan = hitSpan;

        const btnToggle = document.createElement('button');
        btnToggle.className = 'btn btn-small ' + (trigger.active ? 'btn-success' : 'btn-secondary');
        btnToggle.textContent = trigger.active ? 'ON' : 'OFF';
        btnToggle.addEventListener('click', () => {
            trigger.active = !trigger.active;
            btnToggle.textContent = trigger.active ? 'ON' : 'OFF';
            btnToggle.className = 'btn btn-small ' + (trigger.active ? 'btn-success' : 'btn-secondary');
            saveDeviceMacros(dev);
        });

        const btnDel = document.createElement('button');
        btnDel.className = 'btn btn-small btn-danger';
        btnDel.textContent = '×';
        btnDel.addEventListener('click', () => {
            dev.triggers = dev.triggers.filter(t => t !== trigger);
            el.remove();
            saveDeviceMacros(dev);
        });

        el.appendChild(patternSpan);
        el.appendChild(actionSpan);
        el.appendChild(hitSpan);
        el.appendChild(btnToggle);
        el.appendChild(btnDel);
        dev.els.triggersContainer.appendChild(el);
    }

    // --- Triggers (pattern matching on RX) ------------------------------------

    function checkTriggers(dev, text) {
        if (!dev.triggers) return;
        for (const trigger of dev.triggers) {
            if (!trigger.active) continue;
            try {
                if (new RegExp(trigger.pattern, 'i').test(text)) {
                    // Update hit count
                    trigger.hitCount = (trigger.hitCount || 0) + 1;
                    if (trigger._hitSpan) trigger._hitSpan.textContent = trigger.hitCount;

                    if (trigger.action === 'sound') {
                        playBeep(800, 0.15);
                    } else if (trigger.action === 'alarm') {
                        playBeep(1200, 0.1);
                        setTimeout(() => playBeep(900, 0.1), 150);
                        setTimeout(() => playBeep(1200, 0.1), 300);
                    } else if (trigger.action === 'success') {
                        playBeep(523, 0.1);
                        setTimeout(() => playBeep(659, 0.1), 120);
                        setTimeout(() => playBeep(784, 0.15), 240);
                    } else if (trigger.action === 'notify') {
                        if (Notification.permission === 'granted') {
                            new Notification(`ESP32 Device ${dev.index + 1}`, {
                                body: `Trigger /${trigger.pattern}/ : ${text.substring(0, 120)}`,
                                tag: `esp32-trigger-${dev.index}-${trigger.pattern}`,
                            });
                        }
                        incrementAlertBadge();
                    } else if (trigger.action === 'highlight') {
                        if (trigger._el) {
                            trigger._el.classList.add('macro-trigger-flash');
                            setTimeout(() => trigger._el.classList.remove('macro-trigger-flash'), 600);
                        }
                    } else if (trigger.action === 'banner') {
                        showAlertBanner(dev, trigger.pattern, text);
                    } else if (trigger.action === 'sendcmd') {
                        if (trigger.cmd) {
                            sendRawCommand(dev, trigger.cmd);
                        }
                    } else if (trigger.action === 'webhook') {
                        if (trigger.webhookUrl) {
                            fireWebhook(dev, trigger, text);
                        }
                    }
                }
            } catch (e) { /* invalid regex */ }
        }
    }

    // --- Alert badge (sidebar notification counter) ---
    let _alertBadgeCount = 0;
    let _alertBadgeEl = null;

    function getAlertBadgeEl() {
        if (_alertBadgeEl) return _alertBadgeEl;
        const sidebar = document.getElementById('viewSidebar');
        if (!sidebar) return null;
        const badge = document.createElement('span');
        badge.className = 'sidebar-alert-badge';
        badge.style.display = 'none';
        badge.textContent = '0';
        // Insert after the last sidebar-toggle
        const lastToggle = sidebar.querySelector('.sidebar-spacer');
        if (lastToggle) sidebar.insertBefore(badge, lastToggle);
        _alertBadgeEl = badge;
        // Click to reset
        badge.addEventListener('click', () => {
            _alertBadgeCount = 0;
            badge.textContent = '0';
            badge.style.display = 'none';
        });
        return badge;
    }

    function incrementAlertBadge() {
        const badge = getAlertBadgeEl();
        if (!badge) return;
        _alertBadgeCount++;
        badge.textContent = _alertBadgeCount;
        badge.style.display = '';
        badge.classList.add('badge-pulse');
        setTimeout(() => badge.classList.remove('badge-pulse'), 500);
    }

    // --- Alert banner (temporary top banner) ---
    function showAlertBanner(dev, pattern, text) {
        let container = document.getElementById('alertBannerContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'alertBannerContainer';
            container.className = 'alert-banner-container';
            document.body.appendChild(container);
        }
        const banner = document.createElement('div');
        banner.className = 'alert-banner';
        banner.innerHTML = `<span class="alert-banner-icon">⚠️</span>` +
            `<span class="alert-banner-text"><b>Device ${dev.index + 1}</b> — /${pattern}/ → ${text.substring(0, 100).replace(/</g, '&lt;')}</span>` +
            `<button class="alert-banner-close">✕</button>`;
        banner.querySelector('.alert-banner-close').addEventListener('click', () => banner.remove());
        container.appendChild(banner);
        // Auto-dismiss after 8s
        setTimeout(() => { if (banner.parentNode) banner.remove(); }, 8000);
        // Sound
        playBeep(600, 0.08);
    }

    // --- Webhook (HTTP POST on trigger) ---
    function fireWebhook(dev, trigger, text) {
        const url = trigger.webhookUrl;
        const payload = {
            source: 'ESP32 Web Tester',
            device: dev.index + 1,
            trigger: trigger.pattern,
            message: text.substring(0, 500),
            timestamp: new Date().toISOString(),
            hitCount: trigger.hitCount,
        };

        // Detect Slack/Discord format
        let body, contentType;
        if (url.includes('hooks.slack.com')) {
            body = JSON.stringify({ text: `*ESP32 Device ${dev.index + 1}* — Trigger \`${trigger.pattern}\`\n> ${text.substring(0, 300)}` });
            contentType = 'application/json';
        } else if (url.includes('discord.com/api/webhooks')) {
            body = JSON.stringify({ content: `**ESP32 Device ${dev.index + 1}** — Trigger \`${trigger.pattern}\`\n> ${text.substring(0, 300)}` });
            contentType = 'application/json';
        } else {
            body = JSON.stringify(payload);
            contentType = 'application/json';
        }

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body,
        }).then(res => {
            if (!res.ok) console.warn(`Webhook ${url}: HTTP ${res.status}`);
        }).catch(err => {
            console.warn(`Webhook error: ${err.message}`);
        });
    }

    function playBeep(freq, duration) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = freq || 800;
            gain.gain.value = 0.3;
            osc.start();
            osc.stop(ctx.currentTime + (duration || 0.15));
        } catch (e) { /* no audio */ }
    }

    // --- RX frequency & throughput tracking -----------------------------------

    function trackRx(dev) {
        dev.rxTimestamps.push(performance.now());
        const cutoff = performance.now() - 2000;
        while (dev.rxTimestamps.length > 0 && dev.rxTimestamps[0] < cutoff) {
            dev.rxTimestamps.shift();
        }
    }

    function startRxFreqUpdater(dev) {
        if (dev.rxFreqInterval) return;
        dev.rxTimestamps = [];
        dev.rxBytesLast = dev.rxBytes;
        dev.rxFreqInterval = setInterval(() => {
            updateRxFreqDisplay(dev);
            updateThroughput(dev);
        }, 500);
    }

    function stopRxFreqUpdater(dev) {
        if (dev.rxFreqInterval) {
            clearInterval(dev.rxFreqInterval);
            dev.rxFreqInterval = null;
        }
        dev.rxTimestamps = [];
        dev.els.rxFreqDisplay.textContent = '— Hz';
        dev.els.rxFreqDisplay.className = 'rx-freq-display';
        dev.els.rxThroughput.textContent = '0 B/s';
    }

    function updateRxFreqDisplay(dev) {
        const el = dev.els.rxFreqDisplay;
        const now = performance.now();
        const cutoff = now - 2000;
        while (dev.rxTimestamps.length > 0 && dev.rxTimestamps[0] < cutoff) {
            dev.rxTimestamps.shift();
        }
        const count = dev.rxTimestamps.length;
        if (count < 2) {
            el.textContent = count === 0 ? '— Hz' : '< 1 Hz';
            el.className = 'rx-freq-display';
            return;
        }
        const span = (dev.rxTimestamps[count - 1] - dev.rxTimestamps[0]) / 1000;
        const hz = (count - 1) / span;
        const intervals = [];
        for (let i = 1; i < count; i++) {
            intervals.push(dev.rxTimestamps[i] - dev.rxTimestamps[i - 1]);
        }
        const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const stddev = Math.sqrt(intervals.reduce((a, v) => a + (v - mean) ** 2, 0) / intervals.length);
        const cv = mean > 0 ? stddev / mean : 0;
        el.textContent = hz >= 10 ? `${Math.round(hz)} Hz` : `${hz.toFixed(1)} Hz`;
        el.className = 'rx-freq-display ' + (cv > 0.3 ? 'freq-irregular' : 'freq-active');
    }

    function updateThroughput(dev) {
        const delta = dev.rxBytes - dev.rxBytesLast;
        dev.rxBytesLast = dev.rxBytes;
        const bps = delta * 2; // 500ms interval → x2 for per-second
        let txt;
        if (bps >= 1024 * 1024) txt = (bps / 1024 / 1024).toFixed(1) + ' MB/s';
        else if (bps >= 1024) txt = (bps / 1024).toFixed(1) + ' KB/s';
        else txt = bps + ' B/s';
        dev.els.rxThroughput.textContent = txt;
    }

    // --- Command history -----------------------------------------------------

    function historyUp(dev) {
        if (dev.cmdHistory.length === 0) return;
        if (dev.historyIdx < dev.cmdHistory.length - 1) {
            dev.historyIdx++;
        }
        dev.els.serialInput.value = dev.cmdHistory[dev.cmdHistory.length - 1 - dev.historyIdx];
    }

    function historyDown(dev) {
        if (dev.historyIdx > 0) {
            dev.historyIdx--;
            dev.els.serialInput.value = dev.cmdHistory[dev.cmdHistory.length - 1 - dev.historyIdx];
        } else {
            dev.historyIdx = -1;
            dev.els.serialInput.value = '';
        }
    }

    function historyPush(dev, cmd) {
        if (cmd && (dev.cmdHistory.length === 0 || dev.cmdHistory[dev.cmdHistory.length - 1] !== cmd)) {
            dev.cmdHistory.push(cmd);
            if (dev.cmdHistory.length > 200) dev.cmdHistory.shift();
        }
        dev.historyIdx = -1;
        // Persist history
        try { localStorage.setItem('esp32_history_' + dev.index, JSON.stringify(dev.cmdHistory)); } catch (_) {}
    }

    function loadHistory(dev) {
        try {
            const raw = localStorage.getItem('esp32_history_' + dev.index);
            if (raw) dev.cmdHistory = JSON.parse(raw);
        } catch (_) {}
    }

    // =========================================================================
    // setDeviceActive
    // =========================================================================

    function setDeviceActive(dev, active) {
        const type = dev.connectionType || 'serial';

        // Common UI
        dev.els.btnSend.disabled       = !active;
        dev.els.serialInput.disabled   = !active;
        dev.els.repeatInput.disabled   = !active;
        dev.els.btnRepeatStart.disabled = !active;

        // Serial-specific buttons
        if (type === 'serial') {
            dev.els.btnConnect.disabled    = active;
            dev.els.btnDisconnect.disabled = !active && !dev.simulated;
            dev.els.btnSimulate.disabled   = active;
            dev.els.baudRate.disabled      = active;
        }

        // TCP/UDP-specific buttons
        if (type === 'websocket') {
            const relayOk = dev.relayConnected;
            dev.els.btnNetConnect.disabled    = active || !relayOk;
            dev.els.btnNetDisconnect.disabled = !active;
            dev.els.btnNetListen.disabled     = active || !relayOk;
            dev.els.btnNetStop.disabled       = !active;
            dev.els.btnNetUdpBind.disabled    = active || !relayOk;
            dev.els.btnNetUdpClose.disabled   = !active;
        }

        // MQTT-specific buttons
        if (type === 'mqtt') {
            dev.els.btnMqttConnect.disabled    = active;
            dev.els.btnMqttDisconnect.disabled = !active;
            dev.els.btnMqttSub.disabled        = !active;
            dev.els.btnMqttUnsub.disabled      = !active;
        }

        // Status display
        if (dev.simulated) {
            dev.els.status.textContent = 'Simulé';
            dev.els.status.className   = 'device-status status simulated';
            dev.els.btnSimulate.textContent = 'Arrêter simu.';
            dev.els.btnSimulate.disabled = false;
            dev.els.btnConnect.disabled = true;
            dev.els.btnDisconnect.disabled = true;
        } else if (active) {
            const labels = { serial: 'Connecté (Série)', websocket: 'Connecté (TCP/UDP)', mqtt: 'Connecté (MQTT)' };
            dev.els.status.textContent = labels[type] || 'Connecté';
            dev.els.status.className   = 'device-status status connected';
            if (type === 'serial') dev.els.btnSimulate.textContent = 'Simuler';
        } else {
            dev.els.status.textContent = 'Déconnecté';
            dev.els.status.className   = 'device-status status disconnected';
            if (type === 'serial') dev.els.btnSimulate.textContent = 'Simuler';
        }

        if (active) {
            startRxFreqUpdater(dev);
        } else {
            stopRepeat(dev);
            stopRxFreqUpdater(dev);
        }
        updateBridgeStates();
    }

    function simulateRx(dev, message) {
        trackRx(dev);
        appendLine(dev, message, 'line-rx');
        feedPlotter(dev, message);
        bridgeForward(dev, message);
    }

    // =========================================================================
    // Web Serial API check
    // =========================================================================

    const hasWebSerial = ('serial' in navigator);
    if (!hasWebSerial) {
        console.warn('Web Serial API non disponible. Les connexions série ne fonctionneront pas. WebSocket et MQTT restent disponibles.');
    }

    // =========================================================================
    // Device panel creation
    // =========================================================================

    function createDevicePanel(index) {
        const clone = template.content.cloneNode(true);
        const panel = clone.querySelector('.device-panel');
        const plotterSection = clone.querySelector('.device-plotter-section');
        panel.dataset.deviceIndex = index;
        panel.querySelector('.device-num').textContent = index + 1;
        plotterSection.querySelector('.plotter-device-num').textContent = index + 1;

        const els = {
            panel,
            status:         panel.querySelector('.device-status'),
            deviceTitleText: panel.querySelector('.device-title-text'),
            devicePortInfo: panel.querySelector('.device-port-info'),
            // Serial config
            baudRate:       panel.querySelector('.baud-rate'),
            btnConnect:     panel.querySelector('.btn-connect'),
            btnDisconnect:  panel.querySelector('.btn-disconnect'),
            btnSimulate:    panel.querySelector('.btn-simulate'),
            chkAutoReconnect: panel.querySelector('.chk-auto-reconnect'),
            // TCP/UDP config (via relay)
            netRelayUrl:    panel.querySelector('.net-relay-url'),
            btnRelayConnect: panel.querySelector('.btn-relay-connect'),
            relayStatus:    panel.querySelector('.relay-status'),
            netProto:       panel.querySelector('.net-proto'),
            netRole:        panel.querySelector('.net-role'),
            netHost:        panel.querySelector('.net-host'),
            netPort:        panel.querySelector('.net-port'),
            btnNetConnect:  panel.querySelector('.btn-net-connect'),
            btnNetDisconnect: panel.querySelector('.btn-net-disconnect'),
            netListenPort:  panel.querySelector('.net-listen-port'),
            btnNetListen:   panel.querySelector('.btn-net-listen'),
            btnNetStop:     panel.querySelector('.btn-net-stop'),
            netClientsList: panel.querySelector('.net-clients-list'),
            netUdpLocalPort:  panel.querySelector('.net-udp-local-port'),
            netUdpRemoteHost: panel.querySelector('.net-udp-remote-host'),
            netUdpRemotePort: panel.querySelector('.net-udp-remote-port'),
            btnNetUdpBind:  panel.querySelector('.btn-net-udp-bind'),
            btnNetUdpClose: panel.querySelector('.btn-net-udp-close'),
            netRoleConfigs: panel.querySelectorAll('.net-role-config'),
            // MQTT config
            mqttBroker:     panel.querySelector('.mqtt-broker'),
            mqttClientId:   panel.querySelector('.mqtt-client-id'),
            mqttUser:       panel.querySelector('.mqtt-user'),
            mqttPass:       panel.querySelector('.mqtt-pass'),
            btnMqttConnect: panel.querySelector('.btn-mqtt-connect'),
            btnMqttDisconnect: panel.querySelector('.btn-mqtt-disconnect'),
            mqttSubTopic:   panel.querySelector('.mqtt-sub-topic'),
            mqttSubQos:     panel.querySelector('.mqtt-sub-qos'),
            btnMqttSub:     panel.querySelector('.btn-mqtt-sub'),
            btnMqttUnsub:   panel.querySelector('.btn-mqtt-unsub'),
            mqttSubsList:   panel.querySelector('.mqtt-subs-list'),
            mqttPubTopic:   panel.querySelector('.mqtt-pub-topic'),
            mqttPubQos:     panel.querySelector('.mqtt-pub-qos'),
            mqttPubRetain:  panel.querySelector('.mqtt-pub-retain'),
            // Connection tabs
            connTabs:       panel.querySelectorAll('.conn-tab'),
            connConfigs:    panel.querySelectorAll('.conn-config'),
            // Console & common
            console:        panel.querySelector('.device-console'),
            chkAutoScroll:  panel.querySelector('.chk-autoscroll'),
            chkTimestamp:   panel.querySelector('.chk-timestamp'),
            chkHex:         panel.querySelector('.chk-hex'),
            chkAnsi:        panel.querySelector('.chk-ansi'),
            btnClear:       panel.querySelector('.btn-clear'),
            btnBookmarkPrev: panel.querySelector('.btn-bookmark-prev'),
            btnBookmarkNext: panel.querySelector('.btn-bookmark-next'),
            btnDetachConsole: panel.querySelector('.btn-detach-console'),
            btnDetachDataTable: panel.querySelector('.btn-detach-datatable'),
            serialInput:    panel.querySelector('.serial-input'),
            lineEnding:     panel.querySelector('.line-ending'),
            btnSend:        panel.querySelector('.btn-send'),
            repeatInput:    panel.querySelector('.repeat-msg-input'),
            repeatFreq:     panel.querySelector('.repeat-freq'),
            btnRepeatStart: panel.querySelector('.btn-repeat-start'),
            btnRepeatStop:  panel.querySelector('.btn-repeat-stop'),
            repeatStatus:   panel.querySelector('.repeat-status'),
            rxFreqDisplay:  panel.querySelector('.rx-freq-display'),
            rxThroughput:   panel.querySelector('.rx-throughput'),
            rxLineCount:    panel.querySelector('.rx-line-count'),
            filterInput:    panel.querySelector('.filter-input'),
            chkFilterInvert: panel.querySelector('.chk-filter-invert'),
            filterCount:    panel.querySelector('.filter-count'),
            searchBar:      panel.querySelector('.console-search-bar'),
            searchInput:    panel.querySelector('.console-search-input'),
            searchCount:    panel.querySelector('.console-search-count'),
            btnSearchPrev:  panel.querySelector('.btn-search-prev'),
            btnSearchNext:  panel.querySelector('.btn-search-next'),
            btnSearchClose: panel.querySelector('.btn-search-close'),
            btnRecord:      panel.querySelector('.btn-record'),
            exportDropdown: panel.querySelector('.export-dropdown'),
            btnExportToggle: panel.querySelector('.btn-export-toggle'),
            btnExportTxt:   panel.querySelector('.btn-export-txt'),
            btnExportCsv:   panel.querySelector('.btn-export-csv'),
            btnExportJson:  panel.querySelector('.btn-export-json'),
            btnImportReplay: panel.querySelector('.btn-import-replay'),
            chkJson:        panel.querySelector('.chk-json'),
        };

        // Device control elements
        const controlSection = panel.querySelector('.device-control-section');
        const ctrlEls = {};
        if (controlSection) {
            ctrlEls.ctrlToggle = controlSection.querySelector('.btn-control-toggle');
            ctrlEls.ctrlBody = controlSection.querySelector('.control-section-body');
            ctrlEls.ctrlHeader = controlSection.querySelector('.control-section-header');
            ctrlEls.btnGpioAdd = controlSection.querySelector('.btn-gpio-add');
            ctrlEls.gpioPins = controlSection.querySelector('.gpio-pins');
            ctrlEls.btnDashAdd = controlSection.querySelector('.btn-dash-add');
            ctrlEls.dashVars = controlSection.querySelector('.dashboard-vars');
            ctrlEls.btnUpload = controlSection.querySelector('.btn-upload');
            ctrlEls.uploadProtocol = controlSection.querySelector('.upload-protocol');
            ctrlEls.uploadStatus = controlSection.querySelector('.upload-status');
        }
        Object.assign(els, ctrlEls);

        // Macro elements
        const macrosSection = panel.querySelector('.macros-section');
        const macroEls = {};
        if (macrosSection) {
            macroEls.btnMacroAdd = macrosSection.querySelector('.btn-macro-add');
            macroEls.btnSequenceAdd = macrosSection.querySelector('.btn-sequence-add');
            macroEls.btnTriggerAdd = macrosSection.querySelector('.btn-trigger-add');
            macroEls.quickCmds = macrosSection.querySelector('.macros-quick-cmds');
            macroEls.sequences = macrosSection.querySelector('.macros-sequences');
            macroEls.triggersContainer = macrosSection.querySelector('.macros-triggers');
        }
        Object.assign(els, macroEls);

        // Phase 9 elements: highlights, file sender, console tabs
        const hlSection = panel.querySelector('.highlights-section');
        if (hlSection) {
            els.btnHighlightAdd = hlSection.querySelector('.btn-highlight-add');
            els.highlightsList = hlSection.querySelector('.highlights-list');
        }
        const fsSection = panel.querySelector('.file-sender-section');
        if (fsSection) {
            els.fileSenderToggle = fsSection.querySelector('.btn-file-sender-toggle');
            els.fileSenderBody = fsSection.querySelector('.file-sender-body');
            els.fileSenderHeader = fsSection.querySelector('.file-sender-header');
            els.btnFileSelect = fsSection.querySelector('.btn-file-select');
            els.fileSenderName = fsSection.querySelector('.file-sender-name');
            els.fileSenderFreq = fsSection.querySelector('.file-sender-freq');
            els.chkFileSenderLoop = fsSection.querySelector('.chk-file-sender-loop');
            els.btnFileStart = fsSection.querySelector('.btn-file-start');
            els.btnFileStop = fsSection.querySelector('.btn-file-stop');
            els.btnFilePause = fsSection.querySelector('.btn-file-pause');
            els.fileSenderStatus = fsSection.querySelector('.file-sender-status');
            els.fileSenderProgressBar = fsSection.querySelector('.file-sender-progress-bar');
            els.fileSenderColumns = fsSection.querySelector('.file-sender-columns');
            els.fileSenderColInfo = fsSection.querySelector('.file-sender-col-info');
            els.fileSenderColPreview = fsSection.querySelector('.file-sender-col-preview');
            els.fileSenderColSelect = fsSection.querySelector('.file-sender-col-select');
            els.fileSenderColSep = fsSection.querySelector('.file-sender-col-sep');
            els.btnFileColApply = fsSection.querySelector('.btn-file-col-apply');
            els.fileSenderColResult = fsSection.querySelector('.file-sender-col-result');
        }
        els.consoleTabs = panel.querySelectorAll('.console-tab');
        els.btnTabAdd = panel.querySelector('.btn-tab-add');

        // Scripting section elements
        const scriptSection = clone.querySelector('.scripting-section');
        if (scriptSection) {
            scriptSection.querySelector('.scripting-device-num').textContent = index + 1;
            els.scriptSection = scriptSection;
            els.scriptToggle = scriptSection.querySelector('.btn-script-toggle');
            els.scriptBody = scriptSection.querySelector('.scripting-body');
            els.scriptEditor = scriptSection.querySelector('.script-editor');
            els.scriptOutput = scriptSection.querySelector('.script-output');
            els.scriptStatus = scriptSection.querySelector('.script-status');
            els.btnScriptRun = scriptSection.querySelector('.btn-script-run');
            els.btnScriptStop = scriptSection.querySelector('.btn-script-stop');
            els.btnScriptLoad = scriptSection.querySelector('.btn-script-load');
            els.btnScriptSave = scriptSection.querySelector('.btn-script-save');
            els.btnScriptHelp = scriptSection.querySelector('.btn-script-help');
            // Test Suite
            els.suiteList = scriptSection.querySelector('.test-suite-list');
            els.suiteSummary = scriptSection.querySelector('.test-suite-summary');
            els.btnSuiteAdd = scriptSection.querySelector('.btn-suite-add');
            els.btnSuiteRunAll = scriptSection.querySelector('.btn-suite-run-all');
            els.btnSuiteReport = scriptSection.querySelector('.btn-suite-report');
        }

        // Live Data Table elements
        const liveTableSection = clone.querySelector('.live-table-section');
        if (liveTableSection) {
            liveTableSection.querySelector('.live-table-device-num').textContent = index + 1;
            els.liveTableSection = liveTableSection;
            els.liveTableThead = liveTableSection.querySelector('thead tr');
            els.liveTableTbody = liveTableSection.querySelector('tbody');
            els.liveTableSep = liveTableSection.querySelector('.live-table-sep');
            els.liveTableMaxRows = liveTableSection.querySelector('.live-table-max-rows');
            els.chkLiveTableFollow = liveTableSection.querySelector('.chk-live-table-follow');
            els.btnLiveTableClear = liveTableSection.querySelector('.btn-live-table-clear');
            els.btnLiveTableCsv = liveTableSection.querySelector('.btn-live-table-csv');
        }

        // Decoder elements (in the decoder section next to the panel)
        const group = clone.querySelector('.device-group');
        const decoderSection = group ? group.querySelector('.device-decoder-section') : null;
        const decoderEls = {};
        if (decoderSection) {
            decoderSection.querySelector('.decoder-device-num').textContent = index + 1;
            decoderEls.decoderMode = decoderSection.querySelector('.decoder-mode');
            decoderEls.decoderOutput = decoderSection.querySelector('.decoder-output');
            decoderEls.chkDecoderFollow = decoderSection.querySelector('.chk-decoder-follow');
            decoderEls.btnDecoderClear = decoderSection.querySelector('.btn-decoder-clear');
            decoderEls.binaryConfig = decoderSection.querySelector('.decoder-binary-config');
            decoderEls.binHeader = decoderSection.querySelector('.decoder-bin-header');
            decoderEls.binLenMode = decoderSection.querySelector('.decoder-bin-len-mode');
            decoderEls.binLenVal = decoderSection.querySelector('.decoder-bin-len-val');
            decoderEls.binChecksum = decoderSection.querySelector('.decoder-bin-checksum');
            Object.assign(els, decoderEls);
        }

        const dev = {
            index,
            customName: localStorage.getItem(`dev-name-${index}`) || '',
            connectionType: 'serial',  // 'serial' | 'websocket' | 'mqtt'
            // Serial transport
            port: null,
            reader: null,
            writer: null,
            readLoopActive: false,
            simulated: false,
            // TCP/UDP transport (via relay)
            relayWs: null,          // WebSocket to relay.js
            relayConnected: false,
            netConnId: null,        // current TCP/UDP connection id from relay
            netServerClients: [],   // [{subId, remote}] for server mode
            wsSocket: null,         // kept for isActive compat
            // MQTT transport
            mqttWs: null,
            mqttConnected: false,
            mqttSubs: new Set(),
            mqttMsgId: 1,
            mqttPingInterval: null,
            mqttBuffer: new Uint8Array(0),
            // Common
            els,
            repeatId: null,
            repeatCount: 0,
            plotter: null,
            plotterPopup: false,
            rxTimestamps: [],
            rxFreqInterval: null,
            rxBytes: 0,
            rxBytesLast: 0,
            lineCount: 0,
            consoleData: [],       // Raw data for export/recording
            cmdHistory: [],        // Command history
            historyIdx: -1,
            triggers: [],          // Per-device triggers
            macros: [],            // Quick commands [{label, cmd}]
            sequences: [],         // Sequences [{name, steps:[{cmd,delay}], running, abortFlag}]
            recording: false,
            recordStart: 0,
            recordData: [],
            decoderSection: decoderSection,
            decoderConfig: null,
            decoderCsvCols: 0,
            decoderCsvHeaders: null,
            decoderCsvTable: null,
            gpioPins: [],              // [{label, pin, mode, cmdOn, cmdOff, state}]
            dashVars: [],              // [{name, regex, unit, min, max, value}]
            // Live Data Table
            liveTable: { detectedSep: null, cols: 0, headers: [], rows: [], sortCol: -1, sortAsc: true },
            // Auto-reconnect
            autoReconnect: { enabled: false, attempts: 0, timer: null, lastConnType: null, userDisconnect: false },
        };

        // --- Connection type tabs ---
        els.connTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                els.connTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const connType = tab.dataset.conn;
                dev.connectionType = connType;
                els.connConfigs.forEach(c => c.classList.remove('active'));
                const target = panel.querySelector('.conn-' + connType);
                if (target) target.classList.add('active');
                // Disable serial connect if Web Serial not available
                if (connType === 'serial' && !hasWebSerial) {
                    els.btnConnect.disabled = true;
                    els.btnConnect.title = 'Web Serial API non disponible';
                }
            });
        });

        // --- Auto-reconnect checkbox ---
        if (els.chkAutoReconnect) {
            els.chkAutoReconnect.addEventListener('change', () => {
                dev.autoReconnect.enabled = els.chkAutoReconnect.checked;
                if (!els.chkAutoReconnect.checked) cancelAutoReconnect(dev);
            });
        }

        // --- Device name (click to rename) ---
        function updateDeviceTitle() {
            const base = `Device ${index + 1}`;
            const name = dev.customName || base;
            els.deviceTitleText.textContent = name;
        }
        updateDeviceTitle();

        els.deviceTitleText.style.cursor = 'pointer';
        els.deviceTitleText.addEventListener('click', () => {
            const current = dev.customName || `Device ${index + 1}`;
            const newName = prompt(t('prompt.deviceName') || 'Nom du device :', current);
            if (newName === null) return; // cancelled
            dev.customName = newName.trim();
            if (dev.customName) {
                localStorage.setItem(`dev-name-${index}`, dev.customName);
            } else {
                localStorage.removeItem(`dev-name-${index}`);
            }
            updateDeviceTitle();
        });

        // Expose updateDeviceTitle for use after connection
        dev._updateTitle = updateDeviceTitle;

        // --- Serial Events ---
        els.btnConnect.addEventListener('click', () => { resetAutoReconnect(dev); connectDevice(dev); });
        els.btnDisconnect.addEventListener('click', () => { dev.autoReconnect.userDisconnect = true; cancelAutoReconnect(dev); disconnectDevice(dev); });
        els.btnSimulate.addEventListener('click', () => toggleSimulation(dev));

        // --- TCP/UDP (relay) Events ---
        els.btnRelayConnect.addEventListener('click', () => connectRelay(dev));
        els.btnNetConnect.addEventListener('click', () => netTcpConnect(dev));
        els.btnNetDisconnect.addEventListener('click', () => netDisconnect(dev));
        els.btnNetListen.addEventListener('click', () => netTcpListen(dev));
        els.btnNetStop.addEventListener('click', () => netDisconnect(dev));
        els.btnNetUdpBind.addEventListener('click', () => netUdpBind(dev));
        els.btnNetUdpClose.addEventListener('click', () => netDisconnect(dev));

        // Toggle Client/Server/UDP role panels
        function updateNetRolePanels() {
            const proto = els.netProto.value;
            const role = els.netRole.value;
            els.netRoleConfigs.forEach(c => c.classList.remove('active'));
            if (proto === 'udp') {
                panel.querySelector('.net-role-udp').style.display = '';
                panel.querySelector('.net-role-client').classList.remove('active');
                panel.querySelector('.net-role-server').classList.remove('active');
                panel.querySelector('.net-role-udp').classList.add('active');
            } else {
                panel.querySelector('.net-role-udp').style.display = 'none';
                if (role === 'client') {
                    panel.querySelector('.net-role-client').classList.add('active');
                } else {
                    panel.querySelector('.net-role-server').classList.add('active');
                }
            }
        }
        els.netProto.addEventListener('change', updateNetRolePanels);
        els.netRole.addEventListener('change', updateNetRolePanels);
        updateNetRolePanels();

        // --- MQTT Events ---
        els.btnMqttConnect.addEventListener('click', () => { resetAutoReconnect(dev); connectMqtt(dev); });
        els.btnMqttDisconnect.addEventListener('click', () => { dev.autoReconnect.userDisconnect = true; cancelAutoReconnect(dev); disconnectMqtt(dev); });
        els.btnMqttSub.addEventListener('click', () => mqttSubscribe(dev));
        els.btnMqttUnsub.addEventListener('click', () => mqttUnsubscribe(dev));
        els.btnSend.addEventListener('click', () => sendCommand(dev));
        els.btnClear.addEventListener('click', () => {
            els.console.innerHTML = '';
            dev.consoleData = [];
            dev.lineCount = 0;
            dev.rxBytes = 0;
            els.rxLineCount.textContent = '0 lignes';
        });

        // Bookmark navigation
        els.btnBookmarkPrev.addEventListener('click', () => navigateBookmarks(dev, -1));
        els.btnBookmarkNext.addEventListener('click', () => navigateBookmarks(dev, 1));

        // Detach panels (Electron only)
        if (isElectron && window.electronRelay.openDetachedPanel) {
            dev._detachedConsole = false;
            dev._detachedDataTable = false;

            els.btnDetachConsole.addEventListener('click', () => {
                if (dev._detachedConsole) return;
                window.electronRelay.openDetachedPanel('console', dev.index, `Console — Device ${dev.index + 1}`);
                dev._detachedConsole = true;
                els.btnDetachConsole.textContent = '⇲';
                els.btnDetachConsole.title = 'Console détachée';
                showToast(t('toast.consoleDetached'), 'info', 1500);
            });

            if (els.btnDetachDataTable) {
                els.btnDetachDataTable.addEventListener('click', () => {
                    if (dev._detachedDataTable) return;
                    window.electronRelay.openDetachedPanel('datatable', dev.index, `Tableau — Device ${dev.index + 1}`);
                    dev._detachedDataTable = true;
                    // Send existing headers
                    if (dev.liveTable.headers.length > 0) {
                        window.electronRelay.detachedPanelData('datatable', dev.index, { headers: dev.liveTable.headers });
                    }
                    els.btnDetachDataTable.textContent = '⇲';
                    showToast(t('toast.tableDetached'), 'info', 1500);
                });
            }

            window.electronRelay.onDetachedPanelClosed(({ type, deviceIdx }) => {
                if (deviceIdx !== dev.index) return;
                if (type === 'console') {
                    dev._detachedConsole = false;
                    els.btnDetachConsole.textContent = '⇱';
                    els.btnDetachConsole.title = 'Détacher la console';
                }
                if (type === 'datatable') {
                    dev._detachedDataTable = false;
                    if (els.btnDetachDataTable) {
                        els.btnDetachDataTable.textContent = '⇱';
                        els.btnDetachDataTable.title = 'Détacher le tableau';
                    }
                }
            });
        } else {
            // Hide detach buttons in browser mode
            els.btnDetachConsole.style.display = 'none';
            if (els.btnDetachDataTable) els.btnDetachDataTable.style.display = 'none';
        }

        // Command history (up/down arrows)
        els.serialInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !els.btnSend.disabled) {
                sendCommand(dev);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                historyUp(dev);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                historyDown(dev);
            }
        });

        els.btnRepeatStart.addEventListener('click', () => startRepeat(dev));
        els.btnRepeatStop.addEventListener('click', () => stopRepeat(dev));

        // Record button
        els.btnRecord.addEventListener('click', () => toggleRecord(dev));

        // Export dropdown
        els.btnExportToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            els.exportDropdown.classList.toggle('open');
        });
        document.addEventListener('click', () => {
            els.exportDropdown.classList.remove('open');
        });
        els.btnExportTxt.addEventListener('click', () => { exportTxt(dev); els.exportDropdown.classList.remove('open'); });
        els.btnExportCsv.addEventListener('click', () => { exportCsv(dev); els.exportDropdown.classList.remove('open'); });
        els.btnExportJson.addEventListener('click', () => { exportJson(dev); els.exportDropdown.classList.remove('open'); });
        els.btnImportReplay.addEventListener('click', () => { importAndReplay(dev); els.exportDropdown.classList.remove('open'); });

        // Decoder events
        if (decoderSection) {
            const updateDecoderConfig = () => {
                dev.decoderConfig = {
                    header: els.binHeader.value,
                    lenMode: els.binLenMode.value,
                    lenVal: parseInt(els.binLenVal.value, 10) || 0,
                    checksum: els.binChecksum.value,
                };
            };
            updateDecoderConfig();

            els.decoderMode.addEventListener('change', () => {
                const isBinary = els.decoderMode.value === 'binary';
                els.binaryConfig.style.display = isBinary ? '' : 'none';
            });

            els.binHeader.addEventListener('change', updateDecoderConfig);
            els.binLenMode.addEventListener('change', updateDecoderConfig);
            els.binLenVal.addEventListener('change', updateDecoderConfig);
            els.binChecksum.addEventListener('change', updateDecoderConfig);

            els.btnDecoderClear.addEventListener('click', () => {
                els.decoderOutput.innerHTML = '';
                dev.decoderCsvCols = 0;
                dev.decoderCsvHeaders = null;
                dev.decoderCsvTable = null;
                decoderSection.classList.add('decoder-collapsed');
            });
        }

        // Device control events
        if (controlSection) {
            els.ctrlHeader.addEventListener('click', () => {
                const open = els.ctrlBody.style.display !== 'none';
                els.ctrlBody.style.display = open ? 'none' : '';
                els.ctrlToggle.textContent = open ? '▾' : '▴';
            });
            els.btnGpioAdd.addEventListener('click', () => addGpioPin(dev));
            els.btnDashAdd.addEventListener('click', () => addDashVar(dev));
            els.btnUpload.addEventListener('click', () => uploadFile(dev));
        }

        // Macro events
        if (macrosSection) {
            els.btnMacroAdd.addEventListener('click', () => addQuickCommand(dev));
            els.btnSequenceAdd.addEventListener('click', () => addSequence(dev));
            els.btnTriggerAdd.addEventListener('click', () => addTriggerUI(dev));
        }

        // Filter: debounced reapply
        let filterTimer = null;
        const onFilterChange = () => {
            clearTimeout(filterTimer);
            filterTimer = setTimeout(() => reapplyFilter(dev), 150);
        };
        els.filterInput.addEventListener('input', onFilterChange);
        els.chkFilterInvert.addEventListener('change', onFilterChange);

        // Console resize handle (drag to resize all)
        const consoleResizeHandle = panel.querySelector('.console-resize-handle');
        if (consoleResizeHandle) {
            let startY, startH;
            const onMouseMove = (e) => {
                const newH = Math.min(800, Math.max(300, startH + (e.clientY - startY)));
                for (const d of devices) {
                    d.els.console.style.height = newH + 'px';
                }
            };
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };
            consoleResizeHandle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startY = e.clientY;
                startH = els.console.offsetHeight;
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        }

        container.appendChild(clone);
        dev.plotter = Plotter.init(plotterSection);
        devices.push(dev);

        // Load saved macros/sequences/triggers/GPIO/dashboard
        loadDeviceMacros(dev);

        // Phase 9: load persistent history
        loadHistory(dev);

        // Phase 9: init highlight rules & file sender state
        dev.highlightRules = [];
        dev.fileSender = { lines: null, index: 0, timer: null, paused: false, fileName: '' };
        dev.scriptRunner = { running: false, aborted: false, vars: {}, passCount: 0, failCount: 0 };
        loadHighlightRules(dev);

        // Phase 9: setup console tabs, autocomplete, highlights, file sender
        setupConsoleTabs(dev);
        setupAutocomplete(dev);
        setupHighlights(dev);
        setupFileSender(dev);

        // Phase 10: setup scripting
        setupScripting(dev);

        // Console search (Ctrl+F)
        setupConsoleSearch(dev);

        // Live Data Table
        setupLiveTable(dev);

        return dev;
    }

    function removeAllDevicePanels() {
        for (const dev of devices) {
            if (dev.plotter) Plotter.destroy(dev.plotter);
            if (dev.plotterPopup) {
                if (isElectron && window.electronRelay.closePlotterWindow) {
                    window.electronRelay.closePlotterWindow(dev.index);
                } else if (dev._plotterPopupWin && !dev._plotterPopupWin.closed) {
                    dev._plotterPopupWin.close();
                }
            }
            if (dev.simulated) dev.simulated = false;
            if (dev.port) disconnectDevice(dev);
            if (dev.netConnId) netDisconnect(dev);
            if (dev.relayWs) { dev.relayWs.close(); dev.relayWs = null; }
            if (dev.mqttWs) disconnectMqtt(dev);
        }
        devices.length = 0;
        container.innerHTML = '';
    }

    // =========================================================================
    // TCP/UDP via Relay
    // =========================================================================

    // Detect Electron environment
    const isElectron = !!(window.electronRelay && window.electronRelay.isElectron);

    // Listen for serial port info from Electron's port selection dialog
    if (isElectron && window.electronRelay.onSerialPortSelected) {
        window.electronRelay.onSerialPortSelected((info) => {
            window._lastSerialPortInfo = info;
        });
    }

    // Cleanup all serial ports on app close (Electron)
    if (isElectron && window.electronRelay.onAppClosing) {
        window.electronRelay.onAppClosing(async () => {
            for (const dev of devices) {
                if (dev.port) {
                    try { await disconnectDevice(dev); } catch (_) {}
                }
            }
        });
    }

    function connectRelay(dev) {
        // --- Electron mode: relay is built-in, no WebSocket needed ---
        if (isElectron) {
            dev.relayConnected = true;
            dev.els.relayStatus.textContent = 'Intégré';
            dev.els.relayStatus.className = 'relay-status relay-on';
            dev.els.netRelayUrl.value = '(intégré)';
            dev.els.netRelayUrl.disabled = true;
            dev.els.btnRelayConnect.disabled = true;
            appendLine(dev, 'Relay TCP/UDP intégré (Electron).', 'line-info');
            enableNetButtons(dev, true);
            return;
        }

        // --- Browser mode: connect via WebSocket to relay.js ---
        const url = dev.els.netRelayUrl.value.trim();
        if (!url) return;
        if (dev.relayWs) { dev.relayWs.close(); }

        appendLine(dev, `Connexion au relay ${url}...`, 'line-info');
        try {
            dev.relayWs = new WebSocket(url);
            dev.relayWs.onopen = () => {
                dev.relayConnected = true;
                dev.els.relayStatus.textContent = 'Connecté';
                dev.els.relayStatus.className = 'relay-status relay-on';
                appendLine(dev, 'Relay connecté.', 'line-info');
                enableNetButtons(dev, true);
            };
            dev.relayWs.onmessage = (e) => {
                handleRelayMessage(dev, e.data);
            };
            dev.relayWs.onerror = () => {
                appendLine(dev, 'Erreur relay. Vérifiez que relay.js tourne (node relay.js).', 'line-err');
            };
            dev.relayWs.onclose = () => {
                const hadConnection = !!dev.netConnId;
                dev.relayConnected = false;
                dev.relayWs = null;
                dev.els.relayStatus.textContent = 'Déconnecté';
                dev.els.relayStatus.className = 'relay-status relay-off';
                if (dev.netConnId) {
                    dev.netConnId = null;
                    dev.writer = null;
                    dev.netServerClients = [];
                    setDeviceActive(dev, false);
                }
                enableNetButtons(dev, false);
                appendLine(dev, 'Relay déconnecté.', 'line-info');
                // Auto-reconnect relay
                if (hadConnection && dev.autoReconnect.enabled && !dev.autoReconnect.userDisconnect) {
                    dev.autoReconnect.lastConnType = 'websocket';
                    scheduleAutoReconnect(dev);
                }
            };
        } catch (err) {
            appendLine(dev, 'Erreur relay : ' + err.message, 'line-err');
        }
    }

    function enableNetButtons(dev, enabled) {
        dev.els.btnNetConnect.disabled  = !enabled;
        dev.els.btnNetListen.disabled   = !enabled;
        dev.els.btnNetUdpBind.disabled  = !enabled;
    }

    function relaySend(dev, obj) {
        if (isElectron) {
            window.electronRelay.send(obj);
            return;
        }
        if (dev.relayWs && dev.relayWs.readyState === WebSocket.OPEN) {
            dev.relayWs.send(JSON.stringify(obj));
        }
    }

    function handleRelayMessage(dev, raw) {
        let msg;
        if (typeof raw === 'object') { msg = raw; }
        else { try { msg = JSON.parse(raw); } catch (_) { return; } }

        switch (msg.event) {
            case 'ready':
                appendLine(dev, msg.message, 'line-info');
                break;

            case 'creating':
                appendLine(dev, msg.info, 'line-info');
                break;

            case 'connected':
                dev.netConnId = msg.id;
                dev.writer = {
                    write: (data) => { relaySend(dev, { action: 'send', id: dev.netConnId, data }); }
                };
                setDeviceActive(dev, true);
                appendLine(dev, `Connecté TCP → ${msg.remote}`, 'line-info');
                break;

            case 'listening':
                dev.netConnId = msg.id;
                if (dev.els.netProto.value === 'udp') {
                    dev.writer = {
                        write: (data) => {
                            const rh = dev.els.netUdpRemoteHost.value.trim();
                            const rp = parseInt(dev.els.netUdpRemotePort.value, 10);
                            relaySend(dev, { action: 'send', id: dev.netConnId, data, remoteHost: rh, remotePort: rp });
                        }
                    };
                    appendLine(dev, `UDP bind sur port ${msg.port}`, 'line-info');
                } else {
                    dev.writer = {
                        write: (data) => { relaySend(dev, { action: 'send', id: dev.netConnId, data }); }
                    };
                    appendLine(dev, `Serveur TCP à l'écoute sur port ${msg.port}`, 'line-info');
                }
                setDeviceActive(dev, true);
                break;

            case 'client-connected':
                dev.netServerClients.push({ subId: msg.subId, remote: msg.remote });
                appendLine(dev, `Client connecté : ${msg.remote}`, 'line-info');
                renderNetClientsList(dev);
                break;

            case 'client-disconnected':
                dev.netServerClients = dev.netServerClients.filter(c => c.subId !== msg.subId);
                appendLine(dev, `Client déconnecté : ${msg.remote}`, 'line-info');
                renderNetClientsList(dev);
                break;

            case 'data': {
                const prefix = msg.remote ? `[${msg.remote}] ` : '';
                const text = msg.data;
                trackRx(dev);
                appendLine(dev, prefix + text, 'line-rx');
                feedPlotter(dev, text);
                bridgeForward(dev, text);
                break;
            }

            case 'closed':
                if (msg.id === dev.netConnId) {
                    dev.netConnId = null;
                    dev.writer = null;
                    dev.netServerClients = [];
                    setDeviceActive(dev, false);
                    renderNetClientsList(dev);
                    appendLine(dev, 'Connexion fermée.', 'line-info');
                }
                break;

            case 'error':
                appendLine(dev, 'Erreur : ' + msg.message, 'line-err');
                break;
        }
    }

    function renderNetClientsList(dev) {
        const el = dev.els.netClientsList;
        if (!el) return;
        el.innerHTML = '';
        dev.netServerClients.forEach(c => {
            const tag = document.createElement('span');
            tag.className = 'net-client-tag';
            tag.textContent = c.remote;
            el.appendChild(tag);
        });
    }

    function netTcpConnect(dev) {
        if (!dev.relayConnected) return;
        const host = dev.els.netHost.value.trim();
        const port = parseInt(dev.els.netPort.value, 10);
        if (!host || !port) return;
        relaySend(dev, { action: 'tcp-client', host, port });
    }

    function netTcpListen(dev) {
        if (!dev.relayConnected) return;
        const port = parseInt(dev.els.netListenPort.value, 10);
        if (!port) return;
        relaySend(dev, { action: 'tcp-server', port });
    }

    function netUdpBind(dev) {
        if (!dev.relayConnected) return;
        const localPort = parseInt(dev.els.netUdpLocalPort.value, 10) || 0;
        const remoteHost = dev.els.netUdpRemoteHost.value.trim();
        const remotePort = parseInt(dev.els.netUdpRemotePort.value, 10);
        relaySend(dev, { action: 'udp-bind', localPort, remoteHost, remotePort });
    }

    function netDisconnect(dev) {
        stopRepeat(dev);
        if (dev.netConnId) {
            relaySend(dev, { action: 'close', id: dev.netConnId });
        }
    }

    // =========================================================================
    // MQTT Connect / Disconnect
    // =========================================================================

    function connectMqtt(dev) {
        const MQTT = getMQTT();
        if (!MQTT) { appendLine(dev, 'MQTT non disponible (network.js manquant).', 'line-err'); return; }

        const broker = dev.els.mqttBroker.value.trim();
        let clientId = dev.els.mqttClientId.value.trim();
        if (!clientId) clientId = 'esp32tester_' + Math.random().toString(36).slice(2, 8);
        const user = dev.els.mqttUser.value.trim() || null;
        const pass = dev.els.mqttPass.value.trim() || null;
        if (!broker) return;

        appendLine(dev, `Connexion MQTT à ${broker}...`, 'line-info');

        try {
            dev.mqttWs = new WebSocket(broker, 'mqtt');
            dev.mqttWs.binaryType = 'arraybuffer';
            dev.mqttBuffer = new Uint8Array(0);

            dev.mqttWs.onopen = () => {
                dev.mqttWs.send(MQTT.buildConnect(clientId, user, pass));
            };

            dev.mqttWs.onmessage = (e) => {
                const incoming = new Uint8Array(e.data);
                const newBuf = new Uint8Array(dev.mqttBuffer.length + incoming.length);
                newBuf.set(dev.mqttBuffer);
                newBuf.set(incoming, dev.mqttBuffer.length);
                dev.mqttBuffer = newBuf;

                while (dev.mqttBuffer.length >= 2) {
                    const packetType = (dev.mqttBuffer[0] >> 4) & 0x0F;
                    const { value: remLen, bytesRead } = MQTT.decodeLength(dev.mqttBuffer, 1);
                    const totalLen = 1 + bytesRead + remLen;
                    if (dev.mqttBuffer.length < totalLen) break;
                    const packet = dev.mqttBuffer.slice(0, totalLen);
                    dev.mqttBuffer = dev.mqttBuffer.slice(totalLen);
                    handleMqttPacket(dev, packetType, packet);
                }
            };

            dev.mqttWs.onerror = () => {
                appendLine(dev, 'Erreur WebSocket MQTT.', 'line-err');
            };

            dev.mqttWs.onclose = () => {
                const wasConnected = dev.mqttConnected;
                dev.mqttConnected = false;
                dev.mqttWs = null;
                dev.writer = null;
                if (dev.mqttPingInterval) { clearInterval(dev.mqttPingInterval); dev.mqttPingInterval = null; }
                setDeviceActive(dev, false);
                appendLine(dev, 'Déconnecté du broker MQTT.', 'line-info');
                // Auto-reconnect MQTT
                if (wasConnected && dev.autoReconnect.enabled && !dev.autoReconnect.userDisconnect) {
                    dev.autoReconnect.lastConnType = 'mqtt';
                    scheduleAutoReconnect(dev);
                }
            };
        } catch (err) {
            appendLine(dev, 'Erreur connexion MQTT : ' + err.message, 'line-err');
        }
    }

    function handleMqttPacket(dev, type, packet) {
        const MQTT = getMQTT();
        switch (type) {
            case MQTT.CONNACK: {
                const rc = packet[3];
                if (rc === 0) {
                    dev.mqttConnected = true;
                    dev.writer = {
                        write: (data) => {
                            const topic = dev.els.mqttPubTopic.value.trim() || 'esp32/cmd';
                            const qos = parseInt(dev.els.mqttPubQos.value, 10) || 0;
                            const retain = dev.els.mqttPubRetain.checked;
                            dev.mqttWs.send(MQTT.buildPublish(topic, data, qos, retain));
                        }
                    };
                    setDeviceActive(dev, true);
                    appendLine(dev, 'Connecté au broker MQTT.', 'line-info');
                    // Reset auto-reconnect on successful connection
                    dev.autoReconnect.attempts = 0;
                    dev.autoReconnect.userDisconnect = false;
                    // Re-subscribe to saved topics after reconnect
                    if (dev.mqttSubs.size > 0) {
                        for (const topic of dev.mqttSubs) {
                            dev.mqttWs.send(MQTT.buildSubscribe(dev.mqttMsgId++, topic, 0));
                        }
                        appendLine(dev, `Re-souscrit à ${dev.mqttSubs.size} topic(s).`, 'line-info');
                    }
                    dev.mqttPingInterval = setInterval(() => {
                        if (dev.mqttWs && dev.mqttWs.readyState === WebSocket.OPEN) dev.mqttWs.send(MQTT.buildPingreq());
                    }, 30000);
                } else {
                    appendLine(dev, `CONNACK erreur, code: ${rc}`, 'line-err');
                }
                break;
            }
            case MQTT.PUBLISH: {
                try {
                    const msg = MQTT.parsePublish(packet);
                    trackRx(dev);
                    appendLine(dev, `[${msg.topic}] ${msg.payload}`, 'line-rx');
                    feedPlotter(dev, msg.payload);
                    bridgeForward(dev, msg.payload);
                } catch (err) {
                    appendLine(dev, `Erreur parsing PUBLISH: ${err.message}`, 'line-err');
                }
                break;
            }
            case MQTT.SUBACK:
                appendLine(dev, 'Abonnement confirmé.', 'line-info');
                break;
            case MQTT.UNSUBACK:
                appendLine(dev, 'Désabonnement confirmé.', 'line-info');
                break;
            case MQTT.PINGRESP:
                break;
        }
    }

    function disconnectMqtt(dev) {
        const MQTT = getMQTT();
        stopRepeat(dev);
        if (dev.mqttWs && dev.mqttWs.readyState === WebSocket.OPEN) {
            if (MQTT) dev.mqttWs.send(MQTT.buildDisconnect());
            dev.mqttWs.close();
        }
    }

    function mqttSubscribe(dev) {
        const MQTT = getMQTT();
        if (!dev.mqttConnected || !dev.mqttWs || !MQTT) return;
        const topic = dev.els.mqttSubTopic.value.trim();
        if (!topic) return;
        const qos = parseInt(dev.els.mqttSubQos.value, 10);
        dev.mqttWs.send(MQTT.buildSubscribe(dev.mqttMsgId++, topic, qos));
        dev.mqttSubs.add(topic);
        renderMqttSubsList(dev);
        appendLine(dev, `Abonné à "${topic}" (QoS ${qos})`, 'line-info');
    }

    function mqttUnsubscribe(dev) {
        const MQTT = getMQTT();
        if (!dev.mqttConnected || !dev.mqttWs || !MQTT) return;
        const topic = dev.els.mqttSubTopic.value.trim();
        if (!topic) return;
        dev.mqttWs.send(MQTT.buildUnsubscribe(dev.mqttMsgId++, topic));
        dev.mqttSubs.delete(topic);
        renderMqttSubsList(dev);
        appendLine(dev, `Désabonné de "${topic}"`, 'line-info');
    }

    function renderMqttSubsList(dev) {
        const MQTT = getMQTT();
        dev.els.mqttSubsList.innerHTML = '';
        for (const topic of dev.mqttSubs) {
            const tag = document.createElement('span');
            tag.className = 'mqtt-sub-tag';
            tag.innerHTML = `${escapeHtml(topic)} <span class="sub-remove" title="Se désabonner">×</span>`;
            tag.querySelector('.sub-remove').addEventListener('click', () => {
                if (dev.mqttConnected && dev.mqttWs && MQTT) {
                    dev.mqttWs.send(MQTT.buildUnsubscribe(dev.mqttMsgId++, topic));
                }
                dev.mqttSubs.delete(topic);
                renderMqttSubsList(dev);
            });
            dev.els.mqttSubsList.appendChild(tag);
        }
    }

    // =========================================================================
    // Auto-reconnect with exponential backoff
    // =========================================================================

    const RECONNECT_BASE_DELAY = 1000;   // 1s initial
    const RECONNECT_MAX_DELAY = 30000;   // 30s max
    const RECONNECT_MAX_ATTEMPTS = 20;

    function scheduleAutoReconnect(dev) {
        const ar = dev.autoReconnect;
        if (!ar.enabled || ar.userDisconnect || ar.attempts >= RECONNECT_MAX_ATTEMPTS) {
            if (ar.attempts >= RECONNECT_MAX_ATTEMPTS) {
                appendLine(dev, t('reconnect.maxAttempts'), 'line-err');
            }
            return;
        }
        ar.attempts++;
        const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, ar.attempts - 1), RECONNECT_MAX_DELAY);
        appendLine(dev, t('reconnect.scheduling', { delay: Math.round(delay / 1000), attempt: ar.attempts }), 'line-info');

        ar.timer = setTimeout(async () => {
            ar.timer = null;
            if (!ar.enabled || ar.userDisconnect) return;
            appendLine(dev, t('reconnect.attempting', { attempt: ar.attempts }), 'line-info');

            try {
                const connType = ar.lastConnType || dev.connectionType;
                if (connType === 'serial') {
                    await autoReconnectSerial(dev);
                } else if (connType === 'mqtt') {
                    connectMqtt(dev);
                } else if (connType === 'websocket') {
                    // Reconnect relay first, then the net connection
                    if (!dev.relayConnected && !isElectron) {
                        connectRelay(dev);
                    }
                }
            } catch (err) {
                appendLine(dev, t('reconnect.failed', { err: err.message }), 'line-err');
                scheduleAutoReconnect(dev);
            }
        }, delay);
    }

    function cancelAutoReconnect(dev) {
        const ar = dev.autoReconnect;
        if (ar.timer) { clearTimeout(ar.timer); ar.timer = null; }
        ar.attempts = 0;
    }

    function resetAutoReconnect(dev) {
        cancelAutoReconnect(dev);
        dev.autoReconnect.userDisconnect = false;
    }

    async function autoReconnectSerial(dev) {
        if (!hasWebSerial || !dev.port) {
            // Cannot auto-reconnect serial without a saved port reference
            appendLine(dev, t('reconnect.noPort'), 'line-err');
            cancelAutoReconnect(dev);
            return;
        }
        try {
            const baud = parseInt(dev.els.baudRate.value, 10);
            await dev.port.open({ baudRate: baud });
            appendLine(dev, `Port rouvert (${baud} bauds)`, 'line-info');
            setDeviceActive(dev, true);
            dev.autoReconnect.attempts = 0;

            const encoder = new TextEncoderStream();
            encoder.readable.pipeTo(dev.port.writable);
            dev.writer = encoder.writable.getWriter();
            dev.readLoopActive = true;
            readLoop(dev);
        } catch (err) {
            appendLine(dev, t('reconnect.failed', { err: err.message }), 'line-err');
            scheduleAutoReconnect(dev);
        }
    }

    // =========================================================================
    // Serial Connect / Disconnect
    // =========================================================================

    async function connectDevice(dev) {
        if (!hasWebSerial) { appendLine(dev, 'Web Serial API non disponible.', 'line-err'); return; }
        try {
            dev.port = await navigator.serial.requestPort();
            const baud = parseInt(dev.els.baudRate.value, 10);
            await dev.port.open({ baudRate: baud });

            // Retrieve port info and display it
            let portInfoStr = '';
            try {
                const info = dev.port.getInfo();
                const vid = info.usbVendorId ? info.usbVendorId.toString(16).toUpperCase().padStart(4, '0') : '';
                const pid = info.usbProductId ? info.usbProductId.toString(16).toUpperCase().padStart(4, '0') : '';
                if (vid && pid) portInfoStr = `VID:${vid} PID:${pid}`;
                // Try to get the display name from Electron's last selected port
                if (window._lastSerialPortInfo) {
                    const lsp = window._lastSerialPortInfo;
                    const parts = [];
                    if (lsp.portName) parts.push(lsp.portName);
                    if (lsp.displayName) parts.push(lsp.displayName);
                    portInfoStr = parts.join(' — ') || portInfoStr;
                    // Auto-set device name if not customized
                    if (!dev.customName && lsp.displayName) {
                        dev.customName = `Device ${dev.index + 1} : ${lsp.displayName}`;
                        localStorage.setItem(`dev-name-${dev.index}`, dev.customName);
                        if (dev._updateTitle) dev._updateTitle();
                    }
                }
            } catch (_) {}
            dev.els.devicePortInfo.textContent = portInfoStr ? ` (${portInfoStr})` : '';

            appendLine(dev, `Port ouvert (${baud} bauds)${portInfoStr ? ' — ' + portInfoStr : ''}`, 'line-info');
            setDeviceActive(dev, true);

            // Writer: use port.writable directly (no pipeTo which locks the stream)
            dev.writer = dev.port.writable.getWriter();
            dev._writerEncoder = new TextEncoder();

            dev.readLoopActive = true;
            readLoop(dev);

        } catch (err) {
            appendLine(dev, 'Erreur connexion : ' + err.message, 'line-err');
            dev.port = null;
        }
    }

    async function disconnectDevice(dev) {
        dev.readLoopActive = false;
        stopRepeat(dev);

        // Release reader lock (cancel stops the read loop)
        try {
            if (dev.reader) {
                await dev.reader.cancel();
                dev.reader.releaseLock();
                dev.reader = null;
            }
        } catch (e) { /* */ }

        // Release writer lock
        try {
            if (dev.writer) {
                dev.writer.releaseLock();
                dev.writer = null;
            }
        } catch (e) { /* */ }
        dev._writerEncoder = null;

        // Now close the port (streams are unlocked)
        try {
            if (dev.port) { await dev.port.close(); }
        } catch (e) { /* */ }

        dev.port = null;
        dev.els.devicePortInfo.textContent = '';
        setDeviceActive(dev, false);
        appendLine(dev, 'Port fermé', 'line-info');
    }

    // =========================================================================
    // Simulation
    // =========================================================================

    function toggleSimulation(dev) {
        if (dev.simulated) {
            stopRepeat(dev);
            dev.simulated = false;
            dev.writer = null;
            dev.connectionType = 'serial';
            setDeviceActive(dev, false);
            appendLine(dev, 'Simulation arrêtée', 'line-info');
        } else {
            if (isActive(dev)) return;
            dev.simulated = true;
            dev.writer = {
                write: async (data) => {
                    const lines = data.split(/\r?\n/).filter(l => l.length > 0);
                    for (const line of lines) {
                        appendLine(dev, line, 'line-sim-rx');
                    }
                }
            };
            setDeviceActive(dev, true);
            appendLine(dev, 'Mode simulation activé — tapez des messages pour simuler l\'ESP32', 'line-info');
        }
    }

    // =========================================================================
    // Read loop (real devices)
    // =========================================================================

    async function readLoop(dev) {
        // Read directly from port.readable without pipeTo (which locks the stream)
        dev.reader = dev.port.readable.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = '';

        try {
            while (dev.readLoopActive) {
                const { value, done } = await dev.reader.read();
                if (done) break;
                if (!value) continue;

                // value is Uint8Array — decode to string
                lineBuffer += decoder.decode(value, { stream: true });
                const lines = lineBuffer.split(/\r?\n/);
                lineBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.length > 0) {
                        trackRx(dev);
                        appendLine(dev, line, 'line-rx');
                        feedPlotter(dev, line);
                        bridgeForward(dev, line);
                    }
                }
            }
        } catch (err) {
            if (dev.readLoopActive) {
                appendLine(dev, 'Erreur lecture : ' + err.message, 'line-err');
            }
        } finally {
            try { dev.reader.releaseLock(); } catch (_) {}
            dev.reader = null;
            if (lineBuffer.length > 0) {
                trackRx(dev);
                appendLine(dev, lineBuffer, 'line-rx');
                feedPlotter(dev, lineBuffer);
                bridgeForward(dev, lineBuffer);
            }
            // Auto-reconnect on unexpected serial disconnect
            if (dev.autoReconnect.enabled && !dev.autoReconnect.userDisconnect && dev.connectionType === 'serial') {
                setDeviceActive(dev, false);
                dev.autoReconnect.lastConnType = 'serial';
                scheduleAutoReconnect(dev);
            }
        }
    }

    // =========================================================================
    // Send
    // =========================================================================

    // Write to serial port: encode string to Uint8Array for raw writable stream
    async function serialWrite(dev, data) {
        if (!dev.writer) return;
        if (dev.connectionType === 'serial' && dev._writerEncoder) {
            await dev.writer.write(dev._writerEncoder.encode(data));
        } else {
            // MQTT / WebSocket writers accept strings
            dev.writer.write(data);
        }
    }

    async function sendCommand(dev) {
        const text = dev.els.serialInput.value;
        if (!text) return;

        historyPush(dev, text);

        if (dev.simulated) {
            simulateRx(dev, text);
            appendLine(dev, text, 'line-tx');
            dev.els.serialInput.value = '';
            dev.els.serialInput.focus();
            return;
        }

        if (!dev.writer) return;
        const type = dev.connectionType || 'serial';
        try {
            if (type === 'mqtt') {
                const topic = dev.els.mqttPubTopic.value.trim() || 'esp32/cmd';
                await serialWrite(dev, text);
                appendLine(dev, `PUB [${topic}] ${text}`, 'line-tx');
            } else {
                const ending = getLineEnding(dev);
                await serialWrite(dev, text + ending);
                appendLine(dev, text, 'line-tx');
            }
            dev.els.serialInput.value = '';
            dev.els.serialInput.focus();
        } catch (err) {
            appendLine(dev, 'Erreur envoi : ' + err.message, 'line-err');
        }
    }

    // =========================================================================
    // Repeat
    // =========================================================================

    function startRepeat(dev) {
        const msg = dev.els.repeatInput.value;
        if (!msg) return;
        if (!isActive(dev)) { appendLine(dev, 'Device non connecté.', 'line-error'); return; }

        dev.repeatCount = 0;
        dev.repeatCurrentFreq = Math.max(10, parseInt(dev.els.repeatFreq.value, 10) || 100);

        dev.els.btnRepeatStart.disabled = true;
        dev.els.btnRepeatStop.disabled  = false;
        dev.els.repeatStatus.textContent = 'Envoi en cours...';
        appendLine(dev, `Envoi répété: "${msg}" toutes les ${dev.repeatCurrentFreq}ms`, 'line-info');

        async function doSend() {
            if (!isActive(dev)) { stopRepeat(dev); return; }
            // Read message and freq live so changes are picked up instantly
            const liveMsg = dev.els.repeatInput.value;
            if (!liveMsg) return;
            try {
                if (dev.simulated) {
                    simulateRx(dev, liveMsg);
                } else if (dev.connectionType === 'mqtt') {
                    await serialWrite(dev, liveMsg);
                } else {
                    const ending = getLineEnding(dev);
                    await serialWrite(dev, liveMsg + ending);
                }
                dev.repeatCount++;
                const liveFreq = Math.max(10, parseInt(dev.els.repeatFreq.value, 10) || 100);
                dev.els.repeatStatus.textContent = `#${dev.repeatCount} — ${liveFreq}ms`;
                // If frequency changed, restart the interval
                if (liveFreq !== dev.repeatCurrentFreq) {
                    dev.repeatCurrentFreq = liveFreq;
                    clearInterval(dev.repeatId);
                    dev.repeatId = setInterval(doSend, liveFreq);
                }
            } catch (err) {
                appendLine(dev, 'Erreur envoi répété : ' + err.message, 'line-err');
                stopRepeat(dev);
            }
        }

        doSend();
        dev.repeatId = setInterval(doSend, dev.repeatCurrentFreq);
    }

    function stopRepeat(dev) {
        if (dev.repeatId !== null) {
            clearInterval(dev.repeatId);
            dev.repeatId = null;
        }
        dev.els.btnRepeatStart.disabled = !isActive(dev);
        dev.els.btnRepeatStop.disabled  = true;
        if (dev.repeatCount > 0) {
            dev.els.repeatStatus.textContent = `Arrêté (${dev.repeatCount})`;
            appendLine(dev, `Envoi répété arrêté (${dev.repeatCount} envoi(s))`, 'line-info');
        }
        dev.repeatCount = 0;
    }

    // =========================================================================
    // Protocol Decoder
    // =========================================================================

    // --- JSON pretty-print (DOM-based with collapsible nodes) ----------------

    function tryParseJson(text) {
        const trimmed = text.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try { return JSON.parse(trimmed); } catch (e) { /* not valid JSON */ }
        }
        return null;
    }

    function jsonToHtml(obj, indent) {
        indent = indent || 0;
        const pad = '  '.repeat(indent);
        const pad1 = '  '.repeat(indent + 1);

        if (obj === null) return `<span class="json-null">null</span>`;
        if (typeof obj === 'boolean') return `<span class="json-bool">${obj}</span>`;
        if (typeof obj === 'number') return `<span class="json-number">${obj}</span>`;
        if (typeof obj === 'string') return `<span class="json-string">"${escapeHtml(obj)}"</span>`;

        if (Array.isArray(obj)) {
            if (obj.length === 0) return `<span class="json-brace">[]</span>`;
            let html = `<span class="json-toggle json-array" onclick="this.parentNode.classList.toggle('json-collapsed')">` +
                       `<span class="json-brace">[</span></span>` +
                       `<span class="json-children">\n`;
            for (let i = 0; i < obj.length; i++) {
                html += pad1 + jsonToHtml(obj[i], indent + 1);
                if (i < obj.length - 1) html += ',';
                html += '\n';
            }
            html += pad + `<span class="json-brace">]</span></span>`;
            return html;
        }

        if (typeof obj === 'object') {
            const keys = Object.keys(obj);
            if (keys.length === 0) return `<span class="json-brace">{}</span>`;
            let html = `<span class="json-toggle" onclick="this.parentNode.classList.toggle('json-collapsed')">` +
                       `<span class="json-brace">{</span></span>` +
                       `<span class="json-children">\n`;
            for (let i = 0; i < keys.length; i++) {
                html += pad1 + `<span class="json-key">"${escapeHtml(keys[i])}"</span>: ` +
                        jsonToHtml(obj[keys[i]], indent + 1);
                if (i < keys.length - 1) html += ',';
                html += '\n';
            }
            html += pad + `<span class="json-brace">}</span></span>`;
            return html;
        }

        return escapeHtml(String(obj));
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // --- Binary frame decoder ------------------------------------------------

    function parseHexString(hexStr) {
        const clean = hexStr.replace(/\s+/g, '').replace(/0x/gi, '');
        const bytes = [];
        for (let i = 0; i < clean.length; i += 2) {
            const b = parseInt(clean.substr(i, 2), 16);
            if (!isNaN(b)) bytes.push(b);
        }
        return bytes;
    }

    function checksumSum8(data) {
        let sum = 0;
        for (const b of data) sum = (sum + b) & 0xFF;
        return sum;
    }

    function checksumXor(data) {
        let x = 0;
        for (const b of data) x ^= b;
        return x;
    }

    function checksumCrc16(data) {
        let crc = 0xFFFF;
        for (const b of data) {
            crc ^= b;
            for (let i = 0; i < 8; i++) {
                if (crc & 1) crc = (crc >> 1) ^ 0xA001;
                else crc >>= 1;
            }
        }
        return crc;
    }

    function decodeBinaryFrame(dev, rawBytes) {
        const cfg = dev.decoderConfig;
        if (!cfg) return null;

        const header = parseHexString(cfg.header);
        if (header.length === 0) return null;

        // Find header in raw bytes
        let startPos = -1;
        for (let i = 0; i <= rawBytes.length - header.length; i++) {
            let match = true;
            for (let j = 0; j < header.length; j++) {
                if (rawBytes[i + j] !== header[j]) { match = false; break; }
            }
            if (match) { startPos = i; break; }
        }
        if (startPos < 0) return null;

        const afterHeader = startPos + header.length;
        let payloadLen = 0;
        let payloadStart = afterHeader;

        if (cfg.lenMode === 'fixed') {
            payloadLen = cfg.lenVal;
            payloadStart = afterHeader;
        } else if (cfg.lenMode === 'field') {
            // Next byte(s) after header is the length field
            if (afterHeader >= rawBytes.length) return null;
            payloadLen = rawBytes[afterHeader];
            payloadStart = afterHeader + 1;
        } else if (cfg.lenMode === 'delimiter') {
            // Read until end delimiter (lenVal as hex byte)
            const endByte = cfg.lenVal;
            let endPos = rawBytes.indexOf(endByte, afterHeader);
            if (endPos < 0) return null;
            payloadLen = endPos - afterHeader;
            payloadStart = afterHeader;
        }

        if (payloadStart + payloadLen > rawBytes.length) return null;
        const payload = rawBytes.slice(payloadStart, payloadStart + payloadLen);

        // Checksum
        let checksumOk = null;
        let checksumByte = null;
        if (cfg.checksum !== 'none' && payloadStart + payloadLen < rawBytes.length) {
            checksumByte = rawBytes[payloadStart + payloadLen];
            const dataForChecksum = rawBytes.slice(startPos, payloadStart + payloadLen);
            let expected;
            if (cfg.checksum === 'sum8') expected = checksumSum8(dataForChecksum);
            else if (cfg.checksum === 'xor') expected = checksumXor(dataForChecksum);
            else if (cfg.checksum === 'crc16') expected = checksumCrc16(dataForChecksum) & 0xFF;
            checksumOk = (checksumByte === expected);
        }

        return {
            header: header.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
            payload,
            payloadHex: payload.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
            payloadAscii: payload.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join(''),
            checksumOk,
            checksumByte,
            totalLen: (payloadStart + payloadLen + (checksumByte !== null ? 1 : 0)) - startPos,
        };
    }

    function renderDecodedFrame(frame) {
        const div = document.createElement('div');
        div.className = 'decoded-frame';
        let html = `<div class="frame-field"><span class="frame-label">Header:</span> <span class="frame-header">${frame.header}</span></div>`;
        html += `<div class="frame-field"><span class="frame-label">Payload (${frame.payload.length} octets):</span> <span class="frame-value">${frame.payloadHex}</span></div>`;
        html += `<div class="frame-field"><span class="frame-label">ASCII:</span> <span class="frame-value">${escapeHtml(frame.payloadAscii)}</span></div>`;

        // Numeric interpretations for small payloads
        if (frame.payload.length >= 2 && frame.payload.length <= 8) {
            const vals = [];
            if (frame.payload.length >= 2) {
                const u16be = (frame.payload[0] << 8) | frame.payload[1];
                const u16le = (frame.payload[1] << 8) | frame.payload[0];
                vals.push(`uint16 BE: ${u16be}, LE: ${u16le}`);
            }
            if (frame.payload.length >= 4) {
                const dv = new DataView(new Uint8Array(frame.payload).buffer);
                vals.push(`int32 BE: ${dv.getInt32(0)}, LE: ${dv.getInt32(0, true)}`);
                vals.push(`float32 BE: ${dv.getFloat32(0).toFixed(4)}, LE: ${dv.getFloat32(0, true).toFixed(4)}`);
            }
            html += `<div class="frame-field"><span class="frame-label">Valeurs:</span> <span class="frame-hex">${vals.join(' | ')}</span></div>`;
        }

        if (frame.checksumOk !== null) {
            const cls = frame.checksumOk ? 'frame-ok' : 'frame-err';
            const txt = frame.checksumOk ? 'OK' : `ERREUR (reçu: 0x${frame.checksumByte.toString(16).toUpperCase()})`;
            html += `<div class="frame-field"><span class="frame-label">Checksum:</span> <span class="${cls}">${txt}</span></div>`;
        }
        div.innerHTML = html;
        return div;
    }

    // --- CSV/Table decoder ----------------------------------------------------

    function tryDecodeCsv(text) {
        const trimmed = text.trim();
        // Detect separator
        const seps = [';', ',', '\t', '|'];
        let bestSep = null, bestCount = 0;
        for (const sep of seps) {
            const count = trimmed.split(sep).length;
            if (count > bestCount) { bestCount = count; bestSep = sep; }
        }
        if (!bestSep || bestCount < 2) return null;
        return trimmed.split(bestSep).map(s => s.trim());
    }

    // --- Decoder feed (called from appendLine for RX data) -------------------

    function feedDecoder(dev, text) {
        const section = dev.decoderSection;
        if (!section) return;

        const mode = dev.els.decoderMode.value;
        const output = dev.els.decoderOutput;
        const follow = dev.els.chkDecoderFollow.checked;

        // Auto-detect or forced mode
        let handled = false;

        // JSON
        if (mode === 'auto' || mode === 'json') {
            const parsed = tryParseJson(text);
            if (parsed !== null) {
                if (!handled) showDecoder(section);
                const block = document.createElement('div');
                block.className = 'json-block';
                block.innerHTML = jsonToHtml(parsed, 0);
                output.appendChild(block);
                handled = true;
            }
        }

        // Binary
        if (!handled && (mode === 'binary')) {
            const rawBytes = new TextEncoder().encode(text);
            const frame = decodeBinaryFrame(dev, rawBytes);
            if (frame) {
                showDecoder(section);
                output.appendChild(renderDecodedFrame(frame));
                handled = true;
            }
        }

        // CSV/Table
        if (!handled && (mode === 'auto' || mode === 'csv')) {
            const fields = tryDecodeCsv(text);
            if (fields && fields.length >= 2) {
                showDecoder(section);
                // If this is first CSV line or columns changed, create header
                if (!dev.decoderCsvCols || dev.decoderCsvCols !== fields.length) {
                    dev.decoderCsvCols = fields.length;
                    // Detect if first line is header (non-numeric)
                    const isHeader = fields.every(f => isNaN(Number(f)));
                    if (isHeader) {
                        dev.decoderCsvHeaders = fields;
                        // Create table with headers
                        const table = document.createElement('table');
                        table.className = 'decoded-table';
                        const thead = document.createElement('thead');
                        const tr = document.createElement('tr');
                        fields.forEach(h => { const th = document.createElement('th'); th.textContent = h; tr.appendChild(th); });
                        thead.appendChild(tr);
                        table.appendChild(thead);
                        const tbody = document.createElement('tbody');
                        table.appendChild(tbody);
                        dev.decoderCsvTable = tbody;
                        output.appendChild(table);
                        handled = true;
                    }
                }
                if (!handled && dev.decoderCsvTable) {
                    const tr = document.createElement('tr');
                    fields.forEach(f => { const td = document.createElement('td'); td.textContent = f; tr.appendChild(td); });
                    dev.decoderCsvTable.appendChild(tr);
                    handled = true;
                } else if (!handled) {
                    // No header row yet, just show values in a row
                    const row = document.createElement('div');
                    row.className = 'decoded-frame';
                    row.innerHTML = fields.map((f, i) => `<span class="frame-label">F${i + 1}:</span> <span class="frame-value">${escapeHtml(f)}</span>`).join('  ');
                    output.appendChild(row);
                    handled = true;
                }
            }
        }

        if (handled && follow) {
            output.scrollTop = output.scrollHeight;
        }

        // Limit decoder output (keep last 200 entries)
        while (output.children.length > 200) {
            output.removeChild(output.firstChild);
        }
    }

    function showDecoder(section) {
        section.classList.remove('decoder-collapsed');
    }

    // --- JSON in console (pretty-print inline) --------------------------------

    function appendJsonLine(dev, text, parsed) {
        const el = dev.els.console;
        const line = document.createElement('div');
        line.className = 'line-rx line-json';
        line.dataset.raw = text;

        if (dev.els.chkTimestamp.checked) {
            const ts = document.createElement('span');
            ts.className = 'timestamp';
            ts.textContent = `[${timestamp()}]`;
            line.appendChild(ts);
        }

        const block = document.createElement('div');
        block.className = 'json-block';
        block.innerHTML = jsonToHtml(parsed, 0);
        line.appendChild(block);

        addBookmarkHandler(line, dev);
        el.appendChild(line);
        applyFilterToLine(dev, line);
        return line;
    }

    // =========================================================================
    // Bridge
    // =========================================================================

    function buildBridgeUI() {
        bridgeRules.length = 0;
        bridgeRulesEl.innerHTML = '';

        if (deviceCount < 2) {
            bridgeSection.style.display = 'none';
            return;
        }
        bridgeSection.style.display = '';

        for (let i = 0; i < deviceCount; i++) {
            for (let j = 0; j < deviceCount; j++) {
                if (i === j) continue;
                const rule = { from: i, to: j, active: false, el: null };
                const row = document.createElement('div');
                row.className = 'bridge-rule';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'bridge-cb';
                cb.addEventListener('change', () => { rule.active = cb.checked; updateBridgeStates(); });
                const label = document.createElement('span');
                label.className = 'bridge-label';
                label.textContent = `Device ${i + 1}  →  Device ${j + 1}`;
                const statusSpan = document.createElement('span');
                statusSpan.className = 'bridge-status';
                row.appendChild(cb);
                row.appendChild(label);
                row.appendChild(statusSpan);
                bridgeRulesEl.appendChild(row);
                rule.el = { checkbox: cb, status: statusSpan, row };
                bridgeRules.push(rule);
            }
        }
        updateBridgeStates();
    }

    function updateBridgeStates() {
        for (const rule of bridgeRules) {
            const srcDev = devices[rule.from];
            const dstDev = devices[rule.to];
            const srcOk = srcDev && isActive(srcDev);
            const dstOk = dstDev && isActive(dstDev);
            if (rule.active && srcOk && dstOk) {
                rule.el.status.textContent = 'actif';
                rule.el.status.className = 'bridge-status bridge-active';
            } else if (rule.active) {
                rule.el.status.textContent = 'en attente';
                rule.el.status.className = 'bridge-status bridge-waiting';
            } else {
                rule.el.status.textContent = '';
                rule.el.status.className = 'bridge-status';
            }
        }
    }

    async function bridgeForward(srcDev, message) {
        for (const rule of bridgeRules) {
            if (!rule.active) continue;
            if (rule.from !== srcDev.index) continue;
            const dstDev = devices[rule.to];
            if (!dstDev || !isActive(dstDev)) continue;
            const tag = `[bridge D${srcDev.index + 1}→D${dstDev.index + 1}]`;
            if (dstDev.simulated) {
                trackRx(dstDev);
                appendLine(dstDev, `${tag} ${message}`, 'line-bridge');
                feedPlotter(dstDev, message);
            } else if (dstDev.writer) {
                const ending = getLineEnding(dstDev);
                try {
                    await dstDev.writer.write(message + ending);
                    trackRx(dstDev);
                    appendLine(dstDev, `${tag} ${message}`, 'line-bridge');
                } catch (err) {
                    appendLine(dstDev, `Erreur bridge : ${err.message}`, 'line-err');
                }
            }
        }
    }

    // =========================================================================
    // Keyboard shortcuts
    // =========================================================================

    document.addEventListener('keydown', (e) => {
        // Find the focused device (default to first)
        let focusedDev = devices[0];
        const activeEl = document.activeElement;
        if (activeEl) {
            const panel = activeEl.closest('.device-panel');
            if (panel) {
                const idx = parseInt(panel.dataset.deviceIndex, 10);
                if (devices[idx]) focusedDev = devices[idx];
            }
        }
        if (!focusedDev) return;

        if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            focusedDev.els.console.innerHTML = '';
            focusedDev.consoleData = [];
            focusedDev.lineCount = 0;
            focusedDev.rxBytes = 0;
            focusedDev.els.rxLineCount.textContent = '0 lignes';
        }
        if (e.ctrlKey && e.key === 'f') {
            e.preventDefault();
            focusedDev.els.filterInput.focus();
        }
        if (e.ctrlKey && e.key === 'r') {
            e.preventDefault();
            toggleRecord(focusedDev);
        }
    });

    // =========================================================================
    // Device count management
    // =========================================================================

    function rebuildDevices(count) {
        deviceCount = count;
        removeAllDevicePanels();
        for (let i = 0; i < count; i++) {
            createDevicePanel(i);
        }
        container.classList.toggle('multi', count > 1);
        buildBridgeUI();
        // Update logic analyzer sources
        if (window._updateLogicSources) window._updateLogicSources();
        // Phase 8: re-attach observers for new devices
        if (window._onDevicesRebuilt) window._onDevicesRebuilt();
        // Re-apply i18n to newly cloned elements
        if (window.ESP32Tester && window.ESP32Tester._reapplyLang) window.ESP32Tester._reapplyLang();
    }

    // Sidebar device count sync
    const sidebarDevCount = document.getElementById('sidebarDeviceCount');
    function syncDeviceCount(source) {
        const val = parseInt(source.value, 10);
        deviceCountSel.value = val;
        if (sidebarDevCount) sidebarDevCount.value = val;
        rebuildDevices(val);
    }
    deviceCountSel.addEventListener('change', () => syncDeviceCount(deviceCountSel));
    if (sidebarDevCount) {
        sidebarDevCount.addEventListener('change', () => syncDeviceCount(sidebarDevCount));
    }

    // Export / Import macros buttons
    document.querySelector('.btn-export-macros').addEventListener('click', exportMacrosToFile);
    document.querySelector('.btn-import-macros').addEventListener('click', importMacrosFromFile);
    document.querySelector('.btn-export-session').addEventListener('click', exportSessionHTML);

    if (hasWebSerial) navigator.serial.addEventListener('disconnect', (e) => {
        for (const dev of devices) {
            if (dev.port && e.target === dev.port) {
                appendLine(dev, 'ESP32 déconnecté', 'line-err');
                setDeviceActive(dev, false);
                dev.port = null;
                // Disconnect alert
                playBeep(400, 0.2);
                setTimeout(() => playBeep(300, 0.3), 250);
                if (Notification.permission === 'granted') {
                    new Notification(`ESP32 Device ${dev.index + 1}`, { body: 'Déconnecté !', tag: `esp32-disconnect-${dev.index}` });
                }
                showAlertBanner(dev, 'DISCONNECT', 'Device déconnecté du port série');
            }
        }
    });

    // =========================================================================
    // Expose devices for tools.js (future)
    // =========================================================================

    window.ESP32Tester = {
        getDevices: () => devices,
        sendToDevice: async (dev, text) => {
            if (dev.simulated) { simulateRx(dev, text); }
            else if (dev.writer) { await serialWrite(dev, text + getLineEnding(dev)); }
        },
        appendLine,
    };

    // =========================================================================
    // Init
    // =========================================================================

    rebuildDevices(parseInt(deviceCountSel.value, 10));

    // Sync sidebar device count with header
    if (sidebarDevCount) sidebarDevCount.value = deviceCountSel.value;

    // Auto-connect relay
    setTimeout(() => {
        if (isElectron) {
            // Electron: relay intégré, connecter via IPC + écouter les events
            window.electronRelay.onEvent((msg) => {
                // Dispatch to the appropriate device based on connId
                for (const dev of devices) {
                    if (dev.connectionType === 'websocket') {
                        handleRelayMessage(dev, msg);
                    }
                }
            });
            for (const dev of devices) {
                connectRelay(dev);
            }
            // Show version + update status
            window.electronRelay.getVersion().then(v => {
                document.title = `ESP32 Web Tester v${v}`;
            });
            window.electronRelay.onUpdateStatus((msg) => {
                console.log('[Update]', msg);
            });
        } else if (location.protocol === 'http:' || location.protocol === 'https:') {
            // Browser served by relay.js: auto-connect WebSocket
            const autoRelayUrl = `ws://${location.host}`;
            for (const dev of devices) {
                dev.els.netRelayUrl.value = autoRelayUrl;
                connectRelay(dev);
            }
        }
    }, 300);

    // =========================================================================
    // View toggles (Traceur, Décodeur, Analyseur logique)
    // =========================================================================

    const chkPlotter = document.getElementById('chkShowPlotter');
    const chkDecoder = document.getElementById('chkShowDecoder');
    const chkLogic   = document.getElementById('chkShowLogic');
    const chkScript  = document.getElementById('chkShowScript');
    const chkDataTable = document.getElementById('chkShowDataTable');
    const chkPinMap  = document.getElementById('chkShowPinMap');

    function syncViewToggle(chk, cls) {
        if (chk.checked) document.body.classList.add(cls);
        else document.body.classList.remove(cls);
    }

    chkPlotter.addEventListener('change', () => syncViewToggle(chkPlotter, 'show-plotter'));
    chkDecoder.addEventListener('change', () => syncViewToggle(chkDecoder, 'show-decoder'));
    chkLogic.addEventListener('change', () => syncViewToggle(chkLogic, 'show-logic'));
    if (chkPinMap) chkPinMap.addEventListener('change', () => syncViewToggle(chkPinMap, 'show-pinmap'));
    chkScript.addEventListener('change', () => {
        for (const d of devices) {
            if (d.els.scriptSection) d.els.scriptSection.style.display = chkScript.checked ? '' : 'none';
        }
    });
    chkDataTable.addEventListener('change', () => {
        for (const d of devices) {
            if (d.els.liveTableSection) d.els.liveTableSection.style.display = chkDataTable.checked ? '' : 'none';
        }
    });

    // Restore from localStorage
    if (localStorage.getItem('view-plotter') === '1') { chkPlotter.checked = true; syncViewToggle(chkPlotter, 'show-plotter'); }
    if (localStorage.getItem('view-decoder') === '1') { chkDecoder.checked = true; syncViewToggle(chkDecoder, 'show-decoder'); }
    if (localStorage.getItem('view-logic') === '1')   { chkLogic.checked = true;   syncViewToggle(chkLogic, 'show-logic'); }
    if (localStorage.getItem('view-script') === '1')   { chkScript.checked = true; for (const d of devices) { if (d.els.scriptSection) d.els.scriptSection.style.display = ''; } }
    if (localStorage.getItem('view-datatable') === '1') { chkDataTable.checked = true; for (const d of devices) { if (d.els.liveTableSection) d.els.liveTableSection.style.display = ''; } }
    if (chkPinMap && localStorage.getItem('view-pinmap') === '1') { chkPinMap.checked = true; syncViewToggle(chkPinMap, 'show-pinmap'); }

    // Save on change
    chkPlotter.addEventListener('change', () => localStorage.setItem('view-plotter', chkPlotter.checked ? '1' : '0'));
    chkDecoder.addEventListener('change', () => localStorage.setItem('view-decoder', chkDecoder.checked ? '1' : '0'));
    chkLogic.addEventListener('change', () => localStorage.setItem('view-logic', chkLogic.checked ? '1' : '0'));
    chkScript.addEventListener('change', () => localStorage.setItem('view-script', chkScript.checked ? '1' : '0'));
    chkDataTable.addEventListener('change', () => localStorage.setItem('view-datatable', chkDataTable.checked ? '1' : '0'));
    if (chkPinMap) chkPinMap.addEventListener('change', () => localStorage.setItem('view-pinmap', chkPinMap.checked ? '1' : '0'));

    // =========================================================================
    // Plotter modes: bottom (default) / side / floating
    // =========================================================================

    function resetPlotterMode(section) {
        const group = section.closest('.device-group');
        section.classList.remove('plotter-floating');
        if (group) {
            group.classList.remove('plotter-side');
            group.style.gridTemplateColumns = '';
        }
        section.style.left = '';
        section.style.top = '';
        section.style.width = '';
        section.style.height = '';
    }

    // ▶ Dock side (snap right of device)
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-plotter-dock-side');
        if (!btn) return;
        const section = btn.closest('.device-plotter-section');
        if (!section) return;
        const group = section.closest('.device-group');
        if (!group) return;

        if (group.classList.contains('plotter-side')) {
            // Back to bottom
            resetPlotterMode(section);
            btn.textContent = '▶';
            btn.title = 'Aimanter à droite du device';
        } else {
            // Go to side mode
            resetPlotterMode(section);
            group.classList.add('plotter-side');
            btn.textContent = '▼';
            btn.title = 'Remettre en dessous';
        }
    });

    // ⇱ Float (detach) — Electron: real child window / Browser: CSS floating
    function getDevFromSection(section) {
        const group = section.closest('.device-group');
        if (!group) return null;
        const panel = group.querySelector('.device-panel');
        if (!panel) return null;
        const idx = parseInt(panel.dataset.deviceIndex, 10);
        return devices[idx] || null;
    }

    function redockPlotter(deviceIdx) {
        const dev = devices[deviceIdx];
        if (!dev) return;
        dev.plotterPopup = false;
        dev._plotterPopupWin = null;
        const group = dev.els.panel.closest('.device-group');
        if (!group) return;
        const section = group.querySelector('.device-plotter-section');
        if (!section) return;
        section.style.display = '';
        const btn = section.querySelector('.btn-plotter-undock');
        if (btn) { btn.textContent = '⇱'; btn.title = 'Détacher en fenêtre flottante'; }
        const sideBtn = section.querySelector('.btn-plotter-dock-side');
        if (sideBtn) { sideBtn.textContent = '▶'; sideBtn.title = 'Aimanter à droite du device'; }
    }

    // Listen for child window closed (Electron)
    if (isElectron && window.electronRelay.onPlotterWindowClosed) {
        window.electronRelay.onPlotterWindowClosed((deviceIdx) => {
            redockPlotter(deviceIdx);
        });
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-plotter-undock');
        if (!btn) return;
        const section = btn.closest('.device-plotter-section');
        if (!section) return;
        const dev = getDevFromSection(section);

        // Electron mode: open real child window
        if (isElectron && window.electronRelay.openPlotterWindow) {
            if (dev && dev.plotterPopup) {
                // Already popped out — close it (will trigger redock via event)
                window.electronRelay.closePlotterWindow(dev.index);
                return;
            }
            if (dev) {
                // Gather plotter config from toolbar
                const sep = section.querySelector('.plotter-sep').value;
                const stripStart = section.querySelector('.plotter-strip-start').value;
                const stripEnd = section.querySelector('.plotter-strip-end').value;
                const maxPts = section.querySelector('.plotter-max-pts').value;
                const multiY = section.querySelector('.chk-multi-y').checked ? '1' : '0';
                resetPlotterMode(section);
                section.style.display = 'none';
                dev.plotterPopup = true;
                window.electronRelay.openPlotterWindow(dev.index, { sep, stripStart, stripEnd, maxPts, multiY });
                btn.textContent = '⇲';
                btn.title = 'Rattacher';
            }
            return;
        }

        // Browser fallback: window.open() popup
        if (!dev) return;
        if (dev.plotterPopup) {
            // Already popped out — close it
            if (dev._plotterPopupWin && !dev._plotterPopupWin.closed) {
                dev._plotterPopupWin.close();
            }
            redockPlotter(dev.index);
            return;
        }
        // Gather plotter config from toolbar
        const sep = section.querySelector('.plotter-sep').value;
        const stripStart = section.querySelector('.plotter-strip-start').value;
        const stripEnd = section.querySelector('.plotter-strip-end').value;
        const maxPts = section.querySelector('.plotter-max-pts').value;
        const multiY = section.querySelector('.chk-multi-y').checked ? '1' : '0';
        const qs = `device=${dev.index}&sep=${encodeURIComponent(sep)}&stripStart=${stripStart}&stripEnd=${stripEnd}&maxPts=${maxPts}&multiY=${multiY}`;
        const popup = window.open(`plotter-popup.html?${qs}`, `plotter_${dev.index}`, 'width=750,height=500,resizable=yes,scrollbars=no');
        if (popup) {
            resetPlotterMode(section);
            section.style.display = 'none';
            dev.plotterPopup = true;
            dev._plotterPopupWin = popup;
            btn.textContent = '⇲';
            btn.title = 'Rattacher';
            // Poll for popup close
            const checkClosed = setInterval(() => {
                if (!popup || popup.closed) {
                    clearInterval(checkClosed);
                    redockPlotter(dev.index);
                    dev._plotterPopupWin = null;
                }
            }, 400);
        }
    });

    // Drag plotter via handle — auto-floats if not already floating
    // Snap zones: right of device panel → dock side, bottom → dock bottom
    document.addEventListener('mousedown', (e) => {
        const handle = e.target.closest('.plotter-drag-handle');
        if (!handle) return;
        const section = handle.closest('.device-plotter-section');
        if (!section) return;
        const group = section.closest('.device-group');
        if (!group) return;
        const panel = group.querySelector('.device-panel');
        if (!panel) return;

        e.preventDefault();

        // If not floating yet, switch to floating mode at cursor position
        if (!section.classList.contains('plotter-floating')) {
            const rect = section.getBoundingClientRect();
            group.classList.remove('plotter-side');
            group.style.gridTemplateColumns = '';
            section.classList.add('plotter-floating');
            section.style.left = Math.max(0, e.clientX - 100) + 'px';
            section.style.top = Math.max(0, e.clientY - 15) + 'px';
            section.style.width = Math.min(rect.width, window.innerWidth * 0.7) + 'px';
            section.style.height = rect.height + 'px';
        }

        const startX = e.clientX, startY = e.clientY;
        const startL = parseInt(section.style.left, 10) || 0;
        const startT = parseInt(section.style.top, 10) || 0;

        // Create snap indicator overlay
        let snapIndicator = document.createElement('div');
        snapIndicator.className = 'plotter-snap-indicator';
        snapIndicator.style.display = 'none';
        document.body.appendChild(snapIndicator);

        let snapTarget = null; // 'side' | 'bottom' | null

        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';

        const SNAP_DISTANCE = 60;

        const onMove = (ev) => {
            section.style.left = (startL + ev.clientX - startX) + 'px';
            section.style.top  = (startT + ev.clientY - startY) + 'px';

            // Check snap zones against the device panel
            const panelRect = panel.getBoundingClientRect();
            const mx = ev.clientX;
            const my = ev.clientY;

            // Right edge snap zone: mouse is near the right side of the panel and vertically overlapping
            const nearRight = mx > panelRect.right - SNAP_DISTANCE && mx < panelRect.right + SNAP_DISTANCE * 2
                && my > panelRect.top - 30 && my < panelRect.bottom + 30;
            // Bottom snap zone: mouse is near the bottom of the panel and horizontally overlapping
            const nearBottom = my > panelRect.bottom - SNAP_DISTANCE && my < panelRect.bottom + SNAP_DISTANCE * 2
                && mx > panelRect.left - 30 && mx < panelRect.right + 30;

            if (nearRight) {
                snapTarget = 'side';
                snapIndicator.style.display = 'block';
                snapIndicator.style.left = panelRect.right + 'px';
                snapIndicator.style.top = panelRect.top + 'px';
                snapIndicator.style.width = '4px';
                snapIndicator.style.height = panelRect.height + 'px';
                snapIndicator.className = 'plotter-snap-indicator snap-active';
            } else if (nearBottom) {
                snapTarget = 'bottom';
                snapIndicator.style.display = 'block';
                snapIndicator.style.left = panelRect.left + 'px';
                snapIndicator.style.top = panelRect.bottom + 'px';
                snapIndicator.style.width = panelRect.width + 'px';
                snapIndicator.style.height = '4px';
                snapIndicator.className = 'plotter-snap-indicator snap-active';
            } else {
                snapTarget = null;
                snapIndicator.style.display = 'none';
            }
        };

        const onUp = () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            snapIndicator.remove();

            if (snapTarget === 'side') {
                // Dock to right side
                resetPlotterMode(section);
                group.classList.add('plotter-side');
                const sideBtn = section.querySelector('.btn-plotter-dock-side');
                if (sideBtn) { sideBtn.textContent = '▼'; sideBtn.title = 'Remettre en dessous'; }
            } else if (snapTarget === 'bottom') {
                // Dock back to bottom
                resetPlotterMode(section);
                const sideBtn = section.querySelector('.btn-plotter-dock-side');
                if (sideBtn) { sideBtn.textContent = '▶'; sideBtn.title = 'Aimanter à droite du device'; }
            }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    // Resize handle between device panel and plotter in side mode (CSS Grid)
    document.addEventListener('mousedown', (e) => {
        const handle = e.target.closest('.plotter-side-resize-handle');
        if (!handle) return;
        const group = handle.closest('.device-group');
        if (!group || !group.classList.contains('plotter-side')) return;

        e.preventDefault();
        const groupRect = group.getBoundingClientRect();
        const handleW = handle.getBoundingClientRect().width;
        const totalW = groupRect.width - handleW;

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMove = (ev) => {
            const panelW = Math.max(280, Math.min(totalW - 250, ev.clientX - groupRect.left));
            const plotterW = totalW - panelW;
            group.style.gridTemplateColumns = `${panelW}px ${handleW}px ${plotterW}px`;
        };
        const onUp = () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    // =========================================================================
    // Phase 9.1 — Console tabs (filter presets)
    // =========================================================================

    function setupConsoleTabs(dev) {
        const tabs = dev.els.consoleTabs;
        if (!tabs || !tabs.length) return;

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                // Deactivate all tabs in this panel
                const allTabs = tab.parentElement.querySelectorAll('.console-tab');
                allTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                // Apply the tab's filter regex to the filter input
                const filter = tab.dataset.tabFilter || '';
                dev.els.filterInput.value = filter;
                reapplyFilter(dev);
            });
        });

        if (dev.els.btnTabAdd) {
            dev.els.btnTabAdd.addEventListener('click', () => {
                const name = prompt(t('prompt.tabName'));
                if (!name) return;
                const regex = prompt(t('prompt.tabRegex'), '');
                if (regex === null) return;
                const btn = document.createElement('button');
                btn.className = 'console-tab';
                btn.dataset.tabFilter = regex;
                btn.textContent = name;
                btn.title = regex || '(tout)';
                btn.addEventListener('click', () => {
                    const allTabs = btn.parentElement.querySelectorAll('.console-tab');
                    allTabs.forEach(t => t.classList.remove('active'));
                    btn.classList.add('active');
                    dev.els.filterInput.value = regex;
                    reapplyFilter(dev);
                });
                // Right-click to remove custom tab
                btn.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    if (confirm(t('prompt.confirmDeleteTab', { name }))) {
                        if (btn.classList.contains('active')) {
                            // Switch to first tab
                            const first = btn.parentElement.querySelector('.console-tab');
                            if (first) first.click();
                        }
                        btn.remove();
                    }
                });
                dev.els.btnTabAdd.before(btn);
            });
        }
    }

    // =========================================================================
    // Phase 9.2 — Autocomplete popup
    // =========================================================================

    function setupAutocomplete(dev) {
        const input = dev.els.serialInput;
        if (!input) return;

        // Create autocomplete popup element
        const popup = document.createElement('div');
        popup.className = 'autocomplete-popup';
        input.closest('.console-input-row').appendChild(popup);

        let selectedIdx = -1;
        let matches = [];

        function updatePopup() {
            const val = input.value;
            if (!val || dev.cmdHistory.length === 0) {
                popup.classList.remove('visible');
                matches = [];
                selectedIdx = -1;
                return;
            }
            const lower = val.toLowerCase();
            // Find matching history entries (most recent first, deduplicated)
            const seen = new Set();
            matches = [];
            for (let i = dev.cmdHistory.length - 1; i >= 0 && matches.length < 10; i--) {
                const cmd = dev.cmdHistory[i];
                const cmdLower = cmd.toLowerCase();
                if (!seen.has(cmdLower) && cmdLower.includes(lower) && cmd !== val) {
                    seen.add(cmdLower);
                    matches.push(cmd);
                }
            }
            if (matches.length === 0) {
                popup.classList.remove('visible');
                selectedIdx = -1;
                return;
            }
            popup.innerHTML = '';
            matches.forEach((m, i) => {
                const item = document.createElement('div');
                item.className = 'autocomplete-item';
                item.textContent = m;
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    input.value = m;
                    popup.classList.remove('visible');
                    input.focus();
                });
                popup.appendChild(item);
            });
            selectedIdx = -1;
            popup.classList.add('visible');
        }

        function highlightItem(idx) {
            const items = popup.querySelectorAll('.autocomplete-item');
            items.forEach((el, i) => el.classList.toggle('selected', i === idx));
        }

        input.addEventListener('input', updatePopup);
        input.addEventListener('blur', () => {
            setTimeout(() => popup.classList.remove('visible'), 150);
        });

        // Override keydown for autocomplete navigation
        input.addEventListener('keydown', (e) => {
            if (!popup.classList.contains('visible')) return;

            if (e.key === 'ArrowUp') {
                // Only intercept when autocomplete is visible and we're navigating it
                if (selectedIdx <= 0 && matches.length > 0) {
                    // Let the default history handler take over once we go past the top
                    if (selectedIdx === 0) {
                        popup.classList.remove('visible');
                        return;
                    }
                }
            }

            if (e.key === 'Tab' || (e.key === 'ArrowDown' && popup.classList.contains('visible'))) {
                e.preventDefault();
                e.stopImmediatePropagation();
                selectedIdx = Math.min(selectedIdx + 1, matches.length - 1);
                highlightItem(selectedIdx);
                return;
            }
            if (e.key === 'ArrowUp' && popup.classList.contains('visible') && selectedIdx > 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                selectedIdx--;
                highlightItem(selectedIdx);
                return;
            }
            if (e.key === 'Enter' && selectedIdx >= 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                input.value = matches[selectedIdx];
                popup.classList.remove('visible');
                return;
            }
            if (e.key === 'Escape') {
                popup.classList.remove('visible');
                selectedIdx = -1;
            }
        }, true); // capture phase to intercept before history handler
    }

    // =========================================================================
    // Phase 9.3 — Highlight rules (regex coloring)
    // =========================================================================

    const HL_COLORS = [
        '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7',
        '#da77f2', '#ff8787', '#74c0fc', '#a9e34b', '#f783ac'
    ];

    function loadHighlightRules(dev) {
        try {
            const raw = localStorage.getItem('esp32_highlights_' + dev.index);
            if (raw) dev.highlightRules = JSON.parse(raw);
        } catch (_) {}
    }

    function saveHighlightRules(dev) {
        try {
            localStorage.setItem('esp32_highlights_' + dev.index, JSON.stringify(dev.highlightRules));
        } catch (_) {}
    }

    function renderHighlightRules(dev) {
        const list = dev.els.highlightsList;
        if (!list) return;
        list.innerHTML = '';
        dev.highlightRules.forEach((rule, i) => {
            const el = document.createElement('div');
            el.className = 'highlight-rule';
            el.innerHTML = `
                <span class="hl-match" style="background:${rule.color};color:#000;padding:0 4px;">${rule.pattern}</span>
                <label><input type="checkbox" ${rule.enabled ? 'checked' : ''} data-hl-idx="${i}"> actif</label>
                <button class="btn btn-small btn-danger" data-hl-del="${i}" style="padding:1px 5px;">×</button>
            `;
            list.appendChild(el);
        });

        // Bind toggle & delete
        list.querySelectorAll('[data-hl-idx]').forEach(chk => {
            chk.addEventListener('change', () => {
                dev.highlightRules[parseInt(chk.dataset.hlIdx)].enabled = chk.checked;
                saveHighlightRules(dev);
                reapplyHighlights(dev);
            });
        });
        list.querySelectorAll('[data-hl-del]').forEach(btn => {
            btn.addEventListener('click', () => {
                dev.highlightRules.splice(parseInt(btn.dataset.hlDel), 1);
                saveHighlightRules(dev);
                renderHighlightRules(dev);
                reapplyHighlights(dev);
            });
        });
    }

    function applyHighlightsToLine(dev, lineEl) {
        if (!dev.highlightRules || dev.highlightRules.length === 0) return;
        const raw = lineEl.dataset.raw || lineEl.textContent;
        for (const rule of dev.highlightRules) {
            if (!rule.enabled) continue;
            try {
                const re = new RegExp(rule.pattern, 'gi');
                if (re.test(raw)) {
                    lineEl.style.borderLeft = `3px solid ${rule.color}`;
                    lineEl.style.paddingLeft = '4px';
                    // Also highlight matched text inside the line
                    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, null, false);
                    const textNodes = [];
                    while (walker.nextNode()) textNodes.push(walker.currentNode);
                    for (const node of textNodes) {
                        const parts = node.textContent.split(new RegExp(`(${rule.pattern})`, 'gi'));
                        if (parts.length <= 1) continue;
                        const frag = document.createDocumentFragment();
                        parts.forEach(part => {
                            if (new RegExp(rule.pattern, 'i').test(part)) {
                                const span = document.createElement('span');
                                span.className = 'hl-match';
                                span.style.background = rule.color;
                                span.style.color = '#000';
                                span.textContent = part;
                                frag.appendChild(span);
                            } else {
                                frag.appendChild(document.createTextNode(part));
                            }
                        });
                        node.parentNode.replaceChild(frag, node);
                    }
                    return; // First matching rule wins for border
                }
            } catch (_) {}
        }
    }

    function reapplyHighlights(dev) {
        const lines = dev.els.console.querySelectorAll('div');
        for (const line of lines) {
            // Reset highlight styling
            line.style.borderLeft = '';
            line.style.paddingLeft = '';
            // Remove highlight spans (revert to text)
            line.querySelectorAll('.hl-match').forEach(span => {
                span.replaceWith(document.createTextNode(span.textContent));
            });
            applyHighlightsToLine(dev, line);
        }
    }

    function setupHighlights(dev) {
        if (!dev.els.btnHighlightAdd) return;
        renderHighlightRules(dev);

        dev.els.btnHighlightAdd.addEventListener('click', () => {
            const pattern = prompt(t('prompt.highlightRegex'));
            if (!pattern) return;
            const colorIdx = dev.highlightRules.length % HL_COLORS.length;
            dev.highlightRules.push({ pattern, color: HL_COLORS[colorIdx], enabled: true });
            saveHighlightRules(dev);
            renderHighlightRules(dev);
            reapplyHighlights(dev);
        });
    }

    // =========================================================================
    // Phase 9.4 — File line-by-line sender
    // =========================================================================

    function setupFileSender(dev) {
        if (!dev.els.fileSenderToggle) return;

        // Toggle collapse
        dev.els.fileSenderToggle.addEventListener('click', () => {
            const body = dev.els.fileSenderBody;
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : '';
            dev.els.fileSenderToggle.textContent = open ? '▾' : '▴';
        });

        // File select
        dev.els.btnFileSelect.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.txt,.csv,.log,.gcode,.hex,.bin,*';
            fileInput.addEventListener('change', () => {
                const file = fileInput.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    const text = reader.result;
                    dev.fileSender.rawLines = text.split(/\r?\n/);
                    // Remove trailing empty line
                    if (dev.fileSender.rawLines.length > 0 && dev.fileSender.rawLines[dev.fileSender.rawLines.length - 1] === '') {
                        dev.fileSender.rawLines.pop();
                    }
                    dev.fileSender.lines = dev.fileSender.rawLines.slice();
                    dev.fileSender.mappedLines = null;
                    dev.fileSender.index = 0;
                    dev.fileSender.fileName = file.name;
                    dev.fileSender.paused = false;
                    dev.els.fileSenderName.textContent = `${file.name} (${dev.fileSender.rawLines.length} lignes)`;
                    dev.els.btnFileStart.disabled = false;
                    dev.els.fileSenderProgressBar.style.width = '0%';
                    dev.els.fileSenderStatus.textContent = 'Prêt';

                    // Detect columns (tab, semicolon, comma separated)
                    fileSenderDetectColumns(dev);
                };
                reader.readAsText(file);
            });
            fileInput.click();
        });

        // Start sending
        dev.els.btnFileStart.addEventListener('click', () => {
            if (!dev.fileSender.lines || !isActive(dev)) {
                showToast(t('toast.noFileOrDevice'), 'error');
                return;
            }
            dev.fileSender.index = 0;
            dev.fileSender.paused = false;
            dev.els.btnFileStart.disabled = true;
            dev.els.btnFileStop.disabled = false;
            dev.els.btnFilePause.disabled = false;
            dev.els.btnFilePause.textContent = 'Pause';
            fileSenderTick(dev);
        });

        // Stop
        dev.els.btnFileStop.addEventListener('click', () => {
            fileSenderStop(dev);
        });

        // Column mapping apply
        if (dev.els.btnFileColApply) {
            dev.els.btnFileColApply.addEventListener('click', () => {
                fileSenderApplyColumns(dev);
            });
            // Also apply on Enter in column select input
            dev.els.fileSenderColSelect.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') fileSenderApplyColumns(dev);
            });
        }

        // Pause / Resume
        dev.els.btnFilePause.addEventListener('click', () => {
            if (dev.fileSender.paused) {
                dev.fileSender.paused = false;
                dev.els.btnFilePause.textContent = 'Pause';
                dev.els.fileSenderStatus.textContent = 'Envoi...';
                fileSenderTick(dev);
            } else {
                dev.fileSender.paused = true;
                dev.els.btnFilePause.textContent = 'Reprendre';
                dev.els.fileSenderStatus.textContent = 'En pause';
                if (dev.fileSender.timer) {
                    clearTimeout(dev.fileSender.timer);
                    dev.fileSender.timer = null;
                }
            }
        });
    }

    function fileSenderTick(dev) {
        if (dev.fileSender.paused) return;
        const lines = dev.fileSender.lines;
        if (!lines) return;

        if (dev.fileSender.index >= lines.length) {
            // End of file
            const loop = dev.els.chkFileSenderLoop && dev.els.chkFileSenderLoop.checked;
            if (loop) {
                dev.fileSender.index = 0;
                dev.els.fileSenderStatus.textContent = 'Boucle...';
            } else {
                fileSenderStop(dev);
                dev.els.fileSenderStatus.textContent = 'Terminé';
                showToast(t('toast.fileSendDone'), 'success');
                return;
            }
        }

        if (!isActive(dev)) {
            fileSenderStop(dev);
            dev.els.fileSenderStatus.textContent = 'Déconnecté';
            return;
        }

        const mapped = dev.fileSender.mappedLines || lines;
        const line = mapped[dev.fileSender.index];
        sendRawCommand(dev, line);
        dev.fileSender.index++;

        // Update progress
        const pct = Math.round((dev.fileSender.index / lines.length) * 100);
        dev.els.fileSenderProgressBar.style.width = pct + '%';
        dev.els.fileSenderStatus.textContent = `${dev.fileSender.index}/${lines.length} (${pct}%)`;

        // Schedule next line
        const freq = parseInt(dev.els.fileSenderFreq.value, 10) || 100;
        dev.fileSender.timer = setTimeout(() => fileSenderTick(dev), freq);
    }

    function fileSenderStop(dev) {
        if (dev.fileSender.timer) {
            clearTimeout(dev.fileSender.timer);
            dev.fileSender.timer = null;
        }
        dev.fileSender.paused = false;
        dev.els.btnFileStart.disabled = !dev.fileSender.lines;
        dev.els.btnFileStop.disabled = true;
        dev.els.btnFilePause.disabled = true;
        dev.els.btnFilePause.textContent = 'Pause';
    }

    function fileSenderDetectColumns(dev) {
        if (!dev.els.fileSenderColumns) return;
        const rawLines = dev.fileSender.rawLines;
        if (!rawLines || rawLines.length === 0) {
            dev.els.fileSenderColumns.style.display = 'none';
            return;
        }

        // Auto-detect separator from first non-empty line
        let sep = '\t';
        const sample = rawLines.find(l => l.trim().length > 0) || '';
        if (sample.includes('\t')) sep = '\t';
        else if (sample.split(';').length > 1) sep = ';';
        else if (sample.split(',').length > 1) sep = ',';
        else if (sample.split(/\s{2,}/).length > 1) sep = /\s+/;

        const cols = sample.split(sep);
        if (cols.length <= 1) {
            // Single column, no need for column mapping
            dev.els.fileSenderColumns.style.display = 'none';
            dev.fileSender.detectedSep = null;
            return;
        }

        dev.fileSender.detectedSep = sep;
        dev.fileSender.colCount = cols.length;
        dev.els.fileSenderColumns.style.display = '';

        const sepLabel = sep === '\t' ? 'TAB' : (sep instanceof RegExp ? 'espaces' : `"${sep}"`);
        dev.els.fileSenderColInfo.textContent = `${cols.length} colonnes détectées (sép: ${sepLabel})`;

        // Show preview of first 3 lines with column numbers
        const preview = dev.els.fileSenderColPreview;
        preview.innerHTML = '';
        const header = document.createElement('div');
        header.style.color = 'var(--accent)';
        header.style.fontWeight = '600';
        header.textContent = cols.map((_, i) => `[Col${i + 1}]`).join('  ');
        preview.appendChild(header);
        for (let i = 0; i < Math.min(3, rawLines.length); i++) {
            const row = document.createElement('div');
            const parts = rawLines[i].split(sep);
            row.textContent = parts.map(p => p.trim()).join('  |  ');
            preview.appendChild(row);
        }
        if (rawLines.length > 3) {
            const more = document.createElement('div');
            more.style.color = 'var(--text-muted)';
            more.textContent = `... (${rawLines.length - 3} lignes de plus)`;
            preview.appendChild(more);
        }

        // Pre-fill with all columns
        dev.els.fileSenderColSelect.value = cols.map((_, i) => i + 1).join(';');
        dev.els.fileSenderColResult.style.display = 'none';
    }

    function fileSenderApplyColumns(dev) {
        const rawLines = dev.fileSender.rawLines;
        if (!rawLines || !dev.fileSender.detectedSep) return;

        const selectStr = dev.els.fileSenderColSelect.value.trim();
        if (!selectStr) {
            // Empty = send all columns as-is
            dev.fileSender.mappedLines = null;
            dev.fileSender.lines = rawLines.slice();
            dev.els.fileSenderColResult.style.display = 'none';
            showToast(t('toast.allColsSent'), 'info', 1500);
            return;
        }

        // Parse column indices (1-based, separated by ; or ,)
        const indices = selectStr.split(/[;,]/).map(s => parseInt(s.trim(), 10) - 1).filter(n => !isNaN(n) && n >= 0);
        if (indices.length === 0) {
            showToast(t('toast.invalidColIdx'), 'error');
            return;
        }

        const outSep = dev.els.fileSenderColSep.value || ';';
        const sep = dev.fileSender.detectedSep;

        const mapped = rawLines.map(line => {
            const parts = line.split(sep);
            return indices.map(i => (i < parts.length ? parts[i].trim() : '')).join(outSep);
        });

        dev.fileSender.mappedLines = mapped;
        dev.fileSender.lines = rawLines.slice(); // keep rawLines length for progress

        // Show preview of result
        const result = dev.els.fileSenderColResult;
        result.style.display = '';
        result.innerHTML = '';
        const hdr = document.createElement('div');
        hdr.style.color = 'var(--accent)';
        hdr.style.fontWeight = '600';
        hdr.textContent = `Résultat: colonnes [${indices.map(i => i + 1).join(', ')}] → sép "${outSep}"`;
        result.appendChild(hdr);
        for (let i = 0; i < Math.min(3, mapped.length); i++) {
            const row = document.createElement('div');
            row.textContent = mapped[i];
            result.appendChild(row);
        }
        if (mapped.length > 3) {
            const more = document.createElement('div');
            more.style.color = 'var(--text-muted)';
            more.textContent = `... (${mapped.length - 3} lignes de plus)`;
            result.appendChild(more);
        }

        showToast(t('toast.colsSelected', { cols: indices.map(i => i + 1).join(', ') }), 'success', 2000);
    }

    // =========================================================================
    // Console Search (Ctrl+F)
    // =========================================================================

    function setupConsoleSearch(dev) {
        if (!dev.els.searchBar) return;
        dev._searchMatches = [];
        dev._searchCurrentIdx = -1;

        const openSearch = () => {
            dev.els.searchBar.style.display = 'flex';
            dev.els.searchInput.focus();
            dev.els.searchInput.select();
        };
        const closeSearch = () => {
            dev.els.searchBar.style.display = 'none';
            dev.els.searchInput.value = '';
            clearSearchHighlights(dev);
            dev._searchMatches = [];
            dev._searchCurrentIdx = -1;
            dev.els.searchCount.textContent = '';
        };

        // Ctrl+F on panel opens search
        dev.els.panel.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                openSearch();
            }
        });

        // Input: debounced search
        let searchTimer = null;
        dev.els.searchInput.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => performSearch(dev), 150);
        });

        // Enter = next, Shift+Enter = prev
        dev.els.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) navigateSearch(dev, -1);
                else navigateSearch(dev, 1);
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
            }
        });

        dev.els.btnSearchNext.addEventListener('click', () => navigateSearch(dev, 1));
        dev.els.btnSearchPrev.addEventListener('click', () => navigateSearch(dev, -1));
        dev.els.btnSearchClose.addEventListener('click', closeSearch);
    }

    function clearSearchHighlights(dev) {
        const matches = dev.els.console.querySelectorAll('.search-match');
        matches.forEach(span => {
            span.replaceWith(document.createTextNode(span.textContent));
        });
        // Normalize text nodes
        dev.els.console.normalize();
    }

    function performSearch(dev) {
        clearSearchHighlights(dev);
        dev._searchMatches = [];
        dev._searchCurrentIdx = -1;

        const query = dev.els.searchInput.value.trim();
        if (!query) {
            dev.els.searchCount.textContent = '';
            return;
        }

        let re;
        try { re = new RegExp(query, 'gi'); }
        catch (_) {
            dev.els.searchCount.textContent = 'regex invalide';
            return;
        }

        // Walk through all console lines and highlight matches
        const lines = dev.els.console.querySelectorAll('div');
        for (const line of lines) {
            if (line.classList.contains('line-filtered')) continue;
            const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, null, false);
            const textNodes = [];
            while (walker.nextNode()) textNodes.push(walker.currentNode);

            for (const node of textNodes) {
                const text = node.textContent;
                re.lastIndex = 0;
                if (!re.test(text)) continue;

                // Split and wrap matches
                const parts = text.split(new RegExp(`(${query})`, 'gi'));
                if (parts.length <= 1) continue;

                const frag = document.createDocumentFragment();
                for (const part of parts) {
                    re.lastIndex = 0;
                    if (re.test(part)) {
                        const span = document.createElement('span');
                        span.className = 'search-match';
                        span.textContent = part;
                        frag.appendChild(span);
                        dev._searchMatches.push(span);
                    } else {
                        frag.appendChild(document.createTextNode(part));
                    }
                }
                node.parentNode.replaceChild(frag, node);
            }
        }

        const total = dev._searchMatches.length;
        dev.els.searchCount.textContent = total > 0 ? `0/${total}` : 'Aucun résultat';

        if (total > 0) {
            dev._searchCurrentIdx = 0;
            highlightCurrentMatch(dev);
        }
    }

    function highlightCurrentMatch(dev) {
        // Remove current highlight from all
        dev._searchMatches.forEach(s => s.classList.remove('search-match-current'));
        if (dev._searchCurrentIdx >= 0 && dev._searchCurrentIdx < dev._searchMatches.length) {
            const el = dev._searchMatches[dev._searchCurrentIdx];
            el.classList.add('search-match-current');
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            dev.els.searchCount.textContent = `${dev._searchCurrentIdx + 1}/${dev._searchMatches.length}`;
        }
    }

    function navigateSearch(dev, direction) {
        if (dev._searchMatches.length === 0) return;
        dev._searchCurrentIdx += direction;
        if (dev._searchCurrentIdx >= dev._searchMatches.length) dev._searchCurrentIdx = 0;
        if (dev._searchCurrentIdx < 0) dev._searchCurrentIdx = dev._searchMatches.length - 1;
        highlightCurrentMatch(dev);
    }

    // =========================================================================
    // Live Data Table
    // =========================================================================

    function setupLiveTable(dev) {
        if (!dev.els.liveTableSection) return;
        // Initially hidden unless toggled
        const dtChk = document.getElementById('chkShowDataTable');
        if (!dtChk || !dtChk.checked) dev.els.liveTableSection.style.display = 'none';

        dev.els.btnLiveTableClear.addEventListener('click', () => {
            dev.liveTable.rows = [];
            dev.liveTable.cols = 0;
            dev.liveTable.headers = [];
            dev.liveTable.detectedSep = null;
            dev.els.liveTableThead.innerHTML = '';
            dev.els.liveTableTbody.innerHTML = '';
        });

        dev.els.btnLiveTableCsv.addEventListener('click', () => {
            const lt = dev.liveTable;
            if (lt.rows.length === 0) { showToast(t('toast.noData'), 'info'); return; }
            let csv = lt.headers.join(';') + '\n';
            for (const row of lt.rows) csv += row.join(';') + '\n';
            downloadFile(`datatable_dev${dev.index + 1}.csv`, csv, 'text/csv');
        });

        // Sort on header click
        dev.els.liveTableThead.addEventListener('click', (e) => {
            const th = e.target.closest('th');
            if (!th) return;
            const colIdx = Array.from(dev.els.liveTableThead.children).indexOf(th);
            if (colIdx < 0) return;
            const lt = dev.liveTable;
            if (lt.sortCol === colIdx) lt.sortAsc = !lt.sortAsc;
            else { lt.sortCol = colIdx; lt.sortAsc = true; }
            lt.rows.sort((a, b) => {
                const va = parseFloat(a[colIdx]), vb = parseFloat(b[colIdx]);
                if (!isNaN(va) && !isNaN(vb)) return lt.sortAsc ? va - vb : vb - va;
                return lt.sortAsc ? String(a[colIdx]).localeCompare(String(b[colIdx])) : String(b[colIdx]).localeCompare(String(a[colIdx]));
            });
            renderLiveTable(dev);
        });
    }

    function detectLiveTableSep(dev, text) {
        const sepVal = dev.els.liveTableSep.value;
        if (sepVal !== 'auto') return sepVal === '\\t' ? '\t' : sepVal;
        if (dev.liveTable.detectedSep) return dev.liveTable.detectedSep;
        const seps = ['\t', ';', ',', '  ', ' '];
        for (const s of seps) {
            if (text.includes(s) && text.split(s).length >= 2) {
                dev.liveTable.detectedSep = s;
                return s;
            }
        }
        return null;
    }

    function feedLiveTable(dev, text) {
        if (!dev.els.liveTableSection || dev.els.liveTableSection.style.display === 'none') return;
        const sep = detectLiveTableSep(dev, text);
        if (!sep) return;

        const parts = text.split(sep).map(s => s.trim());
        if (parts.length < 2) return;

        const lt = dev.liveTable;
        const maxRows = parseInt(dev.els.liveTableMaxRows.value, 10) || 200;

        // Init headers if first data
        if (lt.cols === 0) {
            lt.cols = parts.length;
            // Check if first row looks like headers (non-numeric)
            const allNonNumeric = parts.every(p => isNaN(parseFloat(p)));
            if (allNonNumeric) {
                lt.headers = parts;
                renderLiveTableHeaders(dev);
                return;
            } else {
                lt.headers = parts.map((_, i) => `Col ${i + 1}`);
                renderLiveTableHeaders(dev);
            }
        }

        // Pad or trim to match columns
        while (parts.length < lt.cols) parts.push('');
        if (parts.length > lt.cols) parts.length = lt.cols;

        lt.rows.push(parts);
        if (lt.rows.length > maxRows) lt.rows.shift();

        // Append row to DOM
        appendLiveTableRow(dev, parts);

        // Auto-scroll
        if (dev.els.chkLiveTableFollow.checked) {
            const wrap = dev.els.liveTableSection.querySelector('.live-table-wrap');
            wrap.scrollTop = wrap.scrollHeight;
        }

        // Feed detached data table window
        if (dev._detachedDataTable && isElectron && window.electronRelay.detachedPanelData) {
            window.electronRelay.detachedPanelData('datatable', dev.index, { row: parts });
        }
    }

    function renderLiveTableHeaders(dev) {
        const lt = dev.liveTable;
        let html = '';
        for (let i = 0; i < lt.headers.length; i++) {
            const arrow = lt.sortCol === i ? (lt.sortAsc ? '▲' : '▼') : '';
            html += `<th>${lt.headers[i]} <span class="sort-arrow">${arrow}</span></th>`;
        }
        dev.els.liveTableThead.innerHTML = html;
    }

    function appendLiveTableRow(dev, parts) {
        const tr = document.createElement('tr');
        for (const val of parts) {
            const td = document.createElement('td');
            td.textContent = val;
            tr.appendChild(td);
        }
        dev.els.liveTableTbody.appendChild(tr);

        // Trim excess rows from DOM
        const maxRows = parseInt(dev.els.liveTableMaxRows.value, 10) || 200;
        while (dev.els.liveTableTbody.children.length > maxRows) {
            dev.els.liveTableTbody.removeChild(dev.els.liveTableTbody.firstChild);
        }
    }

    function renderLiveTable(dev) {
        dev.els.liveTableTbody.innerHTML = '';
        renderLiveTableHeaders(dev);
        for (const row of dev.liveTable.rows) {
            appendLiveTableRow(dev, row);
        }
    }

    // =========================================================================
    // Phase 10 — Scripting / Mini Test-Runner
    // =========================================================================

    function setupScripting(dev) {
        if (!dev.els.scriptSection) return;

        // Toggle collapse
        dev.els.scriptToggle.addEventListener('click', () => {
            const body = dev.els.scriptBody;
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : '';
            dev.els.scriptToggle.textContent = open ? '▾' : '▴';
        });

        // Header click to toggle
        dev.els.scriptSection.querySelector('.scripting-header').addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            dev.els.scriptToggle.click();
        });

        // Run
        dev.els.btnScriptRun.addEventListener('click', () => runScript(dev));

        // Stop
        dev.els.btnScriptStop.addEventListener('click', () => {
            dev.scriptRunner.aborted = true;
        });

        // Save script to file
        dev.els.btnScriptSave.addEventListener('click', () => {
            const text = dev.els.scriptEditor.value;
            if (!text.trim()) return;
            const blob = new Blob([text], { type: 'text/plain' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `script_dev${dev.index + 1}.txt`;
            a.click();
            URL.revokeObjectURL(a.href);
        });

        // Load script from file
        dev.els.btnScriptLoad.addEventListener('click', () => {
            const fi = document.createElement('input');
            fi.type = 'file';
            fi.accept = '.txt,.script,.test,*';
            fi.addEventListener('change', () => {
                const file = fi.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => { dev.els.scriptEditor.value = reader.result; };
                reader.readAsText(file);
            });
            fi.click();
        });

        // Help
        dev.els.btnScriptHelp.addEventListener('click', () => {
            const help = `Commandes du script :

SEND commande              → Envoyer sur le port série
DELAY 500                  → Attendre N millisecondes
EXPECT regex [timeout]     → Attendre une réception matchant la regex
ASSERT regex [timeout]     → Comme EXPECT, FAIL si timeout
CAPTURE regex AS var [ms]  → Capturer un groupe regex dans une variable
SET var=valeur             → Définir une variable
CALC var = expression      → Calcul arithmétique (+, -, *, /, %)
SEND \${var}               → Utiliser une variable

IF condition               → Branchement conditionnel
ELSEIF condition           → Condition alternative
ELSE                       → Bloc par défaut
ENDIF                      → Fin du IF

  Conditions supportées :
  IF \${temp} > 25          (comparaison numérique)
  IF \${status} == "OK"     (comparaison texte)
  IF MATCH \${line} ^ERROR  (test regex)
  IF DEFINED myVar         (variable existe ?)

LOOP N / ENDLOOP           → Boucle N fois
WHILE condition / ENDWHILE → Boucle conditionnelle
LOG message                → Message dans le rapport
PASS / FAIL message        → Marquer un résultat

# Commentaire              → Ignoré

Exemple avancé :
  SET count=0
  SEND AT
  CAPTURE (OK|ERROR) AS resp 3000
  IF \${resp} == "OK"
    PASS Réponse OK
  ELSEIF \${resp} == "ERROR"
    FAIL Erreur reçue
  ELSE
    FAIL Pas de réponse
  ENDIF
  WHILE \${count} < 5
    CALC count = \${count} + 1
    SEND READ \${count}
    DELAY 200
  ENDWHILE`;
            alert(help);
        });

        // Tab key inserts spaces in editor
        dev.els.scriptEditor.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const ta = dev.els.scriptEditor;
                const start = ta.selectionStart;
                ta.value = ta.value.substring(0, start) + '    ' + ta.value.substring(ta.selectionEnd);
                ta.selectionStart = ta.selectionEnd = start + 4;
            }
        });

        // Show scripting section if view-script is enabled
        if (localStorage.getItem('view-script') === '1') {
            dev.els.scriptSection.style.display = '';
        }

        // === Test Suite setup ===
        dev.testSuite = []; // [{name, script, status:'pending'|'pass'|'fail', pass:0, fail:0, log:[]}]

        if (dev.els.btnSuiteAdd) {
            dev.els.btnSuiteAdd.addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.txt,.script';
                input.multiple = true;
                input.addEventListener('change', () => {
                    for (const file of input.files) {
                        const reader = new FileReader();
                        reader.onload = () => {
                            dev.testSuite.push({ name: file.name, script: reader.result, status: 'pending', pass: 0, fail: 0, log: [] });
                            renderTestSuiteList(dev);
                        };
                        reader.readAsText(file);
                    }
                });
                input.click();
            });
        }

        if (dev.els.btnSuiteRunAll) {
            dev.els.btnSuiteRunAll.addEventListener('click', () => runTestSuite(dev));
        }

        if (dev.els.btnSuiteReport) {
            dev.els.btnSuiteReport.addEventListener('click', () => exportSuiteReport(dev));
        }
    }

    function scriptLog(dev, text, cls) {
        const div = document.createElement('div');
        div.className = 'script-line ' + (cls || 'script-line-info');
        div.textContent = text;
        dev.els.scriptOutput.appendChild(div);
        dev.els.scriptOutput.scrollTop = dev.els.scriptOutput.scrollHeight;
        return div;
    }

    function parseScriptLines(text) {
        return text.split(/\r?\n/).map((raw, i) => ({ raw, lineNum: i + 1 }));
    }

    async function runScript(dev) {
        if (dev.scriptRunner.running) return;
        const text = dev.els.scriptEditor.value;
        if (!text.trim()) return;

        // Reset state
        dev.scriptRunner.running = true;
        dev.scriptRunner.aborted = false;
        dev.scriptRunner.vars = {};
        dev.scriptRunner.passCount = 0;
        dev.scriptRunner.failCount = 0;
        dev.els.scriptOutput.innerHTML = '';
        dev.els.btnScriptRun.disabled = true;
        dev.els.btnScriptStop.disabled = false;
        dev.els.scriptStatus.textContent = 'En cours...';

        const lines = parseScriptLines(text);
        const startTime = Date.now();

        try {
            await executeBlock(dev, lines, 0, lines.length);
        } catch (err) {
            scriptLog(dev, `ERREUR: ${err.message}`, 'script-line-fail');
            dev.scriptRunner.failCount++;
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const pass = dev.scriptRunner.passCount;
        const fail = dev.scriptRunner.failCount;
        const total = pass + fail;

        // Summary
        const summary = document.createElement('div');
        summary.className = 'script-summary ' + (fail > 0 ? 'script-summary-fail' : 'script-summary-pass');
        summary.textContent = `${fail > 0 ? 'FAIL' : 'PASS'} — ${pass}/${total} tests réussis — ${elapsed}s`;
        dev.els.scriptOutput.appendChild(summary);

        dev.els.scriptStatus.textContent = fail > 0 ? `FAIL (${fail})` : `PASS (${pass})`;
        dev.scriptRunner.running = false;
        dev.els.btnScriptRun.disabled = false;
        dev.els.btnScriptStop.disabled = true;

        return { pass, fail, elapsed };
    }

    // --- Run a single script text and return results (for suite) ---
    async function runScriptText(dev, scriptText) {
        dev.scriptRunner.running = true;
        dev.scriptRunner.aborted = false;
        dev.scriptRunner.vars = {};
        dev.scriptRunner.passCount = 0;
        dev.scriptRunner.failCount = 0;
        dev.els.scriptOutput.innerHTML = '';

        const lines = parseScriptLines(scriptText);
        const startTime = Date.now();
        const logEntries = [];

        // Capture logs
        const origLog = scriptLog;
        const captureLog = (d, text, cls) => {
            logEntries.push({ text, cls: cls || 'script-line-info' });
            return origLog(d, text, cls);
        };

        try {
            await executeBlock(dev, lines, 0, lines.length);
        } catch (err) {
            captureLog(dev, `ERREUR: ${err.message}`, 'script-line-fail');
            dev.scriptRunner.failCount++;
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        dev.scriptRunner.running = false;

        return {
            pass: dev.scriptRunner.passCount,
            fail: dev.scriptRunner.failCount,
            elapsed,
            log: logEntries
        };
    }

    // --- Test Suite functions ---

    function renderTestSuiteList(dev) {
        const el = dev.els.suiteList;
        if (!el) return;
        el.innerHTML = '';
        dev.testSuite.forEach((item, idx) => {
            const div = document.createElement('div');
            div.className = 'suite-item';
            const statusCls = item.status === 'pass' ? 'suite-status-pass' : item.status === 'fail' ? 'suite-status-fail' : item.status === 'running' ? 'suite-status-running' : 'suite-status-pending';
            const statusLabel = item.status === 'pass' ? `PASS (${item.pass})` : item.status === 'fail' ? `FAIL (${item.fail})` : item.status === 'running' ? '⏳' : '—';
            div.innerHTML = `<span class="suite-item-name" title="${item.name}">${idx + 1}. ${item.name}</span>` +
                `<span class="suite-item-status ${statusCls}">${statusLabel}</span>` +
                `<button class="btn btn-small btn-suite-remove" data-idx="${idx}" title="Retirer">✕</button>`;
            el.appendChild(div);
        });
        // Remove handler
        el.querySelectorAll('.btn-suite-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                dev.testSuite.splice(parseInt(btn.dataset.idx, 10), 1);
                renderTestSuiteList(dev);
            });
        });
    }

    async function runTestSuite(dev) {
        if (dev.testSuite.length === 0) { showToast(t('toast.noSuiteScript'), 'info'); return; }
        if (dev.scriptRunner.running) { showToast(t('toast.scriptRunning'), 'warning'); return; }

        dev.els.suiteSummary.textContent = 'Exécution de la suite...';
        let totalPass = 0, totalFail = 0;

        for (let i = 0; i < dev.testSuite.length; i++) {
            const item = dev.testSuite[i];
            item.status = 'running';
            item.log = [];
            renderTestSuiteList(dev);

            const result = await runScriptText(dev, item.script);
            item.pass = result.pass;
            item.fail = result.fail;
            item.log = result.log;
            item.elapsed = result.elapsed;
            item.status = result.fail > 0 ? 'fail' : 'pass';
            totalPass += result.pass;
            totalFail += result.fail;
            renderTestSuiteList(dev);
        }

        const cls = totalFail > 0 ? 'color:#f87171;' : 'color:#34d399;';
        dev.els.suiteSummary.innerHTML = `<span style="${cls}">${totalFail > 0 ? 'FAIL' : 'PASS'}</span> — ${totalPass} pass, ${totalFail} fail sur ${dev.testSuite.length} scripts`;
    }

    function exportSuiteReport(dev) {
        if (dev.testSuite.length === 0) { showToast(t('toast.noSuiteResult'), 'info'); return; }
        const now = new Date().toLocaleString('fr-FR');
        let totalPass = 0, totalFail = 0;
        let rows = '';
        for (const item of dev.testSuite) {
            totalPass += item.pass || 0;
            totalFail += item.fail || 0;
            const color = item.status === 'pass' ? '#34d399' : item.status === 'fail' ? '#f87171' : '#6b7280';
            const logHTML = (item.log || []).map(l => {
                const c = l.cls.includes('fail') ? '#f87171' : l.cls.includes('pass') ? '#34d399' : '#e5e7eb';
                return `<div style="color:${c};font-size:11px;">${l.text.replace(/</g, '&lt;')}</div>`;
            }).join('');
            rows += `<tr>
                <td>${item.name}</td>
                <td style="color:${color};font-weight:700;">${(item.status || 'pending').toUpperCase()}</td>
                <td>${item.pass || 0}</td>
                <td>${item.fail || 0}</td>
                <td>${item.elapsed || '—'}s</td>
            </tr>
            <tr><td colspan="5" style="padding:2px 12px;border-bottom:1px solid #333;">${logHTML}</td></tr>`;
        }

        const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Rapport de suite — ${now}</title>
<style>body{background:#111;color:#e5e7eb;font-family:system-ui,sans-serif;padding:20px;}
h1{color:#4a9eff;}table{width:100%;border-collapse:collapse;margin:12px 0;}
th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #333;}
th{background:#1a1d23;color:#9ca3af;}
.summary{font-size:18px;margin:12px 0;font-weight:700;}</style></head><body>
<h1>Rapport suite de tests — Device ${dev.index + 1}</h1>
<div style="color:#6b7280;">${now}</div>
<div class="summary" style="color:${totalFail > 0 ? '#f87171' : '#34d399'};">${totalFail > 0 ? 'FAIL' : 'PASS'} — ${totalPass} pass, ${totalFail} fail / ${dev.testSuite.length} scripts</div>
<table><tr><th>Script</th><th>Résultat</th><th>Pass</th><th>Fail</th><th>Durée</th></tr>${rows}</table>
</body></html>`;

        downloadFile(`suite_report_dev${dev.index + 1}_${dateTag()}.html`, html, 'text/html');
        showToast(t('toast.reportExported'), 'success');
    }

    async function executeBlock(dev, lines, start, end) {
        let i = start;
        while (i < end) {
            if (dev.scriptRunner.aborted) {
                scriptLog(dev, '— Script interrompu —', 'script-line-fail');
                throw new Error('Interrompu par l\'utilisateur');
            }

            const { raw, lineNum } = lines[i];
            const trimmed = raw.trim();

            // Skip empty lines and comments
            if (!trimmed || trimmed.startsWith('#')) { i++; continue; }

            const upper = trimmed.toUpperCase();

            // WHILE condition / ENDWHILE
            if (upper.startsWith('WHILE ')) {
                const condition = trimmed.substring(6).trim();
                // Find matching ENDWHILE
                let depth = 1, j = i + 1;
                while (j < end && depth > 0) {
                    const t = lines[j].raw.trim().toUpperCase();
                    if (t.startsWith('WHILE ')) depth++;
                    if (t === 'ENDWHILE') depth--;
                    j++;
                }
                if (depth !== 0) {
                    scriptLog(dev, `L${lineNum}: ENDWHILE manquant`, 'script-line-fail');
                    dev.scriptRunner.failCount++;
                    i = end; break;
                }
                const whileEnd = j;
                const blockStart = i + 1;
                const blockEnd = whileEnd - 1;
                let whileIter = 0;
                const MAX_WHILE = 10000;
                while (evaluateCondition(dev, condition) && !dev.scriptRunner.aborted) {
                    whileIter++;
                    if (whileIter > MAX_WHILE) {
                        scriptLog(dev, `L${lineNum}: WHILE boucle infinie (>${MAX_WHILE} itérations)`, 'script-line-fail');
                        dev.scriptRunner.failCount++;
                        break;
                    }
                    await executeBlock(dev, lines, blockStart, blockEnd);
                }
                i = whileEnd;
                continue;
            }

            if (upper === 'ENDWHILE') { i++; continue; }

            // LOOP N
            if (upper.startsWith('LOOP ')) {
                const count = parseInt(trimmed.substring(5).trim(), 10) || 1;
                // Find matching ENDLOOP
                let depth = 1, j = i + 1;
                while (j < end && depth > 0) {
                    const t = lines[j].raw.trim().toUpperCase();
                    if (t.startsWith('LOOP ')) depth++;
                    if (t === 'ENDLOOP') depth--;
                    j++;
                }
                if (depth !== 0) {
                    scriptLog(dev, `L${lineNum}: ENDLOOP manquant`, 'script-line-fail');
                    dev.scriptRunner.failCount++;
                    i = end;
                    break;
                }
                const loopEnd = j; // j is after ENDLOOP
                const blockStart = i + 1;
                const blockEnd = loopEnd - 1; // before ENDLOOP

                for (let iter = 0; iter < count; iter++) {
                    if (dev.scriptRunner.aborted) break;
                    scriptLog(dev, `LOOP ${iter + 1}/${count}`, 'script-line-info');
                    await executeBlock(dev, lines, blockStart, blockEnd);
                }
                i = loopEnd;
                continue;
            }

            if (upper === 'ENDLOOP') { i++; continue; } // stray endloop

            // SEND command
            if (upper.startsWith('SEND ')) {
                let cmd = trimmed.substring(5);
                cmd = substituteVars(dev, cmd);
                scriptLog(dev, `L${lineNum}: SEND → ${cmd}`, 'script-line-send');
                sendRawCommand(dev, cmd);
                i++; continue;
            }

            // DELAY ms
            if (upper.startsWith('DELAY ')) {
                const ms = parseInt(trimmed.substring(6).trim(), 10) || 0;
                scriptLog(dev, `L${lineNum}: DELAY ${ms}ms`, 'script-line-info');
                await sleep(ms);
                i++; continue;
            }

            // EXPECT regex [timeout]
            if (upper.startsWith('EXPECT ') || upper.startsWith('ASSERT ')) {
                const isAssert = upper.startsWith('ASSERT');
                const rest = trimmed.substring(isAssert ? 7 : 7).trim();
                const parts = rest.match(/^(.+?)(?:\s+(\d+))?$/);
                const pattern = parts ? parts[1] : rest;
                const timeout = parts && parts[2] ? parseInt(parts[2], 10) : 5000;

                const logEl = scriptLog(dev, `L${lineNum}: ${isAssert ? 'ASSERT' : 'EXPECT'} /${pattern}/ (${timeout}ms)...`, 'script-line-running');
                const result = await waitForMatch(dev, pattern, timeout);

                if (result) {
                    logEl.className = 'script-line script-line-recv';
                    logEl.textContent = `L${lineNum}: ${isAssert ? 'ASSERT' : 'EXPECT'} /${pattern}/ → OK: "${result}"`;
                    if (isAssert) { dev.scriptRunner.passCount++; }
                } else {
                    logEl.className = 'script-line script-line-fail';
                    logEl.textContent = `L${lineNum}: ${isAssert ? 'ASSERT' : 'EXPECT'} /${pattern}/ → TIMEOUT (${timeout}ms)`;
                    if (isAssert) {
                        dev.scriptRunner.failCount++;
                    }
                }
                i++; continue;
            }

            // CALC var = expression (arithmetic)
            if (upper.startsWith('CALC ')) {
                const rest = trimmed.substring(5).trim();
                const eqIdx = rest.indexOf('=');
                if (eqIdx > 0) {
                    const varName = rest.substring(0, eqIdx).trim();
                    let expr = substituteVars(dev, rest.substring(eqIdx + 1).trim());
                    try {
                        // Safe evaluation: only allow numbers, operators, parens, spaces
                        if (!/^[\d\s+\-*/%().]+$/.test(expr)) {
                            throw new Error('Expression invalide');
                        }
                        const result = Function('"use strict"; return (' + expr + ')')();
                        dev.scriptRunner.vars[varName] = String(result);
                        scriptLog(dev, `L${lineNum}: CALC ${varName} = ${expr} → ${result}`, 'script-line-info');
                    } catch (err) {
                        scriptLog(dev, `L${lineNum}: CALC erreur: ${err.message}`, 'script-line-fail');
                    }
                }
                i++; continue;
            }

            // SET var=value
            if (upper.startsWith('SET ')) {
                const eq = trimmed.substring(4).trim();
                const eqIdx = eq.indexOf('=');
                if (eqIdx > 0) {
                    const name = eq.substring(0, eqIdx).trim();
                    const val = eq.substring(eqIdx + 1).trim();
                    dev.scriptRunner.vars[name] = val;
                    scriptLog(dev, `L${lineNum}: SET ${name}=${val}`, 'script-line-info');
                }
                i++; continue;
            }

            // LOG message
            if (upper.startsWith('LOG ')) {
                const msg = substituteVars(dev, trimmed.substring(4));
                scriptLog(dev, `L${lineNum}: ${msg}`, 'script-line-info');
                i++; continue;
            }

            // PASS message
            if (upper.startsWith('PASS')) {
                const msg = trimmed.substring(4).trim() || 'OK';
                scriptLog(dev, `L${lineNum}: PASS — ${msg}`, 'script-line-pass');
                dev.scriptRunner.passCount++;
                i++; continue;
            }

            // FAIL message
            if (upper.startsWith('FAIL')) {
                const msg = trimmed.substring(4).trim() || 'Échec';
                scriptLog(dev, `L${lineNum}: FAIL — ${msg}`, 'script-line-fail');
                dev.scriptRunner.failCount++;
                i++; continue;
            }

            // CAPTURE regex AS varName [timeout]
            if (upper.startsWith('CAPTURE ')) {
                const rest = trimmed.substring(8).trim();
                const captureMatch = rest.match(/^(.+?)\s+AS\s+(\w+)(?:\s+(\d+))?$/i);
                if (!captureMatch) {
                    scriptLog(dev, `L${lineNum}: Syntaxe: CAPTURE regex AS varName [timeout]`, 'script-line-fail');
                    i++; continue;
                }
                const pattern = captureMatch[1];
                const varName = captureMatch[2];
                const timeout = captureMatch[3] ? parseInt(captureMatch[3], 10) : 5000;

                const logEl = scriptLog(dev, `L${lineNum}: CAPTURE /${pattern}/ → ${varName} (${timeout}ms)...`, 'script-line-running');
                const result = await waitForMatch(dev, pattern, timeout, true);

                if (result) {
                    // Store first capture group, or full match if no group
                    const captured = result[1] !== undefined ? result[1] : result[0];
                    dev.scriptRunner.vars[varName] = captured;
                    logEl.className = 'script-line script-line-recv';
                    logEl.textContent = `L${lineNum}: CAPTURE → ${varName}="${captured}"`;
                } else {
                    logEl.className = 'script-line script-line-fail';
                    logEl.textContent = `L${lineNum}: CAPTURE /${pattern}/ → TIMEOUT`;
                }
                i++; continue;
            }

            // IF condition / ELSEIF condition / ELSE / ENDIF
            if (upper.startsWith('IF ')) {
                const condition = trimmed.substring(3).trim();
                const condResult = evaluateCondition(dev, condition);
                scriptLog(dev, `L${lineNum}: IF ${condition} → ${condResult ? 'VRAI' : 'FAUX'}`, 'script-line-info');

                // Find all ELSEIF / ELSE / ENDIF at depth 1
                let depth = 1;
                const branches = []; // {type, condIdx, startIdx}
                let endifIdx = -1;
                let j = i + 1;
                // First branch = IF block
                branches.push({ type: 'if', cond: condition, result: condResult, start: i + 1, end: -1 });

                while (j < end && depth > 0) {
                    const t = lines[j].raw.trim();
                    const tUp = t.toUpperCase();
                    if (tUp.startsWith('IF ')) depth++;
                    if (depth === 1) {
                        if (tUp.startsWith('ELSEIF ')) {
                            // Close previous branch
                            branches[branches.length - 1].end = j;
                            const elseifCond = t.substring(7).trim();
                            const elseifResult = evaluateCondition(dev, elseifCond);
                            branches.push({ type: 'elseif', cond: elseifCond, result: elseifResult, start: j + 1, end: -1 });
                            scriptLog(dev, `L${lines[j].lineNum}: ELSEIF ${elseifCond} → ${elseifResult ? 'VRAI' : 'FAUX'}`, 'script-line-info');
                        } else if (tUp === 'ELSE') {
                            branches[branches.length - 1].end = j;
                            branches.push({ type: 'else', cond: null, result: true, start: j + 1, end: -1 });
                        }
                    }
                    if (tUp === 'ENDIF') {
                        depth--;
                        if (depth === 0) {
                            endifIdx = j;
                            branches[branches.length - 1].end = j;
                        }
                    }
                    j++;
                }
                if (endifIdx === -1) {
                    scriptLog(dev, `L${lineNum}: ENDIF manquant`, 'script-line-fail');
                    dev.scriptRunner.failCount++;
                    i = end; break;
                }

                // Execute first branch whose condition is true
                let executed = false;
                for (const branch of branches) {
                    if (executed) break;
                    const branchTrue = branch.type === 'if' ? condResult
                                     : branch.type === 'elseif' ? branch.result
                                     : true; // else always runs
                    if (branchTrue) {
                        await executeBlock(dev, lines, branch.start, branch.end);
                        executed = true;
                    }
                }
                i = endifIdx + 1;
                continue;
            }

            if (upper === 'ELSE' || upper === 'ENDIF' || upper.startsWith('ELSEIF ')) { i++; continue; } // stray

            // Unknown command
            scriptLog(dev, `L${lineNum}: Commande inconnue: ${trimmed}`, 'script-line-fail');
            i++;
        }
    }

    function substituteVars(dev, text) {
        return text.replace(/\$\{(\w+)\}/g, (_, name) => {
            return dev.scriptRunner.vars[name] !== undefined ? dev.scriptRunner.vars[name] : '${' + name + '}';
        });
    }

    function evaluateCondition(dev, condition) {
        const cond = substituteVars(dev, condition);

        // MATCH "value" regex — tests if value matches regex
        const matchTest = cond.match(/^MATCH\s+"([^"]*)"\s+(.+)$/i) || cond.match(/^MATCH\s+(\S+)\s+(.+)$/i);
        if (matchTest) {
            try { return new RegExp(matchTest[2].trim(), 'i').test(matchTest[1]); }
            catch (_) { return false; }
        }

        // var == value / var != value
        const eqTest = cond.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
        if (eqTest) {
            let left = eqTest[1].trim();
            const op = eqTest[2];
            let right = eqTest[3].trim();
            // Remove quotes
            left = left.replace(/^"|"$/g, '');
            right = right.replace(/^"|"$/g, '');
            const ln = parseFloat(left), rn = parseFloat(right);
            const numeric = !isNaN(ln) && !isNaN(rn);
            switch (op) {
                case '==': return numeric ? ln === rn : left === right;
                case '!=': return numeric ? ln !== rn : left !== right;
                case '>':  return numeric ? ln > rn : left > right;
                case '<':  return numeric ? ln < rn : left < right;
                case '>=': return numeric ? ln >= rn : left >= right;
                case '<=': return numeric ? ln <= rn : left <= right;
            }
        }

        // DEFINED varName — tests if variable exists
        const defTest = cond.match(/^DEFINED\s+(\w+)$/i);
        if (defTest) {
            return dev.scriptRunner.vars[defTest[1]] !== undefined;
        }

        // Truthy: non-empty, non-"0", non-"false"
        const val = cond.trim();
        return val !== '' && val !== '0' && val.toLowerCase() !== 'false';
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function waitForMatch(dev, pattern, timeout, returnGroups) {
        return new Promise(resolve => {
            let re;
            try { re = new RegExp(pattern, 'i'); }
            catch (_) { resolve(null); return; }

            const startLen = dev.consoleData.length;
            const startTime = Date.now();

            const interval = setInterval(() => {
                for (let i = startLen; i < dev.consoleData.length; i++) {
                    const entry = dev.consoleData[i];
                    if (entry.cls !== 'line-rx' && entry.cls !== 'line-bridge') continue;
                    const m = entry.text.match(re);
                    if (m) {
                        clearInterval(interval);
                        resolve(returnGroups ? m : entry.text.trim());
                        return;
                    }
                }
                if (dev.scriptRunner.aborted || Date.now() - startTime >= timeout) {
                    clearInterval(interval);
                    resolve(null);
                }
            }, 50);
        });
    }

    // =========================================================================
    // Phase 8.1 — Theme switcher
    // =========================================================================

    const themeSelect = document.getElementById('themeSelect');
    const themeToggleBtn = document.getElementById('themeToggleBtn');
    const themeIcon = document.getElementById('themeIcon');
    const themeLabel = document.getElementById('themeLabel');
    const THEMES = [
        { value: 'dark', icon: '🌙', label: 'Sombre' },
        { value: 'light', icon: '☀️', label: 'Clair' },
        { value: 'highcontrast', icon: '🔳', label: 'Contraste' },
    ];

    function applyTheme(theme) {
        document.body.classList.remove('theme-light', 'theme-highcontrast');
        if (theme === 'light') document.body.classList.add('theme-light');
        else if (theme === 'highcontrast') document.body.classList.add('theme-highcontrast');
        localStorage.setItem('esp32-theme', theme);
        // Sync UI
        themeSelect.value = theme;
        const t = THEMES.find(t => t.value === theme) || THEMES[0];
        if (themeIcon) themeIcon.textContent = t.icon;
        if (themeLabel) themeLabel.textContent = t.label;
    }

    // Restore
    const savedTheme = localStorage.getItem('esp32-theme') || 'dark';
    applyTheme(savedTheme);
    themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

    // Cycle button
    if (themeToggleBtn) {
        themeToggleBtn.addEventListener('click', () => {
            const cur = THEMES.findIndex(t => t.value === themeSelect.value);
            const next = THEMES[(cur + 1) % THEMES.length];
            applyTheme(next.value);
        });
    }

    // =========================================================================
    // Phase 8.2 — Console height persistence
    // =========================================================================

    // Observe console resize and save height per device
    function persistConsoleHeight(dev) {
        const consoleEl = dev.els.console;
        if (!consoleEl) return;
        const saved = localStorage.getItem('esp32-console-h-' + dev.index);
        if (saved) consoleEl.style.height = saved + 'px';
    }

    // Hook into existing console-resize-handle mousedown
    document.addEventListener('mouseup', () => {
        for (const dev of devices) {
            const consoleEl = dev.els.console;
            if (consoleEl && consoleEl.style.height) {
                localStorage.setItem('esp32-console-h-' + dev.index, parseInt(consoleEl.style.height, 10));
            }
        }
    });

    // =========================================================================
    // Phase 8.3 — Toast notifications
    // =========================================================================

    const toastContainer = document.getElementById('toastContainer');
    function showToast(message, type, duration) {
        type = type || 'info';
        duration = duration || 3000;
        const el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.textContent = message;
        toastContainer.appendChild(el);
        setTimeout(() => {
            el.classList.add('toast-out');
            el.addEventListener('animationend', () => el.remove());
        }, duration);
    }

    // Expose for other modules
    window.ESP32Tester.showToast = showToast;

    // =========================================================================
    // Phase 8.4 — Connection indicators on tabs
    // =========================================================================

    function updateConnIndicators(dev) {
        const panel = dev.els.panel;
        if (!panel) return;
        const indicators = panel.querySelectorAll('.conn-indicator');
        const connType = dev.connectionType || 'serial';
        const isActive = dev.simulated ||
            !!(dev.port) ||
            !!(dev.netConnId) ||
            !!(dev.mqttWs && dev.mqttWs.readyState === WebSocket.OPEN);

        indicators.forEach(ind => {
            const indConn = ind.dataset.conn;
            if (indConn === connType && isActive) {
                ind.classList.add('connected');
            } else {
                ind.classList.remove('connected');
            }
        });
    }

    // Use a MutationObserver on status element to detect changes
    function watchDeviceStatus(dev) {
        const statusEl = dev.els.status;
        if (!statusEl) return;
        const obs = new MutationObserver(() => updateConnIndicators(dev));
        obs.observe(statusEl, { attributes: true, attributeFilter: ['class'] });
    }

    // =========================================================================
    // Phase 8.5 — Keyboard shortcuts
    // =========================================================================

    const shortcutsOverlay = document.getElementById('shortcutsOverlay');

    // Get the "active" device (first one, or the one whose input is focused)
    function getActiveDevice() {
        const focused = document.activeElement;
        if (focused) {
            const panel = focused.closest('.device-panel');
            if (panel) {
                const idx = parseInt(panel.dataset.deviceIndex, 10);
                if (devices[idx]) return devices[idx];
            }
        }
        return devices[0] || null;
    }

    document.addEventListener('keydown', (e) => {
        // Esc: close overlays/menus
        if (e.key === 'Escape') {
            if (shortcutsOverlay.classList.contains('visible')) {
                shortcutsOverlay.classList.remove('visible');
                e.preventDefault();
                return;
            }
            // Close open dropdowns
            document.querySelectorAll('.export-dropdown.open, .png-dropdown.open').forEach(d => d.classList.remove('open'));
            return;
        }

        // All Ctrl shortcuts
        if (!e.ctrlKey || e.altKey) return;

        // Ctrl+? or Ctrl+/ — help
        if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
            e.preventDefault();
            shortcutsOverlay.classList.toggle('visible');
            return;
        }

        // Ctrl+L — clear console
        if (e.key === 'l' || e.key === 'L') {
            e.preventDefault();
            const dev = getActiveDevice();
            if (dev) {
                dev.els.console.innerHTML = '';
                showToast('Console effacée', 'info', 1500);
            }
            return;
        }

        // Ctrl+R — toggle record
        if (e.key === 'r' || e.key === 'R') {
            e.preventDefault();
            const dev = getActiveDevice();
            if (dev && dev.els.btnRecord) dev.els.btnRecord.click();
            return;
        }

        // Ctrl+M — focus input
        if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();
            const dev = getActiveDevice();
            if (dev) dev.els.serialInput.focus();
            return;
        }

        // Ctrl+P — pause plotter
        if (e.key === 'p' || e.key === 'P') {
            e.preventDefault();
            const dev = getActiveDevice();
            if (dev) {
                const group = dev.els.panel.closest('.device-group');
                if (group) {
                    const pauseBtn = group.querySelector('.btn-plotter-pause');
                    if (pauseBtn) pauseBtn.click();
                }
            }
            return;
        }

        // Ctrl+1..4 — switch to device
        if (e.key >= '1' && e.key <= '4') {
            e.preventDefault();
            const idx = parseInt(e.key, 10) - 1;
            if (devices[idx]) {
                devices[idx].els.serialInput.focus();
                showToast('Device ' + (idx + 1), 'info', 1000);
            }
            return;
        }
    });

    // Help button click
    document.querySelector('.btn-shortcuts-help').addEventListener('click', () => {
        shortcutsOverlay.classList.toggle('visible');
    });

    // Click outside shortcuts box closes it
    shortcutsOverlay.addEventListener('click', (e) => {
        if (e.target === shortcutsOverlay) shortcutsOverlay.classList.remove('visible');
    });

    // =========================================================================
    // Toast on connect/disconnect
    // =========================================================================

    // Override status display to show toast notifications
    const statusObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            const el = m.target;
            if (!el.classList.contains('device-status')) continue;
            const panel = el.closest('.device-panel');
            if (!panel) continue;
            const idx = parseInt(panel.dataset.deviceIndex, 10);
            const text = el.textContent;
            if (el.classList.contains('connected')) {
                showToast('Device ' + (idx + 1) + ' : ' + text, 'success', 2500);
            } else if (el.classList.contains('disconnected') && text === 'Déconnecté') {
                // Only toast if it was previously connected (avoid initial state)
            } else if (el.classList.contains('simulated')) {
                showToast('Device ' + (idx + 1) + ' : Simulation active', 'warning', 2500);
            }
        }
    });

    // Setup all Phase 8 observers for devices
    function setupPhase8Observers() {
        for (const dev of devices) {
            watchDeviceStatus(dev);
            updateConnIndicators(dev);
            persistConsoleHeight(dev);
            if (dev.els.status) {
                statusObserver.observe(dev.els.status, { attributes: true, attributeFilter: ['class'] });
            }
        }
    }
    setTimeout(setupPhase8Observers, 150);

    // Called by rebuildDevices when devices are rebuilt
    window._onDevicesRebuilt = () => {
        setTimeout(setupPhase8Observers, 50);
    };

    // =========================================================================
    // Profiles / Workspaces
    // =========================================================================

    const profileSelect = document.getElementById('profileSelect');
    const btnProfileSave = document.querySelector('.btn-profile-save');
    const btnProfileDelete = document.querySelector('.btn-profile-delete');
    const btnProfileExport = document.querySelector('.btn-profile-export');
    const btnProfileImport = document.querySelector('.btn-profile-import');

    function getProfileList() {
        try {
            const raw = localStorage.getItem('esp32_profiles_list');
            return raw ? JSON.parse(raw) : [];
        } catch (_) { return []; }
    }

    function saveProfileList(list) {
        localStorage.setItem('esp32_profiles_list', JSON.stringify(list));
    }

    function refreshProfileSelect() {
        const list = getProfileList();
        // Keep the first option, remove the rest
        while (profileSelect.options.length > 1) profileSelect.remove(1);
        for (const name of list) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            profileSelect.appendChild(opt);
        }
    }

    function collectProfileData() {
        const profile = {
            version: 1,
            timestamp: Date.now(),
            deviceCount: devices.length,
            theme: document.getElementById('themeSelect').value,
            views: {
                plotter: chkPlotter.checked,
                decoder: chkDecoder.checked,
                logic: chkLogic.checked,
                script: chkScript.checked,
            },
            devices: [],
        };

        for (const dev of devices) {
            const devData = {
                // Connection settings
                connectionType: dev.connectionType,
                baudRate: dev.els.baudRate ? dev.els.baudRate.value : '115200',
                lineEnding: dev.els.panel.querySelector('.line-ending') ? dev.els.panel.querySelector('.line-ending').value : '\\r\\n',
                // Console settings
                autoScroll: dev.els.chkAutoScroll.checked,
                timestamp: dev.els.chkTimestamp.checked,
                hex: dev.els.chkHex.checked,
                ansi: dev.els.chkAnsi.checked,
                json: dev.els.chkJson ? dev.els.chkJson.checked : false,
                // Filter
                filter: dev.els.filterInput.value,
                filterInvert: dev.els.chkFilterInvert.checked,
                // History
                cmdHistory: dev.cmdHistory.slice(-50),
                // Macros, sequences, triggers
                macros: dev.macros.map(m => ({ label: m.label, cmd: m.cmd })),
                sequences: dev.sequences.map(s => ({ name: s.name, steps: s.steps })),
                triggers: dev.triggers.map(t => ({ regex: t.regex, cmd: t.cmd, enabled: t.enabled })),
                // GPIO & Dashboard
                gpioPins: dev.gpioPins.map(p => ({ label: p.label, pin: p.pin, mode: p.mode, cmdOn: p.cmdOn, cmdOff: p.cmdOff })),
                dashVars: dev.dashVars.map(v => ({ name: v.name, regex: v.regex, unit: v.unit, min: v.min, max: v.max })),
                // Highlights
                highlightRules: dev.highlightRules || [],
                // Script
                script: dev.els.scriptEditor ? dev.els.scriptEditor.value : '',
            };
            profile.devices.push(devData);
        }

        return profile;
    }

    function applyProfileData(profile) {
        // Theme
        if (profile.theme) {
            document.getElementById('themeSelect').value = profile.theme;
            applyTheme(profile.theme);
        }

        // Views
        if (profile.views) {
            chkPlotter.checked = !!profile.views.plotter;
            syncViewToggle(chkPlotter, 'show-plotter');
            chkDecoder.checked = !!profile.views.decoder;
            syncViewToggle(chkDecoder, 'show-decoder');
            chkLogic.checked = !!profile.views.logic;
            syncViewToggle(chkLogic, 'show-logic');
            chkScript.checked = !!profile.views.script;
            for (const d of devices) {
                if (d.els.scriptSection) d.els.scriptSection.style.display = chkScript.checked ? '' : 'none';
            }
        }

        // Device-level settings
        const devList = profile.devices || [];
        for (let i = 0; i < Math.min(devList.length, devices.length); i++) {
            const pd = devList[i];
            const dev = devices[i];

            // Console settings
            if (pd.autoScroll !== undefined) dev.els.chkAutoScroll.checked = pd.autoScroll;
            if (pd.timestamp !== undefined) dev.els.chkTimestamp.checked = pd.timestamp;
            if (pd.hex !== undefined) dev.els.chkHex.checked = pd.hex;
            if (pd.ansi !== undefined) dev.els.chkAnsi.checked = pd.ansi;
            if (pd.json !== undefined && dev.els.chkJson) dev.els.chkJson.checked = pd.json;
            if (pd.filter) dev.els.filterInput.value = pd.filter;
            if (pd.filterInvert !== undefined) dev.els.chkFilterInvert.checked = pd.filterInvert;
            if (pd.lineEnding) {
                const le = dev.els.panel.querySelector('.line-ending');
                if (le) le.value = pd.lineEnding;
            }

            // History
            if (pd.cmdHistory) {
                dev.cmdHistory = pd.cmdHistory;
                try { localStorage.setItem('esp32_history_' + dev.index, JSON.stringify(dev.cmdHistory)); } catch (_) {}
            }

            // Macros — clear existing, re-add
            dev.macros = [];
            dev.els.quickCmds.innerHTML = '';
            if (pd.macros) {
                for (const m of pd.macros) {
                    const macro = { label: m.label, cmd: m.cmd };
                    dev.macros.push(macro);
                    renderQuickCommand(dev, macro);
                }
            }

            // Sequences — clear existing, re-add
            dev.sequences = [];
            if (dev.els.sequences) dev.els.sequences.innerHTML = '';
            if (pd.sequences) {
                for (const s of pd.sequences) {
                    const seq = { name: s.name, steps: s.steps, running: false, abortFlag: { v: false } };
                    dev.sequences.push(seq);
                    renderSequence(dev, seq);
                }
            }

            // Triggers — clear existing, re-add
            dev.triggers = [];
            if (dev.els.triggersContainer) dev.els.triggersContainer.innerHTML = '';
            if (pd.triggers) {
                for (const t of pd.triggers) {
                    const trigger = { regex: t.regex, cmd: t.cmd, enabled: t.enabled !== false };
                    dev.triggers.push(trigger);
                    renderTrigger(dev, trigger);
                }
            }

            // Highlights
            if (pd.highlightRules) {
                dev.highlightRules = pd.highlightRules;
                saveHighlightRules(dev);
                renderHighlightRules(dev);
            }

            // Script
            if (pd.script && dev.els.scriptEditor) {
                dev.els.scriptEditor.value = pd.script;
            }

            // Save macros state
            saveDeviceMacros(dev);
        }

        showToast(t('toast.profileLoaded'), 'success', 2000);
    }

    // Save current state as a profile
    btnProfileSave.addEventListener('click', () => {
        let name = profileSelect.value;
        if (!name) {
            name = prompt(t('prompt.profileName'));
            if (!name) return;
        }
        const data = collectProfileData();
        localStorage.setItem('esp32_profile_' + name, JSON.stringify(data));
        const list = getProfileList();
        if (!list.includes(name)) {
            list.push(name);
            saveProfileList(list);
        }
        refreshProfileSelect();
        profileSelect.value = name;
        showToast(t('toast.profileSaved', { name }), 'success', 2000);
    });

    // Load selected profile
    profileSelect.addEventListener('change', () => {
        const name = profileSelect.value;
        if (!name) return;
        try {
            const raw = localStorage.getItem('esp32_profile_' + name);
            if (!raw) { showToast(t('toast.profileNotFound'), 'error'); return; }
            applyProfileData(JSON.parse(raw));
        } catch (err) {
            showToast('Erreur chargement profil: ' + err.message, 'error');
        }
    });

    // Delete selected profile
    btnProfileDelete.addEventListener('click', () => {
        const name = profileSelect.value;
        if (!name) return;
        if (!confirm(t('prompt.confirmDeleteProfile', { name }))) return;
        localStorage.removeItem('esp32_profile_' + name);
        const list = getProfileList().filter(n => n !== name);
        saveProfileList(list);
        refreshProfileSelect();
        profileSelect.value = '';
        showToast(t('toast.profileDeleted', { name }), 'info', 2000);
    });

    // Export profile to JSON file
    btnProfileExport.addEventListener('click', () => {
        const name = profileSelect.value;
        const data = name ? localStorage.getItem('esp32_profile_' + name) : JSON.stringify(collectProfileData());
        const blob = new Blob([data || '{}'], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `profile_${name || 'current'}_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // Import profile from JSON file
    btnProfileImport.addEventListener('click', () => {
        const fi = document.createElement('input');
        fi.type = 'file';
        fi.accept = '.json';
        fi.addEventListener('change', () => {
            const file = fi.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    const name = prompt('Nom du profil importé :', file.name.replace(/\.json$/, ''));
                    if (!name) return;
                    localStorage.setItem('esp32_profile_' + name, JSON.stringify(data));
                    const list = getProfileList();
                    if (!list.includes(name)) {
                        list.push(name);
                        saveProfileList(list);
                    }
                    refreshProfileSelect();
                    profileSelect.value = name;
                    applyProfileData(data);
                } catch (err) {
                    showToast('Fichier profil invalide: ' + err.message, 'error');
                }
            };
            reader.readAsText(file);
        });
        fi.click();
    });

    // Initialize profile list
    refreshProfileSelect();

    // =========================================================================
    // Help tooltips system
    // =========================================================================

    const HELP_CONTENT = {
        profiles: {
            title: 'Profils / Workspaces',
            body: `<ul>
<li><b>💾 Sauver</b> : enregistre l'état complet (macros, triggers, highlights, filtres, thème, script, etc.)</li>
<li><b>🗑 Supprimer</b> : supprime le profil sélectionné</li>
<li><b>↗ Exporter</b> : télécharge le profil en fichier JSON (partageable)</li>
<li><b>↙ Importer</b> : charge un profil depuis un fichier JSON</li>
<li>Sélectionner un profil dans la liste le charge automatiquement</li>
<li>Si aucun profil n'est sélectionné, "Sauver" crée un nouveau profil</li>
<li>Les profils sont stockés en localStorage et persistent entre les sessions</li>
</ul>`
        },
        console: {
            title: 'Console série',
            body: `<ul>
<li><b>Auto-scroll</b> : défile automatiquement vers le bas à chaque nouvelle ligne</li>
<li><b>Horodatage</b> : ajoute l'heure à chaque ligne reçue</li>
<li><b>Hex</b> : affiche les données en dump hexadécimal</li>
<li><b>ANSI</b> : interprète les codes couleur ANSI</li>
<li><b>JSON</b> : formate automatiquement les objets JSON reçus</li>
<li><b>Rec</b> : enregistre les données pour export ou replay ultérieur</li>
<li><b>Export</b> : exporte en TXT, CSV, JSON ou rejoue un fichier enregistré</li>
<li>La barre d'input supporte <code>↑↓</code> pour l'historique et l'autocomplétion</li>
</ul>`
        },
        consoletabs: {
            title: 'Onglets console (filtres)',
            body: `<ul>
<li><b>Tout</b> : affiche toutes les lignes sans filtre</li>
<li><b>LOG</b> : filtre les lignes de type ESP-IDF log (E/W/I/D/V)</li>
<li><b>DATA</b> : filtre les lignes contenant uniquement des données numériques</li>
<li><b>+</b> : créer un onglet personnalisé avec un nom et une regex</li>
<li>Clic droit sur un onglet personnalisé pour le supprimer</li>
<li>Cliquer sur un onglet applique automatiquement son filtre regex</li>
</ul>`
        },
        repeat: {
            title: 'Envoi répété',
            body: `<p>Envoie automatiquement un message à intervalle régulier.</p>
<ul>
<li>Saisissez le message à envoyer et la fréquence en millisecondes</li>
<li>Cliquez <b>Répéter</b> pour démarrer, <b>Stop</b> pour arrêter</li>
<li>Utile pour le polling, le heartbeat, ou les tests de stress</li>
</ul>`
        },
        macros: {
            title: 'Macros, Séquences & Triggers',
            body: `<p><b>Commandes rapides (+ Cmd)</b></p>
<ul>
<li>Crée un bouton qui envoie une commande en un clic</li>
<li>Cliquez <b>▶</b> pour exécuter, <b>↻</b> pour envoyer en boucle (avec intervalle), <b>×</b> pour supprimer</li>
</ul>
<p><b>Séquences (+ Séq)</b></p>
<ul>
<li>Enchaîne plusieurs commandes avec des délais entre chaque étape</li>
<li>Ex : <code>AT\\r\\n</code> → 500ms → <code>AT+GMR\\r\\n</code></li>
<li>Cliquez ▶ pour lancer, ■ pour arrêter</li>
</ul>
<p><b>Triggers (+ Trigger)</b></p>
<ul>
<li>Exécute une commande automatiquement quand une regex matche dans les données reçues</li>
<li>Ex : si reçoit <code>READY</code> → envoie <code>START</code></li>
</ul>
<p>Toutes les macros sont sauvegardées automatiquement (localStorage).</p>`
        },
        highlights: {
            title: 'Surlignage (Highlights)',
            body: `<ul>
<li>Cliquez <b>+ Règle</b> pour ajouter une regex de surlignage</li>
<li>Chaque règle a une couleur distincte attribuée automatiquement</li>
<li>Les lignes correspondantes sont marquées avec une bordure colorée</li>
<li>Le texte matché est surligné en couleur dans la ligne</li>
<li>Cochez/décochez pour activer/désactiver une règle, <b>×</b> pour supprimer</li>
<li>Les règles sont persistantes (sauvegardées en localStorage)</li>
</ul>`
        },
        filesender: {
            title: 'Envoi fichier ligne par ligne',
            body: `<ul>
<li><b>Choisir fichier</b> : charger un fichier texte (.txt, .csv, .log, .gcode...)</li>
<li><b>Freq</b> : délai en ms entre l'envoi de chaque ligne</li>
<li><b>Boucle</b> : recommence au début après la dernière ligne</li>
<li><b>Démarrer / Stop / Pause</b> : contrôle de l'envoi</li>
<li>Si le fichier contient des colonnes (tab, ; ou ,), un panneau apparaît pour choisir quelles colonnes envoyer et avec quel séparateur de sortie</li>
<li>Ex : colonnes <code>1;3</code> avec séparateur <code>;</code> → envoie seulement les colonnes 1 et 3</li>
</ul>`
        },
        devicecontrol: {
            title: 'Contrôle du device',
            body: `<p><b>GPIO (+ Pin)</b></p>
<ul>
<li>Ajoute un bouton toggle ON/OFF qui envoie une commande configurée</li>
<li>Configurez le nom, le numéro de pin, les commandes ON/OFF</li>
<li>Mode Output ou PWM disponible</li>
</ul>
<p><b>Dashboard (+ Var)</b></p>
<ul>
<li>Crée une jauge qui extrait une valeur des données reçues via regex</li>
<li>Configurez le nom, la regex d'extraction, l'unité, min et max</li>
<li>La valeur se met à jour automatiquement à chaque ligne reçue matchante</li>
</ul>
<p><b>Upload fichier</b></p>
<ul>
<li>Envoie le contenu complet d'un fichier en une fois sur le port série</li>
</ul>`
        },
        plotter: {
            title: 'Traceur (Plotter)',
            body: `<ul>
<li><b>Zoom</b> : molette souris (Ctrl = X seulement, Shift = Y seulement)</li>
<li><b>Pan</b> : clic milieu ou droit + glisser</li>
<li><b>Curseurs</b> : clic gauche pour placer C1, re-clic pour C2 (affiche Δ)</li>
<li><b>Double-clic</b> : reset zoom/pan/curseurs</li>
<li><b>Stats</b> : min/max/moyenne/écart-type affichés sous le graphe (entre curseurs si placés)</li>
<li><b>Multi-Y</b> : un graphe par canal avec échelles indépendantes</li>
<li><b>FFT</b> : bascule en mode analyse fréquentielle</li>
<li><b>PNG</b> : exporte la vue actuelle ou la courbe complète en image</li>
<li><b>CSV</b> : exporte toutes les données en fichier CSV</li>
<li>Le séparateur, le stripping début/fin et la taille de fenêtre sont configurables</li>
</ul>`
        },
    };

    let activeTooltip = null;

    function showHelpTooltip(tipEl) {
        hideHelpTooltip();
        const key = tipEl.dataset.help;
        const content = HELP_CONTENT[key];
        if (!content) return;

        const tooltip = document.createElement('div');
        tooltip.className = 'help-tooltip';
        tooltip.innerHTML = `<h4>${content.title}</h4>${content.body}`;
        document.body.appendChild(tooltip);

        // Position near the "?" badge
        const rect = tipEl.getBoundingClientRect();
        let top = rect.bottom + 6;
        let left = rect.left - 10;

        // Keep within viewport
        const tw = 360;
        if (left + tw > window.innerWidth - 10) left = window.innerWidth - tw - 10;
        if (left < 10) left = 10;
        if (top + tooltip.offsetHeight > window.innerHeight - 10) {
            top = rect.top - tooltip.offsetHeight - 6;
        }

        tooltip.style.top = top + 'px';
        tooltip.style.left = left + 'px';
        activeTooltip = tooltip;
    }

    function hideHelpTooltip() {
        if (activeTooltip) {
            activeTooltip.remove();
            activeTooltip = null;
        }
    }

    // Event delegation for all help tips
    document.addEventListener('click', (e) => {
        const tip = e.target.closest('.help-tip');
        if (tip) {
            e.stopPropagation();
            if (activeTooltip) {
                hideHelpTooltip();
            } else {
                showHelpTooltip(tip);
            }
            return;
        }
        // Click outside closes tooltip
        if (activeTooltip && !e.target.closest('.help-tooltip')) {
            hideHelpTooltip();
        }
    });

    // =========================================================================
    // Drag & drop — reorder sections within device-group
    // =========================================================================

    const SECTION_ORDER_KEY = 'esp32-section-order';
    const DEFAULT_SECTION_ORDER = ['plotter', 'decoder', 'script', 'datatable'];

    function getSavedSectionOrder() {
        try {
            const raw = localStorage.getItem(SECTION_ORDER_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {}
        return DEFAULT_SECTION_ORDER;
    }

    function saveSectionOrder(order) {
        localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(order));
    }

    /**
     * Apply saved section order within a device-group container.
     * Moves [data-section] elements to match the saved order.
     */
    function applySectionOrder(group) {
        const order = getSavedSectionOrder();
        // Collect the section elements and the plotter resize handle
        const sections = {};
        const resizeHandle = group.querySelector('.plotter-side-resize-handle');
        group.querySelectorAll('[data-section]').forEach(el => {
            sections[el.dataset.section] = el;
        });
        // Re-append in order (after the device-panel which stays first)
        for (const key of order) {
            const el = sections[key];
            if (!el) continue;
            // plotter has a preceding resize handle
            if (key === 'plotter' && resizeHandle) {
                group.appendChild(resizeHandle);
            }
            group.appendChild(el);
        }
    }

    // Apply order to all existing device groups
    function applyAllSectionOrders() {
        document.querySelectorAll('.device-group').forEach(applySectionOrder);
    }

    // Setup drag handlers on a device-group
    function setupSectionDrag(group) {
        let draggedEl = null;

        group.querySelectorAll('[data-section]').forEach(sectionEl => {
            // Find drag handle (plotter already has .plotter-drag-handle, others have .section-drag-handle)
            const handle = sectionEl.querySelector('.section-drag-handle, .plotter-drag-handle');
            if (!handle) return;

            handle.addEventListener('mousedown', () => {
                sectionEl.setAttribute('draggable', 'true');
            });
            handle.addEventListener('mouseup', () => {
                sectionEl.removeAttribute('draggable');
            });

            sectionEl.addEventListener('dragstart', (e) => {
                // Only allow drag from the handle
                if (!e.target.closest('.section-drag-handle, .plotter-drag-handle')) {
                    e.preventDefault();
                    return;
                }
                draggedEl = sectionEl;
                sectionEl.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', sectionEl.dataset.section);
            });

            sectionEl.addEventListener('dragend', () => {
                sectionEl.classList.remove('dragging');
                sectionEl.removeAttribute('draggable');
                draggedEl = null;
                // Remove all drag-over indicators
                group.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            });

            sectionEl.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (draggedEl && draggedEl !== sectionEl) {
                    // Remove drag-over from siblings
                    group.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                    sectionEl.classList.add('drag-over');
                }
            });

            sectionEl.addEventListener('dragleave', () => {
                sectionEl.classList.remove('drag-over');
            });

            sectionEl.addEventListener('drop', (e) => {
                e.preventDefault();
                sectionEl.classList.remove('drag-over');
                if (!draggedEl || draggedEl === sectionEl) return;

                // Move dragged element before or after target
                const rect = sectionEl.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                if (e.clientY < midY) {
                    // Insert before
                    // If dragged is plotter, also move its resize handle
                    if (draggedEl.dataset.section === 'plotter') {
                        const rh = group.querySelector('.plotter-side-resize-handle');
                        if (rh) group.insertBefore(rh, sectionEl);
                    }
                    group.insertBefore(draggedEl, sectionEl);
                } else {
                    // Insert after
                    const next = sectionEl.nextElementSibling;
                    if (draggedEl.dataset.section === 'plotter') {
                        const rh = group.querySelector('.plotter-side-resize-handle');
                        if (rh) {
                            if (next) group.insertBefore(rh, next);
                            else group.appendChild(rh);
                        }
                    }
                    if (next) group.insertBefore(draggedEl, next);
                    else group.appendChild(draggedEl);
                }

                // Save new order
                const newOrder = [];
                group.querySelectorAll('[data-section]').forEach(el => {
                    newOrder.push(el.dataset.section);
                });
                saveSectionOrder(newOrder);
            });
        });
    }

    // Hook into rebuildDevices to setup drag on new panels
    const origOnDevicesRebuilt = window._onDevicesRebuilt;
    window._onDevicesRebuilt = () => {
        if (origOnDevicesRebuilt) origOnDevicesRebuilt();
        document.querySelectorAll('.device-group').forEach(group => {
            applySectionOrder(group);
            setupSectionDrag(group);
        });
    };

    // Apply to existing groups on initial load
    document.querySelectorAll('.device-group').forEach(group => {
        applySectionOrder(group);
        setupSectionDrag(group);
    });

    // =========================================================================
    // i18n — FR / EN language switch
    // =========================================================================

    const I18N = {
        fr: {
            // Sidebar
            'sidebar.devices': 'Devices',
            'sidebar.views': 'Vues',
            'sidebar.plotter': 'Traceur',
            'sidebar.decoder': 'Décodeur',
            'sidebar.script': 'Script',
            'sidebar.datatable': 'Tableau',
            'sidebar.logic': 'Logique',
            'sidebar.config': 'Config',
            'sidebar.exportConfig': 'Export config',
            'sidebar.exportConfigTip': 'Exporter config (macros, triggers, GPIO...)',
            'sidebar.importConfig': 'Import config',
            'sidebar.importConfigTip': 'Charger config',
            'sidebar.sessionHTML': 'Session HTML',
            'sidebar.sessionTip': 'Exporter la session en HTML autonome',
            'sidebar.profile': 'Profil',
            'sidebar.profileDefault': '— Profil —',
            'sidebar.save': 'Sauver',
            'sidebar.saveTip': 'Sauvegarder le profil',
            'sidebar.delete': 'Supprimer',
            'sidebar.deleteTip': 'Supprimer le profil',
            'sidebar.exportJSON': 'Export JSON',
            'sidebar.exportJSONTip': 'Exporter profil en JSON',
            'sidebar.importJSON': 'Import JSON',
            'sidebar.importJSONTip': 'Importer profil JSON',
            'sidebar.shortcuts': 'Raccourcis',
            'sidebar.shortcutsTip': 'Raccourcis clavier (Ctrl+?)',

            // Shortcuts overlay
            'shortcuts.title': 'Raccourcis clavier',
            'shortcuts.clearConsole': 'Effacer la console active',
            'shortcuts.record': 'Enregistrer (Rec)',
            'shortcuts.focusSend': "Focus champ d'envoi",
            'shortcuts.switchDevice': 'Activer device 1-4',
            'shortcuts.pausePlotter': 'Pause/Resume traceur',
            'shortcuts.search': 'Rechercher dans la console',
            'shortcuts.showHelp': 'Afficher cette aide',
            'shortcuts.close': 'Fermer menus / overlay / recherche',
            'shortcuts.pressEsc': 'Appuyez sur <b>Esc</b> pour fermer',

            // Device
            'device.disconnected': 'Déconnecté',
            'device.connected': 'Connecté',

            // Connection
            'conn.serial': 'Série',
            'conn.tcpudp': 'TCP / UDP',
            'conn.relayHint': 'Double-cliquez <b>start-relay.bat</b> pour lancer le relay',

            // Buttons
            'btn.connect': 'Connecter',
            'btn.disconnect': 'Déconnecter',
            'btn.simulate': 'Simuler',
            'btn.connectRelay': 'Connecter relay',
            'btn.send': 'Envoyer',
            'btn.clear': 'Effacer',
            'btn.repeat': 'Répéter',
            'btn.stop': 'Stop',
            'btn.start': 'Démarrer',
            'btn.pause': 'Pause',
            'btn.reset': 'Reset',
            'btn.load': 'Charger',
            'btn.apply': 'Appliquer',

            // Console
            'console.autoscroll': 'Auto-scroll',
            'console.timestamp': 'Horodatage',
            'console.recordTip': 'Enregistrer (Ctrl+R)',
            'console.replay': 'Rejouer…',
            'console.all': 'Tout',
            'console.filterPlaceholder': 'Filtrer (regex)...',
            'console.exclude': 'Exclure',
            'console.searchPlaceholder': 'Rechercher (regex)...',
            'console.sendPlaceholder': 'Envoyer une commande... (↑↓ historique)',
            'console.repeatPlaceholder': 'Message à répéter...',
            'console.every': 'Toutes les',
            'console.none': 'Aucun',
            'console.lines': 'lignes',

            // Macros
            'macros.title': 'Macros',
            'macros.addCmdTip': 'Ajouter une commande rapide',
            'macros.addSeqTip': 'Ajouter une séquence',
            'macros.addTriggerTip': 'Ajouter un trigger',
            'macros.quickCmds': 'Commandes rapides',
            'macros.sequences': 'Séquences',
            'macros.triggers': 'Triggers',

            // Highlights
            'highlights.title': 'Highlights',
            'highlights.addTip': 'Ajouter une règle de surbrillance',
            'highlights.rule': 'Règle',

            // File sender
            'fileSender.title': 'Envoi fichier',
            'fileSender.chooseFile': 'Choisir fichier',
            'fileSender.noFile': 'Aucun fichier',
            'fileSender.loop': 'Boucle',

            // Control
            'control.title': 'Contrôle du device',
            'control.gpio': 'GPIO',
            'control.gpioHint': 'Envoie la commande configurée au device lors du toggle',
            'control.dashboard': 'Dashboard',
            'control.dashHint': 'Extrait automatiquement les valeurs depuis la console',
            'control.upload': 'Upload fichiers',
            'control.uploadFile': 'Envoyer un fichier',

            // Plotter
            'plotter.refresh': 'Actualiser',
            'plotter.currentView': 'Vue actuelle',
            'plotter.fullCurve': 'Courbe complète',
            'plotter.exportViewTip': 'Exporter la vue actuelle',
            'plotter.exportFullTip': 'Exporter toutes les données',
            'plotter.waiting': 'En attente de données numériques…',

            // Decoder
            'decoder.follow': 'Suivre',
            'decoder.waiting': 'En attente de données décodables…',

            // Logic analyzer
            'logic.title': 'Analyseur logique',
            'logic.source': 'Source :',
            'logic.signalRegex': 'Regex signal :',
            'logic.active': 'Actif',

            // Test suite
            'suite.title': 'Suite de tests',
            'suite.addTip': 'Ajouter un script à la suite',
            'suite.runAll': '▶ Tout lancer',
            'suite.report': 'Rapport',
            'suite.reportTip': 'Exporter le rapport HTML',

            // Bridge
            'bridge.title': 'Bridge (relais entre devices)',
            'bridge.hint': 'Les messages reçus par un device source sont automatiquement retransmis au device destination.',

            // Toasts / dynamic
            'toast.profileLoaded': 'Profil chargé',
            'toast.profileSaved': 'Profil "{name}" sauvegardé',
            'toast.profileDeleted': 'Profil "{name}" supprimé',
            'toast.profileNotFound': 'Profil introuvable',
            'toast.noBookmark': 'Aucun signet',
            'toast.sessionExported': 'Session exportée en HTML',
            'toast.consoleDetached': 'Console détachée',
            'toast.tableDetached': 'Tableau détaché',
            'toast.noData': 'Aucune donnée',
            'toast.noFileOrDevice': 'Pas de fichier ou appareil non connecté',
            'toast.fileSendDone': 'Envoi fichier terminé',
            'toast.reportExported': 'Rapport exporté',
            'toast.noSuiteScript': 'Aucun script dans la suite',
            'toast.scriptRunning': 'Script déjà en cours',
            'toast.noSuiteResult': 'Aucun résultat de suite',
            'toast.allColsSent': 'Toutes les colonnes seront envoyées',
            'toast.invalidColIdx': 'Indices de colonnes invalides',
            'toast.colsSelected': 'Colonnes [{cols}] sélectionnées',

            // Prompts
            'prompt.annotationOpt': 'Annotation (optionnel) :',
            'prompt.pinName': 'Nom du pin (ex: LED, Relay) :',
            'prompt.gpioNum': 'Numéro GPIO :',
            'prompt.gpioMode': 'Mode — 1=Output, 2=PWM :',
            'prompt.cmdOn': 'Commande ON :',
            'prompt.cmdOff': 'Commande OFF :',
            'prompt.varName': 'Nom de la variable (ex: Température) :',
            'prompt.varRegex': "Regex d'extraction (groupe 1 = valeur) :",
            'prompt.varUnit': 'Unité (ex: °C, %, V) :',
            'prompt.varMin': 'Valeur min (pour la barre) :',
            'prompt.varMax': 'Valeur max (pour la barre) :',
            'prompt.macroName': 'Nom de la commande :',
            'prompt.macroCmd': 'Commande à envoyer :',
            'prompt.repeatInterval': 'Intervalle (ms) :',
            'prompt.seqName': 'Nom de la séquence :',
            'prompt.seqCmd': 'Commande :',
            'prompt.seqDelay': 'Délai après (ms) :',
            'prompt.triggerPattern': 'Pattern (regex) :',
            'prompt.triggerAction': "Action :\n1 = Beep\n2 = Notification desktop\n3 = Surbrillance console\n4 = Alarme (son continu)\n5 = Son succès\n6 = Bannière alerte\n7 = Envoyer commande\n8 = Webhook (HTTP POST)",
            'prompt.triggerCmd': 'Commande à envoyer quand le pattern matche :',
            'prompt.webhookUrl': 'URL du webhook (POST) :\nEx: https://hooks.slack.com/services/...',
            'prompt.tabName': "Nom de l'onglet :",
            'prompt.tabRegex': 'Regex filtre :',
            'prompt.confirmDeleteTab': 'Supprimer l\'onglet "{name}" ?',
            'prompt.highlightRegex': 'Regex à surligner :',
            'prompt.profileName': 'Nom du profil :',
            'prompt.confirmDeleteProfile': 'Supprimer le profil "{name}" ?',
            'prompt.deviceName': 'Nom du device :',

            // Auto-reconnect
            'conn.autoReconnect': 'Auto-reco',
            'reconnect.scheduling': 'Reconnexion dans {delay}s (tentative {attempt})…',
            'reconnect.attempting': 'Tentative de reconnexion #{attempt}…',
            'reconnect.failed': 'Échec reconnexion : {err}',
            'reconnect.maxAttempts': 'Nombre max de tentatives de reconnexion atteint.',
            'reconnect.noPort': 'Impossible de reconnecter : port série non disponible.',

            // Pin Map
            'sidebar.pinmap': 'Pin Map',
            'pinmap.title': 'Pin Map',
            'pinmap.board': 'Carte',
            'pinmap.source': 'Source',
            'pinmap.regex': 'Regex',
            'pinmap.active': 'Actif',
            'pinmap.clickPin': 'Cliquez sur un pin pour voir ses détails',

            // Plugin
            'plugin.load': 'Plugin',
            'plugin.loadTip': 'Charger un plugin (.js)',
            'plugin.manager': 'Gestionnaire de plugins',
            'plugin.loadFile': 'Charger fichier .js',
            'plugin.loaded': 'Plugin "{name}" chargé',
            'plugin.error': 'Erreur plugin "{name}": {err}',
            'plugin.noPlugins': 'Aucun plugin chargé',
            'plugin.unloaded': 'Plugin "{name}" déchargé',

            // Theme
            'theme.dark': 'Sombre',
            'theme.light': 'Clair',
            'theme.highcontrast': 'Haut contraste',

            // Language
            'lang.label': 'Français',
            'lang.icon': 'FR',
        },
        en: {
            // Sidebar
            'sidebar.devices': 'Devices',
            'sidebar.views': 'Views',
            'sidebar.plotter': 'Plotter',
            'sidebar.decoder': 'Decoder',
            'sidebar.script': 'Script',
            'sidebar.datatable': 'Table',
            'sidebar.logic': 'Logic',
            'sidebar.config': 'Config',
            'sidebar.exportConfig': 'Export config',
            'sidebar.exportConfigTip': 'Export config (macros, triggers, GPIO...)',
            'sidebar.importConfig': 'Import config',
            'sidebar.importConfigTip': 'Load config',
            'sidebar.sessionHTML': 'Session HTML',
            'sidebar.sessionTip': 'Export session as standalone HTML',
            'sidebar.profile': 'Profile',
            'sidebar.profileDefault': '— Profile —',
            'sidebar.save': 'Save',
            'sidebar.saveTip': 'Save profile',
            'sidebar.delete': 'Delete',
            'sidebar.deleteTip': 'Delete profile',
            'sidebar.exportJSON': 'Export JSON',
            'sidebar.exportJSONTip': 'Export profile as JSON',
            'sidebar.importJSON': 'Import JSON',
            'sidebar.importJSONTip': 'Import profile JSON',
            'sidebar.shortcuts': 'Shortcuts',
            'sidebar.shortcutsTip': 'Keyboard shortcuts (Ctrl+?)',

            // Shortcuts overlay
            'shortcuts.title': 'Keyboard shortcuts',
            'shortcuts.clearConsole': 'Clear active console',
            'shortcuts.record': 'Record (Rec)',
            'shortcuts.focusSend': 'Focus send field',
            'shortcuts.switchDevice': 'Switch to device 1-4',
            'shortcuts.pausePlotter': 'Pause/Resume plotter',
            'shortcuts.search': 'Search in console',
            'shortcuts.showHelp': 'Show this help',
            'shortcuts.close': 'Close menus / overlay / search',
            'shortcuts.pressEsc': 'Press <b>Esc</b> to close',

            // Device
            'device.disconnected': 'Disconnected',
            'device.connected': 'Connected',

            // Connection
            'conn.serial': 'Serial',
            'conn.tcpudp': 'TCP / UDP',
            'conn.relayHint': 'Double-click <b>start-relay.bat</b> to start the relay',

            // Buttons
            'btn.connect': 'Connect',
            'btn.disconnect': 'Disconnect',
            'btn.simulate': 'Simulate',
            'btn.connectRelay': 'Connect relay',
            'btn.send': 'Send',
            'btn.clear': 'Clear',
            'btn.repeat': 'Repeat',
            'btn.stop': 'Stop',
            'btn.start': 'Start',
            'btn.pause': 'Pause',
            'btn.reset': 'Reset',
            'btn.load': 'Load',
            'btn.apply': 'Apply',

            // Console
            'console.autoscroll': 'Auto-scroll',
            'console.timestamp': 'Timestamp',
            'console.recordTip': 'Record (Ctrl+R)',
            'console.replay': 'Replay…',
            'console.all': 'All',
            'console.filterPlaceholder': 'Filter (regex)...',
            'console.exclude': 'Exclude',
            'console.searchPlaceholder': 'Search (regex)...',
            'console.sendPlaceholder': 'Send a command... (↑↓ history)',
            'console.repeatPlaceholder': 'Message to repeat...',
            'console.every': 'Every',
            'console.none': 'None',
            'console.lines': 'lines',

            // Macros
            'macros.title': 'Macros',
            'macros.addCmdTip': 'Add a quick command',
            'macros.addSeqTip': 'Add a sequence',
            'macros.addTriggerTip': 'Add a trigger',
            'macros.quickCmds': 'Quick commands',
            'macros.sequences': 'Sequences',
            'macros.triggers': 'Triggers',

            // Highlights
            'highlights.title': 'Highlights',
            'highlights.addTip': 'Add a highlight rule',
            'highlights.rule': 'Rule',

            // File sender
            'fileSender.title': 'File sender',
            'fileSender.chooseFile': 'Choose file',
            'fileSender.noFile': 'No file',
            'fileSender.loop': 'Loop',

            // Control
            'control.title': 'Device control',
            'control.gpio': 'GPIO',
            'control.gpioHint': 'Sends the configured command on toggle',
            'control.dashboard': 'Dashboard',
            'control.dashHint': 'Automatically extracts values from console',
            'control.upload': 'File upload',
            'control.uploadFile': 'Upload a file',

            // Plotter
            'plotter.refresh': 'Refresh',
            'plotter.currentView': 'Current view',
            'plotter.fullCurve': 'Full curve',
            'plotter.exportViewTip': 'Export current view',
            'plotter.exportFullTip': 'Export all data',
            'plotter.waiting': 'Waiting for numeric data…',

            // Decoder
            'decoder.follow': 'Follow',
            'decoder.waiting': 'Waiting for decodable data…',

            // Logic analyzer
            'logic.title': 'Logic analyzer',
            'logic.source': 'Source:',
            'logic.signalRegex': 'Signal regex:',
            'logic.active': 'Active',

            // Test suite
            'suite.title': 'Test suite',
            'suite.addTip': 'Add a script to the suite',
            'suite.runAll': '▶ Run all',
            'suite.report': 'Report',
            'suite.reportTip': 'Export HTML report',

            // Bridge
            'bridge.title': 'Bridge (relay between devices)',
            'bridge.hint': 'Messages received by a source device are automatically forwarded to the destination device.',

            // Toasts / dynamic
            'toast.profileLoaded': 'Profile loaded',
            'toast.profileSaved': 'Profile "{name}" saved',
            'toast.profileDeleted': 'Profile "{name}" deleted',
            'toast.profileNotFound': 'Profile not found',
            'toast.noBookmark': 'No bookmark',
            'toast.sessionExported': 'Session exported as HTML',
            'toast.consoleDetached': 'Console detached',
            'toast.tableDetached': 'Table detached',
            'toast.noData': 'No data',
            'toast.noFileOrDevice': 'No file or device not connected',
            'toast.fileSendDone': 'File send complete',
            'toast.reportExported': 'Report exported',
            'toast.noSuiteScript': 'No script in the suite',
            'toast.scriptRunning': 'Script already running',
            'toast.noSuiteResult': 'No suite results',
            'toast.allColsSent': 'All columns will be sent',
            'toast.invalidColIdx': 'Invalid column indices',
            'toast.colsSelected': 'Columns [{cols}] selected',

            // Prompts
            'prompt.annotationOpt': 'Annotation (optional):',
            'prompt.pinName': 'Pin name (e.g. LED, Relay):',
            'prompt.gpioNum': 'GPIO number:',
            'prompt.gpioMode': 'Mode — 1=Output, 2=PWM:',
            'prompt.cmdOn': 'ON command:',
            'prompt.cmdOff': 'OFF command:',
            'prompt.varName': 'Variable name (e.g. Temperature):',
            'prompt.varRegex': 'Extraction regex (group 1 = value):',
            'prompt.varUnit': 'Unit (e.g. °C, %, V):',
            'prompt.varMin': 'Min value (for bar):',
            'prompt.varMax': 'Max value (for bar):',
            'prompt.macroName': 'Command name:',
            'prompt.macroCmd': 'Command to send:',
            'prompt.repeatInterval': 'Interval (ms):',
            'prompt.seqName': 'Sequence name:',
            'prompt.seqCmd': 'Command:',
            'prompt.seqDelay': 'Delay after (ms):',
            'prompt.triggerPattern': 'Pattern (regex):',
            'prompt.triggerAction': 'Action:\n1 = Beep\n2 = Desktop notification\n3 = Console highlight\n4 = Alarm (continuous sound)\n5 = Success sound\n6 = Alert banner\n7 = Send command\n8 = Webhook (HTTP POST)',
            'prompt.triggerCmd': 'Command to send when pattern matches:',
            'prompt.webhookUrl': 'Webhook URL (POST):\nEx: https://hooks.slack.com/services/...',
            'prompt.tabName': 'Tab name:',
            'prompt.tabRegex': 'Filter regex:',
            'prompt.confirmDeleteTab': 'Delete tab "{name}"?',
            'prompt.highlightRegex': 'Regex to highlight:',
            'prompt.profileName': 'Profile name:',
            'prompt.confirmDeleteProfile': 'Delete profile "{name}"?',
            'prompt.deviceName': 'Device name:',

            // Auto-reconnect
            'conn.autoReconnect': 'Auto-reco',
            'reconnect.scheduling': 'Reconnecting in {delay}s (attempt {attempt})…',
            'reconnect.attempting': 'Reconnection attempt #{attempt}…',
            'reconnect.failed': 'Reconnection failed: {err}',
            'reconnect.maxAttempts': 'Max reconnection attempts reached.',
            'reconnect.noPort': 'Cannot reconnect: serial port unavailable.',

            // Pin Map
            'sidebar.pinmap': 'Pin Map',
            'pinmap.title': 'Pin Map',
            'pinmap.board': 'Board',
            'pinmap.source': 'Source',
            'pinmap.regex': 'Regex',
            'pinmap.active': 'Active',
            'pinmap.clickPin': 'Click a pin to see its details',

            // Plugin
            'plugin.load': 'Plugin',
            'plugin.loadTip': 'Load a plugin (.js)',
            'plugin.manager': 'Plugin manager',
            'plugin.loadFile': 'Load .js file',
            'plugin.loaded': 'Plugin "{name}" loaded',
            'plugin.error': 'Plugin error "{name}": {err}',
            'plugin.noPlugins': 'No plugins loaded',
            'plugin.unloaded': 'Plugin "{name}" unloaded',

            // Theme
            'theme.dark': 'Dark',
            'theme.light': 'Light',
            'theme.highcontrast': 'High contrast',

            // Language
            'lang.label': 'English',
            'lang.icon': 'EN',
        }
    };

    let currentLang = localStorage.getItem('esp32-lang') || 'fr';

    /**
     * Get translation for a key, with optional placeholder replacements.
     * t('toast.profileSaved', { name: 'MyProfile' })
     */
    function t(key, vars) {
        const dict = I18N[currentLang] || I18N.fr;
        let str = dict[key];
        if (str === undefined) str = (I18N.fr[key] || key);
        if (vars) {
            for (const [k, v] of Object.entries(vars)) {
                str = str.replace('{' + k + '}', v);
            }
        }
        return str;
    }

    // Expose for other modules
    window.ESP32Tester.t = t;
    window.ESP32Tester._reapplyLang = () => applyLanguage(currentLang);

    /**
     * Apply language to all elements with data-i18n, data-i18n-placeholder, data-i18n-title.
     * Applies to both the main document and all device panels (cloned from template).
     */
    function applyLanguage(lang) {
        currentLang = lang;
        localStorage.setItem('esp32-lang', lang);
        document.documentElement.lang = lang;

        // Update all static data-i18n elements (textContent)
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const val = t(key);
            // For elements that use innerHTML (e.g. shortcuts.pressEsc has <b>)
            if (val.includes('<')) {
                el.innerHTML = val;
            } else {
                el.textContent = val;
            }
        });

        // Update placeholders
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
        });

        // Update titles (tooltips)
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            el.title = t(el.getAttribute('data-i18n-title'));
        });

        // Update lang toggle button
        const langIcon = document.getElementById('langIcon');
        const langLabel = document.getElementById('langLabel');
        if (langIcon) langIcon.textContent = t('lang.icon');
        if (langLabel) langLabel.textContent = t('lang.label');

        // Update theme label to match current language
        const themeLabel = document.getElementById('themeLabel');
        const themeSelect = document.getElementById('themeSelect');
        if (themeLabel && themeSelect) {
            const themeNames = {
                fr: { dark: 'Sombre', light: 'Clair', highcontrast: 'Haut contraste' },
                en: { dark: 'Dark', light: 'Light', highcontrast: 'High contrast' }
            };
            const names = themeNames[lang] || themeNames.fr;
            themeLabel.textContent = names[themeSelect.value] || themeSelect.value;
        }
    }

    // Language toggle button handler
    const langToggleBtn = document.getElementById('langToggleBtn');
    if (langToggleBtn) {
        langToggleBtn.addEventListener('click', () => {
            const next = currentLang === 'fr' ? 'en' : 'fr';
            applyLanguage(next);
        });
    }

    // Apply saved language on load
    applyLanguage(currentLang);

    // =========================================================================
    // Plugin system — load external .js extensions
    // =========================================================================

    const pluginRegistry = [];   // { name, cleanup }

    /**
     * Public API exposed to plugins via window.ESP32Tester.
     * Plugins receive: devices, showToast, t, appendLine, sendRawCommand, on/off events.
     */
    window.ESP32Tester.devices = devices;
    window.ESP32Tester.showToast = showToast;
    window.ESP32Tester.getDevices = () => devices;
    window.ESP32Tester.getDevice = (idx) => devices[idx] || null;
    window.ESP32Tester.appendLine = (dev, text, cls) => {
        if (typeof dev === 'number') dev = devices[dev];
        if (dev) appendLine(dev, text, cls);
    };
    window.ESP32Tester.sendCommand = (dev, cmd) => {
        if (typeof dev === 'number') dev = devices[dev];
        if (dev) sendRawCommand(dev, cmd);
    };

    // Simple event bus for plugins
    const pluginListeners = {};
    window.ESP32Tester.on = (event, fn) => {
        if (!pluginListeners[event]) pluginListeners[event] = [];
        pluginListeners[event].push(fn);
    };
    window.ESP32Tester.off = (event, fn) => {
        if (!pluginListeners[event]) return;
        pluginListeners[event] = pluginListeners[event].filter(f => f !== fn);
    };
    window.ESP32Tester.emit = (event, data) => {
        if (pluginListeners[event]) {
            for (const fn of pluginListeners[event]) {
                try { fn(data); } catch (e) { console.error('Plugin event error:', e); }
            }
        }
    };

    // Hook into appendLine to emit 'line' events for plugins
    const origAppendLine = appendLine;
    // We can't override const, but we can hook via the emit pattern.
    // Instead, we emit from within the existing data flow via a MutationObserver
    // or we simply call emit in the existing appendLine flow.
    // For simplicity, we expose the emit and document that plugins should
    // use window.ESP32Tester.on('line', ({dev, text}) => {...})

    /**
     * Load a plugin from a JS file.
     * The file should export/call: ESP32Tester.registerPlugin({ name, init, cleanup })
     */
    window.ESP32Tester.registerPlugin = (pluginDef) => {
        const name = pluginDef.name || 'unnamed';
        let cleanup = null;
        try {
            if (typeof pluginDef.init === 'function') {
                cleanup = pluginDef.init(window.ESP32Tester);
            }
            pluginRegistry.push({ name, cleanup: cleanup || pluginDef.cleanup || null });
            showToast(t('plugin.loaded', { name }), 'success', 2000);
            renderPluginList();
        } catch (err) {
            showToast(t('plugin.error', { name, err: err.message }), 'error', 4000);
            console.error('Plugin load error:', err);
        }
    };

    function unloadPlugin(idx) {
        const p = pluginRegistry[idx];
        if (!p) return;
        try {
            if (typeof p.cleanup === 'function') p.cleanup();
        } catch (e) { console.error('Plugin cleanup error:', e); }
        showToast(t('plugin.unloaded', { name: p.name }), 'info', 2000);
        pluginRegistry.splice(idx, 1);
        renderPluginList();
    }

    function renderPluginList() {
        const list = document.getElementById('pluginList');
        if (!list) return;
        if (pluginRegistry.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">' + t('plugin.noPlugins') + '</p>';
            return;
        }
        list.innerHTML = '';
        pluginRegistry.forEach((p, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);';
            row.innerHTML = '<span style="flex:1;font-size:13px;">🧩 ' + p.name + '</span>';
            const btn = document.createElement('button');
            btn.className = 'btn btn-danger btn-small';
            btn.textContent = '✕';
            btn.title = 'Unload';
            btn.onclick = () => unloadPlugin(i);
            row.appendChild(btn);
            list.appendChild(row);
        });
    }

    // Load plugin from file input
    function loadPluginFile(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const script = document.createElement('script');
                script.textContent = reader.result;
                script.dataset.pluginName = file.name;
                document.body.appendChild(script);
            } catch (err) {
                showToast(t('plugin.error', { name: file.name, err: err.message }), 'error', 4000);
            }
        };
        reader.readAsText(file);
    }

    // UI wiring
    const pluginOverlay = document.getElementById('pluginOverlay');
    const btnLoadPlugin = document.getElementById('btnLoadPlugin');
    const btnPluginFile = document.getElementById('btnPluginFile');
    const pluginFileInput = document.getElementById('pluginFileInput');

    if (btnLoadPlugin) {
        btnLoadPlugin.addEventListener('click', () => {
            if (pluginOverlay) {
                pluginOverlay.style.display = pluginOverlay.style.display === 'none' ? 'flex' : 'none';
                renderPluginList();
            }
        });
    }

    if (btnPluginFile && pluginFileInput) {
        btnPluginFile.addEventListener('click', () => pluginFileInput.click());
        pluginFileInput.addEventListener('change', () => {
            for (const f of pluginFileInput.files) {
                loadPluginFile(f);
            }
            pluginFileInput.value = '';
        });
    }

    // Close plugin overlay on Esc (reuse existing Esc handler logic)
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && pluginOverlay && pluginOverlay.style.display !== 'none') {
            pluginOverlay.style.display = 'none';
        }
    });

    // Expose plugin registry
    window.ESP32Tester.plugins = pluginRegistry;

})();
