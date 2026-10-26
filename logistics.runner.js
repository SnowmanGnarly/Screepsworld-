// @ts-check

var MainCache = require('./main.cache');
var LogisticsManager = require('./manager.logistics');
var info = require('./main.info');

class LogisticsRunner {

    /**
     * @param {Creep} creep
     * @param {any} role
     * @param {{resourceType?: ResourceConstant}} [options={}]
     */
    static run(creep, role, options = {}) {
        var task = /** @type {any} */ (LogisticsManager.assignTask(creep, options));
        if (!task) {
            this._recoverForeignResources(creep, role);
            return;
        }

        var otherResources = (creep.store.getUsedCapacity() || 0) - (creep.store.getUsedCapacity(task.resourceType) || 0);
        if (otherResources > 0) {
            this._recoverForeignResources(creep, role, task.resourceType);
            return;
        }

        if ((creep.store.getUsedCapacity(task.resourceType) || 0) > 0) {
            this._deliver(creep, role, task);
        } else {
            this._pickup(creep, role, task);
        }
    }

    /**
     * @param {Creep} creep
     * @param {any} role
     * @param {any} task
     */
    static _pickup(creep, role, task) {
        var source = /** @type {any} */ (Game.getObjectById(task.sourceId));
        if (!source) {
            task.state = 'unavailable';
            return;
        }

        var available = LogisticsManager.getResourceAmount(source, task.resourceType);
        var amount = Math.min(available, task.remaining, (creep.store.getFreeCapacity(task.resourceType) || 0));
        if (amount <= 0) {
            task.retryAfter = Game.time + 5;
            return;
        }

        var result;
        if (source.amount !== undefined && source.resourceType) {
            result = creep.pickup(source);
        } else if (source.store) {
            result = creep.withdraw(source, task.resourceType, amount);
        } else {
            result = creep.harvest(source);
        }

        if (result === OK) {
            task.lastProgress = Game.time;
            return;
        }
        if (result === ERR_NOT_IN_RANGE) {
            role._moveToLocation(creep, source);
            return;
        }
        if (result === ERR_FULL && (creep.store.getUsedCapacity(task.resourceType) || 0) > 0) {
            this._deliver(creep, role, task);
            return;
        }
        this._retry(task, result);
    }

    /**
     * @param {Creep} creep
     * @param {any} role
     * @param {any} task
     */
    static _deliver(creep, role, task) {
        var target = /** @type {any} */ (Game.getObjectById(task.targetId));
        if (!target) {
            task.state = 'unavailable';
            return;
        }

        var carried = (creep.store.getUsedCapacity(task.resourceType) || 0);
        var targetFree = LogisticsManager.getTargetFree(target, task.resourceType) || 0;
        var amount = Math.min(carried, task.remaining, targetFree);
        if (amount <= 0) {
            if (targetFree <= 0) {
                task.remaining = 0;
                LogisticsManager.releaseTask(creep.room, task.id);
                delete (/** @type {any} */ (creep.memory)).taskId;
                this._recoverForeignResources(creep, role);
            }
            return;
        }

        var result = creep.transfer(target, task.resourceType, amount);
        if (result === OK) {
            task.lastProgress = Game.time;
            return;
        }
        if (result === ERR_NOT_IN_RANGE) {
            role._moveToLocation(creep, target);
            return;
        }
        if (result === ERR_FULL) {
            task.remaining = 0;
            LogisticsManager.releaseTask(creep.room, task.id);
            delete (/** @type {any} */ (creep.memory)).taskId;
            this._recoverForeignResources(creep, role);
            return;
        }
        this._retry(task, result);
    }

    /**
     * @param {any} task
     * @param {number} result
     */
    static _retry(task, result) {
        task.retryAfter = Game.time + 5;
        task.state = 'open';
        if (result !== ERR_BUSY && result !== ERR_NOT_ENOUGH_RESOURCES && result !== ERR_TIRED) {
            info.warning('Logistics task ' + task.id + ' could not continue: ' + result);
        }
    }

    /**
     * @param {Creep} creep
     * @param {any} role
     * @param {ResourceConstant} [keepResourceType]
     */
    static _recoverForeignResources(creep, role, keepResourceType) {
        var resourceType = /** @type {ResourceConstant|undefined} */ (Object.keys(creep.store).find(resource => {
            return resource !== keepResourceType && (creep.store.getUsedCapacity(/** @type {ResourceConstant} */ (resource)) || 0) > 0;
        }));
        if (!resourceType) return;

        var target = null;
        var hubs = [creep.room.storage, creep.room.terminal].filter(hub => !!hub);
        if (hubs.length > 0) {
            target = hubs.find(hub => hub.store.getFreeCapacity(resourceType) > 0) || null;
        } else if (resourceType === RESOURCE_ENERGY) {
            target = MainCache.find(creep.room, FIND_MY_STRUCTURES, {
                filter: (/** @type {any} */ structure) => (structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION) &&
                    structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            })[0] || null;
        }
        if (!target) return;

        var result = creep.transfer(target, resourceType);
        if (result === ERR_NOT_IN_RANGE) {
            role._moveToLocation(creep, target);
        }
    }
}

module.exports = LogisticsRunner;
