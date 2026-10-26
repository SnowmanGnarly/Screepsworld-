const MainCache = require('../../main.cache');
const MainInfo = require('../../main.info');
MainInfo.__originalLog = MainInfo.log;

const constants = {
    RESOURCE_ENERGY: 'energy', RESOURCE_OXYGEN: 'oxygen', RESOURCE_ZYNTHIUM: 'zynthium',
    FIND_MY_STRUCTURES: 'myStructures', FIND_STRUCTURES: 'structures', FIND_SOURCES: 'sources',
    FIND_SOURCES_ACTIVE: 'activeSources', FIND_MY_SPAWNS: 'mySpawns', FIND_HOSTILE_CREEPS: 'hostiles',
    FIND_MY_CREEPS: 'myCreeps', FIND_DROPPED_RESOURCES: 'dropped', FIND_TOMBSTONES: 'tombstones',
    FIND_RUINS: 'ruins', FIND_MINERALS: 'minerals', FIND_CONSTRUCTION_SITES: 'sites',
    FIND_MY_CONSTRUCTION_SITES: 'mySites', LOOK_STRUCTURES: 'structure', LOOK_CONSTRUCTION_SITES: 'site',
    LOOK_SOURCES: 'source', LOOK_MINERALS: 'mineral', LOOK_TERRAIN: 'terrain',
    STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_STORAGE: 'storage',
    STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link', STRUCTURE_TOWER: 'tower',
    STRUCTURE_CONTROLLER: 'controller', STRUCTURE_LAB: 'lab', STRUCTURE_TERMINAL: 'terminal',
    STRUCTURE_FACTORY: 'factory', STRUCTURE_EXTRACTOR: 'extractor', STRUCTURE_OBSERVER: 'observer',
    STRUCTURE_POWER_SPAWN: 'powerSpawn', STRUCTURE_NUKER: 'nuker', STRUCTURE_RAMPART: 'rampart',
    STRUCTURE_WALL: 'wall', STRUCTURE_ROAD: 'road',
    WORK: 'work', MOVE: 'move', CARRY: 'carry', TOUGH: 'tough', ATTACK: 'attack',
    RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', CLAIM: 'claim',
    BODYPART_COST: { work: 100, move: 50, carry: 50, tough: 10, attack: 80, ranged_attack: 150, heal: 250, claim: 600 },
    OK: 0, ERR_NOT_OWNER: -1, ERR_NO_PATH: -2, ERR_NAME_EXISTS: -3, ERR_BUSY: -4,
    ERR_NOT_ENOUGH_ENERGY: -6, ERR_NOT_ENOUGH_RESOURCES: -6, ERR_INVALID_TARGET: -7,
    ERR_FULL: -8, ERR_NOT_IN_RANGE: -9, ERR_NO_BODYPART: -12, ERR_RCL_NOT_ENOUGH: -14,
    TOWER_ENERGY_COST: 10, TERRAIN_MASK_WALL: 1,
};

Object.assign(global, constants);

class MockRoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }

    getRangeTo(target, y) {
        if (typeof target === 'object' && target.pos) target = target.pos;
        const x = typeof target === 'object' ? target.x : target;
        const otherY = typeof target === 'object' ? target.y : y;
        return Math.max(Math.abs(this.x - x), Math.abs(this.y - otherY));
    }

    inRangeTo(target, range) {
        return this.getRangeTo(target) <= range;
    }

    createConstructionSite(structureType, name) {
        const room = Game.rooms[this.roomName];
        room.createdSites.push({ x: this.x, y: this.y, structureType, name });
        return OK;
    }

    lookFor() {
        return [];
    }

    look() {
        return [];
    }
}

function makeStore(capacity, contents = {}) {
    const store = { ...contents };
    Object.defineProperties(store, {
        _capacity: { value: capacity, writable: true },
        getUsedCapacity: {
            value(resourceType) {
                if (resourceType) return store[resourceType] || 0;
                return Object.keys(store).reduce((sum, key) => sum + (typeof store[key] === 'number' ? store[key] : 0), 0);
            },
        },
        getFreeCapacity: {
            value() {
                return Math.max(0, store._capacity - store.getUsedCapacity());
            },
        },
        set: {
            value(resourceType, amount) {
                if (amount > 0) store[resourceType] = amount;
                else delete store[resourceType];
            },
        },
    });
    return store;
}

function makeRoom(name, options = {}) {
    return {
        name,
        memory: options.memory || {},
        controller: options.controller || { my: true, level: 1 },
        energyAvailable: options.energyAvailable === undefined ? 300 : options.energyAvailable,
        energyCapacityAvailable: options.energyCapacityAvailable || 300,
        visual: { text() {} },
        createdSites: [],
        _find: {},
        find(type, options) {
            const values = this._find[type] || [];
            return options && options.filter ? values.filter(options.filter) : values.slice();
        },
        getTerrain() {
            return { get: () => 0 };
        },
        lookAt() {
            return [];
        },
    };
}

