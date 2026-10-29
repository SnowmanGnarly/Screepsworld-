class MainCache {

	static initRound(allRoles = []) {
		this._state = {
			tick: Game.time,
			roles: allRoles,
			rooms: null,
			spawns: null,
			creeps: null,
			flags: null,
			creepsByHome: null,
			creepCounts: null,
			minerCounts: null,
			sourceAssignments: null,
			freeSpawns: new Map(),
			reservedSpawns: new Set(),
			roomFinds: new Map(),
		};
	}

	static _getState() {
		if (!this._state || this._state.tick !== Game.time) {
			this.initRound(this._state ? this._state.roles : []);
		}
		return this._state;
	}

	static _getCollection(key, collection) {
		var state = this._getState();
		if (!state[key]) {
			state[key] = Object.keys(collection || {}).map(name => collection[name]);
		}
		return state[key];
	}

	static getRooms() {
		return this._getCollection('rooms', Game.rooms);
	}

	static getSpawns() {
		return this._getCollection('spawns', Game.spawns);
	}

	static getCreeps() {
		return this._getCollection('creeps', Game.creeps);
	}

	static getFlags() {
		return this._getCollection('flags', Game.flags);
	}

	static getCreepsByHome(baseName) {
		var state = this._getState();
		if (!state.creepsByHome) {
			state.creepsByHome = new Map();
			this.getCreeps().forEach(creep => {
				var home = creep.memory.home;
				if (!state.creepsByHome.has(home)) {
					state.creepsByHome.set(home, []);
				}
				state.creepsByHome.get(home).push(creep);
			});
		}
		return state.creepsByHome.get(baseName) || [];
	}

	static getCreepCount(baseName, roleName) {
		var state = this._getState();
		if (!state.creepCounts) {
			state.creepCounts = new Map();
			this.getCreeps().forEach(creep => {
				var home = creep.memory.home;
				if (!state.creepCounts.has(home)) {
					state.creepCounts.set(home, new Map());
				}
				var counts = state.creepCounts.get(home);
				counts.set(creep.memory.role, (counts.get(creep.memory.role) || 0) + 1);
			});
		}
		var counts = state.creepCounts.get(baseName);
		return counts ? counts.get(roleName) || 0 : 0;
	}

	static getFreeSpawns(baseName) {
		var state = this._getState();
		var key = baseName || '*';
		if (!state.freeSpawns.has(key)) {
			state.freeSpawns.set(key, this.getSpawns().filter(spawn => {
				return !spawn.spawning && !state.reservedSpawns.has(spawn.name) &&
					(!baseName || spawn.memory.home == baseName);
			}));
		}
		return state.freeSpawns.get(key);
	}

	static getMinerCount(sourceId) {
		var state = this._getState();
		if (!state.minerCounts) {
			state.minerCounts = new Map();
			this.getCreeps().forEach(creep => {
				if (creep.memory.role == 'Miner' && creep.memory.source) {
					state.minerCounts.set(creep.memory.source, (state.minerCounts.get(creep.memory.source) || 0) + 1);
				}
			});
		}
		return state.minerCounts.get(sourceId) || 0;
	}

	static getSourceAssignmentCount(sourceId) {
		var state = this._getState();
		if (!state.sourceAssignments) {
			state.sourceAssignments = new Map();
			this.getCreeps().forEach(creep => {
				if (creep.memory.role != 'Miner' && creep.memory.source) {
					state.sourceAssignments.set(creep.memory.source, (state.sourceAssignments.get(creep.memory.source) || 0) + 1);
				}
			});
		}
		return state.sourceAssignments.get(sourceId) || 0;
	}

	static find(room, findType, options = {}) {
		var state = this._getState();
		if (!state.roomFinds.has(room.name)) {
			state.roomFinds.set(room.name, new Map());
		}
		var roomFinds = state.roomFinds.get(room.name);
		if (!roomFinds.has(findType)) {
			roomFinds.set(findType, room.find(findType));
		}
		var values = roomFinds.get(findType);
		return options.filter ? values.filter(options.filter) : values;
	}

	static invalidateRoom(room, findType) {
		var state = this._getState();
		if (!state.roomFinds.has(room.name)) {
			return;
		}
		if (findType === undefined) {
			state.roomFinds.delete(room.name);
		} else {
			state.roomFinds.get(room.name).delete(findType);
		}
	}

	static invalidateFlags() {
		this._getState().flags = null;
	}

	static recordSpawn(creep, spawn) {
		var state = this._getState();
		state.reservedSpawns.add(spawn.name);
		state.freeSpawns = new Map();
		state.creepsByHome = null;
		state.creepCounts = null;
		state.minerCounts = null;
		state.sourceAssignments = null;
		if (creep && state.creeps && !state.creeps.includes(creep)) {
			state.creeps.push(creep);
		}
		if (creep && state.roomFinds.has(spawn.room.name)) {
			var roomFinds = state.roomFinds.get(spawn.room.name);
			if (roomFinds.has(FIND_MY_CREEPS)) {
				var roomCreeps = roomFinds.get(FIND_MY_CREEPS);
				if (!roomCreeps.includes(creep)) {
					roomCreeps.push(creep);
				}
			}
		}
	}
}

module.exports = MainCache;
