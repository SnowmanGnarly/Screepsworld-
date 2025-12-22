// GUI Graphs Panel - Energy Trends
const panels = require('gui.panels');
const guiStats = require('gui.stats');

module.exports = {
    render: function (room, visual, x, y) {
        const theme = panels.getPanelTheme('primary');
        const width = 20;
        const height = 8;

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '📊 ENERGY',
            level: panels.LEVELS.PASSIVE,
            titleColor: theme.title
        });

        // Get energy history
        const energyHistory = guiStats.getHistory(room, 'energy.total', 50);

        if (energyHistory.length < 2) {
            visual.text('Collecting data...', x + width / 2, contentY + 3, {
                align: 'center',
                color: '#888888',
                font: 0.5
            });
            return y + height + 0.3;
        }

        // Draw graph
        panels.drawGraph(visual, x + 0.5, contentY + 0.5, width - 1, height - 2, energyHistory, {
            lineColor: theme.title,
            gradientColor: theme.accent,
            showGrid: true
        });

        // Stats below graph
        const current = energyHistory[energyHistory.length - 1];
        const previous = energyHistory[energyHistory.length - 2];
        const change = current - previous;
        const changeColor = change >= 0 ? '#00ff88' : '#ff4444';
        const changeIcon = change >= 0 ? '▲' : '▼';

        visual.text(`Current: ${current.toLocaleString()}`, x + 2, contentY + height - 1.2, {
            align: 'left',
            color: '#ffffff',
            font: 0.45
        });

        visual.text(`${changeIcon} ${Math.abs(change).toLocaleString()}`, x + width - 2, contentY + height - 1.2, {
            align: 'right',
            color: changeColor,
            font: 0.45
        });

        return y + height + 0.3;
    },

    /**
     * Render CPU trends graph
     */
    renderCPUTrends: function (room, visual, x, y) {
        const theme = panels.getPanelTheme('info');
        const width = 20;
        const height = 6;

        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '📊 CPU FLOW',
            level: panels.LEVELS.PASSIVE,
            titleColor: theme.title
        });

        const cpuHistory = guiStats.getHistory(room, 'cpu.used', 50);

        if (cpuHistory.length < 2) {
            visual.text('Collecting data...', x + width / 2, contentY + 2, {
                align: 'center',
                color: '#888888',
                font: 0.5
            });
            return y + height + 0.3;
        }

        const cpuLimit = (room.memory.stats && room.memory.stats.current && room.memory.stats.current.cpu && room.memory.stats.current.cpu.limit) || 100;

        panels.drawGraph(visual, x + 0.5, contentY + 0.5, width - 1, height - 1.5, cpuHistory, {
            lineColor: theme.title,
            gradientColor: theme.accent,
            showGrid: true,
            maxValue: cpuLimit,
            minValue: 0
        });

        return y + height + 0.3;
    }
};
