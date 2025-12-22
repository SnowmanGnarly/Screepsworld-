// GUI Creeps Panel - Role Dashboard
const panels = require('gui.panels');
const constants = require('constants');

module.exports = {
    render: function (room, visual, x, y) {
        const stats = room.memory.stats && room.memory.stats.current && room.memory.stats.current.creeps;
        if (!stats) return y;

        const theme = panels.getPanelTheme('primary');
        const roleInfo = room.memory.roleInfo || {};
        const roles = Object.keys(stats);

        const width = 11;
        const height = 2 + roles.length * 0.9;

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '👥 POPULATION',
            level: panels.LEVELS.INFO,
            titleColor: theme.title
        });

        let lineY = contentY + 0.4;

        roles.forEach(role => {
            const roleStats = stats[role];
            const required = (roleInfo[role] && roleInfo[role].requiredNumber) || constants[`MAX_${role.toUpperCase()}S`] || 0;
            const current = roleStats.count;
            const percentage = required > 0 ? Math.min(current / required, 1) : (current > 0 ? 1 : 0);

            // Role label (shorter)
            const label = role.charAt(0).toUpperCase() + role.slice(1, 4);

            panels.drawProgressBar(visual, x + 0.5, lineY, width - 2.5, 0.5, percentage, {
                fillColor: current < required ? panels.NEON.red : panels.NEON.lime,
                showPercentage: false,
                label: label,
                blocks: 8
            });

            visual.text(current, x + width - 1, lineY + 0.35, {
                align: 'center',
                color: current < required ? panels.NEON.red : panels.NEON.text,
                font: panels.FONT_SCALES.LABEL,
                stroke: panels.NEON.black,
                strokeWidth: 0.05
            });

            lineY += 0.9;
        });

        return y + height + 0.3;
    }
};
