/*
 * This code is shared between the roles. It has standard behavior like:
 * - basic fields & methods
 * - moving to an appropriate source
 * - spawning new creeps
 * - commuting between a source and a target
 * 
 * You need to implement / set:
 * - roleName
 * - (color, symbol)
 * - _findTargets(room)
 * - _work(creep)
 * 
 * You might need to override / set:
 * - priority
 * - _targetMode (how to handle set and not found targets)
 * - isNecessary(room) (on default it returns if a valid target is found)
 * - spawnCreep(spawn) (to spawn with something different than standard parts)
 * - _sortTargetForClosest(targets, creep) (on default it sorts for positions)
 */

var constants = require('./main.constants');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');

var MemoryManager = require('./manager.memory');
var LabManager = require('./manager.lab');

class RolePrototype {

	constructor(roleName = 'Prototype', color = '#ff0000', symbol = '❗') {
		this.roleName = roleName;
		this.color = color;
		this.symbol = symbol;
		this.priority = 0; // the higher the better

		this._resourceType = RESOURCE_ENERGY;
		this._reusePath = 5;
		this._targetMode = RolePrototype.TARGET_MODE_USE_IF_VALID;
		this._sourceMode = RolePrototype.SOURCE_MODE_USE_OR_WAIT;
	}

	/*
	 * Creates a single creep for this role.
	 */

	spawnCreep(spawn) {
		return this._spawnCreepWithParts(spawn, [WORK, CARRY, MOVE, MOVE]);
	}

	spawnMissionCreep(spawn, request) {
		var body = request && (request.exactBody || request.body);
		var memory = Object.assign({}, request && request.memory, {
			role: request && request.role || this.roleName,
			home: request && request.home || spawn.memory.home,
		});
		return this._spawnCreepWithBody(spawn, body, memory);
	}

	/*
	 * Return true if a creep with this role would have work to do, i.e. if the
	 * role is currently _really_ necessary.
	 * 
	 * @param {Room} room
	 */

	isNecessary(room) {
		if (!room.memory.base.roleConfig[this.roleName].requiredNumber) {
			// if this role is not required, it's not necessary either
			return false;
		}
		var targets = this._findTargets(room);
		return targets && targets.length > 0;
	}

	/*
	 * Returns the primary target for the creep, e.g. energy stores for
	 * harvester and construction sites for builders.
	 * 
	 * @param {Room} room
	 */

	_findTargets(room) {
		return [];
	}

	/*
	 * Returns the closest primary target for the creep, e.g. energy stores for
	 * harvester and construction sites for builders.
	 * 
	 * @param {Creep} creep
	 */

	_findClosestTarget(creep) {
		var specificTarget;
		if (creep.memory.target) {
			// creep has specific target in mind
			specificTarget = Game.getObjectById(creep.memory.target);
			if (specificTarget && this._targetMode == RolePrototype.TARGET_MODE_USE_OR_WAIT) {
				// only in TARGET_MODE_USE_OR_WAIT we don't care for the validity of the target
				return specificTarget;
			}
			if (!specificTarget) {
				info.error(MainUtil.getDisplayName(creep) + ' could not find target: ' + creep.memory.target);

				if (this._targetMode != RolePrototype.TARGET_MODE_USE_IF_VALID) {
					// only in TARGET_MODE_USE_IF_VALID can we recover from that error
					return null;
				}
			}
		}
		var targets = this._findTargets(this._baseRoom);
		if (targets) {
			// let's see if we found our pre-selected target
			if (specificTarget) {
				var found = targets.filter(t => t.id == specificTarget.id);
				if (found.length > 0) {
					return found[0];
				}
				// our specific target is not valid 
				// - TARGET_MODE_USE_OR_ERROR errors out
				// - TARGET_MODE_USE_IF_VALID falls back to valid target
				if (this._targetMode == RolePrototype.TARGET_MODE_USE_OR_ERROR) {
					info.error(MainUtil.getDisplayName(creep) + ' could not find target in list: ' + creep.memory.target);
					return null;
				}
			}
			targets = this._sortTargetForClosest(targets, creep);
			return targets.length > 0 ? targets[0] : null;
		}
		return null;
	}

