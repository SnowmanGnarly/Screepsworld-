/*
 * Works out how many creeps a room needs from what is actually in it: source output, the
 * distance energy has to travel, stored energy and open construction. Nothing here touches
 * Memory or spawns anything. Results are cached for the tick because roles ask repeatedly.
 */

var config = require('./main.config').ECONOMY;
var BODY = require('./main.config').BODY;
var PLANNER = require('./main.config').PLANNER;
var MainCache = require('./main.cache');
var MainHeap = require('./main.heap');
var MainUtil = require('./main.util');
var constants = require('./main.constants');

class EconomyManager {

	/*
	 * A quota of 0 cannot mean "off", because every role starts at 0. An operator turns a role
	 * off with auto: false, which setCreepCount(room, role, 0) sets. A Mayor that is not in
	 * automatic mode means the operator is running this room by hand.
	 */

	static isAutomatic(room, roleName) {
		var base = room.memory.base;
		if (!base || base.autoDemand === false) return false;
		var mayor = room.memory.mayor;
		if (mayor && mayor.mode && mayor.mode !== 'auto') return false;
		var roleConfig = base.roleConfig && base.roleConfig[roleName];
		return !(roleConfig && roleConfig.auto === false);
	}

	static getSourceOutput(source) {
		return (source.energyCapacity || SOURCE_ENERGY_CAPACITY) / ENERGY_REGEN_TIME;
	}

	/*
	 * Links only send to other links. Energy reaches the room through the receiver beside the
	 * storage, which haulers empty. The controller's link does not count, because only Upgraders
	 * ever take from it.
	 */

	static getHubLink(room) {
		if (!room.storage) return null;
		return MainCache.memo('hubLink:' + room.name, () => {
			return MainCache.find(room, FIND_STRUCTURES).find(structure => {
				return structure.structureType === STRUCTURE_LINK &&
					MainUtil.fetchMemoryOfStructure(structure).type === constants.LINK_TYPE_TARGET &&
					structure.pos.inRangeTo(room.storage.pos, config.HUB_LINK_RANGE);
			}) || null;
		});
	}

	static hasDeliveringLink(room, source) {
		if (!this.getHubLink(room)) return false;
		var link = this._findSourceLink(room, source);
		if (!link) return false;
		// a Miner can only fill what it can reach from where it stands
		var post = this.getMinerPost(room, source);
		return Boolean(post) && link.pos.inRangeTo(post.x, post.y, 1);
	}

	static _findSourceLink(room, source) {
		return MainCache.find(room, FIND_STRUCTURES).find(structure => {
			return structure.structureType === STRUCTURE_LINK &&
				MainUtil.fetchMemoryOfStructure(structure).type !== constants.LINK_TYPE_TARGET &&
				structure.pos.inRangeTo(source.pos, config.SOURCE_DROP_RANGE);
		}) || null;
	}

	/*
	 * Where a Miner stands: on the container if it touches the source, because whatever overflows
	 * then falls into it. Otherwise on a tile that touches both the source and the drop-off.
	 */

	static getMinerPost(room, source) {
		return MainCache.memo('minerPost:' + source.id, () => {
			var container = MainCache.find(room, FIND_STRUCTURES).find(structure => {
				return structure.structureType === STRUCTURE_CONTAINER && structure.pos.inRangeTo(source.pos, config.SOURCE_DROP_RANGE);
			});
			if (container && container.pos.isNearTo(source.pos)) return { x: container.pos.x, y: container.pos.y };
			var dropoff = container || this._findSourceLink(room, source);
			return dropoff ? this._findTileTouching(room, source, dropoff) : null;
		});
	}

	static _findTileTouching(room, source, dropoff) {
		var terrain = room.getTerrain();
		var isBlocked = (x, y) => MainCache.find(room, FIND_STRUCTURES).some(structure => {
			return structure.pos.x === x && structure.pos.y === y &&
				structure.structureType !== STRUCTURE_ROAD && structure.structureType !== STRUCTURE_CONTAINER && structure.structureType !== STRUCTURE_RAMPART;
		});
		for (var dx = -1; dx <= 1; dx++) {
			for (var dy = -1; dy <= 1; dy++) {
				var x = source.pos.x + dx;
				var y = source.pos.y + dy;
				if ((dx === 0 && dy === 0) || !dropoff.pos.inRangeTo(x, y, 1)) continue;
				if (terrain.get(x, y) !== TERRAIN_MASK_WALL && !isBlocked(x, y)) return { x: x, y: y };
			}
		}
		return null;
	}

	/*
	 * A source can only be mined statically once something next to it can take the energy and get
	 * it to the rest of the room.
	 */

	static hasDropoff(room, source) {
		var hasContainer = MainCache.find(room, FIND_STRUCTURES).some(structure => {
			return structure.structureType === STRUCTURE_CONTAINER && structure.pos.inRangeTo(source.pos, config.SOURCE_DROP_RANGE);
		});
		return hasContainer || this.hasDeliveringLink(room, source);
	}

