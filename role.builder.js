const utils = require('utils');
const constants = require('constants');

module.exports = {
    spawn: function (energy) {
        return utils.makeWorkerBody(energy); // Builders use worker bodies
    },

    run: function (creep) {
        if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.building = false;
        }
        if (!creep.memory.building && creep.store.getFreeCapacity() === 0) {
            creep.memory.building = true;
        }

        if (creep.memory.building) {
            // Priority: Repair (if needed) > Construction
            let target = creep.pos.findClosestByRange(FIND_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_RAMPART || s.structureType === STRUCTURE_WALL) &&
                    s.hits < 5000 // Quick patch
            });

            if (!target) {
                const sites = utils.getCachedConstructionSites(creep.room);
                if (sites.length > 0) target = creep.pos.findClosestByRange(sites);
            }

            if (target) {
                if (target instanceof ConstructionSite) {
                    if (creep.build(target) === ERR_NOT_IN_RANGE) utils.smartMove(creep, target);
                } else {
                    if (creep.repair(target) === ERR_NOT_IN_RANGE) utils.smartMove(creep, target);
                }
            } else {
                // If nothing to build/repair, help upgrade
                if (creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
                    utils.smartMove(creep, creep.room.controller);
                }
            }
        } else {
            const target = creep.pos.findClosestByRange(FIND_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER) &&
                    s.store[RESOURCE_ENERGY] > 0
            });
            if (target) {
                if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    utils.smartMove(creep, target);
                }
            }
        }
    }
};
