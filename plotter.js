/* ============================================================================
   ESP32 Web Tester — Plotter (traceur de données série)
   ============================================================================
   Zoom/Pan, Curseur de mesure, Export PNG/CSV, Multi-Y, FFT
   ============================================================================ */
window.Plotter = (function () {
    'use strict';

    const COLORS = [
        '#4a9eff', '#f87171', '#34d399', '#fbbf24', '#a78bfa',
        '#f472b6', '#fb923c', '#22d3ee', '#84cc16', '#e879f9',
        '#60a5fa', '#fca5a5', '#6ee7b7', '#fde68a', '#c4b5fd',
    ];

    const PAD_L = 55, PAD_R = 10, PAD_T = 10, PAD_B = 22;

    // =========================================================================
    // Init
    // =========================================================================

    function init(sectionEl) {
        const section     = sectionEl;
        const canvas      = section.querySelector('.plotter-canvas');
        const canvasWrap  = section.querySelector('.plotter-canvas-wrap');
        const legendEl    = section.querySelector('.plotter-legend');
        const valuesEl    = section.querySelector('.plotter-values');
        const bodyEl      = section.querySelector('.plotter-body');
        const placeholderEl = section.querySelector('.plotter-placeholder');
        const sepSelect   = section.querySelector('.plotter-sep');
        const stripStartEl = section.querySelector('.plotter-strip-start');
        const stripEndEl  = section.querySelector('.plotter-strip-end');
        const maxPtsEl    = section.querySelector('.plotter-max-pts');
        const btnRefresh  = section.querySelector('.btn-plotter-refresh');
        const btnPause    = section.querySelector('.btn-plotter-pause');
        const btnClear    = section.querySelector('.btn-plotter-clear');
        const pngToggle   = section.querySelector('.btn-plotter-png-toggle');
        const btnPngView  = section.querySelector('.btn-png-view');
        const btnPngFull  = section.querySelector('.btn-png-full');
        const pngDropdown = section.querySelector('.png-dropdown');
        const btnCsv      = section.querySelector('.btn-plotter-csv');
        const btnFft      = section.querySelector('.btn-plotter-fft');
        const chkMultiY   = section.querySelector('.chk-multi-y');
        const cursorInfoEl = section.querySelector('.plotter-cursor-info');
        const resizeHandle = section.querySelector('.plotter-resize-handle');

        // Create horizontal scrollbar dynamically
        const scrollbar = document.createElement('input');
        scrollbar.type = 'range';
        scrollbar.className = 'plotter-scrollbar';
        scrollbar.min = 0;
        scrollbar.max = 100;
        scrollbar.value = 100;
        canvasWrap.parentNode.insertBefore(scrollbar, canvasWrap.nextSibling);

        const statsBarEl  = section.querySelector('.plotter-stats-bar');
        const btnHeatmap  = section.querySelector('.btn-plotter-heatmap');
        const btnXY       = section.querySelector('.btn-plotter-xy');
        const xyConfig    = section.querySelector('.plotter-xy-config');
        const xyXSelect   = section.querySelector('.plotter-xy-x');
        const xyYSelect   = section.querySelector('.plotter-xy-y');

        const state = {
            section, canvas, canvasWrap, ctx: canvas.getContext('2d'),
            legendEl, valuesEl, bodyEl, placeholderEl, cursorInfoEl,
            statsBarEl, scrollbar,
            sepSelect, stripStartEl, stripEndEl, maxPtsEl,
            btnXY, xyConfig, xyXSelect, xyYSelect,
            channels: [],
            detectedSep: null,
            autoStripDone: false,
            hasNumericData: false,
            paused: false,
            canvasHeight: 220,
            _raf: null,
            _dirty: false,
            _ro: null,
            // Zoom & pan
            zoomX: 1,
            zoomY: 1,
            panX: 0, // in data-point units (0 = latest at right)
            panY: 0, // in value units
            userPanned: false, // true if user explicitly panned horizontally
            isPanning: false,
            panStartMouse: null,
            panStartState: null,
            // Cursors
            cursor1: null, // { x (canvas px), values: { ci: { idx, val } } }
            cursor2: null,
            // Modes
            fftMode: false,
            multiY: false,
            xyMode: false,
            xyChanX: 0,
            xyChanY: 1,
            heatmapMode: false,
            // Drawing cache (for cursor hit-testing)
            _drawCache: null,
        };

        // --- Button events ---
        btnClear.addEventListener('click', () => reset(state));
        btnRefresh.addEventListener('click', () => refresh(state));
        btnPause.addEventListener('click', () => {
            state.paused = !state.paused;
            btnPause.textContent = state.paused ? 'Reprendre' : 'Pause';
        });
        sepSelect.addEventListener('change', () => { state.detectedSep = null; });

        if (pngToggle && pngDropdown) {
            pngToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                pngDropdown.classList.toggle('open');
            });
            document.addEventListener('click', () => pngDropdown.classList.remove('open'));
        }
        if (btnPngView) btnPngView.addEventListener('click', () => { pngDropdown.classList.remove('open'); exportPng(state); });
        if (btnPngFull) btnPngFull.addEventListener('click', () => { pngDropdown.classList.remove('open'); exportPngFull(state); });
        if (btnCsv) btnCsv.addEventListener('click', () => exportCsv(state));
        if (btnFft) btnFft.addEventListener('click', () => {
            state.fftMode = !state.fftMode;
            btnFft.textContent = state.fftMode ? 'Temps' : 'FFT';
            drawNow(state);
        });
        if (chkMultiY) chkMultiY.addEventListener('change', () => {
            state.multiY = chkMultiY.checked;
            drawNow(state);
        });

        // XY mode
        if (btnXY) btnXY.addEventListener('click', () => {
            state.xyMode = !state.xyMode;
            btnXY.textContent = state.xyMode ? 'Temps' : 'XY';
            xyConfig.style.display = state.xyMode ? 'inline-flex' : 'none';
            if (state.xyMode) updateXYSelectors(state);
            drawNow(state);
        });
        if (xyXSelect) xyXSelect.addEventListener('change', () => {
            state.xyChanX = parseInt(xyXSelect.value, 10) || 0;
            drawNow(state);
        });
        if (xyYSelect) xyYSelect.addEventListener('change', () => {
            state.xyChanY = parseInt(xyYSelect.value, 10) || 1;
            drawNow(state);
        });

        // Heatmap mode
        if (btnHeatmap) btnHeatmap.addEventListener('click', () => {
            state.heatmapMode = !state.heatmapMode;
            btnHeatmap.textContent = state.heatmapMode ? 'Courbe' : 'Heatmap';
            drawNow(state);
        });

        // --- Zoom (mouse wheel) — gentler factor ---
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.02 : 1 / 1.02;

            if (e.shiftKey) {
                state.zoomY = Math.max(0.1, Math.min(100, state.zoomY * factor));
            } else if (e.ctrlKey) {
                state.zoomX = Math.max(0.1, Math.min(100, state.zoomX * factor));
            } else {
                state.zoomX = Math.max(0.1, Math.min(100, state.zoomX * factor));
                state.zoomY = Math.max(0.1, Math.min(100, state.zoomY * factor));
            }
            drawNow(state);
        }, { passive: false });

        // --- Pan (middle click or right click drag) ---
        canvas.addEventListener('mousedown', (e) => {
            if (e.button === 1 || e.button === 2) {
                e.preventDefault();
                state.isPanning = true;
                state.panStartMouse = { x: e.clientX, y: e.clientY };
                state.panStartState = { panX: state.panX, panY: state.panY };
            } else if (e.button === 0) {
                placeCursor(state, e);
            }
        });

        canvas.addEventListener('mousemove', (e) => {
            if (state.isPanning) {
                const dx = e.clientX - state.panStartMouse.x;
                const dy = e.clientY - state.panStartMouse.y;
                const dc = state._drawCache;
                if (dc) {
                    const newPanX = state.panStartState.panX - dx / (dc.xScale * state.zoomX);
                    state.panX = newPanX;
                    state.panY = state.panStartState.panY + dy / (dc.yPixPerUnit * state.zoomY);
                    // Mark as user-panned if moved significantly in X
                    if (Math.abs(dx) > 3) {
                        state.userPanned = true;
                        // Sync scrollbar
                        const maxLen = Math.max(...state.channels.map(c => c.data.length), 0);
                        state.scrollbar.value = Math.max(0, maxLen - state.panX);
                    }
                }
                drawNow(state);
            } else {
                showHoverValue(state, e);
            }
        });

        canvas.addEventListener('mouseup', () => {
            if (state.isPanning) {
                state.isPanning = false;
                // If panX is near 0, snap back to auto-follow
                if (Math.abs(state.panX) < 2) {
                    state.panX = 0;
                    state.userPanned = false;
                    const maxLen = Math.max(...state.channels.map(c => c.data.length), 0);
                    state.scrollbar.max = maxLen;
                    state.scrollbar.value = maxLen;
                }
            }
        });
        canvas.addEventListener('mouseleave', () => {
            state.isPanning = false;
            if (state.cursorInfoEl && !state.cursor1) state.cursorInfoEl.textContent = '';
        });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Double-click to reset zoom/pan/cursors
        canvas.addEventListener('dblclick', () => {
            state.zoomX = 1;
            state.zoomY = 1;
            state.panX = 0;
            state.panY = 0;
            state.userPanned = false;
            state.cursor1 = null;
            state.cursor2 = null;
            state.cursorInfoEl.textContent = '';
            // Sync scrollbar to rightmost
            const maxLen = Math.max(...state.channels.map(c => c.data.length), 0);
            state.scrollbar.max = maxLen;
            state.scrollbar.value = maxLen;
            drawNow(state);
        });

        // --- Scrollbar ---
        scrollbar.addEventListener('input', () => {
            const val = Number(scrollbar.value);
            const max = Number(scrollbar.max);
            if (val >= max - 2) {
                // At or near rightmost position: auto-follow
                state.userPanned = false;
                state.panX = 0;
                scrollbar.value = max;
            } else {
                state.userPanned = true;
                // panX = how many points back from the right edge
                state.panX = max - val;
            }
            drawNow(state);
        });

        // --- Resize handle ---
        if (resizeHandle) {
            let startY = 0, startH = 0;
            const onMouseMove = (e) => {
                const newH = Math.max(100, Math.min(800, startH + (e.clientY - startY)));
                state.canvasHeight = newH;
                canvasWrap.style.height = newH + 'px';
                canvas.style.height = newH + 'px';
                sizeCanvas(state);
                drawNow(state);
            };
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };
            resizeHandle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startY = e.clientY;
                startH = state.canvasHeight;
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });
        }

        // ResizeObserver for width
        const ro = new ResizeObserver(() => { sizeCanvas(state); drawNow(state); });
        ro.observe(section);
        state._ro = ro;

        sizeCanvas(state);
        return state;
    }

    // =========================================================================
    // Canvas sizing
    // =========================================================================

    function sizeCanvas(state) {
        const wrap = state.canvasWrap;
        if (!wrap) return;
        const w = wrap.clientWidth || 400;
        const h = state.canvasHeight || 220;
        if (state.canvas.width !== w || state.canvas.height !== h) {
            state.canvas.width = w;
            state.canvas.height = h;
        }
    }

    // =========================================================================
    // Feed
    // =========================================================================

    function feed(state, rawLine) {
        if (state.paused) return;
        if (!rawLine || rawLine.trim().length === 0) return;

        const trimmed = rawLine.trim();
        let values = parseLine(state, trimmed);
        let nums = values ? values.map(parseNumeric) : [];
        let numericCount = nums.filter(v => v !== null).length;

        if (numericCount === 0 && state.autoStripDone) {
            state.autoStripDone = false;
            state.detectedSep = null;
            values = parseLine(state, trimmed);
            nums = values ? values.map(parseNumeric) : [];
            numericCount = nums.filter(v => v !== null).length;
        }

        if (numericCount === 0) return;

        if (state.channels.length > 0 && numericCount > state.channels.length) {
            state.detectedSep = null;
            state.autoStripDone = false;
            values = parseLine(state, trimmed);
            nums = values ? values.map(parseNumeric) : [];
            numericCount = nums.filter(v => v !== null).length;
        }

        if (!state.hasNumericData) {
            state.hasNumericData = true;
            state.section.classList.remove('plotter-collapsed');
        }

        while (state.channels.length < nums.length) {
            addChannel(state);
        }

        for (let i = 0; i < nums.length; i++) {
            const ch = state.channels[i];
            ch.data.push(nums[i] !== null ? nums[i] : NaN);
        }

        // Update scrollbar range based on data length
        const totalLen = Math.max(...state.channels.map(c => c.data.length));
        state.scrollbar.max = totalLen;
        if (!state.userPanned) {
            state.panX = 0;
            state.scrollbar.value = totalLen;
        }

        updateCurrentValues(state, nums);

        if (!state._dirty) {
            state._dirty = true;
            state._raf = requestAnimationFrame(() => {
                state._dirty = false;
                drawNow(state);
            });
        }
    }

    // =========================================================================
    // Parsing (unchanged)
    // =========================================================================

    function parseLine(state, line) {
        if (!state.autoStripDone) {
            autoDetectStrip(state, line);
            state.autoStripDone = true;
        }
        const ss = parseInt(state.stripStartEl.value, 10) || 0;
        const se = parseInt(state.stripEndEl.value, 10) || 0;
        let s = line;
        if (ss > 0 && ss < s.length) s = s.substring(ss);
        if (se > 0 && se < s.length) s = s.substring(0, s.length - se);
        s = s.trim();
        if (!s) return null;
        const sep = detectSeparator(state, s);
        const parts = s.split(sep).map(p => p.trim()).filter(p => p.length > 0);
        return parts.map(stripKey);
    }

    function autoDetectStrip(state, line) {
        const pairs = [['<', '>'], ['[', ']'], ['{', '}'], ['(', ')']];
        for (const [open, close] of pairs) {
            if (line.startsWith(open) && line.endsWith(close)) {
                state.stripStartEl.value = 1;
                state.stripEndEl.value = 1;
                return;
            }
        }
        if (line.length > 4) {
            let n = 0;
            const fc = line[0];
            if (!/[0-9.\-+]/.test(fc)) {
                while (n < line.length / 2 && line[n] === fc && line[line.length - 1 - n] === fc) n++;
                if (n > 0 && n < 5) {
                    state.stripStartEl.value = n;
                    state.stripEndEl.value = n;
                    return;
                }
            }
        }
    }

    function detectSeparator(state, stripped) {
        const sel = state.sepSelect.value;
        if (sel !== 'auto') return sel === '\\t' ? '\t' : sel;
        if (state.detectedSep) return state.detectedSep;
        const candidates = [';', ',', '\t', ' ', '|'];
        let best = ';', bestScore = -1;
        for (const sep of candidates) {
            const parts = stripped.split(sep).map(p => stripKey(p.trim())).filter(p => p.length > 0);
            if (parts.length < 2 && sep !== candidates[candidates.length - 1]) continue;
            const numCount = parts.filter(p => parseNumeric(p) !== null).length;
            const score = numCount * 10 + parts.length;
            if (numCount > 0 && score > bestScore) { bestScore = score; best = sep; }
        }
        if (bestScore <= 0) best = '\x00';
        state.detectedSep = best;
        return best;
    }

    function stripKey(part) {
        const ci = part.indexOf(':');
        const ei = part.indexOf('=');
        let idx = -1;
        if (ci >= 0 && ei >= 0) idx = Math.min(ci, ei);
        else if (ci >= 0) idx = ci;
        else if (ei >= 0) idx = ei;
        if (idx > 0 && idx < part.length - 1) {
            const candidate = part.substring(idx + 1).trim();
            if (parseNumeric(candidate) !== null) return candidate;
        }
        return part;
    }

    function parseNumeric(str) {
        if (typeof str !== 'string') return null;
        str = str.trim();
        if (!str) return null;
        const lo = str.toLowerCase();
        if (lo === 'true') return 1;
        if (lo === 'false') return 0;
        if (str.indexOf(',') !== -1 && str.split(',').length === 2) {
            const dotVersion = str.replace(',', '.');
            const n = Number(dotVersion);
            if (!isNaN(n) && isFinite(n)) return n;
        }
        const n = Number(str);
        if (!isNaN(n) && isFinite(n)) return n;
        return null;
    }

    // =========================================================================
    // Channels
    // =========================================================================

    function addChannel(state) {
        const idx = state.channels.length;
        const color = COLORS[idx % COLORS.length];
        const wrapper = document.createElement('label');
        wrapper.className = 'plotter-legend-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.style.accentColor = color;
        const swatch = document.createElement('span');
        swatch.className = 'plotter-swatch';
        swatch.style.background = color;
        const label = document.createElement('span');
        label.textContent = `Col ${idx + 1}`;
        cb.addEventListener('change', () => {
            state.channels[idx].visible = cb.checked;
            drawNow(state);
        });
        wrapper.appendChild(cb);
        wrapper.appendChild(swatch);
        wrapper.appendChild(label);
        state.legendEl.appendChild(wrapper);
        state.channels.push({ data: [], visible: true, cbEl: cb, color });
    }

    function updateCurrentValues(state, nums) {
        let html = '';
        for (let i = 0; i < nums.length; i++) {
            if (i >= state.channels.length) break;
            const color = state.channels[i].color;
            const val = nums[i] !== null ? nums[i] : '—';
            html += `<span style="color:${color}">C${i + 1}: <b>${val}</b></span>`;
        }
        state.valuesEl.innerHTML = html;
    }

    // =========================================================================
    // FFT (subtract mean, ignore noise floor)
    // =========================================================================

    function computeFFT(data) {
        const N = data.length;
        if (N === 0) return [];
        // Use only power-of-2 length
        let n = 1;
        while (n * 2 <= N) n *= 2;
        const input = data.slice(data.length - n);

        // Subtract mean to remove DC offset and reduce numerical artifacts
        let mean = 0;
        for (let i = 0; i < n; i++) mean += input[i];
        mean /= n;
        for (let i = 0; i < n; i++) input[i] -= mean;

        const mag = new Array(Math.floor(n / 2));
        for (let k = 0; k < mag.length; k++) {
            let re = 0, im = 0;
            for (let t = 0; t < n; t++) {
                const angle = -2 * Math.PI * k * t / n;
                re += input[t] * Math.cos(angle);
                im += input[t] * Math.sin(angle);
            }
            mag[k] = Math.sqrt(re * re + im * im) / n;
        }
        return mag;
    }

    // =========================================================================
    // Drawing
    // =========================================================================

    function updateXYSelectors(state) {
        const xSel = state.xyXSelect;
        const ySel = state.xyYSelect;
        if (!xSel || !ySel) return;
        xSel.innerHTML = '';
        ySel.innerHTML = '';
        state.channels.forEach((ch, i) => {
            const label = ch.name || `C${i + 1}`;
            xSel.innerHTML += `<option value="${i}"${i === state.xyChanX ? ' selected' : ''}>${label}</option>`;
            ySel.innerHTML += `<option value="${i}"${i === state.xyChanY ? ' selected' : ''}>${label}</option>`;
        });
    }

    function drawNow(state) {
        if (state.heatmapMode && state.channels.length > 0) {
            drawHeatmap(state);
            return;
        }
        if (state.xyMode && state.channels.length >= 2) {
            drawXY(state);
            return;
        }
        if (state.fftMode) {
            drawFFT(state);
            return;
        }

        const ctx = state.ctx;
        const W = state.canvas.width;
        const H = state.canvas.height;
        if (W === 0 || H === 0) { sizeCanvas(state); return; }

        ctx.fillStyle = '#1a1d23';
        ctx.fillRect(0, 0, W, H);

        const maxPts = parseInt(state.maxPtsEl.value, 10) || 500;
        let maxLen = 0;
        for (const ch of state.channels) {
            if (ch.data.length > maxLen) maxLen = ch.data.length;
        }

        if (maxLen === 0) {
            ctx.fillStyle = '#555';
            ctx.font = '13px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('Aucune donnée', W / 2, H / 2);
            state._drawCache = null;
            return;
        }

        if (state.multiY) {
            drawMultiY(state, ctx, W, H, maxPts, maxLen);
        } else {
            drawSingleY(state, ctx, W, H, maxPts, maxLen);
        }

        updateStats(state);
    }

    function drawSingleY(state, ctx, W, H, windowPts, maxLen) {
        const plotW = W - PAD_L - PAD_R;
        const plotH = H - PAD_T - PAD_B;
        const visiblePts = Math.max(1, Math.round(windowPts / state.zoomX));
        const xScale = plotW / Math.max(visiblePts - 1, 1);

        // Visible data range: [startIdx .. endIdx] in data coordinates
        const endIdx = maxLen - Math.round(state.panX);
        const startIdx = endIdx - visiblePts;

        // Compute Y range on ALL data for stable scale when scrolling
        let gMin = Infinity, gMax = -Infinity;
        for (const ch of state.channels) {
            if (!ch.visible) continue;
            for (const v of ch.data) {
                if (isNaN(v)) continue;
                if (v < gMin) gMin = v;
                if (v > gMax) gMax = v;
            }
        }
        if (gMin === Infinity) { gMin = 0; gMax = 1; }

        const range = gMax - gMin || 1;
        gMin -= range * 0.1;
        gMax += range * 0.1;

        // Apply Y zoom & pan
        const yCenter = (gMin + gMax) / 2 + state.panY;
        const yHalf = (gMax - gMin) / 2 / state.zoomY;
        const yMin = yCenter - yHalf;
        const yMax = yCenter + yHalf;
        const yRange = yMax - yMin;
        const yPixPerUnit = plotH / yRange;

        // Map data index to X pixel
        const toX = (i) => PAD_L + (i - startIdx) * xScale;
        const toY = (v) => PAD_T + plotH - ((v - yMin) / yRange) * plotH;

        // Cache for cursor hit-testing
        state._drawCache = { padL: PAD_L, plotW, plotH, xScale, yPixPerUnit, toX, toY, yMin, yMax, visiblePts, maxLen, startIdx, endIdx, mode: 'single' };

        // Grid
        drawGrid(ctx, W, H, PAD_L, plotW, plotH, yMin, yMax, yRange);

        // Curves — only iterate visible range
        ctx.lineWidth = 1.5;
        for (const ch of state.channels) {
            if (!ch.visible || ch.data.length === 0) continue;
            ctx.strokeStyle = ch.color;
            ctx.beginPath();
            let started = false;
            const lo = Math.max(0, startIdx - 1);
            const hi = Math.min(ch.data.length, endIdx + 1);
            for (let i = lo; i < hi; i++) {
                const v = ch.data[i];
                if (isNaN(v)) { started = false; continue; }
                const x = toX(i);
                const y = toY(v);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        // Hover crosshair
        if (state._hoverX && !state.cursor1 && state._hoverIdx >= 0) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.setLineDash([2, 3]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(state._hoverX, PAD_T);
            ctx.lineTo(state._hoverX, PAD_T + plotH);
            ctx.stroke();
            ctx.restore();

            // Hover dots on curves
            for (let ci = 0; ci < state.channels.length; ci++) {
                const ch = state.channels[ci];
                if (!ch.visible || ch.data.length === 0) continue;
                const idx = state._hoverIdx;
                if (idx >= 0 && idx < ch.data.length && !isNaN(ch.data[idx])) {
                    ctx.fillStyle = ch.color;
                    ctx.beginPath();
                    ctx.arc(toX(idx), toY(ch.data[idx]), 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // Cursors
        drawCursors(state, ctx, PAD_L, plotW, plotH);

        // X axis label
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.font = '10px system-ui';
        ctx.fillText(`${maxLen} pts total — fenêtre: ${visiblePts} (zoom: ${state.zoomX.toFixed(1)}x)`, PAD_L + plotW / 2, H - 2);
    }

    function drawMultiY(state, ctx, W, H, windowPts, maxLen) {
        const visibleChannels = state.channels.filter(c => c.visible);
        const numVis = visibleChannels.length;
        if (numVis === 0) return;

        const plotW = W - PAD_L - PAD_R;
        const totalPlotH = H - PAD_T - PAD_B;
        const gap = numVis > 1 ? 8 : 0;
        const subH = (totalPlotH - gap * (numVis - 1)) / numVis;
        const visiblePts = Math.max(1, Math.round(windowPts / state.zoomX));
        const xScale = plotW / Math.max(visiblePts - 1, 1);

        const endIdx = maxLen - Math.round(state.panX);
        const startIdx = endIdx - visiblePts;

        const channelDrawInfo = {};

        let subIdx = 0;
        for (let ci = 0; ci < state.channels.length; ci++) {
            const ch = state.channels[ci];
            if (!ch.visible) continue;

            const subTop = PAD_T + subIdx * (subH + gap);

            // Y range on ALL data for stable scale
            let cMin = Infinity, cMax = -Infinity;
            for (const v of ch.data) {
                if (isNaN(v)) continue;
                if (v < cMin) cMin = v;
                if (v > cMax) cMax = v;
            }
            if (cMin === Infinity) { cMin = 0; cMax = 1; }
            const range = cMax - cMin || 1;
            cMin -= range * 0.1;
            cMax += range * 0.1;
            const yRange = cMax - cMin;

            const toX = (i) => PAD_L + (i - startIdx) * xScale;
            const toY = (v) => subTop + subH - ((v - cMin) / yRange) * subH;

            channelDrawInfo[ci] = { toX, toY, subTop, subH, cMin, cMax, yRange, startIdx, endIdx };

            // Sub-plot background
            ctx.fillStyle = '#1e2229';
            ctx.fillRect(PAD_L, subTop, plotW, subH);

            // Horizontal grid lines
            ctx.strokeStyle = '#2a2f38';
            ctx.lineWidth = 1;
            for (let g = 0; g <= 3; g++) {
                const y = subTop + (g / 3) * subH;
                ctx.beginPath();
                ctx.moveTo(PAD_L, y);
                ctx.lineTo(W - PAD_R, y);
                ctx.stroke();
            }

            // Border
            ctx.strokeStyle = '#3a3f4a';
            ctx.strokeRect(PAD_L, subTop, plotW, subH);

            // Y axis labels
            ctx.font = '10px Consolas, monospace';
            ctx.fillStyle = ch.color;
            ctx.textAlign = 'right';
            for (let g = 0; g <= 3; g++) {
                const y = subTop + (g / 3) * subH;
                const val = cMax - (g / 3) * yRange;
                ctx.fillText(formatVal(val), PAD_L - 5, y + 3);
            }

            // Channel label
            ctx.fillStyle = ch.color;
            ctx.textAlign = 'left';
            ctx.font = 'bold 10px system-ui';
            ctx.fillText(`Col ${ci + 1}`, PAD_L + 5, subTop + 12);

            // Curve — only visible range
            ctx.strokeStyle = ch.color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let started = false;
            const dlo = Math.max(0, startIdx - 1);
            const dhi = Math.min(ch.data.length, endIdx + 1);
            for (let i = dlo; i < dhi; i++) {
                const v = ch.data[i];
                if (isNaN(v)) { started = false; continue; }
                const x = toX(i);
                const y = toY(v);
                const yc = Math.max(subTop, Math.min(subTop + subH, y));
                if (!started) { ctx.moveTo(x, yc); started = true; }
                else ctx.lineTo(x, yc);
            }
            ctx.stroke();
            subIdx++;
        }

        // Cache for cursors
        state._drawCache = {
            padL: PAD_L, plotW, plotH: totalPlotH, xScale,
            yPixPerUnit: 1, visiblePts, maxLen, startIdx, endIdx,
            mode: 'multi', channelDrawInfo
        };

        drawCursorsMultiY(state, ctx, PAD_L, plotW, totalPlotH);

        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.font = '10px system-ui';
        ctx.fillText(`${maxLen} pts total — fenêtre: ${visiblePts} (Multi-Y)`, PAD_L + plotW / 2, H - 2);
    }

    function drawFFT(state) {
        const ctx = state.ctx;
        const W = state.canvas.width;
        const H = state.canvas.height;
        if (W === 0 || H === 0) return;

        const plotW = W - PAD_L - PAD_R;
        const plotH = H - PAD_T - PAD_B;

        ctx.fillStyle = '#1a1d23';
        ctx.fillRect(0, 0, W, H);

        // Grid
        ctx.strokeStyle = '#2a2f38';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 5; i++) {
            const y = PAD_T + (i / 5) * plotH;
            ctx.beginPath();
            ctx.moveTo(PAD_L, y);
            ctx.lineTo(W - PAD_R, y);
            ctx.stroke();
        }
        ctx.strokeStyle = '#3a3f4a';
        ctx.strokeRect(PAD_L, PAD_T, plotW, plotH);

        let maxMag = 0;
        const ffts = [];
        for (const ch of state.channels) {
            if (!ch.visible || ch.data.length < 4) { ffts.push(null); continue; }
            const validData = ch.data.filter(v => !isNaN(v));
            if (validData.length < 4) { ffts.push(null); continue; }
            const mag = computeFFT(validData);
            ffts.push(mag);
            for (let k = 1; k < mag.length; k++) {
                if (mag[k] > maxMag) maxMag = mag[k];
            }
        }

        // If no significant frequency content, show message
        if (maxMag < 1e-6) {
            ctx.fillStyle = '#6b7280';
            ctx.font = '13px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('Signal constant — pas de composante fréquentielle détectée', PAD_L + plotW / 2, PAD_T + plotH / 2);
            ctx.fillText('FFT — Fréquence relative', PAD_L + plotW / 2, H - 2);
            state._drawCache = null;
            return;
        }

        // Draw FFT bars for each channel
        for (let ci = 0; ci < state.channels.length; ci++) {
            const ch = state.channels[ci];
            if (!ch.visible || !ffts[ci]) continue;
            const mag = ffts[ci];
            const barW = plotW / (mag.length - 1);

            ctx.fillStyle = ch.color + '80';
            ctx.strokeStyle = ch.color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let k = 1; k < mag.length; k++) {
                const x = PAD_L + (k - 1) * barW;
                const h = (mag[k] / maxMag) * plotH;
                const y = PAD_T + plotH - h;
                ctx.moveTo(x + barW / 2, PAD_T + plotH);
                ctx.lineTo(x + barW / 2, y);
            }
            ctx.stroke();
        }

        // Labels
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.font = '10px system-ui';
        ctx.fillText('FFT — Fréquence relative', PAD_L + plotW / 2, H - 2);
        ctx.textAlign = 'right';
        ctx.font = '10px Consolas, monospace';
        ctx.fillText(formatVal(maxMag), PAD_L - 5, PAD_T + 10);
        ctx.fillText('0', PAD_L - 5, PAD_T + plotH + 4);

        state._drawCache = null;
    }

    // =========================================================================
    // Heatmap mode — density visualization
    // =========================================================================

    function drawHeatmap(state) {
        const ctx = state.ctx;
        const W = state.canvas.width;
        const H = state.canvas.height;
        if (W === 0 || H === 0) { sizeCanvas(state); return; }

        ctx.fillStyle = '#0a0c10';
        ctx.fillRect(0, 0, W, H);

        const visChannels = state.channels.filter(c => c.visible && c.data.length > 0);
        if (visChannels.length === 0) {
            ctx.fillStyle = '#555';
            ctx.font = '13px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('Heatmap: pas de données', W / 2, H / 2);
            state._drawCache = null;
            return;
        }

        const plotW = W - PAD_L - PAD_R;
        const plotH = H - PAD_T - PAD_B;
        const maxPts = parseInt(state.maxPtsEl.value, 10) || 500;

        // We'll draw a 2D density grid: X = time (data index), Y = value range
        // Use only the first visible channel for simplicity, or overlay
        const ch = visChannels[0];
        const data = ch.data;
        const len = data.length;

        // Determine visible range
        const visiblePts = Math.max(1, Math.round(maxPts / state.zoomX));
        const endIdx = len - Math.round(state.panX);
        const startIdx = Math.max(0, endIdx - visiblePts);

        // Y range
        let yMin = Infinity, yMax = -Infinity;
        for (let i = startIdx; i < Math.min(endIdx, len); i++) {
            if (isNaN(data[i])) continue;
            if (data[i] < yMin) yMin = data[i];
            if (data[i] > yMax) yMax = data[i];
        }
        if (yMin === Infinity) { yMin = 0; yMax = 1; }
        const yRange = (yMax - yMin) || 1;
        yMin -= yRange * 0.05;
        yMax += yRange * 0.05;
        const finalYRange = yMax - yMin;

        // Grid resolution
        const gridW = Math.min(plotW, visiblePts);
        const gridH = Math.min(plotH, 80);
        const cellW = plotW / gridW;
        const cellH = plotH / gridH;

        // Build density grid
        const grid = new Float32Array(gridW * gridH);
        let maxDensity = 0;
        const actualEnd = Math.min(endIdx, len);

        for (let i = startIdx; i < actualEnd; i++) {
            const v = data[i];
            if (isNaN(v)) continue;
            const gx = Math.floor(((i - startIdx) / visiblePts) * gridW);
            const gy = Math.floor(((v - yMin) / finalYRange) * (gridH - 1));
            if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
                // Spread to neighbors for smoother look
                for (let dy = -1; dy <= 1; dy++) {
                    const ny = gy + dy;
                    if (ny < 0 || ny >= gridH) continue;
                    const weight = dy === 0 ? 1.0 : 0.3;
                    grid[ny * gridW + gx] += weight;
                    if (grid[ny * gridW + gx] > maxDensity) maxDensity = grid[ny * gridW + gx];
                }
            }
        }

        if (maxDensity === 0) maxDensity = 1;

        // Draw grid cells with color mapping
        for (let gy = 0; gy < gridH; gy++) {
            for (let gx = 0; gx < gridW; gx++) {
                const d = grid[gy * gridW + gx];
                if (d === 0) continue;
                const intensity = d / maxDensity;
                ctx.fillStyle = heatColor(intensity);
                // Y is inverted (0 = bottom)
                const px = PAD_L + gx * cellW;
                const py = PAD_T + plotH - (gy + 1) * cellH;
                ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
            }
        }

        // Y axis labels
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px Consolas, monospace';
        ctx.textAlign = 'right';
        const ySteps = 5;
        for (let i = 0; i <= ySteps; i++) {
            const v = yMin + (finalYRange * i / ySteps);
            const y = PAD_T + plotH - (plotH * i / ySteps);
            ctx.fillText(formatVal(v), PAD_L - 5, y + 3);
        }

        // X axis
        ctx.textAlign = 'center';
        ctx.fillText(String(startIdx), PAD_L, H - 3);
        ctx.fillText(String(Math.min(endIdx, len)), PAD_L + plotW, H - 3);

        // Color legend
        const legendW = 120, legendH = 10;
        const lx = PAD_L + plotW - legendW - 5;
        const ly = PAD_T + 5;
        for (let i = 0; i < legendW; i++) {
            ctx.fillStyle = heatColor(i / legendW);
            ctx.fillRect(lx + i, ly, 1, legendH);
        }
        ctx.fillStyle = '#9ca3af';
        ctx.font = '9px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText('faible', lx, ly + legendH + 9);
        ctx.textAlign = 'right';
        ctx.fillText('forte', lx + legendW, ly + legendH + 9);
        ctx.textAlign = 'center';
        ctx.fillText('Densité', lx + legendW / 2, ly - 2);

        // Channel label
        ctx.fillStyle = ch.color;
        ctx.font = '11px system-ui';
        ctx.textAlign = 'left';
        ctx.fillText(`Heatmap: ${ch.name || 'C1'} (${actualEnd - startIdx} pts)`, PAD_L + 5, PAD_T + 16);

        // Overlay: if multiple channels, show their names
        if (visChannels.length > 1) {
            ctx.fillStyle = '#6b7280';
            ctx.font = '10px system-ui';
            ctx.fillText('(1er canal visible affiché)', PAD_L + 5, PAD_T + 30);
        }

        state._drawCache = null;
        updateStats(state);
    }

    function heatColor(t) {
        // Cool-to-hot: black → blue → cyan → green → yellow → red → white
        t = Math.max(0, Math.min(1, t));
        let r, g, b;
        if (t < 0.2) {
            const s = t / 0.2;
            r = 0; g = 0; b = Math.round(80 + 175 * s);
        } else if (t < 0.4) {
            const s = (t - 0.2) / 0.2;
            r = 0; g = Math.round(255 * s); b = 255;
        } else if (t < 0.6) {
            const s = (t - 0.4) / 0.2;
            r = Math.round(255 * s); g = 255; b = Math.round(255 * (1 - s));
        } else if (t < 0.8) {
            const s = (t - 0.6) / 0.2;
            r = 255; g = Math.round(255 * (1 - s)); b = 0;
        } else {
            const s = (t - 0.8) / 0.2;
            r = 255; g = Math.round(255 * s); b = Math.round(255 * s);
        }
        return `rgb(${r},${g},${b})`;
    }

    // =========================================================================
    // XY Graph mode
    // =========================================================================

    function drawXY(state) {
        const ctx = state.ctx;
        const W = state.canvas.width;
        const H = state.canvas.height;
        if (W === 0 || H === 0) { sizeCanvas(state); return; }

        ctx.fillStyle = '#1a1d23';
        ctx.fillRect(0, 0, W, H);

        const chX = state.channels[state.xyChanX];
        const chY = state.channels[state.xyChanY];
        if (!chX || !chY || chX.data.length === 0 || chY.data.length === 0) {
            ctx.fillStyle = '#555';
            ctx.font = '13px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText('XY: pas assez de données', W / 2, H / 2);
            state._drawCache = null;
            return;
        }

        const plotW = W - PAD_L - PAD_R - 10;
        const plotH = H - PAD_T - PAD_B - 10;
        const len = Math.min(chX.data.length, chY.data.length);

        // Compute ranges
        let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
        for (let i = 0; i < len; i++) {
            const vx = chX.data[i], vy = chY.data[i];
            if (isNaN(vx) || isNaN(vy)) continue;
            if (vx < xMin) xMin = vx; if (vx > xMax) xMax = vx;
            if (vy < yMin) yMin = vy; if (vy > yMax) yMax = vy;
        }
        if (xMin === Infinity) { xMin = 0; xMax = 1; }
        if (yMin === Infinity) { yMin = 0; yMax = 1; }

        const xRange = (xMax - xMin) || 1;
        const yRange = (yMax - yMin) || 1;
        xMin -= xRange * 0.05; xMax += xRange * 0.05;
        yMin -= yRange * 0.05; yMax += yRange * 0.05;

        // Apply zoom & pan
        const xCenter = (xMin + xMax) / 2 + state.panX * (xMax - xMin) / 100;
        const yCenter = (yMin + yMax) / 2 + state.panY;
        const xHalf = (xMax - xMin) / 2 / state.zoomX;
        const yHalf = (yMax - yMin) / 2 / state.zoomY;
        const fxMin = xCenter - xHalf, fxMax = xCenter + xHalf;
        const fyMin = yCenter - yHalf, fyMax = yCenter + yHalf;
        const fxRange = fxMax - fxMin;
        const fyRange = fyMax - fyMin;

        const toX = (v) => PAD_L + ((v - fxMin) / fxRange) * plotW;
        const toY = (v) => PAD_T + plotH - ((v - fyMin) / fyRange) * plotH;

        // Grid
        drawGrid(ctx, W, H, PAD_L, plotW, plotH, fyMin, fyMax, fyRange);

        // X axis grid & labels
        const xSteps = 5;
        ctx.strokeStyle = '#2a2f38';
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px Consolas, monospace';
        ctx.textAlign = 'center';
        for (let i = 0; i <= xSteps; i++) {
            const v = fxMin + (fxRange * i / xSteps);
            const x = toX(v);
            ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
            ctx.fillText(formatVal(v), x, PAD_T + plotH + 14);
        }

        // Draw XY curve
        ctx.strokeStyle = chY.color || COLORS[1];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < len; i++) {
            const vx = chX.data[i], vy = chY.data[i];
            if (isNaN(vx) || isNaN(vy)) { started = false; continue; }
            const px = toX(vx), py = toY(vy);
            if (!started) { ctx.moveTo(px, py); started = true; }
            else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // Draw points (last 200 for performance)
        const dotStart = Math.max(0, len - 200);
        ctx.fillStyle = chY.color || COLORS[1];
        for (let i = dotStart; i < len; i++) {
            const vx = chX.data[i], vy = chY.data[i];
            if (isNaN(vx) || isNaN(vy)) continue;
            ctx.beginPath();
            ctx.arc(toX(vx), toY(vy), 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Latest point highlighted
        for (let i = len - 1; i >= 0; i--) {
            const vx = chX.data[i], vy = chY.data[i];
            if (isNaN(vx) || isNaN(vy)) continue;
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(toX(vx), toY(vy), 4, 0, Math.PI * 2);
            ctx.fill();
            break;
        }

        // Axis labels
        const xLabel = chX.name || `C${state.xyChanX + 1}`;
        const yLabel = chY.name || `C${state.xyChanY + 1}`;
        ctx.fillStyle = '#9ca3af';
        ctx.font = '11px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(`X: ${xLabel}   Y: ${yLabel}   (${len} pts)`, PAD_L + plotW / 2, H - 2);

        state._drawCache = null;
        updateStats(state);
    }

    function drawGrid(ctx, W, H, padL, plotW, plotH, yMin, yMax, yRange) {
        const gridLines = 5;
        ctx.strokeStyle = '#2a2f38';
        ctx.lineWidth = 1;
        ctx.font = '11px Consolas, monospace';
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'right';
        for (let i = 0; i <= gridLines; i++) {
            const y = PAD_T + (i / gridLines) * plotH;
            const val = yMax - (i / gridLines) * yRange;
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(W - PAD_R, y);
            ctx.stroke();
            ctx.fillText(formatVal(val), padL - 5, y + 4);
        }
        ctx.strokeStyle = '#22262e';
        const vLines = 6;
        for (let i = 1; i < vLines; i++) {
            const x = padL + (i / vLines) * plotW;
            ctx.beginPath();
            ctx.moveTo(x, PAD_T);
            ctx.lineTo(x, PAD_T + plotH);
            ctx.stroke();
        }
        ctx.strokeStyle = '#3a3f4a';
        ctx.strokeRect(padL, PAD_T, plotW, plotH);
    }

    // =========================================================================
    // Cursors
    // =========================================================================

    function placeCursor(state, e) {
        const dc = state._drawCache;
        if (!dc) return;
        const rect = state.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Check if click is in plot area
        if (mx < dc.padL || mx > dc.padL + dc.plotW || my < PAD_T || my > PAD_T + dc.plotH) return;

        // Snap to nearest data point
        const sIdx = dc.startIdx !== undefined ? dc.startIdx : 0;
        let rawIdx = sIdx + (mx - dc.padL) / dc.xScale;
        let bestIdx = Math.round(rawIdx);
        let snappedX = mx;

        // Find the closest valid data point across all visible channels
        let bestDist = Infinity;
        for (let ci = 0; ci < state.channels.length; ci++) {
            const ch = state.channels[ci];
            if (!ch.visible || ch.data.length === 0) continue;
            for (let offset = -2; offset <= 2; offset++) {
                const testIdx = Math.round(rawIdx) + offset;
                if (testIdx >= 0 && testIdx < ch.data.length && !isNaN(ch.data[testIdx])) {
                    const testX = dc.padL + (testIdx - sIdx) * dc.xScale;
                    const dist = Math.abs(testX - mx);
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = testIdx;
                        snappedX = testX;
                    }
                }
            }
        }

        const cursor = { x: snappedX, y: my, values: {} };

        // Collect values at snapped index for each visible channel
        for (let ci = 0; ci < state.channels.length; ci++) {
            const ch = state.channels[ci];
            if (!ch.visible || ch.data.length === 0) continue;
            if (bestIdx >= 0 && bestIdx < ch.data.length && !isNaN(ch.data[bestIdx])) {
                cursor.values[ci] = { idx: bestIdx, val: ch.data[bestIdx] };
            }
        }

        if (!state.cursor1 || state.cursor2) {
            state.cursor1 = cursor;
            state.cursor2 = null;
        } else {
            state.cursor2 = cursor;
        }

        updateCursorInfo(state);
        drawNow(state);
    }

    function drawCursors(state, ctx, padL, plotW, plotH) {
        const dc = state._drawCache;
        const cursors = [state.cursor1, state.cursor2];
        for (let ci2 = 0; ci2 < cursors.length; ci2++) {
            const cursor = cursors[ci2];
            if (!cursor) continue;
            const cursorColor = ci2 === 0 ? '#fbbf24' : '#e879f9';
            const label = ci2 === 0 ? 'C1' : 'C2';

            // Vertical line
            ctx.save();
            ctx.strokeStyle = cursorColor;
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cursor.x, PAD_T);
            ctx.lineTo(cursor.x, PAD_T + plotH);
            ctx.stroke();
            ctx.restore();

            // Cursor label at top
            ctx.save();
            ctx.fillStyle = cursorColor;
            ctx.font = 'bold 10px system-ui';
            ctx.textAlign = 'center';
            ctx.fillText(label, cursor.x, PAD_T - 2);
            ctx.restore();

            // Draw dots and value labels on curves
            if (dc && dc.toY) {
                let labelOffset = 0;
                for (const ci in cursor.values) {
                    const ch = state.channels[ci];
                    if (!ch) continue;
                    const val = cursor.values[ci].val;
                    const y = dc.toY(val);

                    // Dot
                    ctx.fillStyle = ch.color;
                    ctx.beginPath();
                    ctx.arc(cursor.x, y, 4, 0, Math.PI * 2);
                    ctx.fill();

                    // Value label next to dot
                    ctx.save();
                    ctx.fillStyle = ch.color;
                    ctx.font = '10px Consolas, monospace';
                    const side = cursor.x > padL + plotW / 2 ? -1 : 1;
                    ctx.textAlign = side > 0 ? 'left' : 'right';
                    ctx.fillText(formatVal(val), cursor.x + side * 8, y + 3 + labelOffset);
                    ctx.restore();
                    labelOffset += 12;
                }
            }
        }

        // Delta shading between cursors
        if (state.cursor1 && state.cursor2) {
            const x1 = Math.min(state.cursor1.x, state.cursor2.x);
            const x2 = Math.max(state.cursor1.x, state.cursor2.x);
            ctx.save();
            ctx.fillStyle = 'rgba(251, 191, 36, 0.06)';
            ctx.fillRect(x1, PAD_T, x2 - x1, plotH);
            ctx.restore();
        }
    }

    function drawCursorsMultiY(state, ctx, padL, plotW, totalPlotH) {
        const dc = state._drawCache;
        if (!dc || !dc.channelDrawInfo) return;

        for (const cursor of [state.cursor1, state.cursor2]) {
            if (!cursor) continue;

            // Draw vertical line across all sub-plots
            ctx.save();
            ctx.strokeStyle = cursor === state.cursor1 ? '#fbbf24' : '#e879f9';
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cursor.x, PAD_T);
            ctx.lineTo(cursor.x, PAD_T + totalPlotH);
            ctx.stroke();
            ctx.restore();

            // Draw dots on each channel's sub-plot
            for (const ci in cursor.values) {
                const ch = state.channels[ci];
                const info = dc.channelDrawInfo[ci];
                if (!ch || !info) continue;
                const y = info.toY(cursor.values[ci].val);
                ctx.fillStyle = ch.color;
                ctx.beginPath();
                ctx.arc(cursor.x, y, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }

    function updateCursorInfo(state) {
        if (!state.cursorInfoEl) return;
        if (!state.cursor1) {
            state.cursorInfoEl.innerHTML = '';
            return;
        }

        const c1 = state.cursor1;
        let parts = [];
        for (const ci in c1.values) {
            parts.push(`<span style="color:${state.channels[ci]?.color || '#fff'}">C${+ci + 1}=${formatVal(c1.values[ci].val)}</span> [${c1.values[ci].idx}]`);
        }
        let html = '<b style="color:#fbbf24;">C1:</b> ' + (parts.length ? parts.join(', ') : '—');

        if (state.cursor2) {
            const c2 = state.cursor2;
            let parts2 = [], deltas = [];
            for (const ci in c2.values) {
                parts2.push(`<span style="color:${state.channels[ci]?.color || '#fff'}">C${+ci + 1}=${formatVal(c2.values[ci].val)}</span> [${c2.values[ci].idx}]`);
                if (c1.values[ci]) {
                    const dv = c2.values[ci].val - c1.values[ci].val;
                    const di = Math.abs(c2.values[ci].idx - c1.values[ci].idx);
                    deltas.push(`Δ=${formatVal(dv)} (${di} pts)`);

                    // Frequency estimation: if Δindex > 0, estimate as sample rate / Δindex
                    // We'll show Δ in points and if user has a known sample rate, this is useful
                    if (di > 0) {
                        // Estimate period between zero-crossings or just show reciprocal
                        const freq = 1 / di;
                        deltas.push(`f≈${di > 1 ? formatVal(freq) : '—'}/sample`);
                    }
                }
            }
            html += '  &nbsp;|&nbsp;  <b style="color:#e879f9;">C2:</b> ' + (parts2.length ? parts2.join(', ') : '—');
            if (deltas.length) html += '  &nbsp;|&nbsp;  ' + deltas.join(', ');

            // Show Δ index prominently
            const firstCi = Object.keys(c1.values)[0];
            if (firstCi && c2.values[firstCi]) {
                const di = Math.abs(c2.values[firstCi].idx - c1.values[firstCi].idx);
                html += `  &nbsp;|&nbsp;  <b>Δ=${di} pts</b>`;
            }
        }

        state.cursorInfoEl.innerHTML = html;
    }

    function showHoverValue(state, e) {
        const dc = state._drawCache;
        if (!dc || !state.cursorInfoEl) return;
        if (state.cursor1) return;
        if (!dc.xScale) return;

        const rect = state.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        if (mx < dc.padL || mx > dc.padL + dc.plotW) {
            state.cursorInfoEl.innerHTML = '';
            // Clear crosshair
            state._hoverIdx = -1;
            drawNow(state);
            return;
        }

        const sIdx = dc.startIdx !== undefined ? dc.startIdx : 0;
        const rawIdx = sIdx + (mx - dc.padL) / dc.xScale;
        const idx = Math.round(rawIdx);

        let parts = [];
        for (let ci = 0; ci < state.channels.length; ci++) {
            const ch = state.channels[ci];
            if (!ch.visible || ch.data.length === 0) continue;
            if (idx >= 0 && idx < ch.data.length && !isNaN(ch.data[idx])) {
                parts.push(`<span style="color:${ch.color}">C${ci + 1}=${formatVal(ch.data[idx])}</span>`);
            }
        }
        state.cursorInfoEl.innerHTML = parts.length ? `[${idx}] ` + parts.join('  ') : '';

        // Store hover index for crosshair drawing
        state._hoverIdx = idx;
        state._hoverX = mx;
    }

    // =========================================================================
    // Export
    // =========================================================================

    function exportPng(state) {
        const link = document.createElement('a');
        link.download = `plotter_view_${Date.now()}.png`;
        link.href = state.canvas.toDataURL('image/png');
        link.click();
    }

    function exportPngFull(state) {
        // Render all data onto an offscreen canvas
        let maxLen = 0;
        for (const ch of state.channels) {
            if (ch.data.length > maxLen) maxLen = ch.data.length;
        }
        if (maxLen === 0) return;

        // Width: 1px per point, min 800, max 16000
        const offW = Math.max(800, Math.min(16000, maxLen));
        const offH = state.canvas.height;
        const offCanvas = document.createElement('canvas');
        offCanvas.width = offW;
        offCanvas.height = offH;
        const ctx = offCanvas.getContext('2d');

        const plotW = offW - PAD_L - PAD_R;
        const plotH = offH - PAD_T - PAD_B;
        const xScale = plotW / Math.max(maxLen - 1, 1);

        // Background
        ctx.fillStyle = '#1a1d23';
        ctx.fillRect(0, 0, offW, offH);

        // Global Y range
        let gMin = Infinity, gMax = -Infinity;
        for (const ch of state.channels) {
            if (!ch.visible) continue;
            for (const v of ch.data) {
                if (isNaN(v)) continue;
                if (v < gMin) gMin = v;
                if (v > gMax) gMax = v;
            }
        }
        if (gMin === Infinity) { gMin = 0; gMax = 1; }
        const range = gMax - gMin || 1;
        gMin -= range * 0.1;
        gMax += range * 0.1;
        const yRange = gMax - gMin;

        // Grid
        drawGrid(ctx, offW, offH, PAD_L, plotW, plotH, gMin, gMax, yRange);

        // Curves
        ctx.lineWidth = 1.5;
        for (const ch of state.channels) {
            if (!ch.visible || ch.data.length === 0) continue;
            ctx.strokeStyle = ch.color;
            ctx.beginPath();
            let started = false;
            for (let i = 0; i < ch.data.length; i++) {
                const v = ch.data[i];
                if (isNaN(v)) { started = false; continue; }
                const x = PAD_L + i * xScale;
                const y = PAD_T + plotH - ((v - gMin) / yRange) * plotH;
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        // Label
        ctx.fillStyle = '#6b7280';
        ctx.textAlign = 'center';
        ctx.font = '10px system-ui';
        ctx.fillText(`${maxLen} pts (courbe complète)`, PAD_L + plotW / 2, offH - 2);

        const link = document.createElement('a');
        link.download = `plotter_full_${Date.now()}.png`;
        link.href = offCanvas.toDataURL('image/png');
        link.click();
    }

    function exportCsv(state) {
        if (state.channels.length === 0) return;
        const maxLen = Math.max(...state.channels.map(c => c.data.length));
        let csv = state.channels.map((_, i) => `Col${i + 1}`).join(',') + '\n';
        for (let r = 0; r < maxLen; r++) {
            const row = state.channels.map(ch => r < ch.data.length ? (isNaN(ch.data[r]) ? '' : ch.data[r]) : '');
            csv += row.join(',') + '\n';
        }
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `plotter_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // =========================================================================
    // Stats bar (min / max / avg / stddev / Δ between cursors)
    // =========================================================================

    function updateStats(state) {
        const el = state.statsBarEl;
        if (!el) return;

        const dc = state._drawCache;
        if (!dc || state.channels.length === 0) {
            el.innerHTML = '';
            return;
        }

        // Determine data range: between cursors if both exist, else visible window, else all
        let rangeStart = 0, rangeEnd = 0;
        let rangeLabel = '';

        if (state.cursor1 && state.cursor2) {
            // Use cursor range
            const firstVals = Object.values(state.cursor1.values);
            const secVals = Object.values(state.cursor2.values);
            if (firstVals.length > 0 && secVals.length > 0) {
                const i1 = firstVals[0].idx;
                const i2 = secVals[0].idx;
                rangeStart = Math.min(i1, i2);
                rangeEnd = Math.max(i1, i2) + 1;
                rangeLabel = `curseurs [${rangeStart}–${rangeEnd - 1}]`;
            }
        }

        if (rangeEnd <= rangeStart && dc.startIdx !== undefined) {
            rangeStart = Math.max(0, dc.startIdx);
            rangeEnd = dc.endIdx;
            rangeLabel = `fenêtre [${rangeStart}–${rangeEnd - 1}]`;
        }

        let html = '';
        for (let ci = 0; ci < state.channels.length; ci++) {
            const ch = state.channels[ci];
            if (!ch.visible || ch.data.length === 0) continue;

            const lo = Math.max(0, rangeStart);
            const hi = Math.min(ch.data.length, rangeEnd);
            let sum = 0, count = 0, mn = Infinity, mx = -Infinity;
            for (let i = lo; i < hi; i++) {
                const v = ch.data[i];
                if (isNaN(v)) continue;
                sum += v;
                count++;
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
            if (count === 0) continue;

            const avg = sum / count;
            let sq = 0;
            for (let i = lo; i < hi; i++) {
                const v = ch.data[i];
                if (isNaN(v)) continue;
                sq += (v - avg) * (v - avg);
            }
            const stddev = Math.sqrt(sq / count);

            html += `<span class="plotter-stat-item" style="color:${ch.color}">` +
                `<span class="stat-label">C${ci + 1}:</span> ` +
                `min=<span class="stat-val">${formatVal(mn)}</span> ` +
                `max=<span class="stat-val">${formatVal(mx)}</span> ` +
                `moy=<span class="stat-val">${formatVal(avg)}</span> ` +
                `σ=<span class="stat-val">${formatVal(stddev)}</span>` +
                `</span>`;
        }

        if (rangeLabel) {
            html += `<span style="color:var(--text-muted);font-size:9px;margin-left:auto;">${rangeLabel} (${rangeEnd - rangeStart} pts)</span>`;
        }

        el.innerHTML = html;
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function formatVal(v) {
        if (Math.abs(v) >= 10000 || (Math.abs(v) < 0.01 && v !== 0)) return v.toExponential(1);
        if (Number.isInteger(v)) return v.toString();
        return v.toFixed(2);
    }

    // =========================================================================
    // Reset / Destroy
    // =========================================================================

    function refresh(state) {
        state.detectedSep = null;
        state.autoStripDone = false;
        state.channels = [];
        state.legendEl.innerHTML = '';
        state.valuesEl.innerHTML = '';
    }

    function reset(state) {
        for (const ch of state.channels) ch.data = [];
        state.channels = [];
        state.legendEl.innerHTML = '';
        state.valuesEl.innerHTML = '';
        state.detectedSep = null;
        state.autoStripDone = false;
        state.hasNumericData = false;
        state.section.classList.add('plotter-collapsed');
        state.paused = false;
        state.fftMode = false;
        state.xyMode = false;
        state.heatmapMode = false;
        const btnXY2 = state.section.querySelector('.btn-plotter-xy');
        if (btnXY2) btnXY2.textContent = 'XY';
        if (state.xyConfig) state.xyConfig.style.display = 'none';
        const btnHM = state.section.querySelector('.btn-plotter-heatmap');
        if (btnHM) btnHM.textContent = 'Heatmap';
        state.zoomX = 1;
        state.zoomY = 1;
        state.panX = 0;
        state.panY = 0;
        state.userPanned = false;
        state.cursor1 = null;
        state.cursor2 = null;
        if (state.cursorInfoEl) state.cursorInfoEl.textContent = '';
        const btnP = state.section.querySelector('.btn-plotter-pause');
        if (btnP) btnP.textContent = 'Pause';
        const btnF = state.section.querySelector('.btn-plotter-fft');
        if (btnF) btnF.textContent = 'FFT';
        drawNow(state);
    }

    function destroy(state) {
        if (state._raf) cancelAnimationFrame(state._raf);
        if (state._ro) state._ro.disconnect();
    }

    return { init, feed, reset, refresh, destroy };
})();
