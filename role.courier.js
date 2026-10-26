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
        this.priority = 40;
        this._disableAutomaticLoot = true;
    }

    isNecessary(room) {
        var hasLegacyConfig = !!(room.memory.source && room.memory.target);
        return hasLegacyConfig || LogisticsManager.hasEligibleWork(room);
    }

    spawnCreep(spawn) {
        return this._spawnCreepWithParts(spawn, [WORK, CARRY, MOVE, MOVE]);
    }

    _work(creep) {
        LogisticsRunner.run(creep, this);
    }
}

module.exports = Courier;
