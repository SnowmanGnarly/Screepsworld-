/*
 * Builds a room from a live snapshot saved by test/fixtures/fetch-live-room.js: the real terrain,
 * every object where it stands with what it holds, the room's Memory and its creeps' Memory.
 * Call resetScreeps() first. Like the other mocks, actions apply at once and creeps only move
 * when a test moves them.
 */

const {
    makeRoom, makeStructure, makeStore, makeCreep, makeSpawn, makePosition, setFind, registerObject,
} = require('./screeps');

// the API sends terrain as one digit per tile, row by row: bit 1 is a wall, bit 2 a swamp
function makeTerrain(encoded) {
    const masks = Array.from(encoded, digit => {
        const value = Number(digit);
        return value & TERRAIN_MASK_WALL ? TERRAIN_MASK_WALL : value & TERRAIN_MASK_SWAMP ? TERRAIN_MASK_SWAMP : 0;
    });
    return {
        get(x, y) {
            if (x < 0 || y < 0 || x > 49 || y > 49) return TERRAIN_MASK_WALL;
            return masks[y * 50 + x];
        },
    };
}

function storeOf(object) {
    const capacities = object.storeCapacityResource || {};
    const capacity = object.storeCapacity || Object.values(capacities).reduce((sum, value) => sum + value, 0);
    return makeStore(capacity, { ...(object.store || {}) });
}

const STORELESS = new Set([STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_WALL, STRUCTURE_EXTRACTOR, STRUCTURE_OBSERVER, STRUCTURE_KEEPER_LAIR, STRUCTURE_PORTAL]);

