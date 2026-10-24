/*
 * Storekeepers are fast base haulers with high carry capacity.
 * They consume energy logistics tasks to replenish spawns, extensions, towers,
 * and links from containers, storage, and dropped energy.
 */

var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');
var RolePrototype = require('./role.prototype');
var LogisticsManager = require('./manager.logistics');

class StoreKeeper extends RolePrototype {

	constructor() {
		super('Storekeeper', '#ff9900', '🏭');
		this.priority = 60;
	}

	isNecessary(room) {
		return true;
	}

	spawnCreep(spawn) {
		return this._spawnCreepWithParts(spawn, [MOVE, CARRY]);
	}

	_work(creep) {
		// 1. Check for assigned task in LogisticsManager
		var task = LogisticsManager.assignTask(creep, { resourceType: RESOURCE_ENERGY });
		if (task) {
			this._executeLogisticsTask(creep, task);
			return;
		}

		// 2. Autonomous energy distribution fallback
		this._commuteBetweenSourceAndTarget(creep, target => creep.transfer(target, RESOURCE_ENERGY));
	}

	_executeLogisticsTask(creep, task) {
		var hasEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;

		if (!hasEnergy) {
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
				pickupResult = creep.withdraw(source, RESOURCE_ENERGY);
			}

			if (pickupResult === ERR_NOT_IN_RANGE) {
				this._moveToLocation(creep, source);
			} else if (pickupResult === OK || pickupResult === ERR_FULL) {
				var target = Game.getObjectById(task.targetId);
				if (target) {
					this._moveToLocation(creep, target);
				}
			} else if (pickupResult !== ERR_BUSY) {
				LogisticsManager.completeTask(creep.room, task.id);
				creep.memory.taskId = null;
			}
		} else {
			var target = Game.getObjectById(task.targetId);
			if (!target) {
				LogisticsManager.completeTask(creep.room, task.id);
				creep.memory.taskId = null;
				return;
			}

			var transferResult = creep.transfer(target, RESOURCE_ENERGY);
			if (transferResult === ERR_NOT_IN_RANGE) {
				this._moveToLocation(creep, target);
			} else if (transferResult === OK) {
				if (target.store && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
					LogisticsManager.completeTask(creep.room, task.id);
					creep.memory.taskId = null;
				}
			} else if (transferResult === ERR_FULL || transferResult === ERR_INVALID_TARGET) {
				LogisticsManager.completeTask(creep.room, task.id);
				creep.memory.taskId = null;
			}
		}
	}

	_findSources(room) {
		if (!this._useStorageAsSource) {
			return [];
		}
		return MainCache.find(room, FIND_STRUCTURES, {
			filter: (structure) => {
				return (structure.structureType == STRUCTURE_STORAGE ||
					structure.structureType == STRUCTURE_CONTAINER) &&
					structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
			}
		});
	}

	_findTargets(room) {
		return MainCache.find(room, FIND_MY_STRUCTURES, {
			filter: (structure) => {
				return (structure.structureType == STRUCTURE_EXTENSION ||
					structure.structureType == STRUCTURE_SPAWN ||
					(structure.structureType == STRUCTURE_LINK && MainUtil.fetchMemoryOfStructure(structure).type == 'source') ||
					structure.structureType == STRUCTURE_TOWER) &&
					structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
			}
		});
	}

	_sortTargetForClosest(targets, creep) {
		return targets.sort((a, b) => {
			const getPriority = (target) => {
				if (target.structureType == STRUCTURE_EXTENSION ||
					target.structureType == STRUCTURE_SPAWN) return 3;
				if (target.structureType == STRUCTURE_TOWER) return 2;
				if (target.structureType == STRUCTURE_LINK) return 1;
				return 0;
			};

			const aPriority = getPriority(a);
			const bPriority = getPriority(b);

			if (aPriority !== bPriority) {
				return bPriority - aPriority;
			}

			return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
		});
	}
}

module.exports = StoreKeeper;
