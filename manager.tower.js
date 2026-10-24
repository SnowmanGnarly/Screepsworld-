/*
 * This manager coordinates watchtowers for focus fire, friendly healing,
 * and emergency rampart/structure repairs.
 */

var constants = require('./main.constants');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var DefenseManager = require('./manager.defense');

class TowerManager {

	static runAll() {
		MainUtil.findAllRooms().forEach(room => new TowerManager(room).runTowers());
	}

	constructor(room) {
		this._room = room;
	}

	runTowers() {
		var allTowers = this._findTowers();
		if (allTowers.length == 0) {
			return;
		}
		var hostiles = MainCache.find(this._room, FIND_HOSTILE_CREEPS);
		var sharedHostile = this._selectSharedHostile(hostiles, allTowers);
		var damagedCreeps = MainCache.find(this._room, FIND_MY_CREEPS, {
			filter: creep => creep.hits < creep.hitsMax
		});
		var emergencyRepairs = sharedHostile ? [] : this._findEmergencyRepairs();
		allTowers.forEach(tower => this._runTower(tower, sharedHostile, damagedCreeps, emergencyRepairs));
	}

	_findTowers() {
		return MainCache.find(this._room, FIND_MY_STRUCTURES, {
			filter: structure => structure.structureType == STRUCTURE_TOWER
		});
	}

	_selectSharedHostile(hostiles, towers) {
		if (hostiles.length == 0) {
			return null;
		}
		var priorityTarget = DefenseManager.getPriorityTarget(this._room);
		if (priorityTarget) {
			return priorityTarget;
		}

		var criticalPositions = MainCache.find(this._room, FIND_MY_SPAWNS).map(spawn => spawn.pos)
			.concat(towers.map(tower => tower.pos));
		return hostiles.slice().sort((a, b) => {
			return this._getThreatScore(b, criticalPositions) - this._getThreatScore(a, criticalPositions);
		})[0];
	}

	_getThreatScore(creep, criticalPositions) {
		var score = 100 * creep.getActiveBodyparts(ATTACK) +
			120 * creep.getActiveBodyparts(RANGED_ATTACK) +
			150 * creep.getActiveBodyparts(HEAL) +
			80 * creep.getActiveBodyparts(WORK);
		if (criticalPositions.length > 0) {
			var closestRange = Math.min(...criticalPositions.map(position => creep.pos.getRangeTo(position)));
			score -= closestRange * 5;
		}
		return score;
	}

	_findEmergencyRepairs() {
		// First priority: damaged ramparts below safe threshold
		var lowRamparts = MainCache.find(this._room, FIND_MY_STRUCTURES, {
			filter: s => s.structureType == STRUCTURE_RAMPART && s.hits < 10000
		});
		if (lowRamparts.length > 0) {
			return lowRamparts;
		}

		return MainCache.find(this._room, FIND_MY_STRUCTURES, {
			filter: structure => {
				return (structure.structureType == STRUCTURE_SPAWN ||
					structure.structureType == STRUCTURE_TOWER ||
					structure.structureType == STRUCTURE_STORAGE) &&
					structure.hits < structure.hitsMax * constants.TOWER_EMERGENCY_REPAIR_RATIO;
			}
		});
	}

	_runTower(tower, sharedHostile, damagedCreeps, emergencyRepairs) {
		var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY);
		if (sharedHostile) {
			if (energy >= TOWER_ENERGY_COST) {
				tower.attack(sharedHostile);
			}
			return;
		}

		var hasReserve = energy >= constants.TOWER_ENERGY_RESERVE + TOWER_ENERGY_COST;
		if (damagedCreeps.length > 0 && hasReserve) {
			var closestDamagedCreep = damagedCreeps.slice().sort((a, b) => {
				return tower.pos.getRangeTo(a) - tower.pos.getRangeTo(b);
			})[0];
			tower.heal(closestDamagedCreep);
			return;
		}

		if (emergencyRepairs.length > 0 && hasReserve) {
			var repairTarget = emergencyRepairs.slice().sort((a, b) => {
				return a.hits / a.hitsMax - b.hits / b.hitsMax;
			})[0];
			tower.repair(repairTarget);
		}
	}
}

module.exports = TowerManager;
