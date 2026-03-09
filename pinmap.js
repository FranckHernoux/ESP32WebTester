// ============================================================================
// Pin Map Visualizer — Interactive pinout diagram for ESP32 / Arduino
// ============================================================================
(function () {
    'use strict';

    // =========================================================================
    // Board definitions: pin layouts with names, positions, alternate functions
    // =========================================================================

    const BOARDS = {
        'esp32': {
            name: 'ESP32 DevKit V1',
            chipLabel: 'ESP32',
            pins: [
                // Left side (top to bottom)
                { gpio: 36, label: 'VP/36', side: 'left', idx: 0, adc: 'ADC1_CH0', touch: null, funcs: ['input only'] },
                { gpio: 39, label: 'VN/39', side: 'left', idx: 1, adc: 'ADC1_CH3', touch: null, funcs: ['input only'] },
                { gpio: 34, label: '34', side: 'left', idx: 2, adc: 'ADC1_CH6', touch: null, funcs: ['input only'] },
                { gpio: 35, label: '35', side: 'left', idx: 3, adc: 'ADC1_CH7', touch: null, funcs: ['input only'] },
                { gpio: 32, label: '32', side: 'left', idx: 4, adc: 'ADC1_CH4', touch: 'T9', funcs: ['XTAL32K'] },
                { gpio: 33, label: '33', side: 'left', idx: 5, adc: 'ADC1_CH5', touch: 'T8', funcs: ['XTAL32K'] },
                { gpio: 25, label: '25', side: 'left', idx: 6, adc: 'ADC2_CH8', touch: null, funcs: ['DAC1'] },
                { gpio: 26, label: '26', side: 'left', idx: 7, adc: 'ADC2_CH9', touch: null, funcs: ['DAC2'] },
                { gpio: 27, label: '27', side: 'left', idx: 8, adc: 'ADC2_CH7', touch: 'T7', funcs: [] },
                { gpio: 14, label: '14', side: 'left', idx: 9, adc: 'ADC2_CH6', touch: 'T6', funcs: ['HSPI_CLK'] },
                { gpio: 12, label: '12', side: 'left', idx: 10, adc: 'ADC2_CH5', touch: 'T5', funcs: ['HSPI_MISO', 'boot fail if HIGH'] },
                { gpio: 13, label: '13', side: 'left', idx: 11, adc: 'ADC2_CH4', touch: 'T4', funcs: ['HSPI_MOSI'] },
                { gpio: -1, label: 'GND', side: 'left', idx: 12, adc: null, touch: null, funcs: ['ground'], power: true },
                { gpio: -2, label: 'VIN', side: 'left', idx: 13, adc: null, touch: null, funcs: ['5V input'], power: true },
                // Right side (top to bottom)
                { gpio: 23, label: '23', side: 'right', idx: 0, adc: null, touch: null, funcs: ['VSPI_MOSI'] },
                { gpio: 22, label: '22', side: 'right', idx: 1, adc: null, touch: null, funcs: ['I2C_SCL'] },
                { gpio: 1,  label: 'TX0', side: 'right', idx: 2, adc: null, touch: null, funcs: ['UART0_TX', 'debug output'] },
                { gpio: 3,  label: 'RX0', side: 'right', idx: 3, adc: null, touch: null, funcs: ['UART0_RX'] },
                { gpio: 21, label: '21', side: 'right', idx: 4, adc: null, touch: null, funcs: ['I2C_SDA'] },
                { gpio: 19, label: '19', side: 'right', idx: 5, adc: null, touch: null, funcs: ['VSPI_MISO'] },
                { gpio: 18, label: '18', side: 'right', idx: 6, adc: null, touch: null, funcs: ['VSPI_CLK'] },
                { gpio: 5,  label: '5', side: 'right', idx: 7, adc: null, touch: null, funcs: ['VSPI_CS', 'strapping pin'] },
                { gpio: 17, label: '17', side: 'right', idx: 8, adc: null, touch: null, funcs: ['UART2_TX'] },
                { gpio: 16, label: '16', side: 'right', idx: 9, adc: null, touch: null, funcs: ['UART2_RX'] },
                { gpio: 4,  label: '4', side: 'right', idx: 10, adc: 'ADC2_CH0', touch: 'T0', funcs: [] },
                { gpio: 2,  label: '2', side: 'right', idx: 11, adc: 'ADC2_CH2', touch: 'T2', funcs: ['LED_BUILTIN'] },
                { gpio: 15, label: '15', side: 'right', idx: 12, adc: 'ADC2_CH3', touch: 'T3', funcs: ['HSPI_CS', 'strapping pin'] },
                { gpio: -3, label: '3V3', side: 'right', idx: 13, adc: null, touch: null, funcs: ['3.3V output'], power: true },
            ]
        },
        'esp32s3': {
            name: 'ESP32-S3-WROOM',
            chipLabel: 'ESP32-S3',
            pins: [
                // Left side (pin 1→15, top to bottom) — matches physical devkit
                { gpio: -1, label: 'GND',  side: 'left', idx: 0,  adc: null, touch: null, funcs: ['ground'], power: true },
                { gpio: -2, label: '3V3',  side: 'left', idx: 1,  adc: null, touch: null, funcs: ['3.3V output'], power: true },
                { gpio: -3, label: 'EN',   side: 'left', idx: 2,  adc: null, touch: null, funcs: ['reset / enable'], power: true },
                { gpio: 4,  label: '4',    side: 'left', idx: 3,  adc: 'ADC1_CH3', touch: 'TOUCH4', funcs: ['RTC_GPIO4'] },
                { gpio: 5,  label: '5',    side: 'left', idx: 4,  adc: 'ADC1_CH4', touch: 'TOUCH5', funcs: ['RTC_GPIO5'] },
                { gpio: 6,  label: '6',    side: 'left', idx: 5,  adc: 'ADC1_CH5', touch: 'TOUCH6', funcs: ['RTC_GPIO6'] },
                { gpio: 7,  label: '7',    side: 'left', idx: 6,  adc: 'ADC2_CH6', touch: 'TOUCH7', funcs: ['RTC_GPIO7'] },
                { gpio: 15, label: '15',   side: 'left', idx: 7,  adc: 'ADC2_CH4', touch: null, funcs: ['RTC_GPIO15', 'U0RTS'] },
                { gpio: 16, label: '16',   side: 'left', idx: 8,  adc: 'ADC2_CH5', touch: null, funcs: ['RTC_GPIO16', 'U0CTS'] },
                { gpio: 17, label: '17',   side: 'left', idx: 9,  adc: 'ADC2_CH6', touch: null, funcs: ['RTC_GPIO17', 'U1_TXD'] },
                { gpio: 18, label: '18',   side: 'left', idx: 10, adc: 'ADC2_CH7', touch: null, funcs: ['RTC_CPIO18', 'U1_RXD'] },
                { gpio: 8,  label: '8',    side: 'left', idx: 11, adc: null, touch: 'TOUCH8', funcs: ['RTC_GPIO8', 'SPI_CS'] },
                { gpio: 19, label: '19',   side: 'left', idx: 12, adc: 'ADC2_CH8', touch: null, funcs: ['RTC_GPIO19', 'USB_D-'] },
                { gpio: 20, label: '20',   side: 'left', idx: 13, adc: 'ADC2_CH9', touch: null, funcs: ['RTC_GPIO20', 'USB_D+'] },

                // Right side (pin 40→26, top to bottom)
                { gpio: -4, label: 'GND',  side: 'right', idx: 0,  adc: null, touch: null, funcs: ['ground'], power: true },
                { gpio: 1,  label: '1',    side: 'right', idx: 1,  adc: 'ADC1_CH0', touch: 'TOUCH1', funcs: ['RTC_GPIO1'] },
                { gpio: 2,  label: '2',    side: 'right', idx: 2,  adc: 'ADC1_CH1', touch: 'TOUCH2', funcs: ['RTC_GPIO2'] },
                { gpio: 43, label: 'TX',   side: 'right', idx: 3,  adc: null, touch: null, funcs: ['U0_TXD'] },
                { gpio: 44, label: 'RX',   side: 'right', idx: 4,  adc: null, touch: null, funcs: ['U0_RXD'] },
                { gpio: 42, label: '42',   side: 'right', idx: 5,  adc: null, touch: null, funcs: ['MTMS'] },
                { gpio: 41, label: '41',   side: 'right', idx: 6,  adc: null, touch: null, funcs: ['MTDI'] },
                { gpio: 40, label: '40',   side: 'right', idx: 7,  adc: null, touch: null, funcs: ['MTDO', 'JTAG'] },
                { gpio: 39, label: '39',   side: 'right', idx: 8,  adc: null, touch: null, funcs: ['MTCK', 'JTAG'] },
                { gpio: 38, label: '38',   side: 'right', idx: 9,  adc: null, touch: null, funcs: ['FSPIWP'] },
                { gpio: 37, label: '37',   side: 'right', idx: 10, adc: null, touch: null, funcs: ['PSRAM (octal)'] },
                { gpio: 36, label: '36',   side: 'right', idx: 11, adc: null, touch: null, funcs: ['PSRAM (octal)'] },
                { gpio: 35, label: '35',   side: 'right', idx: 12, adc: null, touch: null, funcs: ['PSRAM (octal)'] },
                { gpio: 0,  label: '0',    side: 'right', idx: 13, adc: null, touch: null, funcs: ['RTC_GPIO0', 'strapping pin'] },

                // Bottom side (pin 15→26, left to right)
                { gpio: 3,  label: '3',    side: 'bottom', idx: 0,  adc: 'ADC1_CH2', touch: 'TOUCH3', funcs: ['RTC_GPIO3', 'strapping pin'] },
                { gpio: 46, label: '46',   side: 'bottom', idx: 1,  adc: null, touch: null, funcs: ['strapping pin'] },
                { gpio: 9,  label: '9',    side: 'bottom', idx: 2,  adc: null, touch: 'TOUCH9', funcs: ['RTC_GPIO9'] },
                { gpio: 10, label: '10',   side: 'bottom', idx: 3,  adc: null, touch: 'TOUCH10', funcs: ['RTC_GPIO10', 'FSPIIO4'] },
                { gpio: 11, label: '11',   side: 'bottom', idx: 4,  adc: null, touch: 'TOUCH11', funcs: ['RTC_GPIO11', 'FSPIIO5'] },
                { gpio: 12, label: '12',   side: 'bottom', idx: 5,  adc: null, touch: 'TOUCH12', funcs: ['RTC_GPIO12', 'FSPIIO6'] },
                { gpio: 13, label: '13',   side: 'bottom', idx: 6,  adc: null, touch: 'TOUCH13', funcs: ['RTC_GPIO13', 'FSPIIO7'] },
                { gpio: 14, label: '14',   side: 'bottom', idx: 7,  adc: null, touch: 'TOUCH14', funcs: ['RTC_GPIO14'] },
                { gpio: 21, label: '21',   side: 'bottom', idx: 8,  adc: null, touch: null, funcs: ['RTC_GPIO21'] },
                { gpio: 47, label: '47',   side: 'bottom', idx: 9,  adc: null, touch: null, funcs: [] },
                { gpio: 48, label: '48',   side: 'bottom', idx: 10, adc: null, touch: null, funcs: ['RGB_LED'] },
                { gpio: 45, label: '45',   side: 'bottom', idx: 11, adc: null, touch: null, funcs: ['strapping pin'] },
            ]
        },
        'esp32c3': {
            name: 'ESP32-C3 Mini',
            chipLabel: 'ESP32-C3',
            pins: [
                { gpio: 0,  label: '0', side: 'left', idx: 0, adc: 'ADC1_CH0', touch: null, funcs: [] },
                { gpio: 1,  label: '1', side: 'left', idx: 1, adc: 'ADC1_CH1', touch: null, funcs: [] },
                { gpio: 2,  label: '2', side: 'left', idx: 2, adc: 'ADC1_CH2', touch: null, funcs: [] },
                { gpio: 3,  label: '3', side: 'left', idx: 3, adc: 'ADC1_CH3', touch: null, funcs: [] },
                { gpio: 4,  label: '4', side: 'left', idx: 4, adc: 'ADC1_CH4', touch: null, funcs: [] },
                { gpio: 5,  label: '5', side: 'left', idx: 5, adc: null, touch: null, funcs: [] },
                { gpio: -1, label: 'GND', side: 'left', idx: 6, adc: null, touch: null, funcs: ['ground'], power: true },
                // Right
                { gpio: 21, label: '21', side: 'right', idx: 0, adc: null, touch: null, funcs: ['UART0_TX'] },
                { gpio: 20, label: '20', side: 'right', idx: 1, adc: null, touch: null, funcs: ['UART0_RX'] },
                { gpio: 10, label: '10', side: 'right', idx: 2, adc: null, touch: null, funcs: [] },
                { gpio: 9,  label: '9', side: 'right', idx: 3, adc: null, touch: null, funcs: ['boot'] },
                { gpio: 8,  label: '8', side: 'right', idx: 4, adc: null, touch: null, funcs: ['RGB_LED'] },
                { gpio: 7,  label: '7', side: 'right', idx: 5, adc: null, touch: null, funcs: [] },
                { gpio: 6,  label: '6', side: 'right', idx: 6, adc: null, touch: null, funcs: [] },
            ]
        },
        'arduino-uno': {
            name: 'Arduino Uno',
            chipLabel: 'ATmega328P',
            pins: [
                // Left (digital)
                { gpio: 0,  label: 'D0/RX', side: 'left', idx: 0, adc: null, touch: null, funcs: ['UART_RX'] },
                { gpio: 1,  label: 'D1/TX', side: 'left', idx: 1, adc: null, touch: null, funcs: ['UART_TX'] },
                { gpio: 2,  label: 'D2', side: 'left', idx: 2, adc: null, touch: null, funcs: ['INT0'] },
                { gpio: 3,  label: 'D3~', side: 'left', idx: 3, adc: null, touch: null, funcs: ['INT1', 'PWM'] },
                { gpio: 4,  label: 'D4', side: 'left', idx: 4, adc: null, touch: null, funcs: [] },
                { gpio: 5,  label: 'D5~', side: 'left', idx: 5, adc: null, touch: null, funcs: ['PWM'] },
                { gpio: 6,  label: 'D6~', side: 'left', idx: 6, adc: null, touch: null, funcs: ['PWM'] },
                { gpio: 7,  label: 'D7', side: 'left', idx: 7, adc: null, touch: null, funcs: [] },
                { gpio: 8,  label: 'D8', side: 'left', idx: 8, adc: null, touch: null, funcs: [] },
                { gpio: 9,  label: 'D9~', side: 'left', idx: 9, adc: null, touch: null, funcs: ['PWM'] },
                { gpio: 10, label: 'D10~', side: 'left', idx: 10, adc: null, touch: null, funcs: ['SPI_SS', 'PWM'] },
                { gpio: 11, label: 'D11~', side: 'left', idx: 11, adc: null, touch: null, funcs: ['SPI_MOSI', 'PWM'] },
                { gpio: 12, label: 'D12', side: 'left', idx: 12, adc: null, touch: null, funcs: ['SPI_MISO'] },
                { gpio: 13, label: 'D13', side: 'left', idx: 13, adc: null, touch: null, funcs: ['SPI_SCK', 'LED_BUILTIN'] },
                // Right (analog)
                { gpio: 14, label: 'A0', side: 'right', idx: 0, adc: 'ADC0', touch: null, funcs: [] },
                { gpio: 15, label: 'A1', side: 'right', idx: 1, adc: 'ADC1', touch: null, funcs: [] },
                { gpio: 16, label: 'A2', side: 'right', idx: 2, adc: 'ADC2', touch: null, funcs: [] },
                { gpio: 17, label: 'A3', side: 'right', idx: 3, adc: 'ADC3', touch: null, funcs: [] },
                { gpio: 18, label: 'A4', side: 'right', idx: 4, adc: 'ADC4', touch: null, funcs: ['I2C_SDA'] },
                { gpio: 19, label: 'A5', side: 'right', idx: 5, adc: 'ADC5', touch: null, funcs: ['I2C_SCL'] },
                { gpio: -1, label: 'VIN', side: 'right', idx: 6, adc: null, touch: null, funcs: ['voltage in'], power: true },
                { gpio: -2, label: 'GND', side: 'right', idx: 7, adc: null, touch: null, funcs: ['ground'], power: true },
                { gpio: -3, label: '5V', side: 'right', idx: 8, adc: null, touch: null, funcs: ['5V'], power: true },
                { gpio: -4, label: '3V3', side: 'right', idx: 9, adc: null, touch: null, funcs: ['3.3V'], power: true },
            ]
        },
        'arduino-mega': {
            name: 'Arduino Mega 2560',
            chipLabel: 'ATmega2560',
            pins: (() => {
                const p = [];
                // Left: Digital 0-21
                for (let i = 0; i <= 21; i++) {
                    const funcs = [];
                    if (i === 0) funcs.push('UART0_RX');
                    if (i === 1) funcs.push('UART0_TX');
                    if ([2,3].includes(i)) funcs.push('INT');
                    if ([2,3,4,5,6,7,8,9,10,11,12,13,44,45,46].includes(i)) funcs.push('PWM');
                    if (i === 13) funcs.push('LED_BUILTIN');
                    if (i === 20) funcs.push('I2C_SDA');
                    if (i === 21) funcs.push('I2C_SCL');
                    p.push({ gpio: i, label: `D${i}`, side: 'left', idx: i, adc: null, touch: null, funcs });
                }
                // Right: Analog + some digital
                for (let i = 0; i <= 15; i++) {
                    p.push({ gpio: 54 + i, label: `A${i}`, side: 'right', idx: i, adc: `ADC${i}`, touch: null, funcs: [] });
                }
                return p;
            })()
        }
    };

    // =========================================================================
    // Pin state tracking
    // =========================================================================

    const PIN_COLORS = {
        'OUTPUT_HIGH': '#34d399', // green
        'OUTPUT_LOW':  '#f87171', // red
        'INPUT_HIGH':  '#60a5fa', // blue
        'INPUT_LOW':   '#1e40af', // dark blue
        'PWM':         '#c084fc', // purple
        'I2C':         '#f472b6', // pink
        'SPI':         '#fb923c', // orange
        'ANALOG':      '#2dd4bf', // teal
        'INACTIVE':    '#3a3f4a', // gray
        'POWER':       '#6b7280', // dark gray
    };

    let currentBoard = 'esp32s3';
    let pinStates = {};     // { gpioNum: { mode, state, value, alias } }
    let selectedPin = null;
    let pinAliases = {};    // persisted

    // Load aliases
    try {
        const saved = localStorage.getItem('esp32-pin-aliases');
        if (saved) pinAliases = JSON.parse(saved);
    } catch (e) {}

    function savePinAliases() {
        localStorage.setItem('esp32-pin-aliases', JSON.stringify(pinAliases));
    }

    // =========================================================================
    // SVG rendering
    // =========================================================================

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.getElementById('pinmapSvg');

    function drawBoard(boardKey) {
        if (!svg) return;
        currentBoard = boardKey;
        const board = BOARDS[boardKey];
        if (!board) return;

        svg.innerHTML = '';
        selectedPin = null;

        const leftPins = board.pins.filter(p => p.side === 'left');
        const rightPins = board.pins.filter(p => p.side === 'right');
        const bottomPins = board.pins.filter(p => p.side === 'bottom');
        const maxSidePins = Math.max(leftPins.length, rightPins.length);

        const pinH = 22;
        const pinW = 50;
        const gap = 4;
        const pinSpacing = pinH + gap; // 26px per bottom pin slot
        const minChipW = 140;
        const margin = 30;
        const sideGap = 14; // gap between side pins and chip

        // Chip width: must fit all bottom pins inside + padding
        const bottomNeeded = bottomPins.length > 0
            ? bottomPins.length * pinSpacing + gap + 20 // pins + internal padding
            : 0;
        const chipW = Math.max(minChipW, bottomNeeded);

        const sideAreaH = maxSidePins * (pinH + gap);
        const bottomAreaH = bottomPins.length > 0 ? pinW + 50 : 0; // rotated pins + lines + GPIO labels
        const totalH = sideAreaH + margin * 2 + bottomAreaH;
        const totalW = margin + pinW + sideGap + chipW + sideGap + pinW + margin;

        svg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);

        // Chip body
        const chipX = margin + pinW + sideGap;
        const chipY = margin;
        const chipH = sideAreaH;

        const chipRect = document.createElementNS(NS, 'rect');
        chipRect.setAttribute('class', 'chip-body');
        chipRect.setAttribute('x', chipX);
        chipRect.setAttribute('y', chipY);
        chipRect.setAttribute('width', chipW);
        chipRect.setAttribute('height', chipH);
        svg.appendChild(chipRect);

        // Chip notch (semicircle at top)
        const notch = document.createElementNS(NS, 'path');
        const notchCx = chipX + chipW / 2;
        notch.setAttribute('d', `M${notchCx - 8},${chipY} A8,8 0 0,1 ${notchCx + 8},${chipY}`);
        notch.setAttribute('class', 'chip-notch');
        svg.appendChild(notch);

        // Chip label
        const chipLabelEl = document.createElementNS(NS, 'text');
        chipLabelEl.setAttribute('class', 'chip-label');
        chipLabelEl.setAttribute('x', chipX + chipW / 2);
        chipLabelEl.setAttribute('y', chipY + chipH / 2 + 5);
        chipLabelEl.setAttribute('text-anchor', 'middle');
        chipLabelEl.textContent = board.chipLabel;
        svg.appendChild(chipLabelEl);

        // Draw a horizontal pin (left or right side)
        function drawHPin(pin, x, y, labelSide) {
            const g = document.createElementNS(NS, 'g');
            g.dataset.gpio = pin.gpio;

            const rect = document.createElementNS(NS, 'rect');
            rect.setAttribute('class', 'pin-rect');
            rect.setAttribute('x', x);
            rect.setAttribute('y', y);
            rect.setAttribute('width', pinW);
            rect.setAttribute('height', pinH);
            rect.setAttribute('rx', 3);
            rect.setAttribute('fill', getPinColor(pin));
            g.appendChild(rect);

            const label = document.createElementNS(NS, 'text');
            label.setAttribute('class', 'pin-label');
            label.setAttribute('x', x + pinW / 2);
            label.setAttribute('y', y + pinH / 2 + 3);
            label.setAttribute('text-anchor', 'middle');
            const alias = pinAliases[boardKey + '_' + pin.gpio];
            label.textContent = alias || pin.label;
            g.appendChild(label);

            const num = document.createElementNS(NS, 'text');
            num.setAttribute('class', 'pin-num');
            if (labelSide === 'left') {
                num.setAttribute('x', x + pinW + 4);
                num.setAttribute('y', y + pinH / 2 + 3);
                num.setAttribute('text-anchor', 'start');
            } else {
                num.setAttribute('x', x - 4);
                num.setAttribute('y', y + pinH / 2 + 3);
                num.setAttribute('text-anchor', 'end');
            }
            if (pin.gpio >= 0) num.textContent = `GPIO${pin.gpio}`;
            g.appendChild(num);

            const line = document.createElementNS(NS, 'line');
            line.setAttribute('stroke', 'var(--border)');
            line.setAttribute('stroke-width', '1');
            if (labelSide === 'left') {
                line.setAttribute('x1', x + pinW);
                line.setAttribute('y1', y + pinH / 2);
                line.setAttribute('x2', chipX);
                line.setAttribute('y2', y + pinH / 2);
            } else {
                line.setAttribute('x1', chipX + chipW);
                line.setAttribute('y1', y + pinH / 2);
                line.setAttribute('x2', x);
                line.setAttribute('y2', y + pinH / 2);
            }
            svg.appendChild(line);

            g.addEventListener('click', () => selectPin(pin, rect));
            svg.appendChild(g);
            return rect;
        }

        // Draw a vertical pin (bottom side)
        function drawVPin(pin, x, y) {
            const g = document.createElementNS(NS, 'g');
            g.dataset.gpio = pin.gpio;

            const rect = document.createElementNS(NS, 'rect');
            rect.setAttribute('class', 'pin-rect');
            rect.setAttribute('x', x);
            rect.setAttribute('y', y);
            rect.setAttribute('width', pinH); // swapped: narrow width
            rect.setAttribute('height', pinW); // swapped: tall height
            rect.setAttribute('rx', 3);
            rect.setAttribute('fill', getPinColor(pin));
            g.appendChild(rect);

            // Rotated label inside pin (bottom-to-top reading direction)
            const label = document.createElementNS(NS, 'text');
            label.setAttribute('class', 'pin-label');
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('transform', `translate(${x + pinH / 2}, ${y + pinW / 2}) rotate(-90)`);
            const alias = pinAliases[boardKey + '_' + pin.gpio];
            label.textContent = alias || pin.label;
            g.appendChild(label);

            // GPIO number above pin (vertical, same reading direction)
            const num = document.createElementNS(NS, 'text');
            num.setAttribute('class', 'pin-num');
            num.setAttribute('text-anchor', 'start');
            num.setAttribute('font-size', '7');
            num.setAttribute('transform', `translate(${x + pinH / 2 + 3}, ${y - 12}) rotate(-90)`);
            if (pin.gpio >= 0) num.textContent = `GPIO${pin.gpio}`;
            g.appendChild(num);

            // Connection line from pin to chip bottom
            const line = document.createElementNS(NS, 'line');
            line.setAttribute('stroke', 'var(--border)');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('x1', x + pinH / 2);
            line.setAttribute('y1', chipY + chipH);
            line.setAttribute('x2', x + pinH / 2);
            line.setAttribute('y2', y);
            svg.appendChild(line);

            g.addEventListener('click', () => selectPin(pin, rect));
            svg.appendChild(g);
            return rect;
        }

        // Draw left pins
        leftPins.forEach((pin, i) => {
            const x = margin;
            const y = margin + i * (pinH + gap);
            pin._rect = drawHPin(pin, x, y, 'left');
        });

        // Draw right pins
        rightPins.forEach((pin, i) => {
            const x = chipX + chipW + sideGap;
            const y = margin + i * (pinH + gap);
            pin._rect = drawHPin(pin, x, y, 'right');
        });

        // Draw bottom pins
        if (bottomPins.length > 0) {
            const bottomCount = bottomPins.length;
            const bottomTotalW = bottomCount * pinSpacing - gap;
            const bottomStartX = chipX + (chipW - bottomTotalW) / 2;
            const bottomY = chipY + chipH + 20; // more space for GPIO labels
            bottomPins.forEach((pin, i) => {
                const x = bottomStartX + i * pinSpacing;
                pin._rect = drawVPin(pin, x, bottomY);
            });
        }

        // Render legend
        renderLegend();
        updateDetailPanel();
    }

    function getPinColor(pin) {
        if (pin.power) return PIN_COLORS.POWER;
        const state = pinStates[pin.gpio];
        if (!state) return PIN_COLORS.INACTIVE;
        if (state.mode === 'PWM') return PIN_COLORS.PWM;
        if (state.mode === 'I2C') return PIN_COLORS.I2C;
        if (state.mode === 'SPI') return PIN_COLORS.SPI;
        if (state.mode === 'ANALOG') return PIN_COLORS.ANALOG;
        const isInput = state.mode === 'INPUT';
        const isOutput = state.mode === 'OUTPUT';
        if (isInput && state.state === 'HIGH')  return PIN_COLORS.INPUT_HIGH;
        if (isInput && state.state === 'LOW')   return PIN_COLORS.INPUT_LOW;
        if (isOutput && state.state === 'HIGH') return PIN_COLORS.OUTPUT_HIGH;
        if (isOutput && state.state === 'LOW')  return PIN_COLORS.OUTPUT_LOW;
        if (isInput)  return PIN_COLORS.INPUT_HIGH;
        if (isOutput) return PIN_COLORS.OUTPUT_HIGH;
        return PIN_COLORS.INACTIVE;
    }

    function renderLegend() {
        const legend = document.getElementById('pinmapLegend');
        if (!legend) return;
        legend.innerHTML = '';
        const items = [
            { color: PIN_COLORS.OUTPUT_HIGH, label: 'OUTPUT HIGH' },
            { color: PIN_COLORS.OUTPUT_LOW, label: 'OUTPUT LOW' },
            { color: PIN_COLORS.INPUT_HIGH, label: 'INPUT HIGH' },
            { color: PIN_COLORS.INPUT_LOW, label: 'INPUT LOW' },
            { color: PIN_COLORS.PWM, label: 'PWM' },
            { color: PIN_COLORS.I2C, label: 'I2C' },
            { color: PIN_COLORS.SPI, label: 'SPI' },
            { color: PIN_COLORS.ANALOG, label: 'ANALOG' },
            { color: PIN_COLORS.POWER, label: 'POWER / GND' },
            { color: PIN_COLORS.INACTIVE, label: 'Inactive' },
        ];
        for (const item of items) {
            const div = document.createElement('div');
            div.className = 'pinmap-legend-item';
            div.innerHTML = `<span class="pinmap-legend-color" style="background:${item.color};"></span><span>${item.label}</span>`;
            legend.appendChild(div);
        }
    }

    // =========================================================================
    // Pin selection & detail panel
    // =========================================================================

    function selectPin(pin, rect) {
        // Deselect previous
        if (selectedPin && selectedPin._rect) {
            selectedPin._rect.classList.remove('selected');
        }
        selectedPin = pin;
        if (rect) {
            pin._rect = rect;
            rect.classList.add('selected');
        }
        updateDetailPanel();
    }

    function updateDetailPanel() {
        const detail = document.getElementById('pinmapDetail');
        if (!detail) return;

        if (!selectedPin || selectedPin.gpio < 0) {
            detail.innerHTML = '<span class="pinmap-detail-placeholder">Cliquez sur un pin pour voir les d\u00e9tails</span>';
            return;
        }

        const pin = selectedPin;
        const state = pinStates[pin.gpio] || {};
        const board = BOARDS[currentBoard];
        const aliasKey = currentBoard + '_' + pin.gpio;
        const alias = pinAliases[aliasKey] || '';

        let html = `<h4>GPIO ${pin.gpio} — ${pin.label}</h4>`;
        html += '<div class="pin-info-row"><span class="pin-info-label">Mode</span><span class="pin-info-value">' + (state.mode || '—') + '</span></div>';
        html += '<div class="pin-info-row"><span class="pin-info-label">State</span><span class="pin-info-value">' + (state.state || '—') + '</span></div>';
        if (state.value !== undefined) {
            html += '<div class="pin-info-row"><span class="pin-info-label">Value</span><span class="pin-info-value">' + state.value + '</span></div>';
        }
        if (pin.adc) {
            html += '<div class="pin-info-row"><span class="pin-info-label">ADC</span><span class="pin-info-value">' + pin.adc + '</span></div>';
        }
        if (pin.touch) {
            html += '<div class="pin-info-row"><span class="pin-info-label">Touch</span><span class="pin-info-value">' + pin.touch + '</span></div>';
        }
        if (pin.funcs && pin.funcs.length > 0) {
            html += '<div class="pin-info-row"><span class="pin-info-label">Functions</span><span class="pin-info-value">' + pin.funcs.join(', ') + '</span></div>';
        }

        // Alias input
        html += '<input type="text" class="pin-alias-input" placeholder="Alias (ex: LED, Relay...)" value="' + alias + '">';

        // Action buttons
        html += '<div class="pin-actions">';
        html += '<button class="btn btn-small btn-success" data-action="high">HIGH</button>';
        html += '<button class="btn btn-small btn-danger" data-action="low">LOW</button>';
        html += '<button class="btn btn-small" data-action="read">READ</button>';
        html += '<button class="btn btn-small" data-action="toggle">TOGGLE</button>';
        html += '</div>';

        detail.innerHTML = html;

        // Wire alias input
        const aliasInput = detail.querySelector('.pin-alias-input');
        if (aliasInput) {
            aliasInput.addEventListener('change', () => {
                const val = aliasInput.value.trim();
                if (val) pinAliases[aliasKey] = val;
                else delete pinAliases[aliasKey];
                savePinAliases();
                drawBoard(currentBoard); // Redraw to update labels
            });
        }

        // Wire action buttons
        const btns = detail.querySelectorAll('[data-action]');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                const action = btn.dataset.action;
                const dev = getSourceDevice();
                if (!dev) return;
                const api = window.ESP32Tester;
                if (!api || !api.sendCommand) return;

                let cmd = '';
                if (action === 'high') cmd = `GPIO ${pin.gpio} HIGH`;
                else if (action === 'low') cmd = `GPIO ${pin.gpio} LOW`;
                else if (action === 'read') cmd = `GPIO ${pin.gpio} READ`;
                else if (action === 'toggle') {
                    const cur = pinStates[pin.gpio];
                    cmd = `GPIO ${pin.gpio} ${(!cur || cur.state !== 'HIGH') ? 'HIGH' : 'LOW'}`;
                }
                if (cmd) api.sendCommand(dev, cmd);
            });
        });
    }

    // =========================================================================
    // Data feed: parse serial lines to detect pin state changes
    // =========================================================================

    let pinmapActive = true;
    let pinmapSourceIdx = 0;
    let pinmapRegex = null;

    function getSourceDevice() {
        const api = window.ESP32Tester;
        if (!api || !api.getDevice) return null;
        return api.getDevice(pinmapSourceIdx);
    }

    function feedPinMap(line) {
        if (!pinmapActive || !pinmapRegex) return;
        let m;
        try { m = pinmapRegex.exec(line); } catch (e) { return; }
        if (!m) return;

        const gpio = parseInt(m[1], 10);
        const mode = (m[2] || '').toUpperCase();
        const state = (m[3] || '').toUpperCase();

        if (isNaN(gpio)) return;

        if (!pinStates[gpio]) pinStates[gpio] = {};
        pinStates[gpio].mode = mode;
        pinStates[gpio].state = state;
        if (m[4] !== undefined) pinStates[gpio].value = m[4];

        // Update the SVG pin color
        const board = BOARDS[currentBoard];
        if (board) {
            const pin = board.pins.find(p => p.gpio === gpio);
            if (pin && pin._rect) {
                pin._rect.setAttribute('fill', getPinColor(pin));
            }
        }

        // Update detail if this pin is selected
        if (selectedPin && selectedPin.gpio === gpio) {
            updateDetailPanel();
        }
    }

    // Expose feed for serial.js to call
    window._pinmapFeed = feedPinMap;

    // =========================================================================
    // UI wiring
    // =========================================================================

    function init() {
        const boardSelect = document.getElementById('pinmapBoardSelect');
        const sourceSelect = document.getElementById('pinmapSourceSelect');
        const regexInput = document.getElementById('pinmapRegex');
        const chkActive = document.getElementById('chkPinmapActive');

        if (boardSelect) {
            boardSelect.addEventListener('change', () => {
                pinStates = {};
                drawBoard(boardSelect.value);
            });
        }

        if (regexInput) {
            regexInput.addEventListener('change', () => {
                try {
                    pinmapRegex = new RegExp(regexInput.value);
                } catch (e) {
                    pinmapRegex = null;
                }
            });
            // Init regex
            try { pinmapRegex = new RegExp(regexInput.value); } catch (e) {}
        }

        if (chkActive) {
            chkActive.addEventListener('change', () => {
                pinmapActive = chkActive.checked;
            });
        }

        // Populate source select (device list)
        function updateSources() {
            if (!sourceSelect) return;
            sourceSelect.innerHTML = '';
            const api = window.ESP32Tester;
            const count = api && api.getDevices ? api.getDevices().length : 1;
            for (let i = 0; i < count; i++) {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = 'Device ' + (i + 1);
                sourceSelect.appendChild(opt);
            }
        }
        updateSources();

        if (sourceSelect) {
            sourceSelect.addEventListener('change', () => {
                pinmapSourceIdx = parseInt(sourceSelect.value, 10) || 0;
            });
        }

        // Hook into device rebuild
        const origRebuilt = window._onDevicesRebuilt;
        window._onDevicesRebuilt = () => {
            if (origRebuilt) origRebuilt();
            updateSources();
        };

        // Draw initial board
        drawBoard(currentBoard);
    }

    // Init when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
