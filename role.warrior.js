const utils = require('utils');

module.exports = {
    spawn: function (energy) {
        return utils.makeWarriorBody(energy);
    },

    run: function (creep) {
        const target = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);

        if (target) {
            if (creep.attack(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { visualizePathStyle: { stroke: '#ff0000' } });
            }
        } else {
            // No hostiles - patrol to flags or stay near controller
            const flag = creep.pos.findClosestByRange(FIND_FLAGS);
            if (flag) {
                creep.moveTo(flag, { visualizePathStyle: { stroke: '#ffaa00' } });
            } else {
                // Patrol near controller
                if (!creep.pos.inRangeTo(creep.room.controller, 5)) {
                    creep.moveTo(creep.room.controller);
                }
            }
        }
    }
};