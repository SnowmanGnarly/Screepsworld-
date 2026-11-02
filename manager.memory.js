/*
 * This manager initializes and manages the memory of all kinds of different objects.
 * 
 * TODO: maybe memory could be stored closer to where it is used?
 */

var config = require('./main.config');
var MainCache = require('./main.cache');
var MainHeap = require('./main.heap');
var MainMove = require('./main.move');
var EconomyManager = require('./manager.economy');
var MainUtil = require('./main.util');
var info = require('./main.info');
var IntelManager = require('./manager.intel');

class MemoryManager {

	/*
	 * Fetches the memory of the room's role config for a specific base name.
	 * 
	 * @param {Room} room
	 * @param allRoles - the roles to be initialized
	 */

	static fetchRoomRoleConfigForBase(baseName, allRoles = []) {
		var roomsOfBase = MainUtil.findAllRooms().filter(room => room.memory.base && room.memory.base.name === baseName);
		if (roomsOfBase.length > 0) {
			return this._fetchRoomRoleConfig(roomsOfBase[0], allRoles);
		}
		return null;
	}

	/*
	 * Fetches the memory of all the room's role configs.
	 * 
	 * @param allRoles
	 */

	static _fetchAllRoomRoleConfigs(allRoles) {
		MainUtil.findAllRooms().forEach(room => {
			if (room.memory.base) {
				this._fetchRoomRoleConfig(room, allRoles);
			}
		});
	}

	/*
	 * Fetches the memory of the room's role config.
	 * 
	 * @param {Room} room
	 * @param allRoles - the roles to be initialized
	 */

	static _fetchRoomRoleConfig(room, allRoles = []) {
		var roleConfig = room.memory.base.roleConfig;
		if (!roleConfig || typeof roleConfig !== 'object' || Array.isArray(roleConfig)) roleConfig = room.memory.base.roleConfig = {};
		// filled in place: rebuilding it every tick only made garbage
		Object.keys(MemoryManager.ROLE_CONFIG_DEFAULTS).forEach(key => {
			if (!(key in roleConfig)) roleConfig[key] = MemoryManager.ROLE_CONFIG_DEFAULTS[key];
		});
		allRoles.forEach(role => {
			if (!(role.roleName in roleConfig)) roleConfig[role.roleName] = { requiredNumber: 0 };
		});
		this._migrateBodyLimit(roleConfig);
		this._migrateDefaultQuotas(room, roleConfig);
		return roleConfig;
	}

	/*
	 * Every room used to store a limit of 5 body repeats as its default, which would now override
	 * the sizes derived from the room. It runs once, so a limit set afterwards is respected.
	 */

	static _migrateBodyLimit(roleConfig) {
		if (roleConfig.bodyVersion === this.BODY_VERSION) return;
		if (roleConfig.partsMaxMultiplier === 5) delete roleConfig.partsMaxMultiplier;
		roleConfig.bodyVersion = this.BODY_VERSION;
	}

	/*
	 * The Mayor used to store a count of 1 for these roles in every automatic room. Rooms now work
	 * out their own demand, and a stored count acts as a floor, so those would keep creeps nobody
	 * asked for. It runs once, so a count set afterwards is respected.
	 */

	static _migrateDefaultQuotas(room, roleConfig) {
		if (roleConfig.quotaVersion === this.QUOTA_VERSION) return;
		// a room run by hand keeps its counts, and this runs once it goes automatic
		var mayor = room.memory.mayor;
		if (room.memory.base.autoDemand === false || (mayor && mayor.mode && mayor.mode !== 'auto')) return;
		roleConfig.quotaVersion = this.QUOTA_VERSION;
		['Harvester', 'Upgrader', 'Builder', 'Handyman'].forEach(roleName => {
			var quota = roleConfig[roleName];
			if (quota && quota.requiredNumber === 1 && quota.auto !== false) quota.requiredNumber = 0;
		});
	}