	static isSourceContainer(room, structure) {
		if (structure.structureType !== STRUCTURE_CONTAINER) return false;
		return MainCache.find(room, FIND_SOURCES).some(source => structure.pos.inRangeTo(source.pos, config.SOURCE_DROP_RANGE));
	}

	/*
	 * Haulers empty a source container only once it holds enough for a trip, so a worker that keeps
	 * taking from it stops that energy ever reaching the storage. Workers leave these containers
	 * alone while anything else in the room holds enough to be worth the walk.
	 */

	static withoutSourceContainers(room, stores) {
		var elsewhere = stores.filter(store => !this.isSourceContainer(room, store));
		var hasEnough = elsewhere.some(store => store.store.getUsedCapacity(RESOURCE_ENERGY) >= config.WORKER_STORE_MIN);
		return hasEnough ? elsewhere : stores;
	}

	static getMinableSources(room) {
		return MainCache.memo('minable:' + room.name, () => {
			return MainCache.find(room, FIND_SOURCES).filter(source => this.hasDropoff(room, source));
		});
	}

	static getDesiredMiners(room) {
		return this.getMinableSources(room).length;
	}

	/*
	 * Static mining only keeps a room alive with both halves present: a Miner on a source whose
	 * energy can reach the room, and a hauler delivering it. Mission creeps work elsewhere, so they
	 * do not count.
	 */

	static isSelfSustaining(room) {
		var base = room.memory.base;
		if (!base) return false;
		return MainCache.memo('selfSustaining:' + room.name, () => {
			var creeps = MainCache.getCreepsByHome(base.name).filter(creep => !creep.memory.missionId);
			var minable = this.getMinableSources(room).map(source => source.id);
			return creeps.some(creep => creep.memory.role === 'Miner' && minable.includes(creep.memory.source)) &&
				creeps.some(creep => creep.memory.role === 'Storekeeper');
		});
	}

	/*
	 * Harvesters are the bootstrap economy. Before static mining works each source gets one, and a
	 * source only stops needing it once a Miner really works there, because a new container alone
	 * adds no income. Once the room sustains itself they are not replaced: a source with a container
	 * belongs to the Miner queue, and only a source that cannot be mined statically needs one.
	 */

	static getDesiredHarvesters(room) {
		var sources = MainCache.find(room, FIND_SOURCES);
		if (this.isSelfSustaining(room)) {
			return sources.filter(source => !this.hasDropoff(room, source)).length;
		}
		var unmined = sources.filter(source => !this.hasDropoff(room, source) || MainCache.getMinerCount(source.id) === 0);
		var wanted = unmined.reduce((sum, source) => sum + this._getHarvestersForSource(room, source), 0);
		return Math.max(1, wanted);
	}

	/*
	 * A small early body leaves most of a source unharvested, so it takes several creeps to use it.
	 * They also need somewhere to stand.
	 */

	static _getHarvestersForSource(room, source) {
		var workPerCreep = Math.max(1, Math.floor(room.energyCapacityAvailable / this._getWorkerUnitCost()));
		var wanted = Math.ceil(this.getHarvestWorkParts() / workPerCreep);
		return Math.min(wanted, config.HARVESTERS_PER_SOURCE_MAX, this._countOpenTiles(room, source));
	}