function loadLiveRoom(fixture) {
    const ownerId = (fixture.objects.find(object => object.type === 'controller') || {}).user;
    const username = id => (fixture.users[id] || {}).username;
    Game.time = fixture.time;
    Memory.creeps = JSON.parse(JSON.stringify(fixture.memory.creeps));
    Memory.rooms = { [fixture.room]: JSON.parse(JSON.stringify(fixture.memory.room)) };

    const room = makeRoom(fixture.room, { memory: Memory.rooms[fixture.room], controller: null });
    const terrain = makeTerrain(fixture.terrain);
    room.getTerrain = () => terrain;
    Game.rooms[fixture.room] = room;

    const found = {
        sources: [], minerals: [], structures: [], mine: [], spawns: [], sites: [], dropped: [],
        tombstones: [], ruins: [], myCreeps: [], hostileCreeps: [], hostileStructures: [],
    };
    const pos = object => makePosition(room, object.x, object.y);

    fixture.objects.forEach(object => {
        const my = object.user === ownerId;
        if (object.type === 'source') {
            found.sources.push(registerObject({
                id: object._id, room, pos: pos(object), energy: object.energy, energyCapacity: object.energyCapacity,
                ticksToRegeneration: object.ticksToRegeneration,
            }, room.name));
        } else if (object.type === 'mineral') {
            found.minerals.push(registerObject({
                id: object._id, room, pos: pos(object), mineralType: object.mineralType, mineralAmount: object.mineralAmount,
                density: object.density, ticksToRegeneration: object.nextRegenerationTime ? object.nextRegenerationTime - fixture.time : undefined,
            }, room.name));
        } else if (object.type === 'controller') {
            room.controller = registerObject({
                id: object._id, structureType: STRUCTURE_CONTROLLER, room, pos: pos(object), my: true,
                owner: { username: username(object.user) }, level: object.level, progress: object.progress,
                progressTotal: CONTROLLER_LEVELS[object.level], ticksToDowngrade: object.downgradeTime - fixture.time,
                safeModeAvailable: object.safeModeAvailable, safeMode: object.safeMode > fixture.time ? object.safeMode - fixture.time : undefined,
            }, room.name);
            found.structures.push(room.controller);
            found.mine.push(room.controller);
        } else if (object.type === 'creep') {
            const body = object.body.map(part => part.type);
            const creep = makeCreep(room, {
                name: object.name, body, pos: pos(object), memory: Memory.creeps[object.name] || {},
                store: makeStore(body.filter(part => part === CARRY).length * CARRY_CAPACITY, { ...(object.store || {}) }),
                ticksToLive: object.ageTime ? object.ageTime - fixture.time : undefined,
                hits: object.hits, hitsMax: object.hitsMax, owner: { username: username(object.user) },
            });
            creep.id = object._id;
            creep.my = my;
            creep.fatigue = object.fatigue || 0;
            creep.body = object.body.map(part => ({ type: part.type, hits: part.hits, boost: part.boost }));
            registerObject(creep, room.name);
            if (my) {
                Memory.creeps[object.name] = creep.memory;
                Game.creeps[object.name] = creep;
                found.myCreeps.push(creep);
            } else {
                found.hostileCreeps.push(creep);
            }
        } else if (object.type === 'constructionSite') {
            found.sites.push(registerObject({
                id: object._id, room, pos: pos(object), structureType: object.structureType, my,
                progress: object.progress, progressTotal: object.progressTotal,
            }, room.name));
        } else if (object.type === 'energy' || object.type === 'resource') {
            const resourceType = object.resourceType || RESOURCE_ENERGY;
            found.dropped.push(registerObject({ id: object._id, room, pos: pos(object), resourceType, amount: object[resourceType] || object.amount }, room.name));
        } else if (object.type === 'tombstone' || object.type === 'ruin') {
            const remains = registerObject({ id: object._id, room, pos: pos(object), store: makeStore(1000000, { ...(object.store || {}) }) }, room.name);
            (object.type === 'tombstone' ? found.tombstones : found.ruins).push(remains);
        } else {
            const structure = makeStructure(room, object.type, {
                id: object._id, pos: pos(object), store: storeOf(object), hits: object.hits, hitsMax: object.hitsMax,
                extra: { my, owner: object.user ? { username: username(object.user) } : undefined },
            });
            if (STORELESS.has(object.type)) delete structure.store;
            if (object.type === STRUCTURE_SPAWN) {
                Object.assign(structure, makeSpawn(room, { name: object.name, pos: structure.pos, memory: (fixture.memory.spawns || {})[object.name] }), {
                    id: object._id, structureType: STRUCTURE_SPAWN, store: storeOf(object), my, hits: object.hits, hitsMax: object.hitsMax,
                    spawning: object.spawning || null,
                });
                structure.memory = structure.memory || { home: (room.memory.base || {}).name || room.name };
                Game.spawns[object.name] = structure;
                found.spawns.push(structure);
            }
            if (object.type === STRUCTURE_STORAGE) room.storage = structure;
            if (object.type === STRUCTURE_TERMINAL) room.terminal = structure;
            registerObject(structure, room.name);
            found.structures.push(structure);
            if (my) found.mine.push(structure);
            else if (object.user) found.hostileStructures.push(structure);
        }
    });

    const energyStructures = found.mine.filter(structure => structure.structureType === STRUCTURE_SPAWN || structure.structureType === STRUCTURE_EXTENSION);
    room.energyAvailable = energyStructures.reduce((sum, structure) => sum + structure.store.getUsedCapacity(RESOURCE_ENERGY), 0);
    room.energyCapacityAvailable = energyStructures.reduce((sum, structure) => sum + structure.store._capacity, 0);

    setFind(room, FIND_SOURCES, found.sources);
    setFind(room, FIND_SOURCES_ACTIVE, found.sources.filter(source => source.energy > 0));
    setFind(room, FIND_MINERALS, found.minerals);
    setFind(room, FIND_STRUCTURES, found.structures);
    setFind(room, FIND_MY_STRUCTURES, found.mine);
    setFind(room, FIND_MY_SPAWNS, found.spawns);
    setFind(room, FIND_CONSTRUCTION_SITES, found.sites);
    setFind(room, FIND_MY_CONSTRUCTION_SITES, found.sites.filter(site => site.my));
    setFind(room, FIND_DROPPED_RESOURCES, found.dropped);
    setFind(room, FIND_TOMBSTONES, found.tombstones);
    setFind(room, FIND_RUINS, found.ruins);
    setFind(room, FIND_MY_CREEPS, found.myCreeps);
    setFind(room, FIND_CREEPS, found.myCreeps.concat(found.hostileCreeps));
    setFind(room, FIND_HOSTILE_CREEPS, found.hostileCreeps);
    setFind(room, FIND_HOSTILE_STRUCTURES, found.hostileStructures);
    setFind(room, FIND_HOSTILE_SPAWNS, found.hostileStructures.filter(structure => structure.structureType === STRUCTURE_SPAWN));
    return room;
}

module.exports = { loadLiveRoom, makeTerrain };
