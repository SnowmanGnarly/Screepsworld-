const utils = require('utils');
const constants = require('constants');

module.exports = {
    spawn: function (energy) {
        return utils.makeHaulerBody(energy);
    },

    run: function (creep) {
        if (creep.store[RESOURCE_ENERGY] === 0) {
            // Fetch energy: Only from structures/ground (Haulers don't mine)
            let target = creep.pos.findClosestByRange(FIND_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_LINK) &&
                    s.store[RESOURCE_ENERGY] > 50
            });

            // Fallback: Check for dropped energy
            if (!target) {
                target = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
                    filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 50
                });
            }

            if (target) {
                if (target instanceof Resource) {
                    if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
                        utils.smartMove(creep, target);
                    } else {
                        creep.memory.lastSource = 'dropped';
                    }
                } else {
                    if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                        utils.smartMove(creep, target);
                    } else {
                        creep.memory.lastSource = (target.structureType === STRUCTURE_STORAGE) ? 'storage' : 'container';
                    }
                }
            }
        } else {
            // Priority 1: Spawn/Extension (Core Power)
            let target = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                    s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            });

            // Priority 2: Towers (Defense)
            if (!target) {
                target = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
                    filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > 200
                });
            }

            // Priority 3: Storage (Only if energy was NOT taken from storage)
            if (!target && creep.memory.lastSource !== 'storage') {
                target = creep.room.storage;
                if (target && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) target = null;
            }

            if (target) {
                if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    utils.smartMove(creep, target);
                }
            }
        }
    }
};
