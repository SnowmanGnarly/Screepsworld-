/*
 * Logistics Manager handles the central task queue for resource transfers.
 * It decouples producers (miners, containers, labs, dropped piles)
 * from consumers (spawns, extensions, towers, labs, storage).
 */

var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');

class LogisticsManager {

	static runAll() {
		MainUtil.findAllRooms().forEach(room => {
			if (room.memory.base) {
				new LogisticsManager(room).run();
			}
		});
	}

	constructor(room) {
		this._room = room;
		this._memory = this._fetchMemory();
	}

	_fetchMemory() {
		var defaultData = {
			tasks: [],
			lastRun: 0,
		};
		if (!this._room.memory.logistics) {
			this._room.memory.logistics = defaultData;
		}
		return this._room.memory.logistics;
	}

	run() {
		this._cleanupStaleTasks();
		this._generateRequests();
	}

	/*
	 * Clean up tasks that expired, whose source or target no longer exists,
	 * or whose targets are full.
	 */
	_cleanupStaleTasks() {
		var tasks = this._memory.tasks;
		var validTasks = [];

		for (var i = 0; i < tasks.length; i++) {
			var task = tasks[i];

			// Task TTL (max 150 ticks)
			if (Game.time - task.created > 150) {
				continue;
			}

			// If creep assigned but creep dead, unassign
			if (task.assignedCreep && !Game.creeps[task.assignedCreep]) {
				task.assignedCreep = null;
			}

			var source = Game.getObjectById(task.sourceId);
			var target = Game.getObjectById(task.targetId);

			if (!source || !target) {
				continue;
			}

			// Verify target still has capacity
			if (target.store && target.store.getFreeCapacity(task.resourceType) === 0) {
				continue;
			}

			// Verify source still has resources
			var sourceAmount = 0;
			if (source.amount !== undefined) {
				sourceAmount = source.amount; // Dropped resource
			} else if (source.store) {
				sourceAmount = source.store.getUsedCapacity(task.resourceType) || 0;
			}
			if (sourceAmount === 0 && (!task.assignedCreep || !Game.creeps[task.assignedCreep] || Game.creeps[task.assignedCreep].store.getUsedCapacity(task.resourceType) === 0)) {
				continue;
			}

			validTasks.push(task);
		}

		this._memory.tasks = validTasks;
	}

	/*
	 * Automatically generate delivery and pickup requests.
	 */
	_generateRequests() {
		var storage = this._room.storage;

		// 1. Critical Base Consumers: Spawns and Extensions (Priority 100)
		var coreStructures = MainCache.find(this._room, FIND_MY_STRUCTURES, {
			filter: s => (s.structureType == STRUCTURE_SPAWN || s.structureType == STRUCTURE_EXTENSION) &&
				s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
		});

		coreStructures.forEach(structure => {
			var needed = structure.store.getFreeCapacity(RESOURCE_ENERGY);
			var source = this._findBestEnergySourceFor(structure);
			if (source) {
				this._createTask(source.id, structure.id, RESOURCE_ENERGY, needed, 100);
			}
		});

		// 2. Defense Consumers: Towers (Priority 95 during threat, 60 peacetime)
		var hostiles = MainCache.find(this._room, FIND_HOSTILE_CREEPS);
		var towerPriority = hostiles.length > 0 ? 95 : 60;
		var towers = MainCache.find(this._room, FIND_MY_STRUCTURES, {
			filter: s => s.structureType == STRUCTURE_TOWER &&
				s.store.getFreeCapacity(RESOURCE_ENERGY) >= 200
		});

		towers.forEach(tower => {
			var needed = tower.store.getFreeCapacity(RESOURCE_ENERGY);
			var source = this._findBestEnergySourceFor(tower);
			if (source) {
				this._createTask(source.id, tower.id, RESOURCE_ENERGY, needed, towerPriority);
			}
		});

		// 3. Labs: Energy refills (Priority 65)
		var labsNeedingEnergy = MainCache.find(this._room, FIND_MY_STRUCTURES, {
			filter: s => s.structureType == STRUCTURE_LAB &&
				s.store.getFreeCapacity(RESOURCE_ENERGY) >= 400
		});

		labsNeedingEnergy.forEach(lab => {
			var needed = lab.store.getFreeCapacity(RESOURCE_ENERGY);
			var source = this._findBestEnergySourceFor(lab);
			if (source) {
				this._createTask(source.id, lab.id, RESOURCE_ENERGY, needed, 65);
			}
		});

		// 4. Source Container Evacuation: Mining containers near full (Priority 75)
		var containers = MainCache.find(this._room, FIND_STRUCTURES, {
			filter: s => s.structureType == STRUCTURE_CONTAINER &&
				s.store.getUsedCapacity(RESOURCE_ENERGY) >= 400
		});

		containers.forEach(container => {
			var target = storage || this._findNearestRefillTarget(container);
			if (target && target.id !== container.id) {
				var amount = container.store.getUsedCapacity(RESOURCE_ENERGY);
				this._createTask(container.id, target.id, RESOURCE_ENERGY, amount, 75);
			}
		});

		// 5. Dropped Energy Piles > 100 (Priority 80)
		var droppedResources = MainCache.find(this._room, FIND_DROPPED_RESOURCES, {
			filter: r => r.amount >= 100
		});

		droppedResources.forEach(drop => {
			var target = storage || this._findNearestRefillTarget(drop);
			if (target) {
				this._createTask(drop.id, target.id, drop.resourceType, drop.amount, 80);
			}
		});

		// 6. Tombstones & Ruins with resources > 50 (Priority 85)
		var tombstones = MainCache.find(this._room, FIND_TOMBSTONES, {
			filter: t => t.store.getUsedCapacity() >= 50
		});
		tombstones.forEach(tomb => {
			for (var res in tomb.store) {
				if (tomb.store[res] >= 50) {
					var target = storage || this._findNearestRefillTarget(tomb);
					if (target) {
						this._createTask(tomb.id, target.id, res, tomb.store[res], 85);
					}
				}
			}
		});
	}

