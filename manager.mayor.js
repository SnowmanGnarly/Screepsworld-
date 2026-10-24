/*
 * The Mayor validates the base state and fixes problems.
 * Extended with an automatic construction queue across controller levels (RCL 1 - 8)
 * and intelligent placement heuristics for extractors, towers, storage, links, labs, and terminals.
 */

var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');

var RoadManager = require('./manager.road');
var RoomManager = require('./manager.room');

class MayorManager {

	static runAll() {
		MainUtil.findAllRooms().forEach(room => {
			try {
				new MayorManager(room).run();
			} catch (e) {
				info.error('Could not run Mayor for room ' + MainUtil.getDisplayName(room) + ': ' + e);
				console.log(e.stack);
			}
		});
	}

	constructor(room) {
		this._room = room;
		this._memory = this._fetchMemoryOfMayor();
	}

	_fetchMemoryOfMayor() {
		var defaultArray = {
			x: 10,
			y: 0,
			mode: MayorManager.MODE_DEFAULT,
			temp: {},
		};
		if (this._room.memory.mayor) {
			this._room.memory.mayor = Object.assign(defaultArray, this._room.memory.mayor);
		} else {
			this._room.memory.mayor = defaultArray;
		}
		return this._room.memory.mayor;
	}

	run() {
		this.errors = [];
		this.warnings = [];

		this._validate();
		this._fixProblems();
		this._visualize();
	}

	_validate() {
		if (!this._room.memory.base) {
			return;
		}

		this._cache = {
			myCreeps: MainCache.find(this._room, FIND_MY_CREEPS),
			constructionSites: MainCache.find(this._room, FIND_CONSTRUCTION_SITES),
			roadConstructionSites: null,
			structures: null,
		};

		['_validateRoads', '_validateCreeps', '_validateBuildings'].forEach(method => {
			try {
				this[method]();
			} catch (e) {
				info.error('Mayor validation ' + method + ' failed: ' + e, this._room);
				console.log(e.stack);
			}
		});
	}

	_validateRoads() {
		if (this._cache.myCreeps.length == 0) {
			return;
		}
		if (this._room.memory.base.roleConfig.Builder && this._room.memory.base.roleConfig.Builder.requiredNumber == 0) {
			return;
		}

		var roadManager = new RoadManager(this._room);
		var roadPositions = roadManager.fetchPositionsOverThreshold().filter(pos => {
			return pos.look().filter(obj => obj.structure && obj.structure.structureType == STRUCTURE_ROAD).length == 0;
		});
		if (roadPositions.length > 0) {
			this.warnings.push({
				text: 'Roads are missing.',
				solution: 'I\'m building roads.',
				act: () => this._buildRoads(roadPositions),
			});
		}
	}

	_buildRoads(roadPositions) {
		if (!this._cache.roadConstructionSites) {
			this._cache.roadConstructionSites = this._cache.constructionSites.filter(site => site.structureType == STRUCTURE_ROAD);
		}
		if (this._cache.roadConstructionSites.length > 0) {
			return;
		}
		for (var i = 0; i < roadPositions.length; i++) {
			if (roadPositions[i].createConstructionSite(STRUCTURE_ROAD) == OK) {
				MainCache.invalidateRoom(this._room, FIND_CONSTRUCTION_SITES);
				MainCache.invalidateRoom(this._room, FIND_MY_CONSTRUCTION_SITES);
				this._cache.constructionSites = MainCache.find(this._room, FIND_CONSTRUCTION_SITES);
				info.log('👷‍♀️ Mayor built a road at: ' + roadPositions[i]);
				break;
			}
		}
	}

