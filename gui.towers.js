// GUI Towers Panel
const panels = require('gui.panels');

module.exports = {
    render: function (room, visual, x, y) {
        const stats = room.memory.stats && room.memory.stats.current && room.memory.stats.current.towers;
        if (!stats || stats.length === 0) return y;

        const theme = panels.getPanelTheme('warning');
        const width = 11;
        const height = Math.max(4, 2 + stats.length * 1.5);

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '🗼 TOWERS',
            backgroundColor: theme.background,
            borderColor: theme.border,
            gradientColor: theme.gradient,
            titleColor: theme.title
        });

        let lineY = contentY + 0.5;

        // Display each tower
        stats.forEach(function (tower, index) {
            visual.text(`Tower ${index + 1}:`, x + 0.5, lineY, {
                align: 'left',
                color: '#00d4ff',
                font: 0.5
            });

            // Energy bar
            panels.drawProgressBar(visual, x + 0.5, lineY + 0.3, width - 1, 0.6, tower.percentage, {
                fillColor: panels.getStatusColor(tower.percentage),
                showPercentage: false
            });

            // Energy amount
            visual.text(`${tower.energy}/${tower.energyCapacity}`, x + width - 0.5, lineY + 0.6, {
                align: 'right',
                color: '#ffffff',
                font: 0.4
            });

            lineY += 1.5;
        });

        // Summary stats
        const totalEnergy = stats.reduce(function (sum, t) { return sum + t.energy; }, 0);
        const totalCapacity = stats.reduce(function (sum, t) { return sum + t.energyCapacity; }, 0);
        const avgPercentage = totalCapacity > 0 ? totalEnergy / totalCapacity : 0;

        visual.text(`Total: ${totalEnergy.toLocaleString()}`, x + width / 2, lineY, {
            align: 'center',
            color: panels.getStatusColor(avgPercentage),
            font: 0.45,
            stroke: '#000000',
            strokeWidth: 0.05
        });

        return y + height + 0.3;
    }
};
