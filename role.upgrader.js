/*
 * Upgraders handle the room controller.
 */

var MainUtil = require('./main.util');
var MainCache = require('./main.cache');

var RolePrototype = require('./role.prototype');

class Upgrader extends RolePrototype {

    constructor() {
        super('Upgrader', '#00ff00', '⚡');
        this.priority = 50;
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
                    (structure.structureType == STRUCTURE_LINK && MainUtil.fetchMemoryOfStructure(structure).type == 'target')) &&
                    structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
            }
        }) : [];
        if (storedEnergy.length > 0 || !this._useSourceAsSource) {
            return storedEnergy;
        }
        return this._findActiveSources(room);
    }

    _findTargets(room) {
        return room.controller && room.controller.my ? [room.controller] : [];
    }
}

module.exports = Upgrader;
