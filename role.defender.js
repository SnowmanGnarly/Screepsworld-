/*
 * Defenders protect the base on-demand when invasions or hostile creeps are detected.
 * They attack the prioritized target determined by DefenseManager.
 */

var MainCache = require('./main.cache');
var MainUtil = require('./main.util');
var info = require('./main.info');
var RolePrototype = require('./role.prototype');
var DefenseManager = require('./manager.defense');

class Defender extends RolePrototype {

	constructor() {
		super('Defender', '#ff0000', '🛡️');
		this.priority = 90;
	}

	isNecessary(room) {
		return room.memory.defense && room.memory.defense.threatLevel > 0;
	}

	spawnCreep(spawn) {
		return this._spawnCreepWithParts(spawn, [TOUGH, ATTACK, MOVE, MOVE], [ATTACK, MOVE]);
	}

	_work(creep) {
		var target = DefenseManager.getPriorityTarget(creep.room);
		if (!target) {
			var hostiles = MainCache.find(creep.room, FIND_HOSTILE_CREEPS);
			if (hostiles.length > 0) {
				target = creep.pos.findClosestByRange(hostiles);
			}
		}

		if (target) {
			var attackResult = creep.attack(target);
			if (attackResult === ERR_NOT_IN_RANGE) {
				this._moveToLocation(creep, target);
			}
			return;
		}

		// If no hostiles, patrol near main spawn or ramparts
		var spawns = MainCache.find(creep.room, FIND_MY_SPAWNS);
		if (spawns.length > 0 && !creep.pos.inRangeTo(spawns[0], 3)) {
			this._moveToLocation(creep, spawns[0]);
		}
	}
}

module.exports = Defender;
