// GUI Source Mining Efficiency Panel - Simplified & Compact
const panels = require('gui.panels');

module.exports = {
    render: function (room, visual, x, y) {
        const stats = room.memory.stats && room.memory.stats.current && room.memory.stats.current.sources;
        if (!stats || stats.length === 0) return y;

        const theme = panels.getPanelTheme('success');
        const width = 11;
        const height = 2 + stats.length * 1.8;

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '⛏️ MINING',
            level: panels.LEVELS.INFO,
            titleColor: theme.title
        });

        let lineY = contentY + 0.4;

        stats.forEach((source, index) => {
            const label = `SRC ${String.fromCharCode(65 + index)}`;

            // Stats row (Parts and Regen)
            visual.text(`${label}: ${source.workParts}W`, x + 0.5, lineY, {
                align: 'left',
                color: panels.NEON.dim,
                font: panels.FONT_SCALES.SMALL
            });
            if (source.ticksToRegen > 0) {
                visual.text(`${source.ticksToRegen}t`, x + width - 0.5, lineY, {
                    align: 'right',
                    color: panels.NEON.orange,
                    font: panels.FONT_SCALES.SMALL
                });
            }
            lineY += 0.5;

            // Efficiency Bar
            panels.drawProgressBar(visual, x + 0.5, lineY, width - 1, 0.5, source.efficiency, {
                fillColor: source.efficiency >= 0.9 ? panels.NEON.lime : panels.NEON.orange,
                showPercentage: true,
                blocks: 10
            });

            // Error emoji
            if (source.harvesters === 0) {
                visual.text('⚠️', x + width - 1.5, lineY - 0.5, { font: 0.4 });
            }

            lineY += 1.3;
        });

        return y + height + 0.3;
    }
};
