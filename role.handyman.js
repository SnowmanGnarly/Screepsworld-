/*
 * Handymen repair buildings. 
 */
 
var constants = require('./main.constants');
var MainCache = require('./main.cache');
var RolePrototype = require('./role.prototype');
 
class Handyman extends RolePrototype {

	constructor() {
		super('Handyman', '#0000ff', '🔧');
	}
	
    _work(creep) {
    	this._commuteBetweenSourceAndTarget(creep, target => creep.repair(target));
    }
    
    _findTargets(room) {
    	var necessaryDamageInPercent = 0.95;
        var results = MainCache.find(room, FIND_STRUCTURES, {
            filter: structure => {
            	return (structure.structureType == STRUCTURE_ROAD ||
                        structure.structureType == STRUCTURE_CONTAINER) &&
                        structure.hits / structure.hitsMax < necessaryDamageInPercent;
            }
        });
        if (results.length > 0) {
        	return results;
        }

        var wallTargetHits = this._getWallTargetHits(room);
        return MainCache.find(room, FIND_STRUCTURES, {
            filter: structure => {
            	return (structure.structureType == STRUCTURE_WALL ||
                        structure.structureType == STRUCTURE_RAMPART) &&
                        structure.hits < wallTargetHits;
            }
        });
    }

    _getWallTargetHits(room) {
    	var level = room.controller && room.controller.level ? room.controller.level : 1;
    	var targetHits = Math.min(
    		constants.WALL_REPAIR_MAX_HITS,
    		constants.WALL_REPAIR_BASE_HITS * Math.pow(2, Math.max(0, level - 1))
    	);
    	if (MainCache.find(room, FIND_HOSTILE_CREEPS).length > 0) {
    		targetHits *= constants.WALL_REPAIR_THREAT_MULTIPLIER;
    	}
    	return targetHits;
    }
    
    _sortTargetForClosest(targets, creep) {
    	var wallTargetHits = this._getWallTargetHits(creep.room);
    	var getRepairProgress = structure => {
    		if (structure.structureType == STRUCTURE_WALL || structure.structureType == STRUCTURE_RAMPART) {
    			return structure.hits / wallTargetHits;
    		}
    		return structure.hits / structure.hitsMax;
    	};
        var result = targets.sort((a, b) => {
        	var progressDifference = getRepairProgress(a) - getRepairProgress(b);
        	return progressDifference || creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
        });
        if (result.length > 0) {
            creep.memory.target = result[0].id;
        }
        return result;
    }
        
}

module.exports = Handyman;
