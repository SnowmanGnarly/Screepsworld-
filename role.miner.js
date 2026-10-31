/*
 * Miners cannot move or carry stuff, but they are very good at harvesting stuff. 
 * So have a container or storage ready for him to use.
 */

var constants = require('./main.constants');
var config = require('./main.config');
var info = require('./main.info');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var EconomyManager = require('./manager.economy');

var RolePrototype = require('./role.prototype');

class Miner extends RolePrototype {

	constructor() {
		super('Miner', '#000000', '🛒');
		this._maxRangeToTarget = config.ECONOMY.MINER_WALK_RANGE;
		this._disableAutomaticLoot = true; // a Miner stays on its source; haulers collect the piles

		this._targetMode = RolePrototype.TARGET_MODE_USE_OR_WAIT;
	}

	isNecessary(room) {
		return true;
	}

	getDemand(room) {
		return EconomyManager.getDesiredMiners(room);
	}

	/*
	 * A replacement has to arrive when the old Miner dies, so it starts one spawn time plus one walk
	 * early. The walk is what this Miner measured on its way here.
	 */

	needsReplacement(creep) {
		if (creep.spawning || !Number.isFinite(creep.ticksToLive)) return false;
		var walk = creep.memory.ticksToSource ? creep.memory.initialTicksToLive - creep.memory.ticksToSource : config.SPAWN.PRESPAWN_MARGIN;
		return creep.ticksToLive <= creep.body.length * CREEP_SPAWN_TIME + walk;
	}

	/*
	 * This method is called by the framework, so we need to find an open
	 * source for the creep to attach to. A Miner about to die no longer holds its source, which is
	 * what sends its replacement to the right one. An outsourced spawn works for another room.
	 */

	spawnCreep(spawn, options = {}) {
		var room = options.baseRoom || spawn.room;
		var minableSources = EconomyManager.getMinableSources(room);
		var allSources = minableSources.length > 0 ? minableSources : MainCache.find(room, FIND_SOURCES);
		var targetSource = null;
		var minMinerCount = Infinity;

		allSources.forEach(source => {
			var minerCount = this._countHoldingMiners(source.id);
			if (minerCount < minMinerCount) {
				minMinerCount = minerCount;
				targetSource = source;
			}
		});

		if (targetSource) {
			return this._spawnCreepFromSpawn(spawn, targetSource.id, options);
		}

		return false;
	}

	_countHoldingMiners(sourceId) {
		return MainCache.getCreeps().filter(creep => {
			return creep.memory.role === this.roleName && creep.memory.source === sourceId && !this.needsReplacement(creep);
		}).length;
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

	_spawnCreepFromSpawn(spawn, sourceId, options = {}) {
		if (!sourceId) {
			info.error('The source is mandatory!');
			return false;
		}
		var resultingCreep = this._spawnCreepWithParts(spawn, [WORK], [MOVE, CARRY], options);
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
		var sourceParts = EconomyManager.getHarvestWorkParts();
		return controller && (controller.my || controller.reservation) ? sourceParts : sourceParts + 1;
	}

	_work(creep) {
		if (!creep.memory.initialTicksToLive) {
			// this is the first time we actually DO something
			// -> remember intial ticksToLive for later
			creep.memory.initialTicksToLive = creep.ticksToLive;
		}

		var source = Game.getObjectById(creep.memory.source);
		// without a working drop-off there is nothing to stand beside. The old way still feeds a link,
		// or a store within reach, instead of spilling everything on the ground
		var post = source && EconomyManager.hasDropoff(source.room, source) ? EconomyManager.getMinerPost(source.room, source) : null;
		if (post) {
			this._mineAtPost(creep, source, post);
		} else {
			this._commuteBetweenSourceAndTarget(creep, target => creep.transfer(target, RESOURCE_ENERGY));
		}
	}

	/*
	 * Harvesting and transferring can both happen in one tick. Walking back and forth with a full
	 * load would cost one tick in six, and a sixth of the source with it.
	 */

	_mineAtPost(creep, source, post) {
		var atPost = creep.pos.roomName === source.room.name && creep.pos.x === post.x && creep.pos.y === post.y;
		if (!atPost && !this._isPostTaken(creep, post)) {
			this._moveToLocation(creep, new RoomPosition(post.x, post.y, source.room.name));
		} else if (!atPost && !creep.pos.isNearTo(source)) {
			this._moveToLocation(creep, source);
		}
		if (!creep.pos.isNearTo(source)) return;

		var harvestResult = creep.harvest(source);
		if (harvestResult == OK) {
			if (!creep.memory.ticksToSource) {
				// this is the first time we can harvest the source
				// -> remember time for later
				creep.memory.ticksToSource = creep.ticksToLive;
			}
		} else {
			this._handleSourceWorkResult(creep, harvestResult);
		}
		this._unload(creep, source);
	}

	// the Miner it replaces stands there until it dies, and this one can already work beside it.
	// Anything else on the tile is only passing through
	_isPostTaken(creep, post) {
		return MainCache.getCreeps().some(other => {
			return other.name !== creep.name && other.memory.role === this.roleName &&
				other.pos.x === post.x && other.pos.y === post.y && other.pos.roomName === creep.pos.roomName;
		});
	}

	_unload(creep, source) {
		var carried = creep.store.getUsedCapacity(RESOURCE_ENERGY);
		if (carried <= 0) return;
		var harvestedPerTick = creep.getActiveBodyparts(WORK) * HARVEST_POWER;
		if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > harvestedPerTick && source.energy > 0) return;
		var target = this._findTargetBeside(creep, source);
		if (target) creep.transfer(target, RESOURCE_ENERGY);
	}

	_findTargetBeside(creep, source) {
		var nearby = MainCache.find(source.room, FIND_STRUCTURES).filter(structure => {
			return structure.store && creep.pos.isNearTo(structure) && structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
		});
		var isUsableLink = structure => structure.structureType == STRUCTURE_LINK && EconomyManager.hasDeliveringLink(source.room, source) &&
			MainUtil.fetchMemoryOfStructure(structure).type == constants.LINK_TYPE_SOURCE;
		var isStore = structure => structure.structureType == STRUCTURE_CONTAINER || structure.structureType == STRUCTURE_STORAGE;
		return nearby.find(isUsableLink) || nearby.find(isStore) || null;
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

	/*
	 * Only for a Miner with no container or link beside its source, which walks to the nearest store.
	 */

	_findClosestTarget(creep) {
		if (creep.memory.target) return super._findClosestTarget(creep);
		var hasArrived = creep.memory.ticksToSource;
		var targets = this._findTargets(this._baseRoom).filter(target => !hasArrived || creep.pos.inRangeTo(target, this._maxRangeToTarget));
		return this._sortTargetForClosest(targets, creep)[0] || null;
	}

	_findTargets(room) {
		return MainCache.find(room, FIND_STRUCTURES, {
			filter: (structure) => {
				return (structure.structureType == STRUCTURE_STORAGE ||
					structure.structureType == STRUCTURE_CONTAINER ||
					(structure.structureType == STRUCTURE_LINK && MainUtil.fetchMemoryOfStructure(structure).type == constants.LINK_TYPE_SOURCE)) &&
					structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
			}
		});
	}
}

module.exports = Miner;

