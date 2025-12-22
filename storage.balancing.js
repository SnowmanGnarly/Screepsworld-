const utils = require('utils');

/**
 * Balance energy between nearby storage structures when a harvester's source is empty.
 * @param {Creep} creep - The harvester creep
 */
function balanceStorages(creep) {
    // Get the assigned source to determine which storages are "nearby"
    const source = Game.getObjectById(creep.memory.sourceId);
    if (!source) {
        creep.say('💤 wait');
        return;
    }

    // Collect storage structures close to the assigned source (within range 5)
    const nearbyStorages = [];
    const maxRange = 5;

    if (creep.room.storage && source.pos.getRangeTo(creep.room.storage) <= maxRange) {
        nearbyStorages.push(creep.room.storage);
    }

    const containers = creep.room.find(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER &&
            source.pos.getRangeTo(s) <= maxRange
    });
    nearbyStorages.push(...containers);

    if (nearbyStorages.length < 2) {
        // Nothing to balance, just idle
        creep.say('💤 wait');
        return;
    }

    // Check if storages are already balanced (within 50 energy tolerance)
    const energyLevels = nearbyStorages.map(s => s.store[RESOURCE_ENERGY] || 0);
    const maxEnergy = Math.max(...energyLevels);
    const minEnergy = Math.min(...energyLevels);
    const tolerance = 50;

    if (maxEnergy - minEnergy <= tolerance) {
        // Storages are balanced, just wait
        creep.say('✅ equal');
        creep.memory.balancing = false;
        return;
    }

    // State management for balancing
    if (creep.memory.balancing && creep.store[RESOURCE_ENERGY] === 0) {
        creep.memory.balancing = false;
        creep.say('⚖️ get');
    }
    if (!creep.memory.balancing && creep.store.getFreeCapacity() === 0) {
        creep.memory.balancing = true;
        creep.say('⚖️ put');
    }

    if (creep.memory.balancing) {
        // Find emptiest nearby storage (with space)
        const emptiest = nearbyStorages
            .filter(s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0)
            .sort((a, b) => a.store[RESOURCE_ENERGY] - b.store[RESOURCE_ENERGY])[0];

        if (emptiest) {
            if (creep.transfer(emptiest, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                utils.smartMove(creep, emptiest);
            }
        } else {
            // All nearby storages are full, just idle
            creep.memory.balancing = false;
        }
    } else {
        // Find fullest nearby storage (with energy)
        const fullest = nearbyStorages
            .filter(s => s.store[RESOURCE_ENERGY] > 0)
            .sort((a, b) => b.store[RESOURCE_ENERGY] - a.store[RESOURCE_ENERGY])[0];

        if (fullest) {
            if (creep.withdraw(fullest, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                utils.smartMove(creep, fullest);
            }
        } else {
            // No energy in nearby storages to balance
            creep.say('💤 wait');
        }
    }
}

module.exports = {
    balanceStorages
};
