// GUI CPU Usage Panel
const panels = require('gui.panels');
const guiStats = require('gui.stats');

module.exports = {
    render: function (room, visual, x, y) {
        const stats = room.memory.stats && room.memory.stats.current && room.memory.stats.current.cpu;
        if (!stats) return y;

        const theme = panels.getPanelTheme('info');
        const width = 10;
        const height = 6;

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '⚡ CPU',
            level: panels.LEVELS.CRITICAL,
            titleColor: theme.title
        });

        // CPU usage bar
        const cpuPercentage = stats.percentage;
        const cpuColor = panels.getStatusColor(1 - cpuPercentage); // Inverted: low is good

        panels.drawProgressBar(visual, x + 0.5, contentY + 0.5, width - 1, 0.6, cpuPercentage, {
            fillColor: cpuColor,
            showPercentage: true
        });

        // CPU stats text
        visual.text(`Used: ${stats.used.toFixed(1)}/${stats.limit}`, x + 0.5, contentY + 1.8, {
            align: 'left',
            color: '#ffffff',
            font: 0.45
        });

        visual.text(`Bucket: ${stats.bucket.toLocaleString()}`, x + 0.5, contentY + 2.5, {
            align: 'left',
            color: stats.bucket > 5000 ? '#00ff88' : '#ffaa00',
            font: 0.45
        });

        // Mini CPU trend graph
        const cpuHistory = guiStats.getHistory(room, 'cpu.used', 20);
        if (cpuHistory.length > 1) {
            panels.drawGraph(visual, x + 0.5, contentY + 3.2, width - 1, 2, cpuHistory, {
                lineColor: cpuColor,
                maxValue: stats.limit,
                minValue: 0
            });
        }

        return y + height + 0.3;
    }
};
