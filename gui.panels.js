// gui.panels.js - CYBER/NEON PANEL UTILITIES
const NEON = {
    bg: '#070a12',
    bg2: '#0b1b2e',
    bgDark: '#050a14',
    cyan: '#00ffcc',
    magenta: '#ff3b6b',
    lime: '#00ffcc',
    orange: '#ffaa00',
    red: '#ff3b6b',
    border: '#00d4ff',
    grid: '#1a2a44',
    text: '#e8f7ff',
    dim: '#a6dfff',
    black: '#000000',
    indigo: '#7c4dff'
};

const LEVELS = {
    CRITICAL: 'CRITICAL',
    IMPORTANT: 'IMPORTANT',
    INFO: 'INFO',
    PASSIVE: 'PASSIVE'
};

const FONT_SCALES = {
    TITLE: 0.5,
    LABEL: 0.4,
    SMALL: 0.38
};

function glowRect(visual, x, y, w, h, color, intensity = 1) {
    visual.rect(x, y, w, h, { fill: 'transparent', stroke: color, strokeWidth: 0.18, opacity: 0.08 * intensity });
    visual.rect(x, y, w, h, { fill: 'transparent', stroke: color, strokeWidth: 0.12, opacity: 0.18 * intensity });
}

function glowText(visual, text, x, y, color, opts = {}) {
    const { font = FONT_SCALES.LABEL, align = 'center', glow = 0.35 } = opts;

    let finalGlow = glow;
    if (opts.pulse) {
        finalGlow *= (0.7 + Math.sin(Game.time / 5) * 0.3);
    }

    // Outer glow
    visual.text(text, x, y, {
        align,
        color: opts.glowColor || color,
        font,
        stroke: 'transparent',
        opacity: finalGlow
    });

    // Main text
    visual.text(text, x, y, {
        align,
        color,
        font,
        stroke: NEON.black,
        strokeWidth: 0.1,
        opacity: 0.95
    });
}