	_validateCreeps() {
		var baseName = this._room.memory.base.name;
		var homeCreeps = MainCache.getCreepsByHome(baseName);
		if (homeCreeps.length == 0) {
			this.errors.push({
				text: 'No creeps belong to this base.',
				solution: 'BaseManager is attempting emergency Harvester recovery.',
			});
			return;
		}

		var roleConfig = this._room.memory.base.roleConfig;
		if (!roleConfig) return;

		// Harvesters
		if (roleConfig.Harvester && roleConfig.Harvester.requiredNumber == 0) {
			this.errors.push({
				text: 'Harvester is missing.',
				solution: 'Spawning Harvester.',
				act: () => roleConfig.Harvester.requiredNumber = 1,
			});
		}

		// Upgraders
		if (roleConfig.Upgrader && roleConfig.Upgrader.requiredNumber == 0) {
			this.errors.push({
				text: 'Upgrader is missing.',
				solution: 'Spawning Upgrader.',
				act: () => roleConfig.Upgrader.requiredNumber = 1,
			});
		}

		// Builders
		if (this._cache.constructionSites.length > 0 && roleConfig.Builder && roleConfig.Builder.requiredNumber == 0) {
			this.warnings.push({
				text: 'Builder is missing.',
				solution: 'Spawning Builder.',
				act: () => roleConfig.Builder.requiredNumber = 1,
			});
		}

		// Handymen
		if (!this._cache.structures) {
			this._cache.structures = MainCache.find(this._room, FIND_STRUCTURES, { filter: s => s.hits < s.hitsMax });
		}
		if (this._cache.structures.length > 0 && roleConfig.Handyman && roleConfig.Handyman.requiredNumber == 0) {
			this.warnings.push({
				text: 'Handyman is missing.',
				solution: 'Spawning Handyman.',
				act: () => roleConfig.Handyman.requiredNumber = 1,
			});
		}
	}

	_fixProblems() {
		if (this._memory.mode === MayorManager.MODE_AUTO) {
			this.errors.forEach(error => {
				try {
					if (error.act) error.act();
				} catch (e) {
					info.error('Could not fix error "' + error.text + '": ' + e);
				}
			});
			this.warnings.forEach(warning => {
				try {
					if (warning.act) warning.act();
				} catch (e) {
					info.error('Could not fix warning "' + warning.text + '": ' + e);
				}
			});
		}
	}

	/*
	 * Evaluates and plans structures based on Controller Level (RCL 1 - 8).
	 */
	_validateBuildings() {
		// Limit active construction sites to avoid builder confusion
		var notRoadConstructionSites = this._cache.constructionSites.filter(site => site.structureType != STRUCTURE_ROAD);
		if (notRoadConstructionSites.length >= 2) {
			return;
		}

		var roomManager = new RoomManager(this._room);
		var somethingWasBuilt = false;

		// Prioritized structure building list (RCL 1 - 8 unlocks)
		for (var i = 0; i < RoomManager.TILES_TO_BE_BUILD.length; i++) {
			var tileToBeBuild = RoomManager.TILES_TO_BE_BUILD[i];
			var freeSlots = roomManager.fetchFreeBuildingSlots(tileToBeBuild.character);

			if (freeSlots > 0) {
				this.warnings.push({
					text: 'Buildable structure ' + tileToBeBuild.structureType,
					solution: 'I\'m building ' + tileToBeBuild.structureType,
					act: () => this._buildStructure(roomManager, tileToBeBuild),
				});
				somethingWasBuilt = true;
				break;
			}
		}

		if (!somethingWasBuilt) {
			for (var j = 0; j < RoomManager.TILES_ENDLESS_STRUCTURES.length; j++) {
				var tileEndless = RoomManager.TILES_ENDLESS_STRUCTURES[j];
				var buildingPositions = this._fetchBuildingSitePositionsForTile(roomManager, tileEndless);

				if (buildingPositions.length > 0) {
					this.warnings.push({
						text: 'Buildable structure ' + tileEndless.structureType,
						solution: 'I\'m building ' + tileEndless.structureType,
						act: () => this._buildStructureAtPosition(buildingPositions[0], tileEndless),
					});
					break;
				}
			}
		}
	}

	_buildStructure(roomManager, tileToBeBuild) {
		// 1. Check for dedicated architectural placement rules
		var smartPos = this._findSmartPlacementPosition(tileToBeBuild.structureType);
		if (smartPos) {
			this._buildStructureAtPosition(smartPos, tileToBeBuild);
			return;
		}

		// 2. Fallback to pre-drawn layout tiles
		var buildingPositions = this._fetchBuildingSitePositionsForTile(roomManager, tileToBeBuild);
		if (buildingPositions.length > 0) {
			this._buildStructureAtPosition(buildingPositions[0], tileToBeBuild);
		} else {
			info.warning("Could not find building position for " + tileToBeBuild.structureType, this._room);
		}
	}

