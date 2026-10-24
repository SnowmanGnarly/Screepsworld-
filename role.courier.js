/*
 * Couriers are multi-resource logistics haulers.
 * They consume tasks from LogisticsManager to move minerals, energy,
 * and lab reagents between containers, labs, storage, and terminals.
 */

var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');
var RolePrototype = require('./role.prototype');
var LogisticsManager = require('./manager.logistics');

class Courier extends RolePrototype {

	constructor() {
		super('Courier', '#ff8800', '📯');
		this.priority = 40;
		this._resourceType = RESOURCE_ENERGY;
	}

	isNecessary(room) {
		var hasTasks = room.memory.logistics && room.memory.logistics.tasks && room.memory.logistics.tasks.length > 0;
		var hasLegacyConfig = !!(room.memory.source && room.memory.target);
		return hasTasks || hasLegacyConfig;
	}

	spawnCreep(spawn) {
		return this._spawnCreepWithParts(spawn, [CARRY, MOVE]);
	}

	_work(creep) {
		// 1. Try to fetch a task from LogisticsManager
		var task = LogisticsManager.assignTask(creep);

		if (task) {
			this._executeLogisticsTask(creep, task);
			return;
		}

		// 2. Fallback to legacy source/target configuration if present
		if (creep.room.memory.source && creep.room.memory.target) {
			this._commuteBetweenSourceAndTarget(creep, target => creep.transfer(target, this._resourceType));
		}
	}

	_executeLogisticsTask(creep, task) {
		var resType = task.resourceType;
		var hasResource = creep.store.getUsedCapacity(resType) > 0;

		// Creep carries other resources that do not match current task -> unload first
		var usedOtherCapacity = creep.store.getUsedCapacity() - (creep.store.getUsedCapacity(resType) || 0);
		if (usedOtherCapacity > 0) {
			this._recoverForeignResources(creep);
			return;
		}

		if (!hasResource) {
			// Phase A: Pick up from Source
			var source = Game.getObjectById(task.sourceId);
			if (!source) {
				LogisticsManager.completeTask(creep.room, task.id);
				creep.memory.taskId = null;
				return;
			}

			var pickupResult;
			if (source.amount !== undefined) {
				pickupResult = creep.pickup(source);
			} else {
				pickupResult = creep.withdraw(source, resType);
			}

			if (pickupResult === ERR_NOT_IN_RANGE) {
				this._moveToLocation(creep, source);
			} else if (pickupResult === OK || pickupResult === ERR_FULL) {
				// Successfully picked up or now full, deliver to target
				var target = Game.getObjectById(task.targetId);
				if (target) {
					this._moveToLocation(creep, target);
				}
			} else if (pickupResult !== ERR_BUSY) {
				// Source depleted or invalid
				LogisticsManager.completeTask(creep.room, task.id);
				creep.memory.taskId = null;
			}
		} else {
			// Phase B: Deliver to Target
			var target = Game.getObjectById(task.targetId);
			if (!target) {
				LogisticsManager.completeTask(creep.room, task.id);
				creep.memory.taskId = null;
				return;
			}

			var transferResult = creep.transfer(target, resType);
			if (transferResult === ERR_NOT_IN_RANGE) {
				this._moveToLocation(creep, target);
			} else if (transferResult === OK) {
				if (creep.store.getUsedCapacity(resType) <= (task.amount || 0)) {
					LogisticsManager.completeTask(creep.room, task.id);
					creep.memory.taskId = null;
				}
			} else if (transferResult === ERR_FULL || transferResult === ERR_INVALID_TARGET) {
				LogisticsManager.completeTask(creep.room, task.id);
				creep.memory.taskId = null;
			}
		}
	}

	_recoverForeignResources(creep) {
		var target = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
			filter: s => s.structureType === STRUCTURE_SPAWN && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
		});

		if (!target) {
			return;
		}

		for (var res in creep.store) {
			if (creep.store[res] > 0) {
				if (creep.transfer(target, res) === ERR_NOT_IN_RANGE) {
					this._moveToLocation(creep, target);
				}
				return;
			}
		}
	}
}

module.exports = Courier;
