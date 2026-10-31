/*
 * The one place creeps get their move orders. Paths ignore other creeps, which needs far fewer
 * searches because traffic stops invalidating them. A walk through the room follows one stored
 * path, kept on the heap so that it costs no Memory and a reset only costs a new search. A creep
 * that has not moved for a few ticks spends a while walking around whatever is in its way, since a
 * new path that ignores creeps could lead straight back through it.
 *
 * moveTo still covers what a stored path cannot: other rooms, the last tiles before the target
 * where other creeps matter, and paths around traffic.
 */

var config = require('./main.config');
var MainHeap = require('./main.heap');

class MainMove {

	static to(creep, location, options = {}) {
		var stuckTicks = this._trackStuck(creep);
		var isStuck = stuckTicks >= config.MOVEMENT.STUCK_TICKS;
		var entry = MainHeap.namespace('stuck')[creep.name];
		// one repath, then a pause, so a creep waiting in a queue does not search every tick
		if (isStuck) {
			entry.count = -config.MOVEMENT.STUCK_REPATH_PAUSE;
			entry.detourUntil = Game.time + config.MOVEMENT.STUCK_REPATH_PAUSE;
			delete MainHeap.namespace('paths')[creep.name];
		}
		var isDetouring = entry.detourUntil > Game.time;
		var result = isDetouring || !this._canFollowPath(creep, location) ? null : this._followPath(creep, location);
		if (result === null) {
			result = creep.moveTo(location, this._getMoveOptions(creep, location, options, isStuck, isDetouring));
		}
		creep.movedThisTick = result === OK;
		return result;
	}

	/*
	 * Drops the state of creeps that no longer exist, which keeps the heap bounded.
	 */

	static prune() {
		['stuck', 'paths'].forEach(name => {
			var entries = MainHeap.namespace(name);
			Object.keys(entries).forEach(creepName => {
				if (!Game.creeps[creepName]) delete entries[creepName];
			});
		});
	}

	static _getMoveOptions(creep, location, options, isStuck, isDetouring) {
		var moveOptions = {
			reusePath: isStuck ? 0 : this._getReusePath(creep, location, options),
			ignoreCreeps: !isDetouring && !this._isNear(creep, location),
		};
		if (config.getSetting('pathVisuals')) {
			moveOptions.visualizePathStyle = { stroke: options.color };
		}
		return moveOptions;
	}

	static _canFollowPath(creep, location) {
		var target = location.pos || location;
		return target.roomName === creep.pos.roomName && !this._isNear(creep, location) && !config.getSetting('pathVisuals');
	}

	/*
	 * Returns the move result, or null when moveTo has to handle this tick.
	 */

	static _followPath(creep, location) {
		var target = location.pos || location;
		var key = target.x + ',' + target.y + ',' + target.roomName;
		var paths = MainHeap.namespace('paths');
		var entry = paths[creep.name];
		var isFresh = entry && entry.key === key && Game.time - entry.at < config.MOVEMENT.PATH_TTL;
		var justSearched = !isFresh;
		if (justSearched) entry = paths[creep.name] = this._searchPath(creep, target, key);
		if (!entry.path) return null;

		var result = creep.moveByPath(entry.path);
		if (result === ERR_NOT_FOUND && !justSearched) {
			// pushed off the path, or it led somewhere else: one new search, no more
			entry = paths[creep.name] = this._searchPath(creep, target, key);
			if (!entry.path) return null;
			result = creep.moveByPath(entry.path);
		}
		return result === ERR_NOT_FOUND ? null : result;
	}

	static _searchPath(creep, target, key) {
		var path = creep.room.findPath(creep.pos, target, { ignoreCreeps: true, serialize: true });
		return { key: key, path: path, at: Game.time };
	}

	static _trackStuck(creep) {
		var stuck = MainHeap.namespace('stuck');
		var entry = stuck[creep.name];
		var pos = creep.pos;
		if (entry && entry.t === Game.time) return entry.count;
		var count = 0;
		if (entry && entry.t === Game.time - 1 && entry.x === pos.x && entry.y === pos.y && entry.roomName === pos.roomName) {
			// waiting out fatigue is not being stuck, but it is not progress either
			count = creep.fatigue > 0 ? entry.count : entry.count + 1;
		}
		stuck[creep.name] = { x: pos.x, y: pos.y, roomName: pos.roomName, t: Game.time, count: count, detourUntil: entry ? entry.detourUntil : 0 };
		return count;
	}

	static _getReusePath(creep, location, options) {
		var target = location.pos || location;
		if (target.roomName && target.roomName !== creep.pos.roomName) return config.MOVEMENT.LONG_REUSE_PATH;
		return options.reusePath;
	}

	static _isNear(creep, location) {
		var target = location.pos || location;
		return target.roomName === creep.pos.roomName && creep.pos.getRangeTo(target) <= config.MOVEMENT.NEAR_RANGE;
	}
}

module.exports = MainMove;
