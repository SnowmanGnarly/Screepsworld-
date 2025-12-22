const utils = require('utils');

module.exports = {
    spawn: function (energy) {
        return utils.makeHealerBody(energy);
    },

    run: function (creep) {
        // Find wounded friendly creeps
        const target = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: function (c) {
                return c.hits < c.hitsMax;
            }
        });

        if (target) {
            if (creep.heal(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { visualizePathStyle: { stroke: '#00ff00' } });
            }
        } else {
            // No wounded - follow warriors
            const warrior = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
                filter: function (c) {
                    return c.memory.role === 'warrior' || c.memory.role === 'ranged';
                }
            });

            if (warrior) {
                if (!creep.pos.inRangeTo(warrior, 3)) {
                    creep.moveTo(warrior, { visualizePathStyle: { stroke: '#00ff00' } });
                }
            } else {
                // No military - patrol to flags or stay near controller
                const flag = creep.pos.findClosestByRange(FIND_FLAGS);
                if (flag) {
                    creep.moveTo(flag, { visualizePathStyle: { stroke: '#ffaa00' } });
                } else {
                    if (!creep.pos.inRangeTo(creep.room.controller, 5)) {
                        creep.moveTo(creep.room.controller);
                    }
                }
            }
        }
    }
};