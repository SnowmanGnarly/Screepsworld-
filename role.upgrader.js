const utils = require('utils');
const constants = require('constants');

module.exports = {
    spawn: function (energy) {
        return utils.makeWorkerBody(energy); // Upgraders use worker bodies
    },

    run: function (creep) {
        if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.upgrading = false;
        }
        if (!creep.memory.upgrading && creep.store.getFreeCapacity() === 0) {
            creep.memory.upgrading = true;
        }

        if (creep.memory.upgrading) {
            if (creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
                utils.smartMove(creep, creep.room.controller);
            }
        } else {
            // Get energy from storage/container
            const target = creep.pos.findClosestByRange(FIND_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER) &&
                    s.store[RESOURCE_ENERGY] > 0
            });
            if (target) {
                if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    utils.smartMove(creep, target);
                }
            } else {
                // Fallback to sources if no storage
                const source = utils.getEnergySource(creep);
                if (source) {
                    if (source instanceof Resource) creep.pickup(source);
                    else creep.withdraw(source, RESOURCE_ENERGY);
                    utils.smartMove(creep, source);
                }
            }
        }
    }
};
