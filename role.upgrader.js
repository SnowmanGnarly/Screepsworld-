/*
 * Upgraders handle the room controller.
 */

var constants = require('./main.constants');
var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var EconomyManager = require('./manager.economy');

var RolePrototype = require('./role.prototype');

class Upgrader extends RolePrototype {

    constructor() {
        super('Upgrader', '#00ff00', '⚡');
    }

    getDemand(room) {
        return EconomyManager.getDesiredUpgraders(room);
    }

    _getUsefulBodyUnits(room) {
        return EconomyManager.getSpendingWorkParts(room);
    }

    _work(creep) {
        this._commuteBetweenSourceAndTarget(creep, target => creep.upgradeController(target));
    }

    _findClosestTarget(creep) {
        var controller = this._baseRoom && this._baseRoom.controller;
        if (creep.memory.target && (!controller || creep.memory.target != controller.id)) {
            creep.memory.target = null;
        }
        return super._findClosestTarget(creep);
    }

    _findSources(room) {
        var storedEnergy = this._useStorageAsSource ? MainCache.find(room, FIND_STRUCTURES, {
            filter: structure => {
                return (structure.structureType == STRUCTURE_STORAGE ||
                    structure.structureType == STRUCTURE_CONTAINER ||
                    (structure.structureType == STRUCTURE_LINK && MainUtil.fetchMemoryOfStructure(structure).type == constants.LINK_TYPE_TARGET)) &&
                    structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
            }
        }) : [];
        if (storedEnergy.length > 0 || !this._useSourceAsSource) {
            return EconomyManager.withoutSourceContainers(room, storedEnergy);
        }
        return this._findActiveSources(room);
    }

    _findTargets(room) {
        return room.controller && room.controller.my ? [room.controller] : [];
    }

    /*
     * An Upgrader spends its life at the controller, so what counts is how far the energy is from
     * there. That is what makes a controller link pay off.
     */

    _sortSourceForClosest(sources, creep) {
        var controller = this._baseRoom && this._baseRoom.controller;
        if (!controller) return super._sortSourceForClosest(sources, creep);
        return sources.sort((a, b) => a.pos.getRangeTo(controller) - b.pos.getRangeTo(controller));
    }
}

module.exports = Upgrader;
