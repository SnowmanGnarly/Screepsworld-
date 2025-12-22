const constants = require('constants');
const utils = require('utils');

/**
 * Determine the optimal source ID to assign to a newly spawned harvester.
 */
function assignHarvesterSource(room, harvesters) {
    const sources = utils.getCachedSources(room);
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

        const roomCreeps = spawn.room.find(FIND_MY_CREEPS);
        const creepsByRole = _.groupBy(roomCreeps, c => c.memory.role);

        const count = role => (creepsByRole[role] || []).length;

        // Threat Check
        const stats = (spawn.room.memory.stats && spawn.room.memory.stats.current) ? spawn.room.memory.stats.current.threats : null;
        const inDanger = stats && (stats.threatLevel === 'danger' || stats.threatLevel === 'warning');

        // 1. Emergency Defense
        if (inDanger && count(constants.ROLE_WARRIOR) < 2) {
            this.spawnCreep(spawn, constants.ROLE_WARRIOR, spawn.room.energyAvailable);
            return;
        }

        // 2. Critical Recovery: Harvesters and Haulers must exist
        if (count(constants.ROLE_HARVESTER) === 0 && spawn.room.energyAvailable >= 200) {
            const sourceId = assignHarvesterSource(spawn.room, creepsByRole[constants.ROLE_HARVESTER] || []);
            this.spawnCreep(spawn, constants.ROLE_HARVESTER, spawn.room.energyAvailable, { assignedSource: sourceId });
            return;
        }

        if (count(constants.ROLE_HAULER) === 0 && spawn.room.energyAvailable >= 200) {
            this.spawnCreep(spawn, constants.ROLE_HAULER, spawn.room.energyAvailable);
            return;
        }

        // 3. Normal specialized spawning
        const roles = [
            { name: constants.ROLE_HARVESTER, limit: constants.MAX_HARVESTERS },
            { name: constants.ROLE_HAULER, limit: constants.MAX_HAULERS },
            { name: constants.ROLE_UPGRADER, limit: constants.MAX_UPGRADERS },
            { name: constants.ROLE_BUILDER, limit: constants.MAX_BUILDERS }
        ];

        for (const roleDef of roles) {
            if (count(roleDef.name) < roleDef.limit) {
                const energy = spawn.room.energyAvailable;
                if (energy >= spawn.room.energyCapacityAvailable || energy >= constants.SPAWN_ENERGY_WAIT_THRESHOLD) {
                    let extraMem = {};
                    if (roleDef.name === constants.ROLE_HARVESTER) {
                        extraMem.assignedSource = assignHarvesterSource(spawn.room, creepsByRole[constants.ROLE_HARVESTER] || []);
                    }
                    this.spawnCreep(spawn, roleDef.name, energy, extraMem);
                    return;
                }
                break; // Wait for energy for this specific role before checking next
            }
        }
    },

    spawnCreep: function (spawn, role, energy, extraMemory = {}) {
        let body;
        if (role === constants.ROLE_HARVESTER) body = utils.makeHarvesterBody(energy);
        else if (role === constants.ROLE_HAULER) body = utils.makeHaulerBody(energy);
        else if (role === constants.ROLE_WARRIOR) body = utils.makeWarriorBody(energy);
        else body = utils.makeWorkerBody(energy);

        const name = role + Game.time;
        const result = spawn.spawnCreep(body, name, { memory: { role, ...extraMemory } });
        if (result === OK) console.log(`✅ [Spawn] ${role} spawned in ${spawn.room.name}`);
        return result;
    }
};