function setFind(room, type, values) {
    room._find[type] = values;
    return values;
}

function makePosition(room, x, y) {
    return new MockRoomPosition(x, y, room.name);
}

function makeStructure(room, structureType, options = {}) {
    return {
        id: options.id || structureType + '-' + Math.random().toString(36).slice(2),
        structureType,
        room,
        pos: options.pos || makePosition(room, 25, 25),
        store: options.store || makeStore(1000),
        memory: options.memory,
        hits: options.hits === undefined ? 1000 : options.hits,
        hitsMax: options.hitsMax || 1000,
        ...options.extra,
    };
}

function makeCreep(room, options = {}) {
    const creep = {
        name: options.name || 'creep-' + Math.random().toString(36).slice(2),
        room,
        memory: options.memory || {},
        body: options.body || [WORK, CARRY, MOVE],
        store: options.store || makeStore(options.capacity || 300),
        pos: options.pos || makePosition(room, 25, 25),
        spawning: options.spawning || false,
        ticksToLive: options.ticksToLive || 1500,
        moveTo() {
            creep.memory.moving = true;
            return OK;
        },
        withdraw(source, resourceType, amount) {
            const available = source.store ? source.store.getUsedCapacity(resourceType) : 0;
            const count = Math.min(amount === undefined ? available : amount, available, creep.store.getFreeCapacity(resourceType));
            if (count <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            source.store.set(resourceType, source.store[resourceType] - count);
            creep.store.set(resourceType, (creep.store[resourceType] || 0) + count);
            return OK;
        },
        transfer(target, resourceType, amount) {
            const available = creep.store.getUsedCapacity(resourceType);
            const free = target.store.getFreeCapacity(resourceType);
            if (free <= 0) return ERR_FULL;
            const count = Math.min(amount === undefined ? available : amount, available, free);
            if (count <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            creep.store.set(resourceType, available - count);
            target.store.set(resourceType, (target.store[resourceType] || 0) + count);
            return OK;
        },
        pickup(source) {
            const resourceType = source.resourceType;
            const count = Math.min(source.amount, creep.store.getFreeCapacity(resourceType));
            if (count <= 0) return ERR_FULL;
            source.amount -= count;
            creep.store.set(resourceType, (creep.store[resourceType] || 0) + count);
            return OK;
        },
        harvest(source) {
            const workParts = creep.body.filter(part => part === WORK || part.type === WORK).length;
            if (workParts === 0) return ERR_NO_BODYPART;
            const resourceType = source.resourceType || RESOURCE_ENERGY;
            const available = source.amount === undefined ? 3000 : source.amount;
            const count = Math.min(workParts * 2, available, creep.store.getFreeCapacity(resourceType));
            if (count <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            source.amount = available - count;
            creep.store.set(resourceType, (creep.store[resourceType] || 0) + count);
            return OK;
        },
        attack() {
            return OK;
        },
    };
    return creep;
}

function makeSpawn(room, options = {}) {
    return {
        name: options.name || 'Spawn1',
        room,
        memory: options.memory || { home: room.name },
        spawning: null,
        pos: options.pos || makePosition(room, 25, 25),
        spawnCreep(body, name, options) {
            const creep = makeCreep(room, { name, body, memory: options.memory, spawning: true });
            Game.creeps[name] = creep;
            this.spawning = creep;
            return OK;
        },
    };
}

function resetScreeps(options = {}) {
    Object.assign(global, constants);
    global.Game = {
        time: options.time || 1,
        rooms: options.rooms || {},
        creeps: options.creeps || {},
        spawns: options.spawns || {},
        flags: options.flags || {},
        objects: {},
        notifications: [],
        getObjectById(id) {
            const object = this.objects[id];
            if (!object || object.destroyed) return null;
            if (object.roomName && !this.rooms[object.roomName]) return null;
            return object;
        },
        notify(message) {
            this.notifications.push(message);
        },
    };
    global.Memory = {};
    global.RoomPosition = MockRoomPosition;
    MainCache.initRound([]);
    const info = require('../../main.info');
    info.log = () => {};
    info.warning = () => {};
    info.error = () => {};
    return Game;
}

function registerObject(object, roomName) {
    if (roomName) object.roomName = roomName;
    Game.objects[object.id] = object;
    return object;
}

module.exports = {
    constants,
    makeStore,
    makeRoom,
    makeStructure,
    makeCreep,
    makeSpawn,
    makePosition,
    setFind,
    resetScreeps,
    registerObject,
};
