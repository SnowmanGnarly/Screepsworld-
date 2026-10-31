/*
 * RoomManager maps the room structures and handles construction site placement rules
 * across controller levels RCL 1 to RCL 8.
 */

var MainInfo = require('./main.info');
var MainCache = require('./main.cache');
var TileArray = require('./tile.array');
var MinCut = require('./main.mincut');
var config = require('./main.config').PLANNER;

class RoomManager {

	static generateLayoutForRoom(room, array = new TileArray(50, 50)) {
		var roomManager = new RoomManager(room);
		var arrayResult = roomManager._generateLayout(array);
		var compactString = arrayResult.toCompactString();
		var memory = roomManager._fetchMemoryOfManager();
		memory.layout = compactString;
		delete memory.rampartPlanVersion; // the wall was drawn around the old layout
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

	/*
	 * Adds the wall that closes off everything the room will ever build with the fewest tiles. The
	 * search is expensive and its result does not change, so it runs once.
	 *
	 * Returns true if it searched.
	 */

	planRamparts() {
		this._initArrayIfNecessary();
		if (this._memory.rampartPlanVersion === RoomManager.RAMPART_PLAN_VERSION) return false;
		var terrain = this._room.getTerrain();
		var cut = MinCut.solve((x, y) => terrain.get(x, y) === TERRAIN_MASK_WALL, this._findProtectedTiles());
		// the same layout would give the same answer, so searching again would only waste CPU
		if (!cut) MainInfo.error('Could not find a rampart line around the base.', this._room);
		(cut || []).forEach(tile => {
			if (this._isOpenTile(this._array, tile.x, tile.y)) this._array.set(tile.x, tile.y, RoomManager.TILE_RAMPART);
		});
		this._memory.layout = this._array.toCompactString();
		this._memory.rampartPlanVersion = RoomManager.RAMPART_PLAN_VERSION;
		return true;
	}

	/*
	 * Every planned building with a margin around it, and the tiles beside the controller. Links and
	 * the extractor sit out at sources and minerals, and walling those in as well would stretch the
	 * wall across the room. Tiles near an exit stay out, because they cannot be closed off.
	 */

	_findProtectedTiles() {
		var tiles = new Map();
		var protect = (pos, range) => {
			for (var x = Math.max(RoomManager.WALL_MIN_TILE, pos.x - range); x <= Math.min(RoomManager.WALL_MAX_TILE, pos.x + range); x++) {
				for (var y = Math.max(RoomManager.WALL_MIN_TILE, pos.y - range); y <= Math.min(RoomManager.WALL_MAX_TILE, pos.y + range); y++) {
					tiles.set(x + ',' + y, { x: x, y: y });
				}
			}
		};
		var buildingTiles = new Set(RoomManager.TILES_TO_BE_BUILD
			.map(tile => tile.character)
			.filter(character => character !== RoomManager.TILE_LINK && character !== RoomManager.TILE_EXTRACTOR));
		for (var x = 0; x < this._array.width; x++) {
			for (var y = 0; y < this._array.height; y++) {
				if (buildingTiles.has(this._array.get(x, y))) protect({ x: x, y: y }, config.RAMPART_MARGIN);
			}
		}
		if (this._room.controller && this._room.controller.pos) protect(this._room.controller.pos, 1);
		return Array.from(tiles.values());
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
			// layouts saved before the full plan was stored only hold the tiles allowed at that RCL
			if (this._memory.planVersion !== RoomManager.PLAN_VERSION) {
				this._generateStructuresToBeBuild(this._array);
				this._memory.layout = this._array.toCompactString();
			}
		} else {
			this._generateLayout(this._array);
			this._memory.layout = this._array.toCompactString();
		}

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
				var terrainType = terrainValue === TERRAIN_MASK_WALL ? 'wall' : terrainValue === TERRAIN_MASK_SWAMP ? 'swamp' : 'plain';
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
			var reserved = this._findReservedTiles(spawn);
			this._planCoreStructures(array, spawn, reserved);
			var extensionsCount = this._getExtensionsCount();
			var extensionPositions = this._findExtensionPointsForSpawn(array, spawn, extensionsCount, reserved);
			extensionPositions.forEach(pos => array.set(pos.x, pos.y, RoomManager.TILE_EXTENSION));
			// the plan is complete now, so later calls just read it instead of searching again
			var memory = this._memory || this._fetchMemoryOfManager();
			memory.planVersion = RoomManager.PLAN_VERSION;
		}
	}

	/*
	 * Tiles the plan must leave open: the way out of the spawn, the upgrade area around the
	 * controller, the mining spots around sources and minerals, and the room's edge.
	 */

	_findReservedTiles(spawn) {
		var reserved = new Set();
		var reserve = (pos, range) => {
			for (var x = pos.x - range; x <= pos.x + range; x++) {
				for (var y = pos.y - range; y <= pos.y + range; y++) {
					reserved.add(x + ',' + y);
				}
			}
		};
		reserve(spawn.pos, 1);
		if (this._room.controller && this._room.controller.pos) reserve(this._room.controller.pos, 3);
		MainCache.find(this._room, FIND_SOURCES).forEach(source => reserve(source.pos, 2));
		MainCache.find(this._room, FIND_MINERALS).forEach(mineral => reserve(mineral.pos, 1));
		for (var edge = 0; edge < 50; edge++) {
			[0, 1, 48, 49].forEach(border => {
				reserved.add(edge + ',' + border);
				reserved.add(border + ',' + edge);
			});
		}
		return reserved;
	}

	/*
	 * For each tile, how far it is to the nearest wall or occupied tile. High values mark open
	 * ground, which is where a cluster can go without closing off a path.
	 */

	_distanceTransform(array) {
		var size = array.width;
		var distances = new Uint8Array(size * size);
		var at = (x, y) => (x < 0 || y < 0 || x >= size || y >= size) ? 0 : distances[x * size + y];
		for (var x = 0; x < size; x++) {
			for (var y = 0; y < size; y++) {
				if (!this._isOpenTile(array, x, y)) continue;
				distances[x * size + y] = Math.min(at(x - 1, y - 1), at(x - 1, y), at(x - 1, y + 1), at(x, y - 1)) + 1;
			}
		}
		for (var bx = size - 1; bx >= 0; bx--) {
			for (var by = size - 1; by >= 0; by--) {
				if (!distances[bx * size + by]) continue;
				distances[bx * size + by] = Math.min(distances[bx * size + by],
					Math.min(at(bx + 1, by + 1), at(bx + 1, by), at(bx + 1, by - 1), at(bx, by + 1)) + 1);
			}
		}
		return { at: at };
	}

	_isOpenTile(array, x, y) {
		var value = array.get(x, y);
		return value === RoomManager.TILE_TERRAIN_PLAIN || value === RoomManager.TILE_TERRAIN_SWAMP;
	}

	_countPlanned(array, character) {
		return array.toCompactString().split(character).length - 1;
	}

	/*
	 * How many tiles a structure type still needs. Older layouts do not know about structures
	 * that were placed without a tile, so what is really standing is counted as well.
	 */

	_countMissingTiles(array, tile) {
		var limits = CONTROLLER_STRUCTURES[tile.structureType];
		var wanted = limits && limits[config.MAX_RCL] || 0;
		if (wanted <= 0) return 0;
		var isOffPlan = object => object.structureType === tile.structureType &&
			array.get(object.pos.x, object.pos.y) !== tile.character;
		var offPlan = MainCache.find(this._room, FIND_STRUCTURES).filter(isOffPlan).length +
			MainCache.find(this._room, FIND_MY_CONSTRUCTION_SITES).filter(isOffPlan).length;
		return Math.max(0, wanted - this._countPlanned(array, tile.character) - offPlan);
	}

	/*
	 * Plans everything the room will ever hold around the spawn, once. Single structures keep the
	 * spawn's checkerboard so that walkways stay open. Links and the extractor are not planned
	 * here because they depend on where sources and minerals are.
	 */

	_planCoreStructures(array, spawn, reserved) {
		var plan = [
			{ tile: RoomManager.TILE_STORAGE, minRange: 2 },
			{ tile: RoomManager.TILE_TERMINAL, near: RoomManager.TILE_STORAGE },
			{ tile: RoomManager.TILE_FACTORY, near: RoomManager.TILE_STORAGE },
			{ tile: RoomManager.TILE_TOWER, minRange: 3, spacing: 3 },
			{ tile: RoomManager.TILE_SPAWN, minRange: 3, spacing: 3 },
			{ tile: RoomManager.TILE_POWER_SPAWN, minRange: 3 },
			{ tile: RoomManager.TILE_NUKER, minRange: 4 },
			{ tile: RoomManager.TILE_OBSERVER, minRange: 4 },
		];
		var tiles = RoomManager.TILES_TO_BE_BUILD;
		var distances = null;
		plan.forEach(entry => {
			var tile = tiles.filter(candidate => candidate.character === entry.tile)[0];
			var missing = this._countMissingTiles(array, tile);
			if (missing <= 0) return;
			distances = this._distanceTransform(array);
			this._placeSingles(array, spawn, reserved, tile, missing, entry, distances);
		});
		this._planLabCluster(array, spawn, reserved);
	}

	_placeSingles(array, spawn, reserved, tile, count, entry, distances) {
		var anchors = [spawn.pos];
		if (entry.near) {
			var nearTiles = this._findTilesWithCharacter(array, entry.near);
			if (nearTiles.length === 0) return;
			anchors = nearTiles;
		}
		var parity = (spawn.pos.x + spawn.pos.y) % 2;
		var candidates = [];
		for (var x = 0; x < array.width; x++) {
			for (var y = 0; y < array.height; y++) {
				if ((x + y) % 2 !== parity || reserved.has(x + ',' + y) || !this._isOpenTile(array, x, y)) continue;
				var range = Math.min(...anchors.map(anchor => Math.max(Math.abs(anchor.x - x), Math.abs(anchor.y - y))));
				if (range < (entry.minRange || 1) || (entry.near && range > 2)) continue;
				candidates.push({ x: x, y: y, range: range, open: distances.at(x, y) });
			}
		}
		// the closest open ground wins, and more open ground breaks a tie
		candidates.sort((a, b) => a.range - b.range || b.open - a.open || a.x - b.x || a.y - b.y);
		var placed = this._findTilesWithCharacter(array, tile.character);
		candidates.forEach(candidate => {
			if (count <= 0) return;
			if (entry.spacing && placed.some(other => Math.max(Math.abs(other.x - candidate.x), Math.abs(other.y - candidate.y)) < entry.spacing)) return;
			array.set(candidate.x, candidate.y, tile.character);
			placed.push(candidate);
			count--;
		});
	}

	_findTilesWithCharacter(array, character) {
		var result = [];
		for (var x = 0; x < array.width; x++) {
			for (var y = 0; y < array.height; y++) {
				if (array.get(x, y) === character) result.push({ x: x, y: y });
			}
		}
		return result;
	}

	/*
	 * Ten labs where the two middle ones reach all eight others within reaction range:
	 *
	 *   B B B B
	 *   . B B .
	 *   B B B B
	 *
	 * The gaps at each end of the middle row let haulers reach the input labs.
	 */

	_planLabCluster(array, spawn, reserved) {
		var limits = CONTROLLER_STRUCTURES[STRUCTURE_LAB];
		if (!limits || !limits[config.MAX_RCL] || this._countPlanned(array, RoomManager.TILE_LAB) > 0) return;
		var isLab = object => object.structureType === STRUCTURE_LAB;
		if (MainCache.find(this._room, FIND_STRUCTURES).some(isLab) || MainCache.find(this._room, FIND_MY_CONSTRUCTION_SITES).some(isLab)) return;

		var distances = this._distanceTransform(array);
		var origins = [];
		for (var x = 2; x < array.width - 5; x++) {
			for (var y = 2; y < array.height - 4; y++) {
				if (distances.at(x + 1, y + 1) < 2) continue;
				origins.push({ x: x, y: y, range: Math.max(Math.abs(spawn.pos.x - x - 1), Math.abs(spawn.pos.y - y - 1)) });
			}
		}
		origins.sort((a, b) => a.range - b.range || a.x - b.x || a.y - b.y);
		var origin = origins.filter(candidate => candidate.range >= 4).find(candidate => {
			for (var dx = 0; dx < 4; dx++) {
				for (var dy = 0; dy < 3; dy++) {
					var key = (candidate.x + dx) + ',' + (candidate.y + dy);
					if (reserved.has(key) || !this._isOpenTile(array, candidate.x + dx, candidate.y + dy)) return false;
				}
			}
			return true;
		});
		if (!origin) return;
		for (var cx = 0; cx < 4; cx++) {
			for (var cy = 0; cy < 3; cy++) {
				if (cy === 1 && (cx === 0 || cx === 3)) continue;
				array.set(origin.x + cx, origin.y + cy, RoomManager.TILE_LAB);
			}
		}
	}

	/*
	 * The layout is a plan for the whole lifetime of the room, so it always holds the
	 * RCL 8 count. fetchFreeBuildingSlots() decides how many of them may be built now.
	 */

	_getExtensionsCount() {
		return CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][config.MAX_RCL];
	}

	_findExtensionPointsForSpawn(array, spawn, limit = array.width * array.height, reserved = new Set()) {
		limit -= (array.toCompactString().match(/o/g) || []).length;
		if (limit <= 0) return [];
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
					!reserved.has(x + ',' + y) &&
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
		var builtCount = MainCache.find(this._room, FIND_STRUCTURES, { filter: s => s.structureType == structureType }).length;
		var siteCount = MainCache.find(this._room, FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType == structureType }).length;
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

RoomManager.PLAN_VERSION = 2;
RoomManager.RAMPART_PLAN_VERSION = 1;
RoomManager.WALL_MIN_TILE = 3; // leaves one tile between the protected area and the unbuildable edge
RoomManager.WALL_MAX_TILE = 46;

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
