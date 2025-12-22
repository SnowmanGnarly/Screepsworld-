// gui.renderer.js - Main orchestrator for all GUI panels (REWORKED LAYOUT)
const guiCPU = require('gui.cpu');
const guiResources = require('gui.resources');
const guiCreeps = require('gui.creeps');
const guiSpawn = require('gui.spawn');
const guiTowers = require('gui.towers');
const guiConstruction = require('gui.construction');
const guiThreats = require('gui.threats');
const guiSources = require('gui.sources');
const guiGraphs = require('gui.graphs');
const panels = require('gui.panels');

module.exports = {
    run(room) {
        const visual = new RoomVisual(room.name);

        // Draw overall backdrop
        panels.drawBackdrop(visual);

        this.renderTopBars(room, visual);
        this.renderMainPanels(room, visual);
    },

    renderTopBars(room, visual) {
        const energyPct = room.energyCapacityAvailable > 0
            ? room.energyAvailable / room.energyCapacityAvailable
            : 0;

        // Energy bar
        visual.rect(0, 0, 49, 0.5, { fill: '#0b1020', opacity: 0.65 });
        if (energyPct > 0) {
            visual.rect(0, 0, 49 * energyPct, 0.5, { fill: '#00ffcc', opacity: 0.55 });
            visual.rect(0, 0, 49 * energyPct, 0.5, { fill: '#00d4ff', opacity: 0.18 });
        }
        visual.text(`⚡ ${room.energyAvailable}/${room.energyCapacityAvailable}`, 24.5, 0.4, {
            align: 'center', color: '#ffffff', font: 0.4, stroke: '#000000', strokeWidth: 0.1
        });

        // RCL bar
        if (room.controller && room.controller.my) {
            const rclPct = room.controller.progressTotal > 0
                ? room.controller.progress / room.controller.progressTotal
                : 0;

            visual.rect(0, 0.5, 49, 0.5, { fill: '#0b1020', opacity: 0.65 });
            if (rclPct > 0) {
                visual.rect(0, 0.5, 49 * rclPct, 0.5, { fill: '#7c4dff', opacity: 0.55 });
                visual.rect(0, 0.5, 49 * rclPct, 0.5, { fill: '#00d4ff', opacity: 0.18 });
            }
            const rclText = `RCL ${room.controller.level} - ${(rclPct * 100).toFixed(1)}%`;
            visual.text(rclText, 24.5, 0.9, {
                align: 'center', color: '#ffffff', font: 0.4, stroke: '#000000', strokeWidth: 0.1
            });
        }
    },

    renderMainPanels(room, visual) {
        // === Layout constants (ONLY change these to move everything) ===
        const MARGIN_X = 0.5;
        const TOP_Y = 1.4;
        const GAP_Y = 0.35;

        // Left “stack” (keeps map visible)
        const LEFT_X = MARGIN_X;

        // Right “stack” (near right edge but not over exit buttons)
        const RIGHT_X = 49 - 11.5 - 0.5; // creep panel width ~11

        // Bottom “wide” panels
        const BOTTOM_Y = 49 - 9.3; // reserve bottom space
        const WIDE_X = MARGIN_X;

        // === LEFT COLUMN: CPU -> SPAWN -> TOWERS -> THREATS ===
        let yLeft = TOP_Y;
        yLeft = guiCPU.render(room, visual, LEFT_X, yLeft) + GAP_Y;
        yLeft = guiSpawn.render(room, visual, LEFT_X, yLeft) + GAP_Y;
        yLeft = guiTowers.render(room, visual, LEFT_X, yLeft) + GAP_Y;
        yLeft = guiThreats.render(room, visual, LEFT_X, yLeft) + GAP_Y;

        // === RIGHT COLUMN: RESOURCES -> CREEPS -> MINING ===
        let yRight = TOP_Y;
        yRight = guiResources.render(room, visual, RIGHT_X, yRight) + GAP_Y;
        yRight = guiCreeps.render(room, visual, RIGHT_X, yRight) + GAP_Y;
        yRight = guiSources.render(room, visual, RIGHT_X, yRight) + GAP_Y;

        // === MIDDLE: Construction (only if exists) ===
        let yMiddle = Math.max(yLeft, yRight) + GAP_Y;
        const constructionStats = room.memory && room.memory.stats && room.memory.stats.current && room.memory.stats.current.construction;
        if (constructionStats && constructionStats.length > 0) {
            yMiddle = guiConstruction.render(room, visual, WIDE_X, yMiddle) + GAP_Y;
        }

        // === BOTTOM: Energy Trends (wide) ===
        const history = room.memory && room.memory.stats && room.memory.stats.history;
        if (history && history.length >= 10) {
            guiGraphs.render(room, visual, WIDE_X, BOTTOM_Y);
        }
    }
};
