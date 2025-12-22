const utils = require('utils');
const taskManager = require('task.manager');

module.exports = {
    spawn: function (energy) {
        return utils.makeWorkerBody(energy);
    },

    run: function (creep) {
        if (creep.memory.working && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.working = false;
        }
        if (!creep.memory.working && creep.store.getFreeCapacity() === 0) {
            creep.memory.working = true;
        }

        if (creep.memory.working) {
            const task = taskManager.getTaskForRole(creep, 'builder');
            const ctx = creep.room.ctx;

            if (task === 'repair_critical') {
                const target = creep.pos.findClosestByRange(ctx.repair.urgent);
                if (target) {
                    if (creep.repair(target) === ERR_NOT_IN_RANGE) utils.smartMove(creep, target);
                    return;
                }
            }

            if (task === 'build') {
                const target = creep.pos.findClosestByRange(ctx.constructionSites);
                if (target) {
                    if (creep.build(target) === ERR_NOT_IN_RANGE) utils.smartMove(creep, target);
                    return;
                }
            }

            if (task === 'repair_maintenance') {
                const target = creep.pos.findClosestByRange(ctx.repair.maintenance);
                if (target) {
                    if (creep.repair(target) === ERR_NOT_IN_RANGE) utils.smartMove(creep, target);
                    return;
                }
            }

            // Fallback: Upgrade
            if (creep.upgradeController(creep.room.controller) === ERR_NOT_IN_RANGE) {
                utils.smartMove(creep, creep.room.controller);
            }

        } else {
            // Withdraw logic: Storage > Container > Source
            const ctx = creep.room.ctx;
            let target = null;

            if (ctx.storage && ctx.storage.store[RESOURCE_ENERGY] > 0) {
                target = ctx.storage;
            } else if (ctx.containers.length > 0) {
                target = creep.pos.findClosestByRange(ctx.containers, {
                    filter: c => c.store[RESOURCE_ENERGY] > 0
                });
            } else {
                // Early game fallback: Harvest
                target = creep.pos.findClosestByRange(ctx.sources);
                if (target) {
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
