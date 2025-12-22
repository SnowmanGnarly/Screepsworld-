// GUI Spawn Queue Panel
const panels = require('gui.panels');

module.exports = {
    render: function (room, visual, x, y) {
        const theme = panels.getPanelTheme('info');
        const width = 11;
        const height = 5;

        // Draw panel
        const contentY = panels.drawPanel(visual, x, y, width, height, {
            title: '🏭 SPAWN',
            backgroundColor: theme.background,
            borderColor: theme.border,
            gradientColor: theme.gradient,
            titleColor: theme.title
        });

        // Find spawns in room
        const spawns = room.find(FIND_MY_SPAWNS);

        if (spawns.length === 0) {
            visual.text('No spawns', x + width / 2, contentY + 2, {
                align: 'center',
                color: '#ff4444',
                font: 0.5
            });
            return y + height + 0.3;
        }

        const spawn = spawns[0]; // Use first spawn

        if (spawn.spawning) {
            const spawningCreep = Game.creeps[spawn.spawning.name];
            const progress = spawn.spawning.needTime > 0
                ? (spawn.spawning.needTime - spawn.spawning.remainingTime) / spawn.spawning.needTime
                : 0;

            // Spawning creep info
            visual.text(`🛠️ Spawning: ${spawningCreep.memory.role}`, x + 0.5, contentY + 0.7, {
                align: 'left',
                color: '#00d4ff',
                font: 0.5
            });

            // Progress bar
            panels.drawProgressBar(visual, x + 0.5, contentY + 1.2, width - 1, 0.7, progress, {
                fillColor: '#00ff88',
                gradientColor: '#00d4ff',
                showPercentage: true
            });

            // Time remaining
            visual.text(`ETA: ${spawn.spawning.remainingTime} ticks`, x + width / 2, contentY + 2.5, {
                align: 'center',
                color: '#ffffff',
                font: 0.45
            });

            // Energy cost
            const bodyCost = spawningCreep.body.reduce(function (sum, part) {
                return sum + BODYPART_COST[part.type];
            }, 0);
            visual.text(`Cost: ${bodyCost} energy`, x + width / 2, contentY + 3.2, {
                align: 'center',
                color: '#ffaa00',
                font: 0.4
            });
        } else {
            // Idle
            visual.text('✅ Ready', x + width / 2, contentY + 1.5, {
                align: 'center',
                color: '#00ff88',
                font: 0.6,
                stroke: '#000000',
                strokeWidth: 0.05
            });

            // Energy available
            const energyPct = room.energyCapacityAvailable > 0
                ? room.energyAvailable / room.energyCapacityAvailable
                : 0;

            visual.text(`Energy: ${room.energyAvailable}/${room.energyCapacityAvailable}`,
                x + width / 2, contentY + 2.5, {
                align: 'center',
                color: panels.getStatusColor(energyPct),
                font: 0.45
            });
        }

        return y + height + 0.3;
    }
};
