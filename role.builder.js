/*
 * Builders create buildings. 
 */
 
var MainCache = require('./main.cache');
var EconomyManager = require('./manager.economy');
var RolePrototype = require('./role.prototype');
 
class Builder extends RolePrototype {

	constructor() {
		super('Builder', '#ffff00', '🔨');
	}

	getDemand(room) {
		return EconomyManager.getDesiredBuilders(room);
	}

	_getUsefulBodyUnits(room) {
		return EconomyManager.getBuilderWorkParts(room);
	}

	/*
	 * Just transfer energy between source and and the construction sites.
	 */
	
    _work(creep) {
    	this._commuteBetweenSourceAndTarget(creep, target => creep.build(target));
    }
    
    /*
     * Stays on one site until it is done. Re-sorting every tick makes a Builder hop between
     * sites, and each hop wastes the walk.
     */

    _findClosestTarget(creep) {
    	if (creep.memory.target) return super._findClosestTarget(creep);
    	var current = creep.memory.buildTarget && Game.getObjectById(creep.memory.buildTarget);
    	if (current) return current;
    	var target = super._findClosestTarget(creep);
    	if (target) creep.memory.buildTarget = target.id;
    	else if (creep.memory.buildTarget) delete creep.memory.buildTarget;
    	return target;
    }

    /*
     * Valid targets are construction sites.
     */
    
    _findTargets(room) {
        return MainCache.find(room, FIND_MY_CONSTRUCTION_SITES)
            .filter(site => site.progress < site.progressTotal);
    }

	/*
	 * Takes the closest to creep and closest to completion.
	 */
    
    _sortTargetForClosest(targets, creep) {
        return targets.sort((a, b) => {
        	var rangeA = creep.pos.getRangeTo(a);
        	var rangeB = creep.pos.getRangeTo(b);
        	var compare = Math.floor(rangeA / 5) - Math.floor(rangeB / 5);
        	if (compare) return compare;
        	
        	var progressLeftA = a.progressTotal - a.progress;
        	var progressLeftB = b.progressTotal - b.progress;
        	var compare = progressLeftA - progressLeftB;
        	if (compare) return compare;
        	
        	return compare;
        });
    }
        
}

module.exports = Builder;
