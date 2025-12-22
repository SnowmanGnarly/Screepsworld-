const utils = require('utils');

module.exports = {
    spawn: function (energy) {
        return utils.makeRangedBody(energy);
    },

    run: function (creep) {
        const target = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);

        if (target) {
            if (creep.rangedAttack(target) === ERR_NOT_IN_RANGE) {
                creep.moveTo(target, { visualizePathStyle: { stroke: '#ff00ff' } });
            } else {
                // Kite - maintain range 3
                if (creep.pos.getRangeTo(target) < 3) {
                    // Too close, move away
                    const fleePath = PathFinder.search(creep.pos, { pos: target.pos, range: 5 }, {
                        flee: true,
                        maxRooms: 1
                    });
                    if (fleePath.path.length > 0) {
                        creep.moveByPath(fleePath.path);
                    }
                }
            }
        } else {
            // No hostiles - patrol to flags or stay near controller
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
};