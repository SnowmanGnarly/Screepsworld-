var MainCache = require('./main.cache');
var RolePrototype = require('./role.prototype');
var RemoteManager = require('./manager.remote');

class RemoteMiner extends RolePrototype {

    constructor() {
        super('RemoteMiner', '#ffaa00', '⛏️');
        this.priority = -10;
        this._disableAutomaticLoot = true;
    }

    isNecessary(room) {
        return false;
    }

    spawnCreep(spawn) {
        return false;
    }

    _work(creep) {
        if (!creep.memory.initialTicksToLive) creep.memory.initialTicksToLive = creep.ticksToLive;
        var destination = creep.memory.sourcePos || { roomName: creep.memory.targetRoom, x: 25, y: 25 };
        if (!this._moveToRoom(creep, destination)) return;

        var source = Game.getObjectById(creep.memory.sourceId || creep.memory.source);
        if (!source) {
            if (creep.pos.x !== destination.x || creep.pos.y !== destination.y) {
                this._moveToLocation(creep, new RoomPosition(destination.x, destination.y, creep.room.name));
            }
            return;
        }

        var before = creep.store.getUsedCapacity(RESOURCE_ENERGY);
        var harvestResult = ERR_NOT_ENOUGH_RESOURCES;
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && source.energy > 0) {
            harvestResult = creep.harvest(source);
            if (harvestResult === ERR_NOT_IN_RANGE) {
                this._moveToLocation(creep, source);
                return;
            }
            if (harvestResult === OK) {
                var harvested = creep.store.getUsedCapacity(RESOURCE_ENERGY) - before;
                RemoteManager.recordEnergyHarvested(creep.memory.missionId, harvested);
                if (!creep.memory.ticksToSource) {
                    creep.memory.ticksToSource = creep.ticksToLive;
                    RemoteManager.recordMinerArrival(creep.memory.missionId,
                        creep.memory.initialTicksToLive - creep.ticksToLive, source);
                }
            }
        }

        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return;
        if (this._buildNearbySite(creep)) return;
        this._deliverOrDrop(creep);
    }

    _buildNearbySite(creep) {
        var sites = MainCache.find(creep.room, FIND_CONSTRUCTION_SITES, {
            filter: site => site.progress < site.progressTotal && creep.pos.inRangeTo(site, 3),
        }).sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
        if (sites.length === 0) return false;
        var site = sites[0];
        var result = creep.build(site);
        if (result === ERR_NOT_IN_RANGE) this._moveToLocation(creep, site);
        if (result === OK && site.progress + creep.getActiveBodyparts(WORK) * 5 >= site.progressTotal) {
            MainCache.invalidateRoom(creep.room, FIND_CONSTRUCTION_SITES);
            MainCache.invalidateRoom(creep.room, FIND_MY_CONSTRUCTION_SITES);
        }
        return result === OK || result === ERR_NOT_IN_RANGE;
    }

    _deliverOrDrop(creep) {
        var targets = MainCache.find(creep.room, FIND_STRUCTURES, {
            filter: structure => (structure.structureType === STRUCTURE_CONTAINER ||
                structure.structureType === STRUCTURE_STORAGE) &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && creep.pos.inRangeTo(structure, 3),
        }).sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
        if (targets.length > 0) {
            var result = creep.transfer(targets[0], RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) this._moveToLocation(creep, targets[0]);
            return;
        }
        if (creep.drop(RESOURCE_ENERGY) === OK) MainCache.invalidateRoom(creep.room, FIND_DROPPED_RESOURCES);
    }
}

module.exports = RemoteMiner;
