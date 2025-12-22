const utils = require('utils');

module.exports = {
    spawn: function (energy) {
        return utils.makeHaulerBody(energy);
    },

    run: function (creep) {
        // State Machine: Transferring vs Gathering
        if (creep.store.getFreeCapacity() === 0) {
            creep.memory.working = true; // Transferring
        }
        if (creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.working = false; // Gathering
            creep.memory.targetId = null; // Clear target when empty
        }

        if (creep.memory.working) {
            this.handleTransfer(creep);
        } else {
            this.handleGather(creep);
        }
    },

    handleGather: function (creep) {
        // Priority: Dropped > Containers > Storage (if we are strictly sourcing from storage? No, haulers usually move FROM source-containers TO storage)
        // Using Context for pre-cached lists
        const ctx = creep.room.ctx;

        let target = null;
        if (creep.memory.targetId) {
            target = Game.getObjectById(creep.memory.targetId);
            if (!target ||
                (target instanceof Resource && target.amount < 50) ||
                (target.store && target.store[RESOURCE_ENERGY] < 50)) {
                target = null;
                creep.memory.targetId = null;
            }
        }

        if (!target) {
            // Priority 1: Pick up dropped energy (decaying fast!)
            if (ctx.droppedResources.length > 0) {
                target = creep.pos.findClosestByRange(ctx.droppedResources, {
                    filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 50
                });
            }

            // Priority 2: Full Containers (usually near sources)
            if (!target && ctx.containers.length > 0) {
                // Find fullest or closest? Closest helps throughput.
                target = creep.pos.findClosestByRange(ctx.containers, {
                    filter: c => c.store[RESOURCE_ENERGY] > 300
                });
            }

            // Priority 3: Tombstones/Ruins
            if (!target && ctx.tombstones.length > 0) {
                target = creep.pos.findClosestByRange(ctx.tombstones, {
                    filter: t => t.store[RESOURCE_ENERGY] > 50
                });
            }
        }

        if (target) {
            creep.memory.targetId = target.id;
            if (target instanceof Resource) {
                if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
                    utils.smartMove(creep, target);
                }
            } else {
                if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                    utils.smartMove(creep, target);
                }
            }
        } else {
            // Idle behavior?
            // creep.say('💤');
        }
    },

    handleTransfer: function (creep) {
        const ctx = creep.room.ctx;
        let target = null;

        // Stick to current target if valid and needs energy
        if (creep.memory.targetId) {
            target = Game.getObjectById(creep.memory.targetId);
            if (!target || (target.store && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0)) {
                target = null;
                creep.memory.targetId = null;
            }
        }

        if (!target) {
            // Priority 1: Spawns & Extensions (Vital for survival)
            // Use cached fill targets from context
            const criticalFill = ctx.energy.fillTargets; // Spawns + Extensions
            if (criticalFill.length > 0) {
                target = creep.pos.findClosestByRange(criticalFill);
            }

            // Priority 2: Towers (Defense)
            if (!target) {
                const towerFill = ctx.energy.towerFillTargets;
                if (towerFill.length > 0) {
                    target = creep.pos.findClosestByRange(towerFill);
                }
            }

            // Priority 3: Storage (The dump)
            if (!target && ctx.storage) {
                if (ctx.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                    target = ctx.storage;
                }
            }
        }

        if (target) {
            creep.memory.targetId = target.id;
            const result = creep.transfer(target, RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) {
                utils.smartMove(creep, target);
            } else if (result === OK) {
                // If full transferred, we might be empty next tick, loop will handle it
                creep.memory.targetId = null; // Clear target immediately to re-evaluate next tick
            }
        } else {
            // No targets? Idle near controller or spawn to get out of the way
            // utils.smartMove(creep, ctx.spawns[0]); 
        }
    }
};
