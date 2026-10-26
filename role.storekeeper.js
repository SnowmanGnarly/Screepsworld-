/*
 * Storekeepers are fast, WORK-less base haulers for energy logistics tasks.
 */

var RolePrototype = require('./role.prototype');
var LogisticsManager = require('./manager.logistics');
var LogisticsRunner = require('./logistics.runner');

class StoreKeeper extends RolePrototype {

    constructor() {
        super('Storekeeper', '#ff9900', '🏭');
        this.priority = 60;
        this._disableAutomaticLoot = true;
    }

    isNecessary(room) {
        return LogisticsManager.hasEligibleWork(room, { resourceType: RESOURCE_ENERGY });
    }

    spawnCreep(spawn) {
        return this._spawnCreepWithParts(spawn, [MOVE, CARRY]);
    }

    _work(creep) {
        LogisticsRunner.run(creep, this, { resourceType: RESOURCE_ENERGY });
    }
}

module.exports = StoreKeeper;
