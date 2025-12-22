const utils = require('utils');
const constants = require('constants');

module.exports = {
    spawn: function (energy) {
        return utils.makeHarvesterBody(energy);
    },

    run: function (creep) {
        // Harvesters stay at their assigned source and harvest
        const source = Game.getObjectById(creep.memory.assignedSource);
        if (!source) return;

        if (creep.store.getFreeCapacity() > 0) {
            if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
                utils.smartMove(creep, source);
            }
        } else {
            // Deposit to nearby container/link or transfer to hauler
            let target = creep.pos.findInRange(FIND_STRUCTURES, 2, {
                filter: s => (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK) &&
                    s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            })[0];

            if (target) {
                if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    utils.smartMove(creep, target);
                }
            } else {
                // If no container/link, drop or wait for hauler
                // Actually, let's have them move to spawn/extension if they have MOVE parts
                target = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
                    filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                });
                if (target) {
                    if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                        utils.smartMove(creep, target);
                    }
                }
            }
        }
    }
};
