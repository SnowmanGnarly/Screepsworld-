/*
 * An explorer goes straight to the next flag, conquering it and starting
 * a new base there.
 */
 
var info = require('./main.info');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');

var MemoryManager = require('./manager.memory');

var Builder = require('./role.builder');
var RolePrototype = require('./role.prototype');

const PHASE_GOTO_FLAG_ROOM = 'gotoFlagRoom';
const PHASE_CLAIM_FLAG_ROOM = 'claimFlagRoom';
const PHASE_CREATE_SPAWN = 'createSpawn';
const PHASE_BUILD_SPAWN = 'buildSpawn';
const PHASE_RETIRE = 'retire';

class Explorer extends RolePrototype {
		
	constructor() {
		super('Explorer', '#cccccc', '🏴');

	    this._targetMode = RolePrototype.TARGET_MODE_USE_OR_ERROR;
	}

	_findTargets(room) {
	    return MainUtil.findAllFlags().slice();
	}
	
	spawnCreep(spawn) {
		var claimedFlags = MainUtil.findAllCreeps()
			.filter(creep => creep.memory.role == 'Explorer')
			.map(creep => creep.memory.targetFlag || creep.memory.target)
			.filter(flagName => !!flagName);
		var allFlags = MainUtil.findAllFlags().filter(flag => !claimedFlags.includes(flag.name));
		if (allFlags.length > 0)
			return this._spawnCreepFromSpawn(spawn, allFlags[0].name);
		return false;
	}

	spawnCreepFromSpawnName(spawnName, flagName) {
	    var spawns = MainUtil.findAllSpawns().filter(spawn => spawn.name == spawnName);
	    if (spawns.length == 0) {
	    	info.error('Could not find spawn: ' + spawnName);
	    	return false;
	    }
	    var spawn = spawns[0];
	    var resultingCreep = this._spawnCreepFromSpawn(spawn, flagName);
	    if (resultingCreep) {
	        info.log(this.symbol + ' Spawning new ' + this.roleName + ' (' + resultingCreep.body.length + 'p)');
	        return resultingCreep;
	    }
	    return resultingCreep;
	}

	_spawnCreepFromSpawn(spawn, flagName) {
	    var resultingCreep = this._spawnCreepWithParts(spawn, [WORK, MOVE, CARRY, MOVE], [ CLAIM, MOVE ]);
	    if (resultingCreep) {
	        resultingCreep.memory.targetFlag = flagName;
	        resultingCreep.memory.target = null;
	        if (Game.flags[flagName]) {
	        	resultingCreep.memory.targetRoom = Game.flags[flagName].pos.roomName;
	        }
	    }
	    return resultingCreep;
	}

	_work(creep) {
		this._migrateTargetMemory(creep);
		if (!creep.memory.phase) {
			creep.memory.phase = PHASE_GOTO_FLAG_ROOM;
		}
    
	    switch (creep.memory.phase) {
	        case PHASE_GOTO_FLAG_ROOM:
	            this._goToFlagRoom(creep);
	            break;
	        case PHASE_CLAIM_FLAG_ROOM:
	            this._claimFlagRoom(creep);
	            break;
	        case PHASE_CREATE_SPAWN:
	            this._createSpawn(creep);
	            break;
	        case PHASE_BUILD_SPAWN:
	            this._buildSpawn(creep);
	            break;
	        case PHASE_RETIRE:
	            this._retire(creep);
	            break;
	        default:
	    	    info.error(MainUtil.getDisplayName(creep) + ' has no recognized phase: ' + creep.memory.phase);
	            break;
	    }
	}

	_migrateTargetMemory(creep) {
		if (!creep.memory.targetFlag && creep.memory.target) {
			creep.memory.targetFlag = creep.memory.target;
			creep.memory.target = null;
		}
		var targetFlag = this._findTargetFlag(creep);
		if (targetFlag) {
			creep.memory.targetRoom = targetFlag.pos.roomName;
		}
	}

	_findTargetFlag(creep) {
		return creep.memory.targetFlag ? Game.flags[creep.memory.targetFlag] : null;
	}

	_isInTargetRoom(creep) {
		return !!creep.memory.targetRoom && creep.room.name == creep.memory.targetRoom;
	}

	_waitForTargetRoom(creep) {
		var targetFlag = this._findTargetFlag(creep);
		if (targetFlag) {
			this._moveToLocation(creep, targetFlag);
		} else {
			info.warning(MainUtil.getDisplayName(creep) + ' cannot find expansion target: ' + creep.memory.targetFlag);
		}
	}
	 
	_goToFlagRoom(creep) {
	    var targetFlag = this._findTargetFlag(creep);
	    if (!targetFlag && creep.memory.targetFlag) {
	    	info.warning(MainUtil.getDisplayName(creep) + ' cannot find expansion flag: ' + creep.memory.targetFlag);
	    	return;
	    }
	    if (!targetFlag) {
	        targetFlag = this._findClosestTarget(creep);
	        if (!targetFlag) {
	        	info.warning(MainUtil.getDisplayName(creep) + ' found no expansion flag');
	        	return;
	        }
	        creep.memory.targetFlag = targetFlag.name;
	        creep.memory.targetRoom = targetFlag.pos.roomName;
    	    info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' travels to ' + targetFlag.name);
	    }
	    