	/*
	 * Placement Rules for RCL Unlocks:
	 * Extractor: Directly on mineral
	 * Storage: Central near spawn
	 * Tower: Range 3-4 from spawn
	 * Links: Sources, controller, and storage
	 * Labs: Clustered within range 2
	 * Terminal / Factory: Adjacent to storage
	 */
	_findSmartPlacementPosition(structureType) {
		var spawns = MainCache.find(this._room, FIND_MY_SPAWNS);
		var primarySpawn = spawns.length > 0 ? spawns[0] : null;

		// 1. Extractor: directly on mineral deposit
		if (structureType === STRUCTURE_EXTRACTOR) {
			var minerals = this._room.find(FIND_MINERALS);
			if (minerals.length > 0 && this._isPositionBuildable(minerals[0].pos)) {
				return minerals[0].pos;
			}
		}

		if (!primarySpawn) return null;

		// 2. Storage: placed 2-3 tiles from primary spawn
		if (structureType === STRUCTURE_STORAGE) {
			return this._findClearTileAround(primarySpawn.pos, 2, 3);
		}

		// 3. Tower: placed 3-4 tiles from primary spawn
		if (structureType === STRUCTURE_TOWER) {
			return this._findClearTileAround(primarySpawn.pos, 3, 4);
		}

		// 4. Terminal: placed adjacent to Storage (range 1-2)
		if (structureType === STRUCTURE_TERMINAL) {
			var storage = this._room.storage;
			var anchor = storage ? storage.pos : primarySpawn.pos;
			return this._findClearTileAround(anchor, 1, 2);
		}

		// 5. Factory: placed adjacent to Storage/Terminal (range 1-2)
		if (structureType === STRUCTURE_FACTORY) {
			var anchorFact = this._room.storage ? this._room.storage.pos : primarySpawn.pos;
			return this._findClearTileAround(anchorFact, 1, 2);
		}

		// 6. Links: 1 near source, 1 near controller, 1 near storage
		if (structureType === STRUCTURE_LINK) {
			var existingLinks = MainCache.find(this._room, FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LINK });
			var sources = MainCache.find(this._room, FIND_SOURCES);

			// Link near sources
			for (var s = 0; s < sources.length; s++) {
				var src = sources[s];
				var hasLinkNear = existingLinks.some(l => l.pos.inRangeTo(src, 2));
				if (!hasLinkNear) {
					var pos = this._findClearTileAround(src.pos, 1, 2);
					if (pos) return pos;
				}
			}

			// Link near controller
			if (this._room.controller) {
				var hasControllerLink = existingLinks.some(l => l.pos.inRangeTo(this._room.controller, 2));
				if (!hasControllerLink) {
					var ctrlPos = this._findClearTileAround(this._room.controller.pos, 2, 2);
					if (ctrlPos) return ctrlPos;
				}
			}

			// Link near storage
			if (this._room.storage) {
				var hasStorageLink = existingLinks.some(l => l.pos.inRangeTo(this._room.storage, 2));
				if (!hasStorageLink) {
					var storPos = this._findClearTileAround(this._room.storage.pos, 1, 2);
					if (storPos) return storPos;
				}
			}
		}

