/*
 * RoomManager maps the room structures and handles construction site placement rules
 * across controller levels RCL 1 to RCL 8.
 */

var MainInfo = require('./main.info');
var MainCache = require('./main.cache');
var TileArray = require('./tile.array');

class RoomManager {

	static generateLayoutForRoom(room, array = new TileArray(50, 50)) {
		var roomManager = new RoomManager(room);
		var arrayResult = roomManager._generateLayout(array);
		var compactString = arrayResult.toCompactString();
		roomManager._fetchMemoryOfManager().layout = compactString;
		return compactString;
	}

	constructor(room) {
		this._room = room;
	}

	fetchBuildingSitePositionsForTile(character) {
		this._initArrayIfNecessary();
		var result = [];

		for (var x = 0; x < this._array.width; x++) {
			for (var y = 0; y < this._array.height; y++) {
				var value = this._array.get(x, y);
				if (value === character) {
					result.push(new RoomPosition(x, y, this._room.name));
				}
			}
		}
		return result;
	}

	_initArrayIfNecessary() {
		if (!this._array) {
			this._initArray();
		}
	}

	_initArray() {
		this._memory = this._fetchMemoryOfManager();
		this._array = new TileArray(50, 50);

		if (this._memory.layout) {
			this._array.fromCompactString(this._memory.layout, { emptyValue: ' ' });
		} else {
			this._generateLayout(this._array);
		}

		this._memory.layout = this._array.toCompactString();

		if (this._memory.debug) {
			this._printRoom(this._array);
		}
	}

	_generateLayout(array = new TileArray(50, 50)) {
		this._generateExistingTiles(array);
		this._generateStructuresToBeBuild(array);
		return array;
	}

	_generateExistingTiles(array) {
		var terrain = this._room.getTerrain();
		var objects = MainCache.find(this._room, FIND_STRUCTURES).map(structure => {
			return { type: LOOK_STRUCTURES, structure: structure };
		}).concat(MainCache.find(this._room, FIND_SOURCES).map(source => {
			return { type: LOOK_SOURCES, source: source };
		})).concat(MainCache.find(this._room, FIND_MINERALS).map(mineral => {
			return { type: LOOK_MINERALS, mineral: mineral };
		}));
		var objectsByPosition = {};
		objects.forEach(object => {
			var position = object.structure ? object.structure.pos : object.source ? object.source.pos : object.mineral.pos;
			var key = position.x + ',' + position.y;
			if (!objectsByPosition[key]) objectsByPosition[key] = [];
			objectsByPosition[key].push(object);
		});

		for (var x = 0; x < array.width; x++) {
			for (var y = 0; y < array.height; y++) {
				var terrainValue = terrain.get(x, y);
				var terrainType = terrainValue === TERRAIN_MASK_WALL ? 'wall' : terrainValue === 2 ? 'swamp' : 'plain';
				var stuffs = (objectsByPosition[x + ',' + y] || []).concat({ type: LOOK_TERRAIN, terrain: terrainType });
				array.set(x, y, this._getTileFromStuffs(stuffs));
			}
		}
	}

	_getTileFromStuffs(stuffs) {
		var toBeBuild = this._filterByTiles(stuffs, RoomManager.TILES_TO_BE_BUILD);
		if (toBeBuild.length > 0) return toBeBuild[0].character;

		var endless = this._filterByTiles(stuffs, RoomManager.TILES_ENDLESS_STRUCTURES);
		if (endless.length > 0) return endless[0].character;

		var preset = this._filterByTiles(stuffs, RoomManager.TILES_PRESET);
		if (preset.length > 0) return preset[0].character;

		var terrain = this._filterByTiles(stuffs, RoomManager.TILES_TERRAIN);
		if (terrain.length > 0) return terrain[0].character;

		return RoomManager.TILE_UNKNOWN;
	}

