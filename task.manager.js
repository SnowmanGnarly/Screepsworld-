module.exports = {
    /**
     * Updates the task priorities for the room based on the current context.
     * This should be called after RoomContext.init() and before roles run.
     */
    run: function (room) {
        if (!room.ctx) return;

        const ctx = room.ctx;
        const tasks = [];

        // 1. Critical Survival Tasks
        if (ctx.threat.level > 0) {
            tasks.push('defense'); // Manning ramparts, attacking
        }

        // Emergency Energy: Spawns/Extensions empty
        const energyAvailable = room.energyAvailable;
        const energyCapacity = room.energyCapacityAvailable;
        const vitalStructures = ctx.energy.fillTargets.length > 0;

        if (vitalStructures && energyAvailable < energyCapacity * 0.5) {
            tasks.push('fill_critical');
        }

        // 2. Defense Maintenance
        const towersLow = ctx.energy.towerFillTargets.length > 0;
        if (towersLow) {
            tasks.push('fill_tower');
        }

        if (ctx.repair.urgent.length > 0) {
            tasks.push('repair_critical');
        }

        // 3. Economic Tasks
        if (vitalStructures) { // Remaining fill targets
            tasks.push('fill_spawn');
        }

        // Construction
        if (ctx.constructionSites.length > 0) {
            tasks.push('build');
        }

        // Upgrading (Always a fallback, but priority varies)
        // If storage is high, upgrade is high priority to avoid cap
        if (ctx.storage && ctx.storage.store[RESOURCE_ENERGY] > 500000) {
            tasks.unshift('upgrade_focus'); // Boost upgrade priority
        } else {
            tasks.push('upgrade');
        }

        // Repair (Non-critical)
        if (ctx.repair.maintenance.length > 0) {
            tasks.push('repair_maintenance');
        }

        room.ctx.tasks = tasks;
    },

    /**
     * Helper to get the most important task for a creep role
     */
    getTaskForRole: function (creep, role) {
        const tasks = creep.room.ctx.tasks || [];

        // Mapping roles to allowed tasks
        if (role === 'hauler') {
            if (tasks.includes('fill_critical')) return 'fill_critical';
            if (tasks.includes('fill_tower')) return 'fill_tower';
            if (tasks.includes('fill_spawn')) return 'fill_spawn';
            return 'haul_storage'; // Default
        }

        if (role === 'builder') {
            if (tasks.includes('repair_critical')) return 'repair_critical';
            if (tasks.includes('build')) return 'build';
            if (tasks.includes('repair_maintenance')) return 'repair_maintenance';
            return 'upgrade'; // Fallback
        }

        if (role === 'upgrader') {
            // Upgraders mostly upgrade, but can help with critical repairs?
            // Usually just upgrade.
            if (tasks.includes('fill_critical') && creep.room.energyAvailable < 300) return 'fill_critical'; // Desperation
            return 'upgrade';
        }

        return 'idle';
    }
};