	    this._moveToLocation(creep, targetFlag);
	    
	    if (creep.room.name == targetFlag.pos.roomName) {
	    	var hasRoomAlready = creep.room.controller.my;
	        creep.memory.phase = hasRoomAlready ? PHASE_CREATE_SPAWN : PHASE_CLAIM_FLAG_ROOM;
	        info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' claims the room of ' + targetFlag.name);
	    }
	}
	 
	_claimFlagRoom(creep) {
		if (!this._isInTargetRoom(creep)) {
			this._waitForTargetRoom(creep);
			return;
		}
		var controller = creep.room.controller;
		if (!controller) {
			info.warning(MainUtil.getDisplayName(creep) + ' cannot find a controller in ' + creep.room.name);
			return;
		}
      	var answer = creep.claimController(controller);
      	if (answer == ERR_NOT_IN_RANGE) {
      		this._moveToLocation(creep, controller);
      	} else if (answer == OK) {
      		creep.memory.phase = PHASE_CREATE_SPAWN;
      	} else {
      		info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' cannot claim: ' + answer);
      	}

	    if (controller.my) {
	    	var hasSpawnAlready = this._findSpawns(creep.room).length > 0;
	        creep.memory.phase = hasSpawnAlready ? PHASE_BUILD_SPAWN : PHASE_CREATE_SPAWN;
	        info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' builds spawn ' + creep.memory.targetFlag);
	    }
	}

    _findSpawns(room) {
        return MainCache.find(room, FIND_MY_SPAWNS);
    }
	
	_createSpawn(creep) {
		if (!this._isInTargetRoom(creep)) {
			this._waitForTargetRoom(creep);
			return;
		}
    	var hasSpawnAlready = this._findSpawns(creep.room).length > 0;
    	if (hasSpawnAlready) {
	        creep.memory.phase = PHASE_RETIRE;
	        this._retire(creep);
	        return;
    	}
    	
    	var hasSpawnConstructionSiteAlready = MainCache.find(creep.room, FIND_MY_CONSTRUCTION_SITES, { filter: site => site.structureType == STRUCTURE_SPAWN }).length > 0;
    	if (hasSpawnConstructionSiteAlready) {
	        info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' is a Builder now.');
	        creep.memory.phase = PHASE_BUILD_SPAWN;
	        return;
    	}
    	
        var targetFlag = this._findTargetFlag(creep);
        if (!targetFlag) {
        	info.warning(MainUtil.getDisplayName(creep) + ' cannot place a spawn without flag: ' + creep.memory.targetFlag);
        	return;
        }
        var createResult = targetFlag.pos.createConstructionSite(STRUCTURE_SPAWN, targetFlag.name);
        if (createResult == OK) {
        	MainCache.invalidateRoom(creep.room, FIND_MY_CONSTRUCTION_SITES);
        	MainCache.invalidateRoom(creep.room, FIND_CONSTRUCTION_SITES);
	        info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' is a Builder now.');
	        creep.memory.phase = PHASE_BUILD_SPAWN;
        } else  {
	        info.error(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' could not create spawn: ' + createResult);
        }
    }
	
	_buildSpawn(creep) {
		if (!this._isInTargetRoom(creep)) {
			this._waitForTargetRoom(creep);
			return;
		}
		new Builder().run(creep, creep.room, { useSourceAsSource: true });
		
		if (this._findSpawns(creep.room).length > 0) {
	        creep.memory.phase = PHASE_RETIRE;
	        this._retire(creep);
		}
	}
	
	_retire(creep) {
		if (!this._isInTargetRoom(creep) || this._findSpawns(creep.room).length == 0) {
			info.warning(MainUtil.getDisplayName(creep) + ' cannot finish expansion before its destination spawn exists');
			return;
		}
		var targetName = creep.memory.targetFlag;
		if (!targetName) {
			info.warning(MainUtil.getDisplayName(creep) + ' cannot finish expansion without a base name');
			return;
		}
		var targetFlag = this._findTargetFlag(creep);
        info.log(this.symbol + ' ' + MainUtil.getDisplayName(creep) + ' has finished ' + targetName);
        
        MemoryManager.fetchRoomBase(creep.room, targetName);

        if (targetFlag) {
        	targetFlag.remove();
        	MainCache.invalidateFlags();
        }
        
    	creep.memory.home = targetName;
    	creep.memory.role = 'Harvester';
    	creep.memory.target = null;
    	delete creep.memory.targetFlag;
    	delete creep.memory.targetRoom;
    	delete creep.memory.phase;
	}
}

module.exports = Explorer;
