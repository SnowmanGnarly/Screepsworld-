// GUI Resources Panel
const panels = require('gui.panels');

module.exports = {
    render: function (room, visual, x, y) {
        const stats = room.memory.stats && room.memory.stats.current && room.memory.stats.current.energy;
        if (!stats) return y;

        const theme = panels.getPanelTheme('success');
        const width = 12;
        const height = 8;

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '⚡ RESOURCES',
            level: panels.LEVELS.INFO,
            titleColor: theme.title
        });

        // Total energy bar
        panels.drawProgressBar(visual, x + 0.5, contentY + 0.5, width - 1, 0.7, stats.percentage, {
            fillColor: panels.getStatusColor(stats.percentage),
            showPercentage: true
        });

        visual.text(`Total: ${stats.total.toLocaleString()}/${stats.capacity.toLocaleString()}`,
            x + width / 2, contentY + 1.6, {
            align: 'center',
            color: '#ffffff',
            font: 0.5,
            stroke: '#000000',
            strokeWidth: 0.05
        });

        // Breakdown
        let lineY = contentY + 2.5;

        // Room energy (spawns/extensions)
        const roomPct = stats.roomEnergyCapacity > 0 ? stats.roomEnergy / stats.roomEnergyCapacity : 0;
        visual.text(`🏭 Spawn Energy:`, x + 0.5, lineY, {
            align: 'left',
            color: '#00d4ff',
            font: 0.45
        });
        panels.drawProgressBar(visual, x + 5.5, lineY - 0.3, width - 6, 0.5, roomPct, {
            fillColor: panels.getStatusColor(roomPct),
            showPercentage: false
        });
        visual.text(`${stats.roomEnergy}/${stats.roomEnergyCapacity}`, x + width - 0.5, lineY, {
            align: 'right',
            color: '#ffffff',
            font: 0.4
        });

        lineY += 1;

        // Storage
        if (stats.storage > 0) {
            visual.text(`📦 Storage:`, x + 0.5, lineY, {
                align: 'left',
                color: '#00d4ff',
                font: 0.45
            });
            visual.text(`${stats.storage.toLocaleString()}`, x + width - 0.5, lineY, {
                align: 'right',
                color: '#00ff88',
                font: 0.4
            });
            lineY += 0.8;
        }

        // Containers
        if (stats.containers > 0) {
            visual.text(`📦 Containers:`, x + 0.5, lineY, {
                align: 'left',
                color: '#00d4ff',
                font: 0.45
            });
            visual.text(`${stats.containers.toLocaleString()}`, x + width - 0.5, lineY, {
                align: 'right',
                color: '#00ff88',
                font: 0.4
            });
        }

        return y + height + 0.3;
    }
};