	_generateStructuresToBeBuild(array) {
		var spawns = MainCache.find(this._room, FIND_MY_SPAWNS);
		if (spawns.length > 0) {
			var spawn = spawns[0];
			var extensionsCount = this._getExtensionsCount();
			var extensionPositions = this._findExtensionPointsForSpawn(array, spawn, extensionsCount);
			extensionPositions.forEach(pos => array.set(pos.x, pos.y, RoomManager.TILE_EXTENSION));
		}
	}

	_getExtensionsCount() {
		var level = this._room.controller ? this._room.controller.level : 8;
		return CONTROLLER_STRUCTURES['extension'][level] || 60;
	}

	_findExtensionPointsForSpawn(array, spawn, limit = array.width * array.height) {
		limit -= (array.toCompactString().match(/o/g) || []).length;
		var spawnPos = (spawn.pos.x + spawn.pos.y) % 2;

		var validPlacementValues = [
			RoomManager.TILE_TERRAIN_PLAIN,
			RoomManager.TILE_TERRAIN_SWAMP,
		];

		var result = [];
		for (var x = 0; x < array.width; x++) {
			for (var y = 0; y < array.height; y++) {
				if ((((x + y) % 2) == spawnPos) &&
					!(x == spawn.pos.x && y == spawn.pos.y) &&
					validPlacementValues.includes(array.get(x, y))) {
					result.push({ x: x, y: y });
				}
			}
		}
		return result
			.sort((a, b) => spawn.pos.getRangeTo(a.x, a.y) - spawn.pos.getRangeTo(b.x, b.y))
			.slice(0, limit)
			.map(pos => new RoomPosition(pos.x, pos.y, this._room.name));
	}

	_fetchMemoryOfManager() {
		var defaultArray = { debug: false };
		if (this._room.memory.roomManager) {
			this._room.memory.roomManager = Object.assign(defaultArray, this._room.memory.roomManager);
		} else {
			this._room.memory.roomManager = defaultArray;
		}
		return this._room.memory.roomManager;
	}

	_filterByTiles(stuffs, tiles) {
		return stuffs.map(stuff => {
			var filteredTiles = tiles.filter(tile => tile.isEqual(stuff));
			return filteredTiles.length > 0 ? filteredTiles[0] : null;
		}).filter(tile => tile != null);
	}

	/*
	 * Returns available building slots considering both built structures AND active construction sites.
	 */
	fetchFreeBuildingSlots(tileCharacter) {
		var tiles = RoomManager.TILES_TO_BE_BUILD.filter(tile => tile.character == tileCharacter);
		if (tiles.length == 0) {
			MainInfo.error('Could not find building for character "' + tileCharacter + '"!');
			return 0;
		}
		var tile = tiles[0];
		var availableSlots = this._fetchAvailableSlots(tile.structureType);
		var usedSlots = this._fetchUsedSlots(tile.structureType);
		return Math.max(0, availableSlots - usedSlots);
	}

	_fetchAvailableSlots(structureType) {
		if (!this._room.controller || !this._room.controller.my) {
			return 0;
		}
		var level = this._room.controller.level || 0;
		return (CONTROLLER_STRUCTURES[structureType] && CONTROLLER_STRUCTURES[structureType][level]) || 0;
	}

	_fetchUsedSlots(structureType) {
		var builtCount = this._room.find(FIND_STRUCTURES, { filter: s => s.structureType == structureType }).length;
		var siteCount = this._room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType == structureType }).length;
		return builtCount + siteCount;
	}

	_printRoom(array) {
		for (var x = 0; x < array.width; x++) {
			for (var y = 0; y < array.height; y++) {
				var value = array.get(x, y);
				if (value !== undefined) {
					this._room.visual.text(value, x, y, { align: 'center', opacity: 0.8 });
				}
			}
		}
	}
}

class RoomTerrainTile {
	constructor(character, terrain) {
		this.character = character;
		this._terrain = terrain;
	}
	isEqual(stuff) {
		return ((stuff.type === LOOK_TERRAIN) && (stuff.terrain == this._terrain));
	}
}

