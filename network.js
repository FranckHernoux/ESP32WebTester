// ============================================================================
// ESP32 Web Tester — MQTT Protocol + Logic Analyzer
// ============================================================================
(function () {
    'use strict';

    // =========================================================================
    // MQTT Protocol Object (exposed globally for serial.js)
    // =========================================================================
    const MQTT = {
        CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4,
        SUBSCRIBE: 8, SUBACK: 9, UNSUBSCRIBE: 10, UNSUBACK: 11,
        PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14,

        encodeLength(len) {
            const bytes = [];
            do {
                let b = len % 128;
                len = Math.floor(len / 128);
                if (len > 0) b |= 0x80;
                bytes.push(b);
            } while (len > 0);
            return bytes;
        },
        decodeLength(data, offset) {
            let multiplier = 1, value = 0, idx = offset;
            let b;
            do { b = data[idx++]; value += (b & 0x7F) * multiplier; multiplier *= 128; }
            while ((b & 0x80) !== 0 && idx < data.length);
            return { value, bytesRead: idx - offset };
        },
        encodeUTF8(str) {
            const enc = new TextEncoder().encode(str);
            return [enc.length >> 8, enc.length & 0xFF, ...enc];
        },
        buildConnect(clientId, user, pass) {
            const protoName = [0, 4, 77, 81, 84, 84];
            const protoLevel = 4;
            let flags = 0x02;
            if (user) flags |= 0x80;
            if (pass) flags |= 0x40;
            const keepAlive = [0, 60];
            const payload = [...this.encodeUTF8(clientId)];
            if (user) payload.push(...this.encodeUTF8(user));
            if (pass) payload.push(...this.encodeUTF8(pass));
            const varHeader = [...protoName, protoLevel, flags, ...keepAlive];
            const remaining = varHeader.length + payload.length;
            return new Uint8Array([0x10, ...this.encodeLength(remaining), ...varHeader, ...payload]);
        },
        buildSubscribe(msgId, topic, qos) {
            const varHeader = [msgId >> 8, msgId & 0xFF];
            const payload = [...this.encodeUTF8(topic), qos];
            const remaining = varHeader.length + payload.length;
            return new Uint8Array([0x82, ...this.encodeLength(remaining), ...varHeader, ...payload]);
        },
        buildUnsubscribe(msgId, topic) {
            const varHeader = [msgId >> 8, msgId & 0xFF];
            const payload = [...this.encodeUTF8(topic)];
            const remaining = varHeader.length + payload.length;
            return new Uint8Array([0xA2, ...this.encodeLength(remaining), ...varHeader, ...payload]);
        },
        buildPublish(topic, message, qos, retain) {
            const topicBytes = this.encodeUTF8(topic);
            const msgBytes = new TextEncoder().encode(message);
            let flags = 0x30;
            if (retain) flags |= 0x01;
            if (qos === 1) flags |= 0x02;
            if (qos === 2) flags |= 0x04;
            const varHeader = [...topicBytes];
            let msgId = [];
            if (qos > 0) { const id = (Math.random() * 0xFFFF) | 0; msgId = [id >> 8, id & 0xFF]; }
            const remaining = varHeader.length + msgId.length + msgBytes.length;
            return new Uint8Array([flags, ...this.encodeLength(remaining), ...varHeader, ...msgId, ...msgBytes]);
        },
        buildPingreq() { return new Uint8Array([0xC0, 0]); },
        buildDisconnect() { return new Uint8Array([0xE0, 0]); },
        parsePublish(data) {
            let offset = 0;
            const byte0 = data[offset++];
            const { value: remaining, bytesRead } = this.decodeLength(data, offset);
            offset += bytesRead;
            const topicLen = (data[offset] << 8) | data[offset + 1];
            offset += 2;
            const topic = new TextDecoder().decode(data.slice(offset, offset + topicLen));
            offset += topicLen;
            const qos = (byte0 >> 1) & 0x03;
            if (qos > 0) offset += 2;
            const payload = new TextDecoder().decode(data.slice(offset, offset + remaining - (offset - bytesRead - 1)));
            return { topic, payload, qos, retain: !!(byte0 & 0x01) };
        }
    };

    // Expose globally
    window.MQTT = MQTT;

    // =========================================================================
    // Logic Analyzer
    // =========================================================================
    const PLOT_COLORS = ['#4a9eff', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#fb923c', '#f472b6', '#38bdf8'];

    const logicSection = document.getElementById('logicAnalyzerSection');
    if (!logicSection) return;

    const logicEls = {
        source:   logicSection.querySelector('.logic-source'),
        regex:    logicSection.querySelector('.logic-regex'),
        window:   logicSection.querySelector('.logic-window'),
        btnClear: logicSection.querySelector('.btn-logic-clear'),
        active:   logicSection.querySelector('.chk-logic-active'),
        channels: logicSection.querySelector('.logic-channels'),
        canvas:   logicSection.querySelector('.logic-canvas'),
    };

    const logicState = { data: {} };

    function updateLogicSources() {
        const sel = logicEls.source;
        const current = sel.value;
        sel.innerHTML = '';
        const panels = document.querySelectorAll('#devicesContainer .device-panel');
        panels.forEach((p, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            opt.textContent = `Device ${i + 1}`;
            sel.appendChild(opt);
        });
        if (current && sel.querySelector(`option[value="${current}"]`)) sel.value = current;
    }

    window._logicAnalyzerFeed = function (deviceIndex, text) {
        if (!logicEls.active.checked) return;
        const srcIdx = parseInt(logicEls.source.value, 10);
        if (deviceIndex !== srcIdx) return;
        const regexStr = logicEls.regex.value.trim();
        if (!regexStr) return;
        try {
            const re = new RegExp(regexStr, 'g');
            let match;
            while ((match = re.exec(text)) !== null) {
                if (match.length >= 3) {
                    const ch = 'CH' + match[1];
                    const val = parseInt(match[2], 10);
                    if (!logicState.data[ch]) logicState.data[ch] = [];
                    logicState.data[ch].push(val ? 1 : 0);
                    const maxPts = parseInt(logicEls.window.value, 10) || 200;
                    if (logicState.data[ch].length > maxPts) logicState.data[ch] = logicState.data[ch].slice(-maxPts);
                }
            }
            renderLogicChannels();
            drawLogicAnalyzer();
        } catch (e) {}
    };

    function renderLogicChannels() {
        logicEls.channels.innerHTML = '';
        Object.keys(logicState.data).sort().forEach((ch, i) => {
            const tag = document.createElement('span');
            tag.className = 'logic-ch-tag';
            tag.style.color = PLOT_COLORS[i % PLOT_COLORS.length];
            tag.style.borderLeft = `3px solid ${PLOT_COLORS[i % PLOT_COLORS.length]}`;
            const lastVal = logicState.data[ch][logicState.data[ch].length - 1];
            tag.textContent = `${ch}: ${lastVal}`;
            logicEls.channels.appendChild(tag);
        });
    }

    function drawLogicAnalyzer() {
        const canvas = logicEls.canvas;
        const ctx = canvas.getContext('2d');
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
        const w = rect.width, h = rect.height;
        ctx.clearRect(0, 0, w, h);

        const chNames = Object.keys(logicState.data).sort();
        if (chNames.length === 0) return;
        const chHeight = Math.min(40, (h - 10) / chNames.length);
        const sigHeight = chHeight * 0.7;
        const maxPts = parseInt(logicEls.window.value, 10) || 200;

        chNames.forEach((ch, ci) => {
            const color = PLOT_COLORS[ci % PLOT_COLORS.length];
            const samples = logicState.data[ch];
            const yBase = 5 + ci * chHeight + chHeight - 4;
            const yHigh = yBase - sigHeight;

            ctx.fillStyle = color;
            ctx.font = '10px monospace';
            ctx.fillText(ch, 4, yBase - sigHeight / 2 + 3);

            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const labelW = 30, plotW = w - labelW - 4;
            for (let i = 0; i < samples.length; i++) {
                const x = labelW + (i / maxPts) * plotW;
                const y = samples[i] ? yHigh : yBase;
                if (i === 0) { ctx.moveTo(x, y); }
                else {
                    const prevY = samples[i - 1] ? yHigh : yBase;
                    if (y !== prevY) { ctx.lineTo(x, prevY); ctx.lineTo(x, y); }
                    else { ctx.lineTo(x, y); }
                }
            }
            ctx.stroke();

            if (ci < chNames.length - 1) {
                ctx.strokeStyle = '#3a3f4a';
                ctx.lineWidth = 0.5;
                ctx.beginPath();
                ctx.moveTo(0, yBase + 4);
                ctx.lineTo(w, yBase + 4);
                ctx.stroke();
            }
        });
    }

    logicEls.btnClear.addEventListener('click', () => {
        logicState.data = {};
        logicEls.channels.innerHTML = '';
        const ctx = logicEls.canvas.getContext('2d');
        ctx.clearRect(0, 0, logicEls.canvas.width, logicEls.canvas.height);
    });

    // Update sources after a short delay (devices may not be created yet)
    window._updateLogicSources = updateLogicSources;
    setTimeout(updateLogicSources, 500);

})();
