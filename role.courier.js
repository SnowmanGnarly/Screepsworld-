/*
 * Couriers are multi-resource logistics haulers, including WORK-capable
 * legacy routes that require harvesting a Mineral.
 */

var RolePrototype = require('./role.prototype');
var LogisticsManager = require('./manager.logistics');
var LogisticsRunner = require('./logistics.runner');

class Courier extends RolePrototype {

    constructor() {
        super('Courier', '#ff8800', '📯');
        this.defaultMaxNumber = 1;
        this.alwaysDerived = true;
        this._disableAutomaticLoot = true;
    }

    getDemand(room) {
        return LogisticsManager.getDesiredWorkerCount(room, this.roleName);
    }

    isNecessary(room) {
        var hasLegacyConfig = !!(room.memory.source && room.memory.target);
        return hasLegacyConfig || LogisticsManager.hasEligibleWork(room);
    }

    spawnCreep(spawn, options = {}) {
        return this._spawnCreepWithParts(spawn, [WORK, CARRY, MOVE, MOVE], [], options);
    }

    _work(creep) {
        LogisticsRunner.run(creep, this);
    }
}

module.exports = Courier;
