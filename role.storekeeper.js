/*
 * Storekeepers are fast, WORK-less base haulers for energy logistics tasks.
 */

var RolePrototype = require('./role.prototype');
var EconomyManager = require('./manager.economy');
var LogisticsManager = require('./manager.logistics');
var LogisticsRunner = require('./logistics.runner');

class StoreKeeper extends RolePrototype {

    constructor() {
        super('Storekeeper', '#ff9900', '🏭');
        this.movesEnergy = true;
        this.alwaysDerived = true; // limited by maxNumber, never switched off with the other roles
        this._disableAutomaticLoot = true;
    }

    getDemand(room) {
        return LogisticsManager.getDesiredWorkerCount(room, this.roleName);
    }

    isNecessary(room) {
        return LogisticsManager.hasEligibleWork(room, { resourceType: RESOURCE_ENERGY });
    }

    spawnCreep(spawn, options = {}) {
        return this._spawnCreepWithParts(spawn, [MOVE, CARRY], [], options);
    }

    _getUsefulBodyUnits(room) {
        return EconomyManager.getStorekeeperCarryParts(room);
    }

    _work(creep) {
        LogisticsRunner.run(creep, this, { resourceType: RESOURCE_ENERGY });
    }
}

module.exports = StoreKeeper;
