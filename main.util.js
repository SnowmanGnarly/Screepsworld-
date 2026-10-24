/*
 * These methods _really_ should be game methods, but oh well ¯\_(ツ)_/¯
 */

var MainCache = require('./main.cache');

class MainUtil {

	/*
	 * Finds all spawns in the game and puts them in an array.
	 */
    
    static findAllSpawns() {
        return MainCache.getSpawns();
    }
    
	/*
	 * Finds all creeps in the game and puts them in an array.
	 */
    
    static findAllCreeps() {
        return MainCache.getCreeps();
    }

	/*
	 * Finds all rooms in the game and puts them in an array.
	 */
    
    static findAllRooms() {
        return MainCache.getRooms();
    }

	/*
	 * Finds all flags in the game and puts them in an array.
	 */
    
	static findAllFlags() {
	    return MainCache.getFlags();
	}

	/*
	 * Returns the display name of a game object.
	 * 
	 * @param game object
	 */
    
	static getDisplayName(gameObject) {
		if (!gameObject) {
			return 'undefined';
		}
	    if (gameObject.name) {
	    	return gameObject.name;
	    }
	    if (gameObject.memory && gameObject.memory.name) {
	    	return gameObject.memory.name;
	    }
	    if (gameObject.structureType && gameObject.id && Memory.structures && Memory.structures[gameObject.id]) {
	    	var memory = Memory.structures[gameObject.id];
	    	if (memory.name) {
	    		return memory.name;
	    	}
	    }
	    if (gameObject.id) {
	    	return gameObject.id;
	    }
	    return JSON.stringify(gameObject);
	}

	/*
	 * Creates a custom node in the Memory for this structure.
	 */
	
	static fetchMemoryOfStructure(structure) {
		if (!Memory.structures) {
			Memory.structures = {};
		}
		if (!Memory.structures[structure.id]) {
			Memory.structures[structure.id] = structure.memory || {};
		}
		var memory = Memory.structures[structure.id];
		structure.memory = memory;
		memory._roomName = structure.room && structure.room.name ? structure.room.name : structure.pos && structure.pos.roomName;
		memory._lastSeen = Game.time;
		return memory;
	}

}

module.exports = MainUtil;