module.exports = {
    LEVELS,
    FONT_SCALES,
    NEON,

    drawBackdrop: function (visual) {
        visual.rect(0, 0, 50, 50, {
            fill: NEON.black,
            opacity: 0.2
        });
    },

    drawPanel(visual, x, y, width, height, options = {}) {
        const {
            title = '',
            backgroundColor = NEON.bg,
            borderColor = NEON.border,
            gradientColor = NEON.bg2,
            opacity = 0.88,
            titleColor = NEON.cyan,
            level = LEVELS.INFO
        } = options;

        let strokeWidth = 0.05;
        let glowIntensity = 1;
        let finalBG = backgroundColor;

        // Apply Priority Logic
        if (level === LEVELS.CRITICAL) {
            strokeWidth = 0.12;
            glowIntensity = 1.5 * (0.8 + Math.sin(Game.time / 5) * 0.2);
        } else if (level === LEVELS.IMPORTANT) {
            strokeWidth = 0.08;
            glowIntensity = 1.0;
        } else if (level === LEVELS.PASSIVE) {
            strokeWidth = 0.03;
            glowIntensity = 0;
            finalBG = NEON.bgDark;
        }

        // Background base
        visual.rect(x, y, width, height, {
            fill: finalBG,
            opacity: opacity * 0.70
        });

        // Top gradient band
        if (level !== LEVELS.PASSIVE) {
            visual.rect(x, y, width, Math.min(1.2, height), {
                fill: gradientColor,
                opacity: opacity * 0.55
            });
        }

        // Neon glow strokes
        if (glowIntensity > 0) {
            glowRect(visual, x, y, width, height, borderColor, glowIntensity);
        }

        // Main border
        visual.rect(x, y, width, height, {
            fill: 'transparent',
            stroke: borderColor,
            strokeWidth: strokeWidth,
            opacity
        });

        // Title strip
        let contentStartY = y + 0.25;
        if (title) {
            visual.rect(x, y, width, 0.95, {
                fill: gradientColor,
                opacity: opacity * 0.85
            });

            glowText(visual, title, x + width / 2, y + 0.68, titleColor, {
                font: FONT_SCALES.TITLE,
                align: 'center',
                glow: glowIntensity * 0.5,
                glowColor: borderColor,
                pulse: level === LEVELS.CRITICAL
            });

            contentStartY = y + 1.10;
        }

        return contentStartY;
    },

    drawProgressBar(visual, x, y, width, height, percentage, options = {}) {
        const {
            backgroundColor = NEON.bg,
            fillColor = NEON.cyan,
            gradientColor = NEON.border,
            borderColor = NEON.grid,
            showPercentage = true,
            label = '',
            blocks = 10
        } = options;

        const pct = Math.max(0, Math.min(percentage, 1));

        // Base
        visual.rect(x, y, width, height, { fill: backgroundColor, opacity: 0.75 });

        // Draw segmented blocks
        const blockWidth = width / blocks;
        const filledBlocks = Math.floor(pct * blocks);

        for (let i = 0; i < blocks; i++) {
            const blockX = x + i * blockWidth;
            const isFilled = i < filledBlocks;
            const blockColor = isFilled ? fillColor : backgroundColor;
            const blockOpacity = isFilled ? 0.65 : 0.2;

            visual.rect(blockX + 0.02, y + 0.02, blockWidth - 0.04, height - 0.04, {
                fill: blockColor,
                opacity: blockOpacity
            });

            if (isFilled && i === 0) {
                // Subtle gradient overlay on filled portion
                visual.rect(x, y, blockWidth * filledBlocks, height, {
                    fill: gradientColor,
                    opacity: 0.15
                });
            }
        }

        // Border
        visual.rect(x, y, width, height, { fill: 'transparent', stroke: borderColor, strokeWidth: 0.03, opacity: 0.9 });

        // Text
        if (showPercentage) {
            visual.text(`${Math.round(pct * 100)}%`, x + width / 2, y + height / 2 + 0.13, {
                align: 'center',
                color: NEON.text,
                font: FONT_SCALES.SMALL,
                stroke: NEON.black,
                strokeWidth: 0.12
            });
        }

        if (label) {
            visual.text(label, x - 0.15, y + height / 2 + 0.13, {
                align: 'right',
                color: NEON.dim,
                font: FONT_SCALES.SMALL
            });
        }
    },

    drawGraph(visual, x, y, width, height, data, options = {}) {
        const {
            lineColor = NEON.cyan,
            gradientColor = NEON.border,
            backgroundColor = NEON.bg,
            gridColor = NEON.grid,
            showGrid = true,
            maxValue = null,
            minValue = null
        } = options;

        if (!data || data.length < 2) return;

        visual.rect(x, y, width, height, { fill: backgroundColor, opacity: 0.65 });

        if (showGrid) {
            for (let i = 0; i <= 4; i++) {
                const gridY = y + (height / 4) * i;
                visual.line(x, gridY, x + width, gridY, {
                    color: gridColor,
                    opacity: 0.25,
                    lineStyle: 'dashed'
                });
            }
        }

        const dataMax = maxValue !== null ? maxValue : Math.max(...data);
        const dataMin = minValue !== null ? minValue : Math.min(...data);
        const range = (dataMax - dataMin) || 1;

        const step = width / (data.length - 1);
        for (let i = 0; i < data.length - 1; i++) {
            const x1 = x + i * step;
            const x2 = x + (i + 1) * step;
            const y1 = y + height - ((data[i] - dataMin) / range) * height;
            const y2 = y + height - ((data[i + 1] - dataMin) / range) * height;

            // glow line
            visual.line(x1, y1, x2, y2, { color: lineColor, width: 0.18, opacity: 0.18 });
            // main line
            visual.line(x1, y1, x2, y2, { color: lineColor, width: 0.10, opacity: 0.85 });
        }

        // light fill under graph
        for (let i = 0; i < data.length; i++) {
            const xPos = x + i * step;
            const yPos = y + height - ((data[i] - dataMin) / range) * height;
            const fillH = (y + height) - yPos;

            visual.rect(xPos, yPos, step, fillH, { fill: gradientColor, opacity: 0.10 });
        }

        visual.rect(x, y, width, height, { fill: 'transparent', stroke: gridColor, strokeWidth: 0.05, opacity: 0.8 });
    },

    getStatusColor: function (percentage, inverted = false) {
        if (inverted) percentage = 1 - percentage;
        if (percentage >= 0.7) return NEON.lime;
        if (percentage >= 0.4) return NEON.orange;
        return NEON.red;
    },

    getPanelTheme(type) {
        const themes = {
            primary: { background: NEON.bg, gradient: NEON.bg2, border: NEON.border, title: NEON.cyan },
            success: { background: '#06130f', gradient: '#0b2a22', border: NEON.lime, title: NEON.lime },
            warning: { background: '#120e06', gradient: '#2a1f0b', border: NEON.orange, title: NEON.orange },
            danger: { background: '#14060a', gradient: '#2a0b12', border: NEON.red, title: NEON.red },
            info: { background: NEON.bg, gradient: '#160b2a', border: NEON.indigo, title: '#a98bff' }
        };
        return themes[type] || themes.primary;
    }
};
