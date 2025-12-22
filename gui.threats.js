// GUI Threats Panel
const panels = require('gui.panels');

module.exports = {
    render: function (room, visual, x, y) {
        const stats = room.memory.stats && room.memory.stats.current && room.memory.stats.current.threats;
        if (!stats) return y;

        // Choose theme based on threat level
        let theme;
        if (stats.threatLevel === 'danger') theme = panels.getPanelTheme('danger');
        else if (stats.threatLevel === 'warning' || stats.threatLevel === 'caution') theme = panels.getPanelTheme('warning');
        else theme = panels.getPanelTheme('success');

        const width = 11;
        const height = stats.hostileCount > 0 ? Math.max(6, 3 + stats.hostiles.length * 0.8) : 4;

        // Draw panel with pulsing effect for danger
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '⚠️ THREATS',
            level: stats.threatLevel === 'danger' ? panels.LEVELS.CRITICAL : panels.LEVELS.IMPORTANT,
            titleColor: theme.title
        });

        if (stats.hostileCount === 0) {
            // Safe
            visual.text('✅ SAFE', x + width / 2, contentY + 1.5, {
                align: 'center',
                color: '#00ff88',
                font: 0.7,
                stroke: '#000000',
                strokeWidth: 0.1
            });
        } else {
            // Threat detected
            const levelText = stats.threatLevel.toUpperCase();
            const levelColors = {
                'caution': '#ffaa00',
                'warning': '#ff8800',
                'danger': '#ff4444'
            };
            const levelColor = levelColors[stats.threatLevel] || '#ffaa00';

            visual.text(`⚠️ ${levelText}`, x + width / 2, contentY + 0.7, {
                align: 'center',
                color: levelColor,
                font: 0.6,
                stroke: '#000000',
                strokeWidth: 0.1
            });

            visual.text(`${stats.hostileCount} Hostile${stats.hostileCount > 1 ? 's' : ''}`,
                x + width / 2, contentY + 1.5, {
                align: 'center',
                color: '#ffffff',
                font: 0.5
            });

            // List hostiles
            let lineY = contentY + 2.3;
            stats.hostiles.slice(0, 3).forEach(function (hostile) {
                visual.text(`👤 ${hostile.owner}`, x + 0.5, lineY, {
                    align: 'left',
                    color: '#ff4444',
                    font: 0.4
                });

                visual.text(`Size: ${hostile.bodySize}`, x + width - 0.5, lineY, {
                    align: 'right',
                    color: '#ffaa00',
                    font: 0.4
                });

                lineY += 0.8;
            });

            if (stats.hostiles.length > 3) {
                visual.text(`+${stats.hostiles.length - 3} more`, x + width / 2, lineY, {
                    align: 'center',
                    color: '#888888',
                    font: 0.35
                });
            }
        }

        return y + height + 0.3;
    }
};
