/*
 * Works out how many creeps a room needs from what is actually in it: source output, the
 * distance energy has to travel, stored energy and open construction. Nothing here touches
 * Memory or spawns anything. Results are cached for the tick because roles ask repeatedly.
 */

var config = require('./main.config').ECONOMY;
var BODY = require('./main.config').BODY;
var MainCache = require('./main.cache');
var MainHeap = require('./main.heap');

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
	 * A source can only be mined statically once something next to it can take the energy.
	 */

	static hasDropoff(room, source) {
		return MainCache.find(room, FIND_STRUCTURES).some(structure => {
			return (structure.structureType === STRUCTURE_CONTAINER || structure.structureType === STRUCTURE_LINK) &&
				structure.pos.inRangeTo(source.pos, config.SOURCE_DROP_RANGE);
		});
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
	 * Static mining only keeps a room alive with both halves present: Miners digging and a hauler
	 * delivering. Mission creeps work elsewhere, so they do not count.
	 */

	static isSelfSustaining(room) {
		var base = room.memory.base;
		if (!base) return false;
		return MainCache.memo('selfSustaining:' + room.name, () => {
			var creeps = MainCache.getCreepsByHome(base.name).filter(creep => !creep.memory.missionId);
			return creeps.some(creep => creep.memory.role === 'Miner') && creeps.some(creep => creep.memory.role === 'Storekeeper');
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
		var mined = sources.filter(source => this.hasDropoff(room, source) && MainCache.getMinerCount(source.id) > 0);
		return Math.max(1, sources.length - mined.length);
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
		var isCapped = room.controller && room.controller.level >= 8;
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
	 * Sources with a link need no hauling, because their energy arrives by link.
	 */

	static getHaulingCarryParts(room) {
		return MainCache.memo('carry:' + room.name, () => {
			var hub = room.storage || MainCache.find(room, FIND_MY_SPAWNS)[0];
			if (!hub) return 0;
			var structures = MainCache.find(room, FIND_STRUCTURES);
			return this.getMinableSources(room).reduce((sum, source) => {
				var hasLink = structures.some(structure => structure.structureType === STRUCTURE_LINK &&
					structure.pos.inRangeTo(source.pos, config.SOURCE_DROP_RANGE));
				if (hasLink) return sum;
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
	 * One Upgrader keeps the controller alive; more are only paid for by stored surplus. At
	 * RCL 8 upgrading is capped per tick, so extra Upgraders would achieve nothing.
	 */

	static getDesiredUpgraders(room) {
		var controller = room.controller;
		if (!controller || !controller.my) return 0;
		if (controller.level >= 8 || !room.storage) return 1;
		var surplus = room.storage.store.getUsedCapacity(RESOURCE_ENERGY) - config.UPGRADER_STORAGE_FLOOR;
		var extra = Math.floor(Math.max(0, surplus) / config.UPGRADER_STORAGE_STEP);
		return Math.min(config.UPGRADER_MAX, 1 + extra);
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