	_createTask(sourceId, targetId, resourceType, amount, priority) {
		// Avoid duplicate tasks for the same source, target, and resource
		var exists = this._memory.tasks.some(t => t.sourceId === sourceId && t.targetId === targetId && t.resourceType === resourceType);
		if (exists) {
			return;
		}

		var taskId = 'req_' + Game.time + '_' + Math.random().toString(36).substring(2, 6);
		this._memory.tasks.push({
			id: taskId,
			sourceId: sourceId,
			targetId: targetId,
			resourceType: resourceType,
			amount: amount,
			priority: priority,
			assignedCreep: null,
			created: Game.time,
		});
	}

	_findBestEnergySourceFor(target) {
		// Prefer storage if it has energy
		if (this._room.storage && this._room.storage.store.getUsedCapacity(RESOURCE_ENERGY) >= 200) {
			return this._room.storage;
		}

		// Fallback to containers with energy
		var containers = MainCache.find(this._room, FIND_STRUCTURES, {
			filter: s => s.structureType == STRUCTURE_CONTAINER &&
				s.store.getUsedCapacity(RESOURCE_ENERGY) >= 100 &&
				s.id != target.id
		});

		if (containers.length > 0) {
			containers.sort((a, b) => target.pos.getRangeTo(a) - target.pos.getRangeTo(b));
			return containers[0];
		}

		return null;
	}

	_findNearestRefillTarget(source) {
		var targets = MainCache.find(this._room, FIND_MY_STRUCTURES, {
			filter: s => (s.structureType == STRUCTURE_SPAWN ||
				s.structureType == STRUCTURE_EXTENSION ||
				s.structureType == STRUCTURE_TOWER) &&
				s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
		});

		if (targets.length > 0) {
			targets.sort((a, b) => source.pos.getRangeTo(a) - source.pos.getRangeTo(b));
			return targets[0];
		}
		return null;
	}

	/*
	 * Static API for Creeps to query tasks.
	 */

	static assignTask(creep, options = {}) {
		var room = creep.room;
		if (!room.memory.logistics) {
			new LogisticsManager(room);
		}
		var tasks = room.memory.logistics.tasks || [];

		// Check if creep has an active valid task
		if (creep.memory.taskId) {
			var existing = tasks.find(t => t.id === creep.memory.taskId);
			if (existing) {
				var target = Game.getObjectById(existing.targetId);
				if (target && target.store && target.store.getFreeCapacity(existing.resourceType) > 0) {
					return existing;
				}
			}
			// Task invalid or finished
			LogisticsManager.completeTask(room, creep.memory.taskId);
			creep.memory.taskId = null;
		}

		// Find best unassigned task
		var availableTasks = tasks.filter(t => !t.assignedCreep || t.assignedCreep === creep.name);

		if (options.resourceType) {
			availableTasks = availableTasks.filter(t => t.resourceType === options.resourceType);
		}

		if (availableTasks.length === 0) {
			return null;
		}

		// Score tasks by: (priority * 100) - distance
		availableTasks.sort((a, b) => {
			var sourceA = Game.getObjectById(a.sourceId);
			var sourceB = Game.getObjectById(b.sourceId);
			var distA = sourceA ? creep.pos.getRangeTo(sourceA) : 50;
			var distB = sourceB ? creep.pos.getRangeTo(sourceB) : 50;

			var scoreA = (a.priority * 100) - distA;
			var scoreB = (b.priority * 100) - distB;
			return scoreB - scoreA;
		});

		var selectedTask = availableTasks[0];
		selectedTask.assignedCreep = creep.name;
		creep.memory.taskId = selectedTask.id;
		return selectedTask;
	}

	static completeTask(room, taskId) {
		if (!room.memory.logistics || !room.memory.logistics.tasks) {
			return;
		}
		room.memory.logistics.tasks = room.memory.logistics.tasks.filter(t => t.id !== taskId);
	}

	static releaseTask(room, taskId) {
		if (!room.memory.logistics || !room.memory.logistics.tasks) {
			return;
		}
		var task = room.memory.logistics.tasks.find(t => t.id === taskId);
		if (task) {
			task.assignedCreep = null;
		}
	}
}

module.exports = LogisticsManager;

