/*
 * TowerManager executes coordinated defense, healing, and emergency repair actions.
 */

var constants = require('./main.constants');
var config = require('./main.config');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var DefenseManager = require('./manager.defense');
var info = require('./main.info');

class TowerManager {

    static runAll() {
        MainUtil.findAllRooms().forEach(room => {
            try {
                new TowerManager(room).runTowers();
            } catch (error) {
                info.error('Could not run towers for ' + room.name + ': ' + error, room);
                console.log(error.stack);
            }
        });
    }

    constructor(room) {
        this._room = room;
    }

    runTowers() {
        var towers = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_TOWER
        });
        if (towers.length === 0) return;

        var plan = DefenseManager.getTowerPlan(this._room, towers);
        var damagedCreeps = MainCache.find(this._room, FIND_MY_CREEPS, {
            filter: creep => creep.hits < creep.hitsMax
        });
        var emergencyRepairs = this._findEmergencyRepairs();
        towers.forEach(tower => this._runTower(tower, plan, damagedCreeps, emergencyRepairs));
    }

    _findEmergencyRepairs() {
        var lowRamparts = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_RAMPART && structure.hits < config.DEFENSE.EMERGENCY_RAMPART_HITS
        });
        if (lowRamparts.length > 0) return lowRamparts;

        return MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => {
                return (structure.structureType === STRUCTURE_SPAWN ||
                    structure.structureType === STRUCTURE_TOWER || structure.structureType === STRUCTURE_STORAGE) &&
                    structure.hits < structure.hitsMax * config.DEFENSE.TOWER_EMERGENCY_REPAIR_RATIO;
            }
        });
    }

    _runTower(tower, plan, damagedCreeps, emergencyRepairs) {
        var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY);
        if (plan.target && plan.attackers.includes(tower) && energy >= TOWER_ENERGY_COST) {
            var attackResult = tower.attack(plan.target);
            if (attackResult === OK) return;
            if (attackResult !== ERR_NOT_IN_RANGE && attackResult !== ERR_INVALID_TARGET) {
                info.warning('Tower attack failed in ' + this._room.name + ': ' + attackResult, this._room);
            }
        }

        var hasReserve = energy >= config.DEFENSE.TOWER_ENERGY_RESERVE + TOWER_ENERGY_COST;
        if (!hasReserve) return;

        if (damagedCreeps.length > 0) {
            var closestDamagedCreep = damagedCreeps.slice().sort((a, b) => {
                return tower.pos.getRangeTo(a) - tower.pos.getRangeTo(b);
            })[0];
            tower.heal(closestDamagedCreep);
            return;
        }

        if (emergencyRepairs.length > 0) {
            var repairTarget = emergencyRepairs.slice().sort((a, b) => {
                return a.hits / a.hitsMax - b.hits / b.hitsMax;
            })[0];
            tower.repair(repairTarget);
        }
    }
}

module.exports = TowerManager;