	/*
	 * Sorts the targets so the closest is first. If there are other things to
	 * take into consideration, this function is overriden.
	 * 
	 * @param {Creep} creep
	 */

	_sortTargetForClosest(targets, creep) {
		return targets.sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
	}

	/*
	 * Moves a creep to its closest primary target, e.g. energy stores for
	 * harvester and construction sites for builders.
	 * 
	 * @param {Creep} creep @param function the work that should be done there
	 */

	_moveToClosestTarget(creep, work) {
		var target = this._findClosestTarget(creep);

		if (!target) return;

		var workResult = work(target);
		if (workResult == ERR_NOT_IN_RANGE) {
			if (creep.memory.debug) {
				info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' is moving to target ' + MainUtil.getDisplayName(target), this._baseRoom);
			}
			this._moveToLocation(creep, target);
		} else if (workResult == OK) {
			if (creep.memory.debug) {
				info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' is working on target ' + MainUtil.getDisplayName(target), this._baseRoom);
			}
		} else {
			this._handleTargetWorkResult(creep, workResult);
		}
	}

	/*
	 * Handles result of work on target.
	 * 
	 * @param {Creep} creep @param work result
	 */

	_handleTargetWorkResult(creep, workResult) {
		// Handle common error cases gracefully
		switch (workResult) {
			case ERR_FULL:
				// Target is full, creep should find a new target
				if (creep.memory.debug) {
					info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' target is full, finding new target', this._baseRoom);
				}
				creep.memory.target = null; // Clear target so creep finds a new one
				break;
			case ERR_NOT_ENOUGH_RESOURCES:
				// Target doesn't have enough resources
				if (creep.memory.debug) {
					info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' target lacks resources', this._baseRoom);
				}
				creep.memory.target = null;
				break;
			case ERR_INVALID_TARGET:
				// Target is no longer valid
				if (creep.memory.debug) {
					info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' target is invalid', this._baseRoom);
				}
				creep.memory.target = null;
				break;
			default:
				info.warning(MainUtil.getDisplayName(creep) + ' cannot work: ' + workResult);
				break;
		}
	}

	/*
	 * Moves a creep to a location.
	 * 
	 * @param {Creep} creep @param location
	 */

	_moveToLocation(creep, location) {
		var moveResult = creep.moveTo(location, {
			reusePath: this._reusePath,
			visualizePathStyle: { stroke: this.color }
		});
		creep.memory.moving = moveResult == OK;
		if (moveResult != OK && creep.memory.debug) {
			info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' could not move: ' + moveResult, this._baseRoom);
		}
		return moveResult;
	}

	_moveToRoom(creep, destination, x = 25, y = 25) {
		var roomName = typeof destination === 'string' ? destination : destination && destination.roomName;
		if (!roomName) return false;
		if (destination && typeof destination === 'object') {
			x = destination.x;
			y = destination.y;
		}
		x = Number.isFinite(x) ? Math.max(0, Math.min(49, x)) : 25;
		y = Number.isFinite(y) ? Math.max(0, Math.min(49, y)) : 25;
		creep.memory.destination = { roomName: roomName, x: x, y: y };
		if (creep.room.name === roomName) return true;
		this._moveToLocation(creep, new RoomPosition(x, y, roomName));
		return false;
	}

	/*
	 * Moves a creep to a source.
	 * 
	 * @param {Creep} creep
	 */

	_moveToClosestSource(creep) {
		// TODO: if source is empty, just go back to working
		var source = this._findClosestSource(creep);

		if (!source) return;

		var harvestResult = source.structureType ? creep.withdraw(source, this._resourceType) : creep.harvest(source);
		if (harvestResult == ERR_NOT_IN_RANGE) {
			if (creep.memory.debug) {
				info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' is moving to source ' + MainUtil.getDisplayName(source), this._baseRoom);
			}
			this._moveToLocation(creep, source);
		} else if (harvestResult == OK) {
			if (creep.memory.debug) {
				info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' is harvesting from source ' + MainUtil.getDisplayName(source), this._baseRoom);
			}
		} else {
			this._handleSourceWorkResult(creep, harvestResult);
		}
		return harvestResult;
	}

	/*
	 * Returns the closest source for the creep, e.g. sources or storages.
	 * 
	 * @param {Creep} creep
	 */

	_findClosestSource(creep) {
		var specificSource;
		if (creep.memory.source) {
			// creep has specific source in mind
			specificSource = Game.getObjectById(creep.memory.source);
			if (specificSource && this._sourceMode == RolePrototype.SOURCE_MODE_USE_OR_WAIT) {
				// only in TARGET_MODE_USE_OR_WAIT we don't care for the validity of the source
				return specificSource;
			}
			if (!specificSource) {
				info.error(MainUtil.getDisplayName(creep) + ' could not find source: ' + creep.memory.source);

				if (this._sourceMode != RolePrototype.SOURCE_MODE_USE_IF_VALID) {
					// only in SOURCE_MODE_USE_IF_VALID can we recover from that error
					return null;
				}
			}
		}
		var sources = this._findSources(this._baseRoom);
		if (sources) {
			// let's see if we found our pre-selected source
			if (specificSource) {
				var found = sources.filter(t => t.id == specificSource.id);
				if (found.length > 0) {
					return found[0];
				}
				// our specific source is not valid 
				// - SOURCE_MODE_USE_OR_ERROR errors out
				// - SOURCE_MODE_USE_IF_VALID falls back to valid source
				if (this._sourceMode == RolePrototype.SOURCE_MODE_USE_OR_ERROR) {
					info.error(MainUtil.getDisplayName(creep) + ' could not find source in list: ' + creep.memory.source);
					return null;
				}
			}
			sources = this._sortSourceForClosest(sources, creep);
			if (sources.length > 0) {
				var selectedSource = sources[0];
				// Remember this source assignment for load balancing
				if (creep.memory.source !== selectedSource.id) {
					creep.memory.source = selectedSource.id;
					if (creep.memory.debug) {
						info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' assigned to source ' + selectedSource.id, this._baseRoom);
					}
				}
				return selectedSource;
			}
		}
		return null;
	}

	/*
	 * Sorts the sources so the closest is first. If there are other things to
	 * take into consideration, this function is overriden.
	 * 
	 * @param {Creep} creep
	 */

	_sortSourceForClosest(sources, creep) {
		return sources.sort((a, b) => {
			var countDiff = MainCache.getSourceAssignmentCount(a.id) - MainCache.getSourceAssignmentCount(b.id);
			if (countDiff !== 0) {
				return countDiff;
			}
			return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
		});
	}

	/*
	 * Returns the primary target for the creep, e.g. energy stores for
	 * harvester and construction sites for builders.
	 * 
	 * @param {Room} room
	 */

	_findSources(room) {
		var storages = this._useStorageAsSource ? MainCache.find(room, FIND_STRUCTURES).filter(structure => {
			return (structure.structureType == STRUCTURE_STORAGE ||
				structure.structureType == STRUCTURE_CONTAINER ||
				(structure.structureType == STRUCTURE_LINK && MainUtil.fetchMemoryOfStructure(structure).type == constants.LINK_TYPE_TARGET)) &&
				structure.store.getUsedCapacity(this._resourceType) > 0;
		}) : [];

		return storages.concat(this._findActiveSources(room));
	}

	_findActiveSources(room) {
		if (!this._useSourceAsSource) {
			return [];
		}
		return MainCache.find(room, FIND_SOURCES_ACTIVE).filter(source => {
			return source.energy > 0 && MainCache.getMinerCount(source.id) == 0;
		});
	}

	/*
	 * Handles result of harvest on source.
	 * 
	 * @param {Creep} creep @param harvest result
	 */

	_handleSourceWorkResult(creep, harvestResult) {
		// Handle common error cases gracefully
		switch (harvestResult) {
			case ERR_NOT_ENOUGH_RESOURCES:
				// Source is empty or doesn't have enough resources
				if (creep.memory.debug) {
					info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' source is empty', this._baseRoom);
				}
				creep.memory.source = null; // Clear source so creep finds a new one
				break;
			case ERR_INVALID_TARGET:
				// Source is no longer valid
				if (creep.memory.debug) {
					info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' source is invalid', this._baseRoom);
				}
				creep.memory.source = null;
				break;
			case ERR_NOT_OWNER:
				// Can't harvest from this source (shouldn't happen normally)
				info.warning(MainUtil.getDisplayName(creep) + ' cannot harvest: not owner');
				creep.memory.source = null;
				break;
			case ERR_BUSY:
				// Creep is busy (spawning, etc.)
				if (creep.memory.debug) {
					info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' is busy', this._baseRoom);
				}
				break;
			case ERR_TIRED:
				// Extractor cooldown
				if (creep.memory.debug) {
					info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' extractor is on cooldown', this._baseRoom);
				}
				break;
			default:
				info.warning(MainUtil.getDisplayName(creep) + ' cannot harvest: ' + harvestResult);
				break;
		}
	}

	/*
	 * Creep AI gets run. Creep might decide working is not in its best
	 * interest.
	 * 
	 * @param {Creep} creep
	 * @param baseRoom
	 * @param sourcePolicy optional per-run source overrides
	 */

	run(creep, baseRoom = RolePrototype._fetchBaseRoomForCreep(creep), sourcePolicy = {}) {
		this._creep = creep;
		this._baseRoom = baseRoom;

		// we want to keep track when a creep is actually moving
		creep.memory.moving = false;

		// init values from room memory
		var memoryRoleConfig = MemoryManager.fetchRoomRoleConfigForBase(creep.memory.home, [this]);
		var useStorageAsSource = !memoryRoleConfig || memoryRoleConfig.useStorageAsSource;
		var useSourceAsSource = !memoryRoleConfig || memoryRoleConfig.useSourceAsSource;
		this._useStorageAsSource = sourcePolicy.useStorageAsSource === undefined ? useStorageAsSource : sourcePolicy.useStorageAsSource;
		this._useSourceAsSource = sourcePolicy.useSourceAsSource === undefined ? useSourceAsSource : sourcePolicy.useSourceAsSource;

		// TOP PRIORITY: Boss tells me to move to a specific game object

		if (creep.memory.moveToGameObject) {
			var gameObject = Game.getObjectById(creep.memory.moveToGameObject);
			if (!gameObject) {
				info.warning(MainUtil.getDisplayName(creep) + ' could not find movement target: ' + creep.memory.moveToGameObject);
				creep.memory.moveToGameObject = null;
			} else if (creep.pos.isNearTo(gameObject)) {
				creep.memory.moveToGameObject = null;
			} else {
				this._moveToLocation(creep, gameObject);
				return;
			}
		}

		// self-destructing is more important than working

		if (creep.memory.selfdestruct) {
			this._selfdestruct(creep);
			return;
		}

		if (this._disableAutomaticLoot) {
			this._work(creep);
			return;
		}

		// picking up the role's resource is more important than working

		var droppedResources = MainCache.find(creep.room, FIND_DROPPED_RESOURCES)
			.filter(e => e.amount > 0 && creep.pos.inRangeTo(e, 3) && e.resourceType == this._resourceType)
			.sort((a, b) => b.amount - a.amount); // Prioritize larger piles
		if (droppedResources.length > 0 && creep.store.getFreeCapacity() > 0) {
			if (creep.memory.debug) {
				info.log('🟡 ' + MainUtil.getDisplayName(creep) + ' is picking up resource ' + MainUtil.getDisplayName(droppedResources[0]), this._baseRoom);
			}
			var pickupResult = creep.pickup(droppedResources[0]);
			if (pickupResult == ERR_NOT_IN_RANGE) {
				this._moveToLocation(creep, droppedResources[0]);
				return;
			}
			if (pickupResult == OK) {
				MainCache.invalidateRoom(creep.room, FIND_DROPPED_RESOURCES);
			}
			// No return after successful pickup - creeps can pickup resources and continue to work
		}

		// looting a tombstone is more important than working
		var tombstones = MainCache.find(creep.room, FIND_TOMBSTONES)
			.filter(t => creep.pos.inRangeTo(t, 3) && t.store.getUsedCapacity(this._resourceType) > 0);
		if (tombstones.length > 0 && creep.store.getFreeCapacity() > 0) {
			var withdrawResult = creep.withdraw(tombstones[0], this._resourceType);
			if (withdrawResult == ERR_NOT_IN_RANGE) {
				if (creep.memory.debug) {
					info.log('⚰ ' + MainUtil.getDisplayName(creep) + ' is moving to tombstone ' + MainUtil.getDisplayName(tombstones[0]), this._baseRoom);
				}
				this._moveToLocation(creep, tombstones[0]);
				return;
			} else if (withdrawResult == OK) {
				if (creep.memory.debug) {
					info.log('⚰ ' + MainUtil.getDisplayName(creep) + ' is looting the tombstone ' + MainUtil.getDisplayName(tombstones[0]), this._baseRoom);
				}
				// Continue to work after successful loot
			} else if (withdrawResult == ERR_NOT_ENOUGH_RESOURCES) {
				// Tombstone was depleted, continue to work
				if (creep.memory.debug) {
					info.log('⚰ ' + MainUtil.getDisplayName(creep) + ' tombstone was already looted', this._baseRoom);
				}
			} else {
				info.log('⚰ ' + MainUtil.getDisplayName(creep) + ' cannot loot the tombstone: ' + withdrawResult, this._baseRoom);
			}
		}

		// looting ruins is important - they can contain significant resources
		var ruins = MainCache.find(creep.room, FIND_RUINS)
			.filter(r => creep.pos.inRangeTo(r, 3) && r.store.getUsedCapacity(this._resourceType) > 0);
		if (ruins.length > 0 && creep.store.getFreeCapacity() > 0) {
			var withdrawResult = creep.withdraw(ruins[0], this._resourceType);
			if (withdrawResult == ERR_NOT_IN_RANGE) {
				if (creep.memory.debug) {
					info.log('🏚️ ' + MainUtil.getDisplayName(creep) + ' is moving to ruin ' + MainUtil.getDisplayName(ruins[0]), this._baseRoom);
				}
				this._moveToLocation(creep, ruins[0]);
				return;
			} else if (withdrawResult == OK) {
				if (creep.memory.debug) {
					info.log('🏚️ ' + MainUtil.getDisplayName(creep) + ' is looting the ruin ' + MainUtil.getDisplayName(ruins[0]), this._baseRoom);
				}
				// Continue to work after successful loot
			} else if (withdrawResult == ERR_NOT_ENOUGH_RESOURCES) {
				// Ruin was depleted, continue to work
				if (creep.memory.debug) {
					info.log('🏚️ ' + MainUtil.getDisplayName(creep) + ' ruin was already looted', this._baseRoom);
				}
			} else {
				info.log('🏚️ ' + MainUtil.getDisplayName(creep) + ' cannot loot the ruin: ' + withdrawResult, this._baseRoom);
			}
		}

		this._work(creep);
	}

	/*
	 * Creep self-destructs or tries to anyway.
	 * 
	 * @param {Creep} creep
	 */

	_selfdestruct(creep) {
		var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
		if (spawn) {
			var recycleAnswer = spawn.recycleCreep(creep);
			if (recycleAnswer == ERR_NOT_IN_RANGE) {
				if (creep.memory.debug) {
					info.log('🔙 ' + MainUtil.getDisplayName(creep) + ' is moving to spawn ' + spawn.id, this._baseRoom);
				}
				this._moveToLocation(creep, spawn);
			} else if (recycleAnswer == OK) {
				if (creep.memory.debug) {
					info.log('🗑 ' + MainUtil.getDisplayName(creep) + ' was recycled.', this._baseRoom);
				}
			}
		} else {
			info.error(MainUtil.getDisplayName(creep) + ' could not find a spawn.', this._baseRoom);
		}
	}

	/*
	 * Finds the room of the creep's base.
	 * 
	 * @param {Creep} creep
	 */

	static _fetchBaseRoomForCreep(creep) {
		var baseRoom = RolePrototype._fetchBaseRoomForName(creep.memory.home);
		return baseRoom ? baseRoom : creep.room;
	}

	/*
	 * Finds the room for the base namse.
	 * 
	 * @param baseName
	 */

	static _fetchBaseRoomForName(baseName) {
		var allRooms = MainUtil.findAllRooms();
		var baseRooms = allRooms ? allRooms.filter(room => room.memory.base ? room.memory.base.name == baseName : false) : [];
		if (baseRooms.length > 0) {
			return baseRooms[0];
		}
		return null;
	}

	/*
	 * Creep works.
	 * 
	 * @param {Creep} creep
	 */

	_work(creep) {
		// do nothing on default
		creep.say('🛑 unimplemented 🛑');
	}

	/*
	 * Creep goes to source until full, then works till it's empty and starts
	 * over.
	 * 
	 * @param {Creep} creep @param function the work that should be done there
	 */

	_commuteBetweenSourceAndTarget(creep, work) {
		var usedCapacity = creep.store.getUsedCapacity(this._resourceType) || 0;
		if (creep.memory.working && usedCapacity == 0) {
			creep.memory.working = false;
		}
		if (!creep.memory.working && (creep.store.getFreeCapacity(this._resourceType) == 0 ||
			(usedCapacity > 0 && this._findSources(this._baseRoom).length == 0))) {
			creep.memory.working = true;
		}

		if (creep.memory.working) {
			this._moveToClosestTarget(creep, work);
		} else {
			this._moveToClosestSource(creep);
		}
	}

	/*
	 * Spawns a creep that has the needed parts (or many of them) and a single
	 * part of some other type.
	 * 
	 * @param {Spawn} spawn @param parts to duplicate @param singleParts that
	 * are added as is
	 */

	_spawnCreepWithParts(spawn, parts, singleParts = [], options = {}) {
		var body = this._calculateMaxParts(spawn, parts, singleParts, options);
		if (!body) {
			return false;
		}
		var memory = {
			role: this.roleName,
			home: spawn.memory.home,
		};
		var boostDecision = LabManager.planSpawnBoost(spawn, body, this.roleName, memory, options);
		if (!boostDecision.allow) return false;
		var newName = this._createCreepName(spawn);
		var spawnResult = spawn.spawnCreep(body, newName, { memory: memory });
		if (spawnResult == OK) {
			var resultingCreep = Game.creeps[newName];
			if (boostDecision.plan) LabManager.registerSpawnBoost(resultingCreep, boostDecision.plan);
			MainCache.recordSpawn(resultingCreep, spawn);
			return resultingCreep;
		}
		var message = 'Could not spawn ' + this.roleName + ' ' + newName + ' (' + body.length + ' parts, ' + this._calculateCostsForParts(body) + ' energy): ' + spawnResult;
		if (spawnResult == ERR_NOT_ENOUGH_ENERGY || spawnResult == ERR_BUSY) {
			if (spawn.memory.debug) {
				info.log(message, spawn.room);
			}
		} else {
			info.error(message, spawn.room);
		}
		return false;
	}

	_spawnCreepWithBody(spawn, body, memory) {
		if (!Array.isArray(body) || body.length === 0 || body.length > 50) return false;
		var cost = this._calculateCostsForParts(body);
		if (!Number.isFinite(cost) || cost > spawn.room.energyAvailable) return false;
		body = body.slice();
		var boostDecision = LabManager.planSpawnBoost(spawn, body, this.roleName, memory);
		if (!boostDecision.allow) return false;
		var newName = this._createCreepName(spawn);
		var spawnResult = spawn.spawnCreep(body, newName, { memory: memory });
		if (spawnResult == OK) {
			var resultingCreep = Game.creeps[newName];
			if (boostDecision.plan) LabManager.registerSpawnBoost(resultingCreep, boostDecision.plan);
			MainCache.recordSpawn(resultingCreep, spawn);
			return resultingCreep;
		}
		var message = 'Could not spawn ' + this.roleName + ' ' + newName + ' (' + body.length + ' parts, ' + cost + ' energy): ' + spawnResult;
		if (spawnResult == ERR_NOT_ENOUGH_ENERGY || spawnResult == ERR_BUSY) {
			if (spawn.memory.debug) info.log(message, spawn.room);
		} else {
			info.error(message, spawn.room);
		}
		return false;
	}

	_createCreepName(spawn) {
		var baseName = this.roleName + ' ' + spawn.name + ' ' + Game.time;
		var newName = baseName;
		var suffix = 1;
		while (Game.creeps[newName]) {
			newName = baseName + ' ' + suffix++;
		}
		return newName;
	}

	// after this point, the rest are only helper methods

	/*
	 * Calculate the max parts we can afford.
	 * 
	 * @param {Spawn} spawn @param parts to duplicate @param singleParts that
	 * are added as is
	 */

	_calculateMaxParts(spawn, parts = [], singleParts = [], options = {}) {
		parts = parts || [];
		singleParts = singleParts || [];
		var costs = this._calculateCostsForParts(parts);
		var singleCosts = this._calculateCostsForParts(singleParts);
		if (!Number.isFinite(costs) || !Number.isFinite(singleCosts) || parts.length + singleParts.length == 0 || singleParts.length > 50) {
			return null;
		}

		if (options.exact) {
			return parts.length + singleParts.length <= 50 && costs + singleCosts <= spawn.room.energyAvailable ? singleParts.concat(parts) : null;
		}

		var minMultiplier = Math.floor(Number(this._getPartsMinMultiplier(spawn)));
		var maxMultiplier = Math.floor(Number(this._getPartsMaxMultiplier(spawn)));
		if (!Number.isFinite(minMultiplier) || !Number.isFinite(maxMultiplier)) {
			return null;
		}
		minMultiplier = Math.max(1, minMultiplier);
		var partLimitedMax = parts.length > 0 ? Math.floor((50 - singleParts.length) / parts.length) : maxMultiplier;
		maxMultiplier = Math.min(maxMultiplier, partLimitedMax);
		if (minMultiplier > maxMultiplier || maxMultiplier < 1) {
			return null;
		}
		if (minMultiplier * costs + singleCosts > spawn.room.energyAvailable) {
			return null;
		}

		var multiplier = minMultiplier;
		while (multiplier < maxMultiplier && (multiplier + 1) * costs + singleCosts <= spawn.room.energyAvailable) {
			multiplier++;
		}

		return singleParts.concat(this._replicateParts(parts, multiplier));
	}

	/*
	 * Returns the minimum multiplier for the parts for this role.
	 * 
	 * @param {Spawn} spawn
	 */

	_getPartsMinMultiplier(spawn) {
		return (spawn.room.memory.base && spawn.room.memory.base.roleConfig && spawn.room.memory.base.roleConfig.partsMinMultiplier) || 0;
	}

	/*
	 * Returns the maximum multiplier for the parts for this role.
	 * 
	 * @param {Spawn} spawn
	 */

	_getPartsMaxMultiplier(spawn) {
		return (spawn.room.memory.base && spawn.room.memory.base.roleConfig && spawn.room.memory.base.roleConfig.partsMaxMultiplier) || 5;
	}

	/*
	 * Calculates the costs for the parts in the array.
	 * 
	 * @param parts array
	 */

	_calculateCostsForParts(parts) {
		var result = 0;
		parts.forEach(part => result += this._calculateCostsForSinglePart(part));
		return result;
	}

	/*
	 * Calculates the costs for a single part.
	 * 
	 * @param part
	 */

	_calculateCostsForSinglePart(part) {
		return BODYPART_COST[part];
	}

	/*
	 * Creates a new array and puts the parts array in there a specific amount
	 * of times.
	 * 
	 * @param part array @param multiplier how often to replicate the array
	 */

	_replicateParts(parts, multiplier) {
		var result = [];
		for (var i = 0; i < multiplier; i++) {
			result = result.concat(parts);
		}
		return result;
	}

};

/* Use the target if valid, else switch to any other one */
RolePrototype.TARGET_MODE_USE_IF_VALID = 'useIfValid';
/* Use the target if valid, else wait for it to become valid */
RolePrototype.TARGET_MODE_USE_OR_WAIT = 'useOrWait';
/* Use the target if valid, else throw an error */
RolePrototype.TARGET_MODE_USE_OR_ERROR = 'useOrError';

/* Use the source if valid, else switch to any other one */
RolePrototype.SOURCE_MODE_USE_IF_VALID = 'useIfValid';
/* Use the source if valid, else wait for it to become valid */
RolePrototype.SOURCE_MODE_USE_OR_WAIT = 'useOrWait';
/* Use the source if valid, else throw an error */
RolePrototype.SOURCE_MODE_USE_OR_ERROR = 'useOrError';

module.exports = RolePrototype;