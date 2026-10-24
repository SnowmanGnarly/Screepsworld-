/*
 * This class watches room tile activity efficiently using sparse coordinate mapping
 * to avoid excessive CPU and memory serialization overhead.
 */

var TileArray = require('./tile.array');

class TileWatcher {
	
	constructor(id, room) {
		this._id = id;
		this._room = room;
	}

	_fetchMemoryOfWatcher() {
		var defaultArray = {
			enabled: true,
			watchTime: 1000,
			visualize: false,
			tick: 0,
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
		var memory = this._fetchMemoryOfWatcher();
		
		if (!memory.enabled) {
			return;
		}
		
		memory.tick++;
		
		if (memory.tick > memory.watchTime) {
			memory.tick = 0;
			memory.lastTiles = memory.tiles;
			memory.tiles = {};
		}
		
		this._watchRoomTiles(memory.tiles);

		if (memory.visualize) {
			this._printRoom(memory.tiles);
		}
	}
	
	_watchRoomTiles(tiles) {
		throw 'TileWatcher#watchRoomTiles is not implemented!';
	}

	_printRoom(tiles) {
		for (var key in tiles) {
			var parts = key.split(',');
			var x = parseInt(parts[0]);
			var y = parseInt(parts[1]);
			this._room.visual.text(tiles[key], x, y, { align: 'center', opacity: 0.5 });
		}
	}
}

module.exports = TileWatcher;

module.exports = TileWatcher;