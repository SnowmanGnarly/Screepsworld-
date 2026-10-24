/*
 * Miners cannot move or carry stuff, but they are very good at harvesting stuff. 
 * So have a container or storage ready for him to use.
 */

var info = require('./main.info');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');

var MemoryManager = require('./manager.memory');

var RolePrototype = require('./role.prototype');

class Miner extends RolePrototype {

	constructor() {
		super('Miner', '#000000', '🛒');
		this.priority = -1; // we never need more than the defined miners
		this._maxRangeToTarget = 7;

		this._targetMode = RolePrototype.TARGET_MODE_USE_OR_WAIT;
	}

	isNecessary(room) {
		return true;
	}

	/*
	 * This method is called by the framework, so we need to find an open
	 * source for the creep to attach to.
	 */

	spawnCreep(spawn) {
		var allSources = MainCache.find(spawn.room, FIND_SOURCES);
		var targetSource = null;
		var minMinerCount = Infinity;

		allSources.forEach(source => {
			var minerCount = MainCache.getMinerCount(source.id);
			if (minerCount < minMinerCount) {
				minMinerCount = minerCount;
				targetSource = source;
			}
		});

		if (targetSource) {
			return this._spawnCreepFromSpawn(spawn, targetSource.id);
		}

		return false;
	}

	spawnCreepFromSpawnName(spawnName, sourceId) {
		var spawns = MainUtil.findAllSpawns().filter(spawn => spawn.name == spawnName);
		if (spawns.length == 0) {
			info.error('Could not find spawn: ' + spawnName);
			return false;
		}
		var spawn = spawns[0];
		var resultingCreep = this._spawnCreepFromSpawn(spawn, sourceId);
		if (resultingCreep) {
			info.log(this.symbol + ' Spawning new ' + this.roleName + ' (' + resultingCreep.body.length + 'p)', this._baseRoom);
			return resultingCreep;
		}
		return resultingCreep;
	}

	_spawnCreepFromSpawn(spawn, sourceId) {
		if (!sourceId) {
			info.error('The source is mandatory!');
			return false;
		}
		var resultingCreep = this._spawnCreepWithParts(spawn, [WORK], [MOVE, CARRY]);
		if (resultingCreep) {
			resultingCreep.memory.homeSpawn = spawn.name;
			resultingCreep.memory.source = sourceId;
			return resultingCreep;
		}
		return resultingCreep;
	}

	/*
	 * Owned and reserved sources regenerate 3000 energy in 300 ticks, so five
	 * WORK parts are sufficient. Unreserved rooms retain the previous limit.
	 */

	_getPartsMaxMultiplier(spawn) {
		var controller = spawn.room.controller;
		return controller && (controller.my || controller.reservation) ? 5 : 6;
	}

	_work(creep) {
		this.creep = creep;

		if (!creep.memory.initialTicksToLive) {
			// this is the first time we actually DO something
			// -> remember intial ticksToLive for later
			creep.memory.initialTicksToLive = creep.ticksToLive;
		}

		this._commuteBetweenSourceAndTarget(creep, target => creep.transfer(target, RESOURCE_ENERGY));

		// we know how long it took this creep to the resource
		// so we need to retrain our replacement before we die
		if (creep.memory.ticksToSource && !creep.memory.trainedReplacement) {
			var timeToSpawn = creep.body.length * 3;
			var ticksToGetReady = (creep.memory.initialTicksToLive - creep.memory.ticksToSource) + timeToSpawn;

			if (creep.ticksToLive < ticksToGetReady) {
				var spawnedCreep = this.spawnCreepFromSpawnName(creep.memory.homeSpawn, creep.memory.source);
				if (spawnedCreep) {
					info.log(this.symbol + ' Training the replacement ' + this.roleName, this._baseRoom);
					creep.memory.trainedReplacement = true;
				}
			}
		}
	}

	_moveToClosestSource(creep) {
		var harvestResult = super._moveToClosestSource(creep);

		if (harvestResult == OK) {
			if (!creep.memory.ticksToSource) {
				// this is the first time we can harvest the source
				// -> remember time for later
				creep.memory.ticksToSource = creep.ticksToLive;
			}
		}
		return harvestResult;
	}

	_handleSourceWorkResult(creep, workResult) {
		if (workResult == ERR_NOT_ENOUGH_RESOURCES) {
			// we mined the source completely ahead of time - ignore
			return;
		}
		super._handleSourceWorkResult(creep, workResult);
	}

	_findTargets(room) {
		// creep must be defined and have reached the source to check the range
		var testCreepPosition = this.creep && this.creep.memory.ticksToSource;
		var targets = MainCache.find(room, FIND_STRUCTURES, {
			filter: (structure) => {
				return (structure.structureType == STRUCTURE_STORAGE ||
					structure.structureType == STRUCTURE_CONTAINER ||
					(structure.structureType == STRUCTURE_LINK && MainUtil.fetchMemoryOfStructure(structure).type == 'source')) &&
					(!testCreepPosition || this.creep.pos.inRangeTo(structure, this._maxRangeToTarget)) &&
					structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
			}
		});
		if (testCreepPosition) {
			var adjacentTargets = targets.filter(target => this.creep.pos.inRangeTo(target, 1));
			if (adjacentTargets.length > 0) {
				return adjacentTargets;
			}
		}
		return targets;
	}
}

module.exports = Miner;

