/*
 * This manager handles the links and to send resources.
 */

var constants = require('./main.constants');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');

var MemoryManager = require('./manager.memory');

const TYPE_TARGET = constants.LINK_TYPE_TARGET;
const TYPE_SOURCE = constants.LINK_TYPE_SOURCE;

class LinkManager {
	 
	/*
	 * Performs 'runLinks()' on an instance of LinkManager for each room. 
	 * 
	 * @param allRoles
	 */
	
	static runAll() {
	    MainUtil.findAllRooms().forEach(room => new LinkManager(room).runLinks());
	}
	
	/*
	 * Adds the type 'target' to the game object with the specified ID.
	 * 
	 * @param linkId
	 */

	static makeLinkTarget(linkId) {
		LinkManager._makeLinkType(linkId, TYPE_TARGET);
	}

	/*
	 * Adds the type 'source' to the game object with the specified ID.
	 * 
	 * @param linkId
	 */

	static makeLinkSource(linkId) {
		LinkManager._makeLinkType(linkId, TYPE_SOURCE);
	}

	/*
	 * Adds the specified type to the game object with the specified ID.
	 * 
	 * @param linkId
	 * @param type
	 */

	static _makeLinkType(linkId, type) {
		var object = Game.getObjectById(linkId);
		var memory = MainUtil.fetchMemoryOfStructure(object);
		memory.type = type; 
	}
	
	constructor(room) {
	    this._room = room;
	}
	
	/*
	 * Handles all links in this room.
	 */
	
	runLinks() {
		this._applyPlannedRoles();
		var allSourceLinks = this._findSourceLinks();
		allSourceLinks.forEach(sourceLink => this._runLink(sourceLink));
	}

	_applyPlannedRoles() {
		var managerMemory = this._room.memory.roomManager;
		if (!managerMemory || !managerMemory.linkRoles) return;
		MainCache.find(this._room, FIND_MY_STRUCTURES, {
			filter: structure => structure.structureType == STRUCTURE_LINK
		}).forEach(link => {
			var plannedRole = managerMemory.linkRoles[link.pos.x + ',' + link.pos.y];
			if (!plannedRole) return;
			var memory = MainUtil.fetchMemoryOfStructure(link);
			if (!memory.type) memory.type = plannedRole;
		});
	}

	/*
	 * Finds all links that are sources for link-to-link communication.
	 */
	
	_findSourceLinks() {
		return MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: (structure) => {
            	if (structure.structureType != STRUCTURE_LINK) {
            		return false;
            	}
        		var memory = MainUtil.fetchMemoryOfStructure(structure);
            	if (!memory.type) {
            		memory.type = TYPE_SOURCE;
            	}
                return memory.type == TYPE_SOURCE 
                	&& structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
            }
		});
	}

	/*
	 * Handles the specific link in this room.
	 */
	
	_runLink(sourceLink) { 

		if (sourceLink.cooldown) {
			return;
		}
		
		var targetLink = this._findTargetLink(sourceLink);
		if (targetLink) {
			var amount = Math.min(
				sourceLink.store.getUsedCapacity(RESOURCE_ENERGY),
				targetLink.store.getFreeCapacity(RESOURCE_ENERGY)
			);
			var transferResult = sourceLink.transferEnergy(targetLink, amount);
			var debug = MainUtil.fetchMemoryOfStructure(sourceLink).debug || MainUtil.fetchMemoryOfStructure(targetLink).debug;
			if (transferResult == OK) {
				if (debug) {
					info.log('💫 Transferred ' + amount + ' energy from ' + MainUtil.getDisplayName(sourceLink) + ' to ' + MainUtil.getDisplayName(targetLink), this._room);
				}
			} else if (transferResult == ERR_FULL || transferResult == ERR_NOT_ENOUGH_RESOURCES) {
				if (debug) {
					info.log('💫 Link transfer skipped: ' + transferResult, this._room);
				}
			} else {
				info.error('Link transfer from ' + MainUtil.getDisplayName(sourceLink) + ' to ' + MainUtil.getDisplayName(targetLink) + ' failed: ' + transferResult, this._room);
			}
		}
	}

	/*
	 * Finds a target for the specific source link.
	 */
	
	_findTargetLink(sourceLink) { 
		// TODO: sort by capacity?
		var targetLinks = MainCache.find(this._room, FIND_MY_STRUCTURES, {
	        filter: (structure) => {
	        	if (structure.structureType != STRUCTURE_LINK) {
	        		return false;
	        	}
	            return MainUtil.fetchMemoryOfStructure(structure).type == TYPE_TARGET
	            	&& structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
	        }
		});
		if (targetLinks.length == 0) {
			if (MainUtil.fetchMemoryOfStructure(sourceLink).debug) {
				info.warning('Link ' + MainUtil.getDisplayName(sourceLink) + ' did not find targets');
			}
			return null;
		}
		return targetLinks[0];
	}
};

module.exports = LinkManager;