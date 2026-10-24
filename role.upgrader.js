const utils = require('utils');

module.exports = {
    spawn: function (energy) {
        return utils.makeWorkerBody(energy);
    },

    run: function (creep) {
        if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.upgrading = false;
        }
        if (!creep.memory.upgrading && creep.store.getFreeCapacity() === 0) {
            creep.memory.upgrading = true;
        }

        if (creep.memory.upgrading) {
            // Upgraders simply upgrade
            // We could add a check for taskManager 'fill_critical' here if we wanted them to emergency fill
            if (creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
                utils.smartMove(creep, creep.room.controller);
            }
        } else {
            // Improve withdraw logic: Storage > Link (Controller link) > Container > Source
            const ctx = creep.room.ctx;
            let target = null;

            // 1. Controller Link? (Not in ctx explicitly yet, but generic link check)
            // ...

            // 2. Storage
            if (!target && ctx.storage && ctx.storage.store[RESOURCE_ENERGY] > 0) {
                target = ctx.storage;
            }

            // 3. Container
            else if (ctx.containers.length > 0) {
                target = creep.pos.findClosestByRange(ctx.containers, {
                    filter: c => c.store[RESOURCE_ENERGY] > 0
                });
            }

            // 4. Fallback Source
            else {
                target = creep.pos.findClosestByRange(ctx.sources);
                if (target instanceof Source) {
                    if (creep.harvest(target) === ERR_NOT_IN_RANGE) utils.smartMove(creep, target);
                    return;
                }
            }

            if (target) {
                if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    utils.smartMove(creep, target);
                }
            }
        }
    }
};
