/*
 * Harvesters collect resources that can be used to do stuff.
 */

var MainUtil = require('./main.util');
var MainCache = require('./main.cache');

var RolePrototype = require('./role.prototype');

class Harvester extends RolePrototype {

    constructor() {
        super('Harvester', '#ffffff', '🧺');
        this.priority = 100;
        this._sourceMode = RolePrototype.SOURCE_MODE_USE_IF_VALID;
    }

    spawnCreep(spawn, options = {}) {
        if (options.emergency) {
            return this._spawnCreepWithParts(spawn, [WORK, CARRY, MOVE], [], { exact: true });
        }
        return super.spawnCreep(spawn);
    }

    _work(creep) {
        this._commuteBetweenSourceAndTarget(creep, target => {
            if (target.structureType == STRUCTURE_CONTROLLER) {
                return creep.upgradeController(target);
            }
            return creep.transfer(target, RESOURCE_ENERGY);
        });
    }

    _findSources(room) {
        var containers = this._useStorageAsSource ? MainCache.find(room, FIND_STRUCTURES, {
            filter: structure => structure.structureType == STRUCTURE_CONTAINER &&
                structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0
        }) : [];
        return containers.concat(this._findActiveSources(room));
    }

    _findTargets(room) {
        const structures = MainCache.find(room, FIND_MY_STRUCTURES, {
            filter: (structure) => {
                return (structure.structureType == STRUCTURE_EXTENSION ||
                    structure.structureType == STRUCTURE_SPAWN ||
                    structure.structureType == STRUCTURE_STORAGE ||
                    (structure.structureType == STRUCTURE_LINK && MainUtil.fetchMemoryOfStructure(structure).type == 'source') ||
                    structure.structureType == STRUCTURE_TOWER) &&
                    structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
            }
        });

        if (room.controller && room.controller.my) {
            structures.push(room.controller);
        }

        return structures;
    }

    _sortTargetForClosest(targets, creep) {
        return targets.sort((a, b) => {
            const getPriority = (target) => {
                if (target.structureType == STRUCTURE_EXTENSION ||
                    target.structureType == STRUCTURE_SPAWN) return 5;
                if (target.structureType == STRUCTURE_TOWER) return 4;
                if (target.structureType == STRUCTURE_LINK) return 3;
                if (target.structureType == STRUCTURE_STORAGE) return 2;
                if (target.structureType == STRUCTURE_CONTROLLER) return 1;
                return 0;
            };

            const aPriority = getPriority(a);
            const bPriority = getPriority(b);

            if (aPriority !== bPriority) {
                return bPriority - aPriority;
            }

            return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
        });
    }
}

module.exports = Harvester;