	static _getWorkerUnitCost() {
		return BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE] * 2;
	}

	static _countOpenTiles(room, source) {
		return MainHeap.cached('openTiles:' + source.id, undefined, () => {
			var terrain = room.getTerrain();
			var open = 0;
			for (var dx = -1; dx <= 1; dx++) {
				for (var dy = -1; dy <= 1; dy++) {
					if ((dx !== 0 || dy !== 0) && terrain.get(source.pos.x + dx, source.pos.y + dy) !== TERRAIN_MASK_WALL) open++;
				}
			}
			return open;
		});
	}

	static getIncome(room) {
		return MainCache.find(room, FIND_SOURCES).reduce((sum, source) => sum + this.getSourceOutput(source), 0);
	}

	/*
	 * WORK parts that empty a source exactly as fast as it refills. More would only stand idle.
	 */

	static getHarvestWorkParts() {
		return Math.ceil(SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME / HARVEST_POWER);
	}

	/*
	 * Upgrading and repairing spend one energy per WORK part per tick, so a creep is sized by the
	 * income it may spend. A bigger creep also does the work of several for one creep's CPU.
	 */

	static getSpendingWorkParts(room) {
		var income = this.getIncome(room);
		if (income <= 0) return BODY.DEFAULT_UNITS;
		var affordable = Math.max(1, Math.ceil(income * config.SPENDING_SHARE));
		var isCapped = room.controller && room.controller.level >= PLANNER.MAX_RCL;
		return isCapped ? Math.min(CONTROLLER_MAX_UPGRADE_PER_TICK, affordable) : affordable;
	}

	/*
	 * Building spends BUILD_POWER energy per WORK part per tick.
	 */

	static getBuilderWorkParts(room) {
		var income = this.getIncome(room);
		return income > 0 ? Math.max(1, Math.ceil(income / BUILD_POWER)) : BODY.DEFAULT_UNITS;
	}

	/*
	 * One Storekeeper big enough for the whole route is cheaper on CPU than several small ones,
	 * but carrying more than the route produces is wasted energy. MOVE pairs with every CARRY.
	 */

	static getStorekeeperCarryParts(room) {
		var wanted = Math.max(config.HAULER_MIN_CARRY, this.getHaulingCarryParts(room));
		return Math.min(wanted, Math.floor(MAX_CREEP_SIZE / 2));
	}

	/*
	 * CARRY parts = output x round trip / CARRY_CAPACITY, for each source being mined statically.
	 * A source whose link can deliver needs no hauling, because its energy arrives by link.
	 */

	static getHaulingCarryParts(room) {
		return MainCache.memo('carry:' + room.name, () => {
			var hub = room.storage || MainCache.find(room, FIND_MY_SPAWNS)[0];
			if (!hub) return 0;
			return this.getMinableSources(room).reduce((sum, source) => {
				if (this.hasDeliveringLink(room, source)) return sum;
				var distance = this.getRouteLength(room, hub, source);
				return sum + Math.ceil(this.getSourceOutput(source) * 2 * distance / CARRY_CAPACITY);
			}, 0);
		});
	}

	/*
	 * Path searches are expensive and a route barely changes, so the length is measured once and
	 * kept on the heap. After a global reset it is simply measured again.
	 */

	static getRouteLength(room, hub, source) {
		var key = 'route:' + room.name + ':' + hub.id + ':' + source.id;
		return MainHeap.cached(key, config.ROUTE_TTL, () => {
			var path = hub.pos.findPathTo ? hub.pos.findPathTo(source.pos, { ignoreCreeps: true, range: 1 }) : [];
			return path.length > 0 ? path.length : hub.pos.getRangeTo(source.pos) * config.PATH_FACTOR;
		});
	}

	static getDesiredStorekeepers(room, carryPerCreep) {
		var carryParts = this.getHaulingCarryParts(room);
		if (carryParts <= 0) return config.WORKERS_FALLBACK;
		var workers = Math.ceil(carryParts / Math.max(1, carryPerCreep));
		return Math.min(config.WORKERS_MAX, Math.max(config.WORKERS_FALLBACK, workers));
	}

	/*
	 * Upgrading is where a room's income should end up, so its size follows what is mined rather
	 * than what is saved. One Upgrader keeps the controller alive before static mining works, when
	 * Harvesters upgrade with what they have left, and while the storage rebuilds its reserve.
	 * Savings above the reserve pay for more. At RCL 8 upgrading is capped per tick.
	 */

	static getDesiredUpgraders(room) {
		var controller = room.controller;
		if (!controller || !controller.my) return 0;
		var reserve = this._getSpareEnergy(room);
		if (!this.isSelfSustaining(room) || reserve < 0) return 1;

		var workPerCreep = Math.max(1, Math.min(this.getSpendingWorkParts(room), Math.floor(room.energyCapacityAvailable / this._getWorkerUnitCost())));
		if (controller.level >= PLANNER.MAX_RCL) return Math.ceil(CONTROLLER_MAX_UPGRADE_PER_TICK / workPerCreep);
		// rounding up can spend more than this share, and the reserve check above is what stops that:
		// below the reserve the room asks for one Upgrader and lets the others die off
		var fromIncome = Math.ceil(this._getMinedIncome(room) * config.UPGRADE_INCOME_SHARE / workPerCreep);
		var fromSavings = Math.floor(reserve / config.UPGRADER_STORAGE_STEP);
		return Math.min(config.UPGRADER_MAX, Math.max(1, fromIncome) + fromSavings);
	}

	/*
	 * What the room holds beyond the reserve it needs for spawning. Before there is a storage, that
	 * reserve is what the haulers take from the containers to fill the spawn.
	 */

	static _getSpareEnergy(room) {
		if (room.storage) return room.storage.store.getUsedCapacity(RESOURCE_ENERGY) - config.UPGRADER_STORAGE_FLOOR;
		var held = MainCache.find(room, FIND_STRUCTURES).reduce((sum, structure) => {
			return structure.structureType === STRUCTURE_CONTAINER ? sum + structure.store.getUsedCapacity(RESOURCE_ENERGY) : sum;
		}, 0);
		return Math.min(0, held - config.UPGRADER_CONTAINER_FLOOR);
	}

	static _getMinedIncome(room) {
		return this.getMinableSources(room).reduce((sum, source) => {
			return MainCache.getMinerCount(source.id) > 0 ? sum + this.getSourceOutput(source) : sum;
		}, 0);
	}

	static getDesiredBuilders(room) {
		var remaining = MainCache.find(room, FIND_MY_CONSTRUCTION_SITES).reduce((sum, site) => {
			return sum + Math.max(0, site.progressTotal - site.progress);
		}, 0);
		if (remaining <= 0) return 0;
		return Math.min(config.BUILDER_MAX, 1 + Math.floor(remaining / config.BUILDER_PROGRESS_STEP));
	}
}

module.exports = EconomyManager;