	/*
	 * Fetches the memory of a room's base.
	 * 
	 * @param {Room} room
	 * @param baseName
	 */

	static fetchRoomBase(room, baseName) {
		var defaultArray = {
			name: baseName,
		};

		if (room.memory.base) {
			room.memory.base = Object.assign(defaultArray, room.memory.base);
		} else {
			room.memory.base = defaultArray;
			info.log('🏠 Created new base: ' + baseName);
		}
		return room.memory.base;
	}

	/*
	 * Clears the memory of the all the room's infos.
	 * 
	 * @param allRoles
	 */

	static _clearAllRoomRoleInfos(allRoles) {
		MainUtil.findAllRooms().forEach(room => this._clearRoomRoleInfo(room, allRoles));
	}

	/*
	 * Clears the memory of the room's role info.
	 * 
	 * @param {Room} room
	 * @param allRoles
	 */

	static _clearRoomRoleInfo(room, allRoles) {
		// older versions rewrote this display data in Memory every tick
		if (room.memory.roleInfo) delete room.memory.roleInfo;
		var roleInfos = MainHeap.namespace('roleInfo');
		if (!config.getSetting('visuals')) {
			delete roleInfos[room.name];
			return null;
		}
		var defaultArray = {};
		allRoles.forEach(role => {
			defaultArray[role.roleName] = {
				symbol: role.symbol,
				currentNumber: 0,
				requiredNumber: this.getRequiredNumberForRoomAndRole(room, role.roleName),
			};
		});
		roleInfos[room.name] = defaultArray;
		return defaultArray;
	}

	/*
	 * The role config of a base, looked up once per tick. Creeps ask for it on every run.
	 *
	 * @param baseName
	 * @param role - used to create the config if the base does not have one yet
	 */

	static getRoleConfigForBase(baseName, role) {
		return MainCache.memo('roleConfig:' + baseName, () => this.fetchRoomRoleConfigForBase(baseName, [role]));
	}

	/*
	 * Gets the required number for a room and a role.
	 * 
	 * @param {Room} room
	 * @param roleName
	 */

	static getRequiredNumberForRoomAndRole(room, roleName) {
		var base = room.memory.base; // one read: the engine's room.memory is a getter
		if (!base) return -1;
		var quota = base.roleConfig && base.roleConfig[roleName];
		return quota ? quota.requiredNumber : 0;
	}


	/*
	 * Initializes all memories for this round.
	 *
	 * @param allRoles
	   */

	static initRound(allRoles) {
		this._initSpawns();

		this._fetchAllRoomRoleConfigs(allRoles);
		this._clearAllRoomRoleInfos(allRoles);

		this._deleteUnusedMemory();
		this._measureMemory();
	}

	static _measureMemory() {
		if (Game.time % config.MEMORY.MEASURE_INTERVAL !== 0 || typeof RawMemory === 'undefined' || !RawMemory.get || this._memoryMeasuredAt === Game.time) return;
		this._memoryMeasuredAt = Game.time;
		this._memorySize = RawMemory.get().length;
		if (this._memorySize > config.MEMORY.SIZE_WARNING_BYTES && (!this._lastMemoryWarning || Game.time - this._lastMemoryWarning > config.MEMORY.SIZE_WARNING_PAUSE)) {
			this._lastMemoryWarning = Game.time;
			info.warning('Serialized memory is approaching the configured limit: ' + this._memorySize + ' bytes.');
		}
	}

	static getMemorySize() {
		return this._memorySize || 0;
	}

	/*
	 * Initializes the very first base.
	 */

	static _initSpawns() {
		// all spawns (and all creeps) have a home, so that we find them again

		MainUtil.findAllSpawns().filter(spawn => !spawn.memory.home).forEach(spawn => {
			if (spawn.room.memory.base) {
				// 2nd spawn in a room
				spawn.memory.home = spawn.room.memory.base.name;
				info.log('🏠 Created new spawn in base: ' + spawn.memory.home);
			} else {
				// new base in this room
				this.fetchRoomBase(spawn.room, spawn.name);
				spawn.memory.home = spawn.room.memory.base.name;
			}
		});
	}

