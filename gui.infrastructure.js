// GUI Infrastructure Panel - Merged Spawn & Towers
const panels = require('gui.panels');

module.exports = {
    render: function (room, visual, x, y) {
        const theme = panels.getPanelTheme('primary');
        const spawnStats = room.find(FIND_MY_SPAWNS);
        const towerStats = room.memory.stats && room.memory.stats.current && room.memory.stats.current.towers;

        const width = 11;
        const height = 3 + (spawnStats.length > 0 && spawnStats[0].spawning ? 2.5 : 1) +
            (towerStats && towerStats.length > 0 ? (towerStats.length * 1.2) : 0);

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '⚙️ INFRASTRUCTURE',
            level: panels.LEVELS.IMPORTANT,
            titleColor: theme.title,
            borderColor: theme.border
        });

        let lineY = contentY + 0.4;

        // 1. Spawn Section
        if (spawnStats.length > 0) {
            const spawn = spawnStats[0];
            if (spawn.spawning) {
                const spawningCreep = Game.creeps[spawn.spawning.name];
                const progress = (spawn.spawning.needTime - spawn.spawning.remainingTime) / spawn.spawning.needTime;

                visual.text(`🛠️ ${spawningCreep.memory.role || '???'}:`, x + 0.5, lineY, {
                    align: 'left',
                    color: panels.NEON.cyan,
                    font: panels.FONT_SCALES.SMALL
                });

                panels.drawProgressBar(visual, x + 0.5, lineY + 0.2, width - 1, 0.5, progress, {
                    fillColor: panels.NEON.lime,
                    showPercentage: true
                });
                lineY += 1.2;
            } else {
                visual.text(`Spawn:`, x + 0.5, lineY, {
                    align: 'left',
                    color: panels.NEON.cyan,
                    font: panels.FONT_SCALES.SMALL
                });
                visual.text(`READY`, x + width - 0.5, lineY, {
                    align: 'right',
                    color: panels.NEON.lime,
                    font: panels.FONT_SCALES.SMALL
                });
                lineY += 0.6;
            }

            const energyPct = room.energyCapacityAvailable > 0 ? room.energyAvailable / room.energyCapacityAvailable : 0;
            visual.text(`Energy: ${room.energyAvailable}/${room.energyCapacityAvailable}`, x + width / 2, lineY, {
                align: 'center',
                color: panels.getStatusColor(energyPct),
                font: panels.FONT_SCALES.SMALL
            });
            lineY += 0.8;
        }

        // 2. Tower Section
        if (towerStats && towerStats.length > 0) {
            visual.line(x + 1, lineY - 0.2, x + width - 1, lineY - 0.2, { color: theme.border, opacity: 0.3 });
            lineY += 0.4;

            visual.text(`Towers:`, x + 0.5, lineY, {
                align: 'left',
                color: panels.NEON.cyan,
                font: panels.FONT_SCALES.SMALL
            });
            lineY += 0.6;

            towerStats.forEach((tower, idx) => {
                panels.drawProgressBar(visual, x + 0.5, lineY, width - 1, 0.4, tower.percentage, {
                    fillColor: panels.getStatusColor(tower.percentage),
                    showPercentage: false,
                    label: `T${idx + 1}`
                });
                lineY += 0.6;
            });
        }

        return y + height + 0.3;
    }
};
