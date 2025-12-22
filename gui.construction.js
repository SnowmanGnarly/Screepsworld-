// GUI Construction Panel
const panels = require('gui.panels');

module.exports = {
    render: function (room, visual, x, y) {
        const stats = room.memory.stats && room.memory.stats.current && room.memory.stats.current.construction;
        if (!stats || stats.length === 0) return y;

        const theme = panels.getPanelTheme('info');
        const width = 20;
        const height = Math.max(4, 2 + stats.length * 1.3);

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '🔨 CONSTRUCTION',
            level: panels.LEVELS.INFO,
            titleColor: theme.title
        });

        let lineY = contentY + 0.5;

        // Display each construction site (max 5 to avoid overflow)
        const displaySites = stats.slice(0, 5);
        const self = this;

        displaySites.forEach(function (site) {
            // Structure type
            const typeIcon = self.getStructureIcon(site.type);
            visual.text(`${typeIcon} ${site.type}:`, x + 0.5, lineY, {
                align: 'left',
                color: '#00d4ff',
                font: 0.45
            });

            // Progress bar
            panels.drawProgressBar(visual, x + 6, lineY - 0.3, width - 11, 0.6, site.percentage, {
                fillColor: panels.getStatusColor(site.percentage),
                showPercentage: true
            });

            // ETA calculation (rough estimate: 5 BUILD parts working = 25 energy/tick)
            const remaining = site.progressTotal - site.progress;
            const eta = Math.ceil(remaining / 25); // Rough estimate

            visual.text(`ETA: ${eta}t`, x + width - 0.5, lineY, {
                align: 'right',
                color: '#ffaa00',
                font: 0.4
            });

            lineY += 1.3;
        });

        // Show count if more sites exist
        if (stats.length > 5) {
            visual.text(`+${stats.length - 5} more...`, x + width / 2, lineY, {
                align: 'center',
                color: '#888888',
                font: 0.4
            });
        }

        return y + height + 0.3;
    },

    getStructureIcon: function (type) {
        const icons = {};
        icons[STRUCTURE_EXTENSION] = '⚡';
        icons[STRUCTURE_ROAD] = '🛣️';
        icons[STRUCTURE_WALL] = '🧱';
        icons[STRUCTURE_RAMPART] = '🛡️';
        icons[STRUCTURE_TOWER] = '🗼';
        icons[STRUCTURE_STORAGE] = '📦';
        icons[STRUCTURE_CONTAINER] = '📦';
        icons[STRUCTURE_SPAWN] = '🏭';
        icons[STRUCTURE_LINK] = '🔗';
        icons[STRUCTURE_OBSERVER] = '👁️';
        icons[STRUCTURE_LAB] = '🧪';
        icons[STRUCTURE_TERMINAL] = '🏪';
        return icons[type] || '🔨';
    }
};
