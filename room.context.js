module.exports = {
    /**
     * Initializes the Room Context (Brain) for the current tick.
     * This should be called at the start of the loop for every room.
     */
    init: function (room) {
        room.ctx = {}; // The context object attached to the room instance

        // 1. Basic Caching (Game Objects)
        // We use find() once and sift through the results to avoid multiple find calls.
        const allStructures = room.find(FIND_STRUCTURES);
        const myStructures = room.find(FIND_MY_STRUCTURES);

        // Group structures by type for O(1) access
        room.ctx.structures = _.groupBy(allStructures, 'structureType');
        room.ctx.myStructures = _.groupBy(myStructures, 'structureType');

        // Shorthands for common structures
        room.ctx.spawns = room.ctx.myStructures[STRUCTURE_SPAWN] || [];
        room.ctx.extensions = room.ctx.myStructures[STRUCTURE_EXTENSION] || [];
        room.ctx.towers = room.ctx.myStructures[STRUCTURE_TOWER] || [];
        room.ctx.links = room.ctx.myStructures[STRUCTURE_LINK] || [];
        room.ctx.storage = room.storage;
        room.ctx.terminal = room.terminal;
        room.ctx.containers = room.ctx.structures[STRUCTURE_CONTAINER] || [];
        room.ctx.walls = room.ctx.structures[STRUCTURE_WALL] || [];
        room.ctx.ramparts = room.ctx.structures[STRUCTURE_RAMPART] || [];
        room.ctx.roads = room.ctx.structures[STRUCTURE_ROAD] || [];

        // Sources & Minerals
        room.ctx.sources = room.find(FIND_SOURCES);
        room.ctx.mineral = room.find(FIND_MINERALS)[0];
        room.ctx.constructionSites = room.find(FIND_CONSTRUCTION_SITES);
        room.ctx.droppedResources = room.find(FIND_DROPPED_RESOURCES);
        room.ctx.tombstones = room.find(FIND_TOMBSTONES);
        room.ctx.ruins = room.find(FIND_RUINS);

        // Creeps
        room.ctx.creeps = room.find(FIND_MY_CREEPS);
        room.ctx.hostiles = room.find(FIND_HOSTILE_CREEPS);

        // 2. Computed Logic (The "Brain")

        // Threat Assessment
        room.ctx.threat = this.assessThreat(room);

        // Energy Logistics
        room.ctx.energy = {
            // where to get energy from
            sources: room.ctx.sources,
            dropped: room.ctx.droppedResources.filter(r => r.resourceType === RESOURCE_ENERGY && r.amount > 50),
            containers: room.ctx.containers.filter(c => c.store[RESOURCE_ENERGY] > 50),
            storage: (room.storage && room.storage.store[RESOURCE_ENERGY] > 50) ? room.storage : null,
            links: room.ctx.links.filter(l => l.store[RESOURCE_ENERGY] > 0), // simplistic, usually source links

            // where to put energy
            fillTargets: this.getFillTargets(room),
            towerFillTargets: room.ctx.towers.filter(t => t.store.getFreeCapacity(RESOURCE_ENERGY) > 200),
        };

        // Repair Logistics
        room.ctx.repair = {
            urgent: this.getUrgentRepairs(room), // Ramparts/Walls critical
            maintenance: this.getMaintenanceRepairs(room) // Roads/Containers
        };
    },

    assessThreat: function (room) {
        const hostiles = room.ctx.hostiles;
        if (hostiles.length === 0) return { level: 0, hostiles: [] };

        // Simple heuristic: count attack/ranged/heal parts
        let attackPower = 0;
        let healPower = 0;

        hostiles.forEach(c => {
            c.body.forEach(p => {
                if (p.type === ATTACK || p.type === RANGED_ATTACK) attackPower += 1;
                if (p.type === HEAL) healPower += 1;
            });
        });

        // Level 1: Scout (1 part) or harmless
        // Level 3: Squad
        // Level 5: Nuke it from orbit
        let level = 1;
        if (attackPower > 2) level = 2;
        if (attackPower > 10) level = 3;
        if (attackPower > 30) level = 4;
        if (attackPower > 50) level = 5;

        return {
            level,
            hostiles,
            attackPower,
            healPower
        };
    },

    getFillTargets: function (room) {
        // Priority: Spawns > Extensions
        // We return a single flat array, sorted by priority implicitly if we concat
        // But usually finding the closest one is better.
        // For context, we just list valid targets.
        const spawns = room.ctx.spawns.filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
        const extensions = room.ctx.extensions.filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
        return [...spawns, ...extensions];
    },

    getUrgentRepairs: function (room) {
        // Critical ramparts/walls
        // Threshold could be dynamic based on RCL
        const CRITICAL_HITS = 5000;
        return [
            ...room.ctx.ramparts.filter(r => r.hits < CRITICAL_HITS),
            ...room.ctx.walls.filter(w => w.hits < CRITICAL_HITS)
        ];
    },

    getMaintenanceRepairs: function (room) {
        // Roads, Containers
        return [
            ...room.ctx.roads.filter(r => r.hits < r.hitsMax * 0.8),
            ...room.ctx.containers.filter(c => c.hits < c.hitsMax * 0.8)
        ];
    }
};
