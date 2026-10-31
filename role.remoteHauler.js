var MainCache = require('./main.cache');
var RolePrototype = require('./role.prototype');
var RemoteManager = require('./manager.remote');

class RemoteHauler extends RolePrototype {

    constructor() {
        super('RemoteHauler', '#ffdd66', '🚚');
        this._disableAutomaticLoot = true;
    }

    isNecessary(room) {
        return false;
    }

    spawnCreep(spawn) {
        return false;
    }

    _work(creep) {
        var foreignResources = Object.keys(creep.store).filter(resourceType => {
            return resourceType !== RESOURCE_ENERGY && typeof creep.store[resourceType] === 'number' && creep.store[resourceType] > 0;
        });
        if (foreignResources.length > 0) {
            this._deliverHome(creep, foreignResources);
            return;
        }

        var energy = creep.store.getUsedCapacity(RESOURCE_ENERGY);
        if (creep.memory.working && energy === 0) creep.memory.working = false;
        if (!creep.memory.working && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.working = true;

        if (creep.memory.working) this._deliverHome(creep, [RESOURCE_ENERGY]);
        else this._collectRemote(creep);
    }

    _deliverHome(creep, resourceTypes) {
        var homeRoom = creep.memory.homeRoom || this._baseRoom && this._baseRoom.name;
        var destination = creep.memory.homePos || { roomName: homeRoom, x: 25, y: 25 };
        if (!this._moveToRoom(creep, destination)) return;
        if (resourceTypes.length === 0) return;

        var resourceType = resourceTypes[0];
        var target = this._findHomeStore(creep.room, resourceType);
        if (!target) {
            if (resourceType !== RESOURCE_ENERGY) creep.drop(resourceType);
            return;
        }
        // a transfer only takes effect at the end of the tick, so the store cannot be measured after it
        var delivered = Math.min(creep.store.getUsedCapacity(resourceType), target.store.getFreeCapacity(resourceType));
        var result = creep.transfer(target, resourceType);
        if (result === ERR_NOT_IN_RANGE) {
            this._moveToLocation(creep, target);
        } else if (result === OK && resourceType === RESOURCE_ENERGY) {
            RemoteManager.recordEnergyDelivered(creep.memory.missionId, delivered);
            creep.memory.trips = (creep.memory.trips || 0) + 1;
        }
    }

    // the first walk out, with an empty hauler, is what the route's hauling need is measured from
    _recordArrival(creep) {
        if (creep.memory.arrivalRecorded) return;
        creep.memory.arrivalRecorded = true;
        if (creep.memory.trips) return; // a hauler from before this was measured is not on its first walk
        RemoteManager.recordHaulerArrival(creep.memory.missionId, CREEP_LIFE_TIME - creep.ticksToLive);
    }

    _findHomeStore(room, resourceType) {
        var candidates = [];
        if (room.storage) candidates.push(room.storage);
        if (room.terminal) candidates.push(room.terminal);
        MainCache.find(room, FIND_STRUCTURES).forEach(structure => {
            if ((structure.structureType === STRUCTURE_STORAGE || structure.structureType === STRUCTURE_TERMINAL) &&
                !candidates.includes(structure)) candidates.push(structure);
        });
        return candidates.filter(structure => structure.store &&
            structure.store.getFreeCapacity(resourceType) > 0)[0] || null;
    }

    _collectRemote(creep) {
        var destination = creep.memory.sourcePos || { roomName: creep.memory.targetRoom, x: 25, y: 25 };
        if (!this._moveToRoom(creep, destination)) return;

        if (creep.pos.inRangeTo(destination.x, destination.y, RemoteHauler.ARRIVAL_RANGE)) this._recordArrival(creep);
        var dropped = MainCache.find(creep.room, FIND_DROPPED_RESOURCES, {
            filter: resource => resource.resourceType === RESOURCE_ENERGY && resource.amount > 0,
        }).sort((a, b) => b.amount - a.amount || creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
        if (dropped.length > 0) {
            var pickupResult = creep.pickup(dropped[0]);
            if (pickupResult === ERR_NOT_IN_RANGE) this._moveToLocation(creep, dropped[0]);
            if (pickupResult === OK) MainCache.invalidateRoom(creep.room, FIND_DROPPED_RESOURCES);
            return;
        }

        var stores = MainCache.find(creep.room, FIND_STRUCTURES, {
            filter: structure => (structure.structureType === STRUCTURE_CONTAINER ||
                structure.structureType === STRUCTURE_STORAGE) && structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
        }).sort((a, b) => b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY) ||
            creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
        if (stores.length > 0) {
            var result = creep.withdraw(stores[0], RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) this._moveToLocation(creep, stores[0]);
            return;
        }

        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            creep.memory.working = true;
            this._deliverHome(creep, [RESOURCE_ENERGY]);
        } else if (creep.pos.getRangeTo(destination.x, destination.y) > 2) {
            this._moveToLocation(creep, new RoomPosition(destination.x, destination.y, creep.room.name));
        }
    }
}

RemoteHauler.ARRIVAL_RANGE = 3; // close enough to the source to count the walk as done

module.exports = RemoteHauler;
