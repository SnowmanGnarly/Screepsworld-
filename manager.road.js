/*
 * This manager handles road building based on creep foot-traffic heatmaps.
 */

var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var TileWatcher = require('./tile.watcher');
var TileArray = require('./tile.array');

class RoadManager extends TileWatcher {

	static watchAllRooms() {
	    MainUtil.findAllRooms().forEach(room => new RoadManager(room).watchRoom());
	}
	
	constructor(room) {
		super('roadManager', room);
	}

	_fetchMemoryOfWatcher() {
		var defaultArray = {
			enabled: true,
			watchTime: 1000,
			visualize: false,
			tick: 0,
			threshold: 100,
			tiles: {},
		};
		if (this._room.memory[this._id]) {
			this._room.memory[this._id] = Object.assign(defaultArray, this._room.memory[this._id]);
		} else {
			this._room.memory[this._id] = defaultArray;
		}
		if (!this._room.memory[this._id].tiles) {
			this._room.memory[this._id].tiles = {};
		}
		return this._room.memory[this._id];
	}
	
	watchRoom() {
		if (MainCache.find(this._room, FIND_MY_CREEPS).some(creep => !creep.spawning)) {
			super.watchRoom();
		}
	}

	_watchRoomTiles(tiles) {
		MainCache.find(this._room, FIND_MY_CREEPS).filter(creep => !creep.spawning).forEach(creep => {
			if (creep.memory.moving) {
				var key = creep.pos.x + ',' + creep.pos.y;
				tiles[key] = (tiles[key] || 0) + 1;
			}
		});
	}
	
	fetchPositionsOverThreshold() {
		var result = [];
		var memory = this._fetchMemoryOfWatcher();
		if (!memory.lastTiles) {
			return result;
		}

		if (typeof memory.lastTiles === 'object' && !Array.isArray(memory.lastTiles)) {
			for (var key in memory.lastTiles) {
				var val = memory.lastTiles[key];
				if (val >= memory.threshold) {
					var coords = key.split(',');
					result.push({
						x: parseInt(coords[0]),
						y: parseInt(coords[1]),
						value: val
					});
				}
			}
		} else if (typeof memory.lastTiles === 'string') {
			var array = new TileArray(50, 50);
			array.fromCompactString(memory.lastTiles);
			for (var x = 0; x < 50; x++) {
				for (var y = 0; y < 50; y++) {
					var value = parseInt(array.get(x, y));
					if (value >= memory.threshold) {
						result.push({ x: x, y: y, value: value });
					}
				}
			}
		}

		return result.sort((a, b) => b.value - a.value).map(pos => new RoomPosition(pos.x, pos.y, this._room.name));
	}
}

module.exports = RoadManager;
