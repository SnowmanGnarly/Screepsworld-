const constants = require('constants');

module.exports = {
    run() {
        for (const room of Object.values(Game.rooms)) {
            // Context must have been initialized in main.js
            if (room.ctx) this.runRoom(room);
        }
    },

    runRoom(room) {
        const towers = room.ctx.towers.filter(t => t.store[RESOURCE_ENERGY] > 0);
        if (towers.length === 0) return;

        // 1. Attack Hostiles (High Priority)
        // room.ctx.hostiles is already cached.
        const hostiles = room.ctx.hostiles;
        if (hostiles.length > 0) {
            // Simple logic: closest hostile to each tower, or focus fire?
            // Focus fire is better, but simple closest is fine for now.
            for (const tower of towers) {
                const target = tower.pos.findClosestByRange(hostiles);
                if (target) tower.attack(target);
            }
            return; // If attacking, don't do anything else
        }

        // 2. Heal Friendly Creeps
        // check for damaged creeps
        // We can optimize this by caching damaged creeps in ctx if needed, but filtering ctx.creeps is fast enough usually.
        const damagedCreeps = room.ctx.creeps.filter(c => c.hits < c.hitsMax);
        if (damagedCreeps.length > 0) {
            for (const tower of towers) {
                const target = tower.pos.findClosestByRange(damagedCreeps);
                if (target) tower.heal(target);
            }
            return;
        }

        // 3. Repair (Urgent only) - Ramparts/Walls
        // Use the Context's urgent list (computed once per room)
        const urgentRepairs = room.ctx.repair.urgent;
        if (urgentRepairs.length > 0) {
            for (const tower of towers) {
                // Sort by lowest hits to maintain walls evenly
                // Optimization: sort once outside the loop?
                // urgentRepairs is shared, so let's just pick one.
                // To avoid all towers hitting the same wall (overkill), maybe random or spread?
                // Simple closest is usually fine.

                // If tower has good energy, repair.
                if (tower.store[RESOURCE_ENERGY] > 400) {
                    // Find closest urgent repair - doing a sort or findClosest is okay here as list should be small
                    const target = tower.pos.findClosestByRange(urgentRepairs);
                    if (target) tower.repair(target);
                }
            }
            // We don't return here, we might want to do other repairs if we have spare towers? 
            // Usually repairs consume all action.
            return;
        }

        // 4. Maintenance (Roads/Containers) - Low Priority
        // Only if tower is full
        const maintenance = room.ctx.repair.maintenance;
        if (maintenance.length > 0) {
            for (const tower of towers) {
                if (tower.store[RESOURCE_ENERGY] > 600) {
                    const target = tower.pos.findClosestByRange(maintenance);
                    if (target) tower.repair(target);
                }
            }
        }
    }
};