RoomManager.TILE_TERRAIN_PLAIN = ' ';
RoomManager.TILE_TERRAIN_SWAMP = '~';
RoomManager.TILE_TERRAIN_WALL = '█';
RoomManager.TILES_TERRAIN = [
	new RoomTerrainTile(RoomManager.TILE_TERRAIN_PLAIN, 'plain'),
	new RoomTerrainTile(RoomManager.TILE_TERRAIN_SWAMP, 'swamp'),
	new RoomTerrainTile(RoomManager.TILE_TERRAIN_WALL, 'wall'),
];

class RoomPresetTile {
	constructor(character, type, structureType) {
		this.character = character;
		this._type = type;
		this._structureType = structureType;
	}
	isEqual(stuff) {
		return (stuff.type === this._type) &&
			(!this._structureType || (stuff.structure && (stuff.structure.structureType == this._structureType)));
	}
}

RoomManager.TILE_CONTROLLER = 'Ø';
RoomManager.TILE_MINERAL = '©';
RoomManager.TILE_SOURCE = 'Ⓢ';
RoomManager.TILES_PRESET = [
	new RoomPresetTile(RoomManager.TILE_CONTROLLER, LOOK_STRUCTURES, STRUCTURE_CONTROLLER),
	new RoomPresetTile(RoomManager.TILE_MINERAL, LOOK_MINERALS),
	new RoomPresetTile(RoomManager.TILE_SOURCE, LOOK_SOURCES),
];

class RoomStructureTile {
	constructor(character, structureType) {
		this.character = character;
		this.structureType = structureType;
	}
	isEqual(stuff) {
		return stuff.type === LOOK_STRUCTURES &&
			(stuff.structure && stuff.structure.structureType == this.structureType);
	}
}

// Full Structure Character Encodings (RCL 1 - RCL 8)
RoomManager.TILE_SPAWN = 'S';
RoomManager.TILE_EXTENSION = 'o';
RoomManager.TILE_TOWER = 'T';
RoomManager.TILE_STORAGE = 'U';
RoomManager.TILE_LINK = 'L';
RoomManager.TILE_EXTRACTOR = 'X';
RoomManager.TILE_LAB = 'B';
RoomManager.TILE_TERMINAL = 'M';
RoomManager.TILE_FACTORY = 'F';
RoomManager.TILE_OBSERVER = 'V';
RoomManager.TILE_POWER_SPAWN = 'P';
RoomManager.TILE_NUKER = 'N';

RoomManager.TILES_TO_BE_BUILD = [
	new RoomStructureTile(RoomManager.TILE_SPAWN, STRUCTURE_SPAWN),
	new RoomStructureTile(RoomManager.TILE_TOWER, STRUCTURE_TOWER),
	new RoomStructureTile(RoomManager.TILE_STORAGE, STRUCTURE_STORAGE),
	new RoomStructureTile(RoomManager.TILE_EXTENSION, STRUCTURE_EXTENSION),
	new RoomStructureTile(RoomManager.TILE_LINK, STRUCTURE_LINK),
	new RoomStructureTile(RoomManager.TILE_EXTRACTOR, STRUCTURE_EXTRACTOR),
	new RoomStructureTile(RoomManager.TILE_TERMINAL, STRUCTURE_TERMINAL),
	new RoomStructureTile(RoomManager.TILE_LAB, STRUCTURE_LAB),
	new RoomStructureTile(RoomManager.TILE_FACTORY, STRUCTURE_FACTORY),
	new RoomStructureTile(RoomManager.TILE_POWER_SPAWN, STRUCTURE_POWER_SPAWN),
	new RoomStructureTile(RoomManager.TILE_OBSERVER, STRUCTURE_OBSERVER),
	new RoomStructureTile(RoomManager.TILE_NUKER, STRUCTURE_NUKER),
];

RoomManager.TILE_WALL = 'w';
RoomManager.TILE_RAMPART = 'r';
RoomManager.TILES_ENDLESS_STRUCTURES = [
	new RoomStructureTile(RoomManager.TILE_RAMPART, STRUCTURE_RAMPART),
	new RoomStructureTile(RoomManager.TILE_WALL, STRUCTURE_WALL),
];

RoomManager.TILE_UNKNOWN = '?';

module.exports = RoomManager;
