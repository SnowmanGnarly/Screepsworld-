const constants = require('constants');
const utils = require('utils');

/**
 * Determine the optimal source ID to assign to a newly spawned harvester.
 */
function assignHarvesterSource(room, harvesters) {
    const sources = room.ctx.sources; // Use Context!
    let bestSourceId = null;
    let leastAssigned = Infinity;

    for (const source of sources) {
        const assignedCount = harvesters.filter(c => c.memory.assignedSource === source.id).length;
        const capacity = constants.SOURCE_CAPACITY[source.id] || 1;
        if (assignedCount < capacity && assignedCount < leastAssigned) {
            leastAssigned = assignedCount;
            bestSourceId = source.id;
        }
    }
    return bestSourceId;
}

module.exports = {
    run: function () {
        for (const spawnName in Game.spawns) {
            this.manageSpawn(Game.spawns[spawnName]);
        }
    },

    manageSpawn: function (spawn) {
        if (spawn.spawning) {
            const spawningCreep = Game.creeps[spawn.spawning.name];
            const role = (spawningCreep && spawningCreep.memory) ? spawningCreep.memory.role : null;
            const symbol = constants.ROLE_SYMBOLS[role] || '🛠️';
            spawn.room.visual.text(symbol + ' ' + (role || '???'),
                spawn.pos.x + 1, spawn.pos.y, { align: 'left', opacity: 0.8 });
            return;
        }

        const room = spawn.room;
        if (!room.ctx) return; // Wait for context init

        // 1. Census (Optimization: scan from Context, not find())
        const creeps = room.ctx.creeps;
        const creepsByRole = _.groupBy(creeps, c => c.memory.role);
        const count = role => (creepsByRole[role] || []).length;

        // 2. Determine Needs (Priority Queue)
        const queue = [];

        // Emergency / Military
        const threatLevel = room.ctx.threat.level;
        if (threatLevel > 0) {
            if (count(constants.ROLE_WARRIOR) < 2) queue.push(constants.ROLE_WARRIOR);
            // More logic for defenders could go here
        }

        // Economy - Critical
        if (count(constants.ROLE_HARVESTER) < 1) queue.push(constants.ROLE_HARVESTER);
        else if (count(constants.ROLE_HAULER) < 1) queue.push(constants.ROLE_HAULER);

        // Economy - Normal
        else {
            if (count(constants.ROLE_HARVESTER) < constants.MAX_HARVESTERS) queue.push(constants.ROLE_HARVESTER);
            else if (count(constants.ROLE_HAULER) < constants.MAX_HAULERS) queue.push(constants.ROLE_HAULER);
            else if (count(constants.ROLE_UPGRADER) < constants.MAX_UPGRADERS) queue.push(constants.ROLE_UPGRADER);
            else if (count(constants.ROLE_BUILDER) < constants.MAX_BUILDERS) queue.push(constants.ROLE_BUILDER);
        }

        // 3. Spawning
        if (queue.length > 0) {
            const roleToSpawn = queue[0];
            const energy = room.energyAvailable;

            // Wait for full energy?
            // If critical (0 harvesters), spawn immediately with what we have.
            const isCritical = (roleToSpawn === constants.ROLE_HARVESTER && count(constants.ROLE_HARVESTER) === 0) ||
                (roleToSpawn === constants.ROLE_HAULER && count(constants.ROLE_HAULER) === 0);

            if (isCritical || energy >= constants.SPAWN_ENERGY_WAIT_THRESHOLD || energy >= room.energyCapacityAvailable) {
                let extraMem = {};
                if (roleToSpawn === constants.ROLE_HARVESTER) {
                    extraMem.assignedSource = assignHarvesterSource(room, creepsByRole[constants.ROLE_HARVESTER] || []);
                }
                this.spawnCreep(spawn, roleToSpawn, energy, extraMem);
            }
        }
    },

    spawnCreep: function (spawn, role, energy, extraMemory = {}) {
        let body;
        if (role === constants.ROLE_HARVESTER) body = utils.makeHarvesterBody(energy);
        else if (role === constants.ROLE_HAULER) body = utils.makeHaulerBody(energy);
        else if (role === constants.ROLE_WARRIOR) body = utils.makeWarriorBody(energy);
        else body = utils.makeWorkerBody(energy); // Builder/Upgrader

        const name = role + Game.time + '_' + Math.floor(Math.random() * 100);
        const result = spawn.spawnCreep(body, name, { memory: { role, ...extraMemory } });

        if (result === OK) {
            console.log(`✅ [Spawn] ${role} spawned in ${spawn.room.name} with ${body.length} parts`);
        }
        return result;
    }
};