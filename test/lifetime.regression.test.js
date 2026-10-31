const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject, rebuildGameObjects,
} = require('./helpers/screeps');
const MainInfo = require('../main.info');

const LIMITS = {
    spawn: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
    extension: { 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
    tower: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
    storage: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
    container: { 0: 5, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5, 8: 5 },
    road: { 0: 2500, 1: 2500, 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
};

function addSource(room, id, x, y) {
    const source = { id, room, pos: makePosition(room, x, y), energy: 3000, energyCapacity: 3000 };
    registerObject(source, room.name);
    setFind(room, FIND_SOURCES, (room._find[FIND_SOURCES] || []).concat(source));
    setFind(room, FIND_SOURCES_ACTIVE, (room._find[FIND_SOURCES_ACTIVE] || []).concat(source));
    return source;
}

function newRoom() {
    const room = makeRoom('A', { energyAvailable: 300, energyCapacityAvailable: 300 });
    room.controller = { my: true, level: 3, owner: { username: 'Me' }, pos: makePosition(room, 40, 25), id: 'controller', structureType: STRUCTURE_CONTROLLER };
    registerObject(room.controller, 'A');
    const spawn = makeSpawn(room, { name: 'Spawn1', memory: {}, pos: makePosition(room, 25, 25) });
    Object.assign(spawn, { id: 'spawn', structureType: STRUCTURE_SPAWN, my: true, hits: 5000, hitsMax: 5000, store: makeStore(300, { [RESOURCE_ENERGY]: 300 }) });
    registerObject(spawn, 'A');
    Game.rooms.A = room;
    Game.spawns.Spawn1 = spawn;
    setFind(room, FIND_MY_SPAWNS, [spawn]);
    setFind(room, FIND_STRUCTURES, [spawn]);
    setFind(room, FIND_MY_STRUCTURES, [spawn]);
    addSource(room, 's1', 10, 10);
    addSource(room, 's2', 40, 40);
    return room;
}

function finishSites(room) {
    const sites = room.createdSites.splice(0);
    room._find[FIND_CONSTRUCTION_SITES] = [];
    room._find[FIND_MY_CONSTRUCTION_SITES] = [];
    sites.forEach(site => {
        const structure = makeStructure(room, site.structureType, { id: site.id + '-' + Game.time, pos: site.pos, extra: { my: true, owner: { username: 'Me' } } });
        if (site.structureType === STRUCTURE_STORAGE) room.storage = structure;
        if (site.structureType === STRUCTURE_TOWER) Object.assign(structure, { attack: () => OK, heal: () => OK, repair: () => OK });
        if (site.structureType === STRUCTURE_LINK) Object.assign(structure, { cooldown: 0, transferEnergy: () => OK });
        registerObject(structure, room.name);
        room._find[FIND_STRUCTURES].push(structure);
        room._find[FIND_MY_STRUCTURES].push(structure);
    });
}

function applyMoves() {
    Object.values(Game.creeps).forEach(creep => {
        const destination = creep.lastMoveTo && (creep.lastMoveTo.pos || creep.lastMoveTo);
        if (destination) creep.pos = new RoomPosition(destination.x, destination.y, destination.roomName);
        if (creep.followedPath) {
            const [x, y] = creep.followedPath.split(',').map(Number);
            creep.pos = new RoomPosition(x, y, creep.pos.roomName);
        }
        creep.lastMoveTo = null;
        creep.followedPath = null;
        creep.spawning = false;
    });
}

describe('Game object lifetime', function () {
    const main = require('../main');
    let problems;
    let originalConsoleLog;

    beforeEach(function () {
        resetScreeps();
        global.CONTROLLER_STRUCTURES = LIMITS;
        problems = [];
        MainInfo.error = message => problems.push(String(message));
        MainInfo.log = message => { if (message instanceof Error) problems.push(String(message)); };
        MainInfo.warning = message => { if (/Stale game object/.test(String(message))) problems.push(String(message)); };
        originalConsoleLog = console.log;
        console.log = message => { if (/Stale game object/.test(String(message))) problems.push(String(message)); };
    });

    afterEach(function () {
        console.log = originalConsoleLog;
        delete global.CONTROLLER_STRUCTURES;
    });

    it('fails loudly when something keeps a game object across ticks', function () {
        const room = newRoom();
        const kept = room.controller;
        rebuildGameObjects();
        assert.throws(() => kept.level, /Stale game object/);
        assert.equal(Game.rooms.A.controller.level, 3, 'the new instance still works');
        assert.equal(Game.rooms.A.controller.pos.x, 40);
        assert.notEqual(Game.rooms.A, room);
        assert.equal(Game.spawns.Spawn1.room, Game.rooms.A, 'links between objects point at the new instances');
    });

    it('also fails on a kept store, and on writing to a kept object', function () {
        const room = newRoom();
        const kept = Game.spawns.Spawn1;
        const keptStore = kept.store;
        rebuildGameObjects();
        assert.throws(() => keptStore.getUsedCapacity(RESOURCE_ENERGY), /Stale game object/);
        assert.throws(() => { kept.hits = 1; }, /Stale game object/);
        assert.throws(() => { room.energyAvailable = 1; }, /Stale game object/);
        assert.equal(Game.spawns.Spawn1.store.getUsedCapacity(RESOURCE_ENERGY), 300, 'the new store has the contents');
    });

    it('does not throw on a console command with a wrong link ID', function () {
        const LinkManager = require('../manager.link');
        assert.doesNotThrow(() => LinkManager.makeLinkSource('nope'));
    });

    it('reports the running version on request, in step with the package', function () {
        const config = require('../main.config');
        assert.equal(config.VERSION, require('../package.json').version);
        assert.equal(global.version(), config.VERSION);
    });

    it('keeps memory and carried stores across the rebuild', function () {
        const room = newRoom();
        room.memory.marker = 'kept';
        Game.creeps.c = makeCreep(room, { name: 'c', memory: { role: 'Builder', home: 'A' }, store: makeStore(50, { [RESOURCE_ENERGY]: 20 }) });
        rebuildGameObjects();
        assert.equal(Game.rooms.A.memory.marker, 'kept');
        assert.equal(Game.creeps.c.store.getUsedCapacity(RESOURCE_ENERGY), 20);
        assert.equal(Game.creeps.c.room, Game.rooms.A);
    });

    it('reports code that reads a kept object during the loop', function () {
        const BaseManager = require('../manager.base');
        const room = newRoom();
        let kept = room;
        BaseManager.registerMissionSpawnProvider('keeper', () => { kept.name; kept = Game.rooms.A; return []; });
        try {
            Memory.creeps = {};
            Game.creeps.c = makeCreep(room, { name: 'c', memory: { role: 'Harvester', home: 'Spawn1' } });
            Game.creeps.d = makeCreep(room, { name: 'd', memory: { role: 'Upgrader', home: 'Spawn1' } });
            main.loop();
            kept = Game.rooms.A;
            Game.time++;
            rebuildGameObjects();
            main.loop();
            assert.ok(problems.some(problem => /Stale game object/.test(problem)), 'the stale read reached the error log');
        } finally {
            BaseManager.unregisterMissionSpawnProvider('keeper');
        }
    });

    it('runs a growing room for many ticks without touching an object from an earlier tick', function () {
        newRoom();
        // a real path, so creeps walk through the stored-path code and not only moveTo
        Game.rooms.A.findPath = (from, to) => to.x + ',' + to.y;
        const seenRoles = new Set();
        let followedPaths = 0;
        for (let tick = 0; tick < 400; tick++) {
            const room = Game.rooms.A;
            const creeps = Object.values(Game.creeps);
            Memory.creeps = Memory.creeps || {};
            creeps.forEach(creep => { Memory.creeps[creep.name] = creep.memory; });
            setFind(room, FIND_MY_CREEPS, creeps);
            Game.spawns.Spawn1.spawning = null;
            room.energyCapacityAvailable = 300 + room._find[FIND_STRUCTURES].filter(s => s.structureType === STRUCTURE_EXTENSION).length * 50;
            room.energyAvailable = room.energyCapacityAvailable;
            main.loop();
            Object.values(Game.creeps).forEach(creep => seenRoles.add(creep.memory.role));
            if (seenRoles.has('Builder')) finishSites(room);
            followedPaths += Object.values(Game.creeps).filter(creep => creep.followedPath).length;
            applyMoves();
            Game.time++;
            rebuildGameObjects();
        }
        assert.deepEqual(problems, []);
        ['Harvester', 'Upgrader', 'Builder', 'Miner', 'Storekeeper'].forEach(role => assert.ok(seenRoles.has(role), role + ' appeared'));
        assert.ok(followedPaths > 0, 'creeps used stored paths');
    });

    it('defends with towers and links for many ticks without touching an old object', function () {
        const room = newRoom();
        room.controller.level = 6;
        room.energyCapacityAvailable = 1300;
        room.energyAvailable = 1300;
        let attacks = 0;
        let transfers = 0;
        const place = (type, id, x, y, extra, store) => {
            const structure = makeStructure(room, type, { id, pos: makePosition(room, x, y), store, extra: Object.assign({ my: true, owner: { username: 'Me' } }, extra) });
            registerObject(structure, 'A');
            room._find[FIND_STRUCTURES].push(structure);
            room._find[FIND_MY_STRUCTURES].push(structure);
            return structure;
        };
        room.storage = place(STRUCTURE_STORAGE, 'storage', 22, 25, {}, makeStore(1000000, { [RESOURCE_ENERGY]: 200000 }));
        place(STRUCTURE_TOWER, 'tower', 28, 25, {
            attack() { attacks++; return OK; },
            heal() { return OK; },
            repair() { return OK; },
        }, makeStore(1000, { [RESOURCE_ENERGY]: 1000 }));
        const linkMethods = { cooldown: 0, transferEnergy() { transfers++; return OK; } };
        place(STRUCTURE_LINK, 'link-source', 11, 11, linkMethods, makeStore(800, { [RESOURCE_ENERGY]: 800 }));
        place(STRUCTURE_LINK, 'link-target', 23, 24, linkMethods, makeStore(800));
        place(STRUCTURE_CONTAINER, 'container', 39, 39, {}, makeStore(2000, { [RESOURCE_ENERGY]: 1000 }));
        Memory.structures = { 'link-source': { type: require('../main.constants').LINK_TYPE_SOURCE }, 'link-target': { type: require('../main.constants').LINK_TYPE_TARGET } };
        const hostile = makeCreep(room, { name: 'raider', owner: { username: 'Raider' }, pos: makePosition(room, 30, 25), body: [ATTACK, RANGED_ATTACK, HEAL, MOVE] });
        setFind(room, FIND_HOSTILE_CREEPS, [hostile]);
        Game.creeps.miner = makeCreep(room, { name: 'miner', memory: { role: 'Miner', home: 'Spawn1', source: 's2' }, pos: makePosition(room, 39, 40) });
        Game.creeps.hauler = makeCreep(room, { name: 'hauler', memory: { role: 'Storekeeper', home: 'Spawn1' }, pos: makePosition(room, 24, 24) });
        Game.creeps.up = makeCreep(room, { name: 'up', memory: { role: 'Upgrader', home: 'Spawn1' }, pos: makePosition(room, 38, 25) });

        for (let tick = 0; tick < 150; tick++) {
            const current = Game.rooms.A;
            const creeps = Object.values(Game.creeps);
            Memory.creeps = Memory.creeps || {};
            creeps.forEach(creep => { Memory.creeps[creep.name] = creep.memory; });
            setFind(current, FIND_MY_CREEPS, creeps);
            Game.spawns.Spawn1.spawning = null;
            main.loop();
            finishSites(current);
            applyMoves();
            Game.time++;
            rebuildGameObjects();
        }
        assert.deepEqual(problems.filter(problem => !/DEFENSE ALERT/.test(problem)), []);
        assert.ok(attacks > 0, 'the tower fired');
        assert.ok(transfers > 0, 'the link fired');
    });
});