	/*
	 * Delete memory of deceased creeps and destroyed structures in visible rooms.
	 */

	static _deleteUnusedMemory() {
		for (var name in Memory.creeps) {
			if (!Game.creeps[name]) {
				delete Memory.creeps[name];
			}
		}
		if (Memory.structures) {
			for (var structureId in Memory.structures) {
				var memory = Memory.structures[structureId];
				if (memory && memory._roomName && Game.rooms[memory._roomName] && !Game.getObjectById(structureId)) {
					delete Memory.structures[structureId];
				}
			}
		}
		// Miners now go through the spawn queue like every other role
		delete Memory.minerReplacements;
		IntelManager.ensureMemory();
		if (Game.time % config.MEMORY.INTEL_CLEANUP_INTERVAL === config.MEMORY.INTEL_CLEANUP_PHASE) IntelManager.cleanup();
		if (Game.time % config.MEMORY.ROOM_PRUNE_INTERVAL === config.MEMORY.ROOM_PRUNE_PHASE) this._pruneRoomMemory();
		if (Game.time % config.MEMORY.STUCK_PRUNE_INTERVAL === config.MEMORY.STUCK_PRUNE_PHASE) MainMove.prune();
	}

	/*
	 * Every room we ever saw keeps a Memory entry, and nothing else removes it. An entry can go
	 * when the room is out of sight and takes no part in a mission. A room we own is always in
	 * sight, so a base out of sight was lost, for example to a respawn. It goes once a whole prune
	 * interval has passed with no creep or spawn calling it home, since its creeps are adopted.
	 */

	static _pruneRoomMemory() {
		if (!Memory.rooms) return;
		var missions = IntelManager.ensureMemory().missions;
		var missionRooms = new Set();
		Object.keys(missions).forEach(id => {
			[missions[id].targetRoom, missions[id].homeRoom].forEach(name => {
				if (name) missionRooms.add(name);
			});
		});
		// a respawn can give the new base the old one's name, and then its creeps keep nothing alive
		var liveBases = new Set(Object.values(Game.rooms).filter(room => room.memory && room.memory.base).map(room => room.memory.base.name));
		var homes = new Set(Object.values(Game.creeps).concat(Object.values(Game.spawns)).map(object => object.memory && object.memory.home)
			.filter(home => !liveBases.has(home)));
		Object.keys(Memory.rooms).forEach(name => {
			var memory = Memory.rooms[name];
			if (Game.rooms[name] || missionRooms.has(name)) {
				if (memory && memory.base) delete memory.base.lostSince;
				return;
			}
			if (memory && memory.base && !this._isLostBase(memory.base, homes)) return;
			delete Memory.rooms[name];
		});
		if (Memory.spawns) {
			Object.keys(Memory.spawns).forEach(name => {
				if (!Game.spawns[name]) delete Memory.spawns[name];
			});
		}
		if (!Memory.structures) return;
		Object.keys(Memory.structures).forEach(id => {
			var roomName = Memory.structures[id] && Memory.structures[id]._roomName;
			if (roomName && !Game.rooms[roomName] && !missionRooms.has(roomName) && !Memory.rooms[roomName]) {
				delete Memory.structures[id];
			}
		});
	}

	static _isLostBase(base, homes) {
		if (homes.has(base.name)) {
			delete base.lostSince;
			return false;
		}
		if (base.lostSince === undefined) base.lostSince = Game.time;
		return Game.time - base.lostSince >= config.MEMORY.ROOM_PRUNE_INTERVAL;
	}

};

MemoryManager.BODY_VERSION = 1;
MemoryManager.ROLE_CONFIG_DEFAULTS = {
	partsMinMultiplier: 0,
	showIcons: true,
	useStorageAsSource: true,
	useSourceAsSource: true,
};
MemoryManager.QUOTA_VERSION = 1;

module.exports = MemoryManager;