		// 7. Labs: Grouped within reaction range (<= 2 tiles of anchor lab)
		if (structureType === STRUCTURE_LAB) {
			var existingLabs = MainCache.find(this._room, FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_LAB });
			if (existingLabs.length === 0) {
				// Anchor lab near storage or spawn (range 4-5)
				return this._findClearTileAround(primarySpawn.pos, 4, 5);
			} else {
				// Subsequent labs must be within range 2 of existing lab
				return this._findClearTileAround(existingLabs[0].pos, 1, 2);
			}
		}

		// 8. Subsequent Spawns (RCL 7 and 8)
		if (structureType === STRUCTURE_SPAWN) {
			return this._findClearTileAround(primarySpawn.pos, 3, 5);
		}

		return null;
	}

	_findClearTileAround(centerPos, minRange, maxRange) {
		for (var dx = -maxRange; dx <= maxRange; dx++) {
			for (var dy = -maxRange; dy <= maxRange; dy++) {
				var range = Math.max(Math.abs(dx), Math.abs(dy));
				if (range < minRange) continue;

				var x = centerPos.x + dx;
				var y = centerPos.y + dy;
				if (x < 2 || x > 47 || y < 2 || y > 47) continue;

				var testPos = new RoomPosition(x, y, this._room.name);
				if (this._isPositionBuildable(testPos)) {
					return testPos;
				}
			}
		}
		return null;
	}

	_isPositionBuildable(pos) {
		var terrain = this._room.getTerrain().get(pos.x, pos.y);
		if (terrain === TERRAIN_MASK_WALL) return false;

		var structures = pos.lookFor(LOOK_STRUCTURES);
		if (structures.length > 0) return false;

		var sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
		if (sites.length > 0) return false;

		return true;
	}

	_fetchBuildingSitePositionsForTile(roomManager, tileToBeBuild) {
		var spawn = MainCache.find(this._room, FIND_MY_SPAWNS)[0];
		var positions = roomManager.fetchBuildingSitePositionsForTile(tileToBeBuild.character)
			.filter(pos => (pos.look().filter(obj => obj.type == LOOK_STRUCTURES || obj.type == LOOK_CONSTRUCTION_SITES).length == 0));
		if (spawn) {
			positions.sort((a, b) => spawn.pos.getRangeTo(a.x, a.y) - spawn.pos.getRangeTo(b.x, b.y));
		}
		return positions;
	}

	_buildStructureAtPosition(buildingPosition, tileToBeBuild) {
		var constructionResult = buildingPosition.createConstructionSite(tileToBeBuild.structureType);
		if (constructionResult == OK) {
			MainCache.invalidateRoom(this._room, FIND_CONSTRUCTION_SITES);
			MainCache.invalidateRoom(this._room, FIND_MY_CONSTRUCTION_SITES);
			this._cache.constructionSites = MainCache.find(this._room, FIND_CONSTRUCTION_SITES);
			info.log('👷‍♀️ Mayor built a ' + tileToBeBuild.structureType + ' at: ' + buildingPosition, this._room);
		} else if (constructionResult != ERR_FULL && constructionResult != ERR_RCL_NOT_ENOUGH) {
			info.error('👷‍♀️ Mayor could not build ' + tileToBeBuild.structureType + ' at: ' + buildingPosition + ' (' + constructionResult + ')', this._room);
		}
	}

	_visualize() {
		var x = this._memory.x;
		var y = this._memory.y;

		this._room.visual.text('👷‍♀️ ' + this._getModeDisplayName(this._memory.mode), x, y++, { align: 'left', opacity: 0.8 });

		if (this._memory.mode === MayorManager.MODE_OFF) {
			return;
		}

		var warn = this._memory.mode !== MayorManager.MODE_AUTO;

		this.errors.forEach(error => {
			this._room.visual.text('🔴 ' + (warn ? error.text : error.solution), x + 1, y++, { align: 'left', opacity: 0.8, color: '#ff0000' });
		});

		if (this.errors.length <= 3) {
			this.warnings.forEach(warning => {
				this._room.visual.text('🟡 ' + (warn ? warning.text : warning.solution), x + 1, y++, { align: 'left', opacity: 0.8, color: '#ffff00' });
			});
		}
	}

	_getModeDisplayName(mode) {
		switch (mode) {
			case MayorManager.MODE_OFF: return 'Mayor is off';
			case MayorManager.MODE_WARN: return 'Mayor will warn you';
			case MayorManager.MODE_AUTO: return 'Mayor will act';
			default: return '???';
		}
	}
}

MayorManager.MODE_OFF = 'off';
MayorManager.MODE_WARN = 'warn';
MayorManager.MODE_AUTO = 'auto';
MayorManager.MODE_DEFAULT = MayorManager.MODE_AUTO;
MayorManager.MODES_ALL = [MayorManager.MODE_OFF, MayorManager.MODE_WARN, MayorManager.MODE_AUTO];

module.exports = MayorManager;
