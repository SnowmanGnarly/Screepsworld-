const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const BaseManager = require('../manager.base');
const EconomyManager = require('../manager.economy');
const LogisticsManager = require('../manager.logistics');
const MainHeap = require('../main.heap');
const MainInfo = require('../main.info');
const config = require('../main.config');
const Builder = require('../role.builder');
const Harvester = require('../role.harvester');
const Miner = require('../role.miner');
const Scout = require('../role.scout');
const Upgrader = require('../role.upgrader');

const LIMITS = {
    spawn: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
    extension: { 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
    tower: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
    storage: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
    container: { 0: 5, 1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 5, 7: 5, 8: 5 },
};

function homeRoom(options = {}) {
    const room = makeRoom('A', {
        memory: { base: { name: 'A', showIcons: false, roleConfig: Object.assign({ showIcons: false }, options.roleConfig) } },
        energyAvailable: options.energy === undefined ? 300 : options.energy,
        energyCapacityAvailable: options.capacity || 300,
    });
    room.controller = { my: true, level: options.level || 2, pos: makePosition(room, 30, 30) };
    const spawn = makeSpawn(room, { name: 'Spawn1' });
    Game.rooms.A = room;
    Game.spawns.Spawn1 = spawn;
    setFind(room, FIND_MY_SPAWNS, [spawn]);
    return { room, spawn };
}

function addCreep(room, name, role, options = {}) {
    Game.creeps[name] = makeCreep(room, Object.assign({ name, memory: { role, home: 'A' } }, options));
    return Game.creeps[name];
}

function addSource(room, id, x, y) {
    const source = { id, room, pos: makePosition(room, x, y), energy: 3000, energyCapacity: 3000 };
    registerObject(source, room.name);
    setFind(room, FIND_SOURCES, (room._find[FIND_SOURCES] || []).concat(source));
    return source;
}

function addStructure(room, type, x, y, options = {}) {
    const structure = makeStructure(room, type, Object.assign({ pos: makePosition(room, x, y) }, options));
    registerObject(structure, room.name);
    setFind(room, FIND_STRUCTURES, (room._find[FIND_STRUCTURES] || []).concat(structure));
    return structure;
}

describe('Derived spawn demand', function () {
    beforeEach(function () {
        resetScreeps();
    });

    describe('EconomyManager', function () {
        it('only counts sources that have somewhere to drop energy as minable', function () {
            const { room } = homeRoom();
            addSource(room, 's1', 10, 10);
            addSource(room, 's2', 40, 40);
            addStructure(room, STRUCTURE_CONTAINER, 11, 11);
            assert.equal(EconomyManager.getDesiredMiners(room), 1);
        });

        it('keeps a Harvester for each source that cannot be mined statically', function () {
            const { room } = homeRoom();
            addSource(room, 's1', 10, 10);
            addSource(room, 's2', 40, 40);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 2);
            addStructure(room, STRUCTURE_CONTAINER, 11, 11);
            require('../main.cache').initRound([]);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 2, 'a container alone adds no income');
            addCreep(room, 'miner', 'Miner', { memory: { role: 'Miner', home: 'A', source: 's1' } });
            require('../main.cache').initRound([]);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 1);
        });

        it('derives hauling from output and distance, and skips sources with a link', function () {
            const { room } = homeRoom();
            room.storage = makeStructure(room, STRUCTURE_STORAGE, { pos: makePosition(room, 10, 40) });
            addSource(room, 's1', 40, 40);
            addStructure(room, STRUCTURE_CONTAINER, 39, 39);
            const roundTrip = 30 * config.ECONOMY.PATH_FACTOR * 2;
            assert.equal(EconomyManager.getHaulingCarryParts(room), Math.ceil(10 * roundTrip / CARRY_CAPACITY));
            addStructure(room, STRUCTURE_LINK, 41, 41);
            require('../main.cache').initRound([]);
            assert.equal(EconomyManager.getHaulingCarryParts(room), 0);
        });

        it('scales Upgraders with stored surplus and stops at RCL 8', function () {
            const { room } = homeRoom();
            assert.equal(EconomyManager.getDesiredUpgraders(room), 1);
            room.storage = makeStructure(room, STRUCTURE_STORAGE, { store: makeStore(1000000, { [RESOURCE_ENERGY]: 50000 }) });
            assert.equal(EconomyManager.getDesiredUpgraders(room), 1);
            room.storage.store.set(RESOURCE_ENERGY, 300000);
            assert.equal(EconomyManager.getDesiredUpgraders(room), 3);
            room.storage.store.set(RESOURCE_ENERGY, 1000000);
            assert.equal(EconomyManager.getDesiredUpgraders(room), config.ECONOMY.UPGRADER_MAX);
            room.controller.level = 8;
            assert.equal(EconomyManager.getDesiredUpgraders(room), 1);
        });

        it('scales Builders with remaining construction work', function () {
            const { room } = homeRoom();
            assert.equal(EconomyManager.getDesiredBuilders(room), 0);
            require('../main.cache').initRound([]);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ progress: 0, progressTotal: 3000 }]);
            assert.equal(EconomyManager.getDesiredBuilders(room), 1);
            require('../main.cache').initRound([]);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ progress: 0, progressTotal: 100000 }]);
            assert.equal(EconomyManager.getDesiredBuilders(room), config.ECONOMY.BUILDER_MAX);
        });

        it('sizes the Storekeeper fleet from hauling need once tasks are open', function () {
            const { room } = homeRoom({ capacity: 800 });
            room.storage = makeStructure(room, STRUCTURE_STORAGE, { pos: makePosition(room, 10, 40) });
            addSource(room, 's1', 40, 40);
            addStructure(room, STRUCTURE_CONTAINER, 39, 39);
            room.memory.logistics = { tasks: [{ remaining: 100, state: 'open', resourceType: RESOURCE_ENERGY, retryAfter: 0 }] };
            const carry = EconomyManager.getHaulingCarryParts(room);
            assert.equal(LogisticsManager.getDesiredWorkerCount(room, 'Storekeeper'), Math.min(config.ECONOMY.WORKERS_MAX, Math.ceil(carry / 5)));
            room.memory.logistics.tasks = [];
            assert.equal(LogisticsManager.getDesiredWorkerCount(room, 'Storekeeper'), 0);
        });
    });

    describe('spawn queue', function () {
        function run(room, roles) {
            new BaseManager(room, roles)._repopulateCreeps();
        }

        it('spawns a static Miner with no console command once a source has a container', function () {
            const { room, spawn } = homeRoom({ energy: 800, capacity: 800 });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            addCreep(room, 'h2', 'Harvester');
            addSource(room, 's1', 10, 10);
            addStructure(room, STRUCTURE_CONTAINER, 11, 11);
            run(room, [new Harvester(), new Upgrader(), new Miner()]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Miner');
            assert.equal(spawn.spawning.memory.source, 's1');
        });

        it('lets a manual quota go above what the room derives', function () {
            const { room, spawn } = homeRoom({ energy: 800, capacity: 800, roleConfig: { Upgrader: { requiredNumber: 3 } } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            run(room, [new Harvester(), new Upgrader()]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Upgrader');
        });

        it('turns off derived demand for one role or the whole base', function () {
            const { room, spawn } = homeRoom({ energy: 800, capacity: 800, roleConfig: { Miner: { requiredNumber: 0, auto: false } } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            addSource(room, 's1', 10, 10);
            addStructure(room, STRUCTURE_CONTAINER, 11, 11);
            run(room, [new Harvester(), new Upgrader(), new Miner()]);
            assert.equal(spawn.spawning, null);

            room.memory.base.roleConfig.Miner.auto = undefined;
            room.memory.base.autoDemand = false;
            run(room, [new Harvester(), new Upgrader(), new Miner()]);
            assert.equal(spawn.spawning, null);
        });

        it('replaces an aging creep once, before it dies', function () {
            const { room, spawn } = homeRoom({ energy: 800, capacity: 800, roleConfig: { Upgrader: { requiredNumber: 1 } } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'old', 'Upgrader', { ticksToLive: 40 });
            run(room, [new Harvester(), new Upgrader()]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Upgrader');

            const replacement = spawn.spawning;
            replacement.spawning = false;
            spawn.spawning = null;
            Game.time++;
            run(room, [new Harvester(), new Upgrader()]);
            assert.equal(spawn.spawning, null, 'the replacement fills the quota');
        });

        it('does not replace a creep with plenty of life left', function () {
            const { room, spawn } = homeRoom({ energy: 800, capacity: 800, roleConfig: { Upgrader: { requiredNumber: 1 } } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'young', 'Upgrader', { ticksToLive: 1000 });
            run(room, [new Harvester(), new Upgrader()]);
            assert.equal(spawn.spawning, null);
        });

        it('saves up for a full-size body and reserves the energy from cheaper requests', function () {
            const { room, spawn } = homeRoom({ energy: 500, capacity: 1000, roleConfig: { Upgrader: { requiredNumber: 2 } } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            BaseManager.registerMissionSpawnProvider('test', () => [{
                id: 'scout', home: 'A', role: 'Scout', priority: 30, body: [MOVE], exactBody: [MOVE], memory: {},
            }]);
            try {
                run(room, [new Harvester(), new Upgrader(), new Scout()]);
            } finally {
                BaseManager.unregisterMissionSpawnProvider('test');
            }
            assert.equal(spawn.spawning, null);
            assert.equal(MainHeap.namespace('spawnWait').A, Game.time);
        });

        it('starts a fresh wait once nothing is saving up any more', function () {
            const { room } = homeRoom({ energy: 500, capacity: 1000 });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            MainHeap.namespace('spawnWait').A = Game.time - config.SPAWN.MAX_WAIT_TICKS;
            run(room, [new Harvester(), new Upgrader()]);
            assert.equal(MainHeap.namespace('spawnWait').A, undefined);
        });

        it('keeps the wait with the base that asked, even on another room\'s spawn', function () {
            const { room } = homeRoom({ energy: 500, capacity: 1000, roleConfig: { Upgrader: { requiredNumber: 2 } } });
            room.memory.base.outsourceSpawn = true;
            const other = makeRoom('B', { energyAvailable: 500, energyCapacityAvailable: 1000, memory: { base: { name: 'B', roleConfig: {} } } });
            Game.rooms.B = other;
            delete Game.spawns.Spawn1;
            Game.spawns.Other = makeSpawn(other, { name: 'Other', memory: { home: 'B' } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            run(room, [new Harvester(), new Upgrader()]);
            assert.equal(MainHeap.namespace('spawnWait').A, Game.time);
            assert.equal(MainHeap.namespace('spawnWait').B, undefined);
            assert.equal(Game.spawns.Other.spawning, null);
        });

        it('lets the operator switch a role off with a count of zero', function () {
            require('../main');
            const { room, spawn } = homeRoom({ energy: 800, capacity: 800, roleConfig: { Upgrader: { requiredNumber: 1 }, Builder: { requiredNumber: 1 } } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ progress: 0, progressTotal: 3000, pos: makePosition(room, 20, 20) }]);
            global.setCreepCount('A', 'Builder', 0);
            run(room, [new Harvester(), new Upgrader(), new Builder()]);
            assert.equal(spawn.spawning, null);

            const mayor = new (require('../manager.mayor'))(room);
            mayor.errors = [];
            mayor.warnings = [];
            mayor._cache = { constructionSites: room._find[FIND_MY_CONSTRUCTION_SITES], myCreeps: [] };
            mayor._validateCreeps();
            assert.ok(!mayor.warnings.some(warning => warning.text === 'Builder is missing.'));

            global.setCreepCount('A', 'Builder', 1);
            assert.equal(room.memory.base.roleConfig.Builder.auto, undefined);
        });

        it('leaves a room with a manual Mayor to its operator, except for defense', function () {
            const Defender = require('../role.defender');
            const { room, spawn } = homeRoom({ energy: 800, capacity: 800 });
            room.memory.mayor = { mode: 'off' };
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            addSource(room, 's1', 10, 10);
            addStructure(room, STRUCTURE_CONTAINER, 11, 11);
            run(room, [new Harvester(), new Upgrader(), new Miner()]);
            assert.equal(spawn.spawning, null);

            room.memory.defense = { threatLevel: 2, desiredDefenders: 1, preferredStyle: 'melee' };
            run(room, [new Harvester(), new Upgrader(), new Miner(), new Defender()]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Defender');
        });

        it('stops waiting after the limit and spawns what the energy buys', function () {
            const { room, spawn } = homeRoom({ energy: 500, capacity: 1000, roleConfig: { Upgrader: { requiredNumber: 2 } } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            MainHeap.namespace('spawnWait').A = Game.time - config.SPAWN.MAX_WAIT_TICKS;
            run(room, [new Harvester(), new Upgrader()]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Upgrader');
            assert.ok(spawn.spawning.body.length < 20);
            assert.equal(MainHeap.namespace('spawnWait').A, undefined);
        });

        it('never makes the first hauler wait while energy piles up in containers', function () {
            const StoreKeeper = require('../role.storekeeper');
            const { room, spawn } = homeRoom({ energy: 300, capacity: 1000 });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            room.memory.logistics = { tasks: [{ remaining: 100, state: 'open', resourceType: RESOURCE_ENERGY, retryAfter: 0 }] };
            run(room, [new Harvester(), new Upgrader(), new StoreKeeper()]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Storekeeper');
        });

        it('makes later haulers save up for a full-size body', function () {
            const StoreKeeper = require('../role.storekeeper');
            const { room, spawn } = homeRoom({ energy: 300, capacity: 1000 });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            addCreep(room, 's', 'Storekeeper');
            room.memory.logistics = { tasks: [
                { remaining: 100, state: 'open', resourceType: RESOURCE_ENERGY, retryAfter: 0 },
                { remaining: 100, state: 'open', resourceType: RESOURCE_ENERGY, retryAfter: 0 },
            ] };
            run(room, [new Harvester(), new Upgrader(), new StoreKeeper()]);
            assert.equal(spawn.spawning, null);
        });

        it('never makes recovery wait for a full-size body', function () {
            const { room, spawn } = homeRoom({ energy: 200, capacity: 1000 });
            run(room, [new Harvester(), new Upgrader()]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });

        it('serves every local role before any mission request', function () {
            const { room, spawn } = homeRoom({ energy: 800, capacity: 800, roleConfig: { Builder: { requiredNumber: 1 } } });
            addCreep(room, 'h', 'Harvester');
            addCreep(room, 'h2', 'Harvester');
            addCreep(room, 'u', 'Upgrader');
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ progress: 0, progressTotal: 100 }]);
            BaseManager.registerMissionSpawnProvider('test', () => [{
                id: 'defense', home: 'A', role: 'Scout', priority: 95, body: [MOVE], exactBody: [MOVE], memory: {},
            }]);
            try {
                run(room, [new Harvester(), new Upgrader(), new Builder(), new Scout()]);
            } finally {
                BaseManager.unregisterMissionSpawnProvider('test');
            }
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Builder');
        });
    });

    describe('a new room with no console commands', function () {
        const main = require('../main');

        afterEach(function () {
            delete global.CONTROLLER_STRUCTURES;
        });

        function completeSites(room) {
            const sites = room.createdSites.splice(0);
            room._find[FIND_CONSTRUCTION_SITES] = [];
            room._find[FIND_MY_CONSTRUCTION_SITES] = [];
            sites.forEach(site => {
                const structure = makeStructure(room, site.structureType, { id: site.id + '-' + Game.time, pos: site.pos, extra: { my: true, owner: { username: 'Me' } } });
                if (site.structureType === STRUCTURE_STORAGE) room.storage = structure;
                if (site.structureType === STRUCTURE_TOWER) structure.store = makeStore(1000);
                registerObject(structure, room.name);
                room._find[FIND_STRUCTURES].push(structure);
                room._find[FIND_MY_STRUCTURES].push(structure);
            });
        }

        function count(room, type) {
            return room._find[FIND_STRUCTURES].filter(structure => structure.structureType === type).length;
        }

        it('builds up to RCL 4 and staffs itself', function () {
            global.CONTROLLER_STRUCTURES = LIMITS;
            const errors = [];
            MainInfo.error = message => errors.push(message);
            const room = makeRoom('A', { energyAvailable: 300, energyCapacityAvailable: 300 });
            room.controller = { my: true, level: 1, owner: { username: 'Me' }, pos: makePosition(room, 40, 25), id: 'controller' };
            registerObject(room.controller, 'A');
            const spawn = makeSpawn(room, { name: 'Spawn1', memory: {}, pos: makePosition(room, 25, 25) });
            spawn.id = 'spawn';
            spawn.structureType = STRUCTURE_SPAWN;
            spawn.my = true;
            spawn.store = makeStore(300, { [RESOURCE_ENERGY]: 300 });
            spawn.hits = 5000;
            spawn.hitsMax = 5000;
            registerObject(spawn, 'A');
            Game.rooms.A = room;
            Game.spawns.Spawn1 = spawn;
            setFind(room, FIND_MY_SPAWNS, [spawn]);
            setFind(room, FIND_STRUCTURES, [spawn]);
            setFind(room, FIND_MY_STRUCTURES, [spawn]);
            addSource(room, 's1', 10, 10);
            addSource(room, 's2', 40, 40);

            const seenRoles = new Set();
            for (let tick = 0; tick < 2000 && room.controller.level < 5; tick++) {
                const creeps = Object.values(Game.creeps);
                Memory.creeps = Memory.creeps || {};
                creeps.forEach(creep => { Memory.creeps[creep.name] = creep.memory; creep.spawning = false; });
                setFind(room, FIND_MY_CREEPS, creeps);
                spawn.spawning = null;
                room.energyCapacityAvailable = 300 + count(room, STRUCTURE_EXTENSION) * 50;
                room.energyAvailable = room.energyCapacityAvailable;
                main.loop();
                Object.values(Game.creeps).forEach(creep => seenRoles.add(creep.memory.role));
                if (seenRoles.has('Builder')) completeSites(room);
                const level = room.controller.level;
                const wantedContainers = level >= config.PLANNER.SOURCE_CONTAINER_RCL ? 2 : 0;
                const buildout = count(room, STRUCTURE_CONTAINER) >= wantedContainers &&
                    ['extension', 'tower', 'storage'].every(type => count(room, type) >= LIMITS[type][level]);
                if (buildout && seenRoles.has('Upgrader')) room.controller.level = Math.min(level + 1, 5);
                Game.time++;
            }

            assert.deepEqual(errors, []);
            assert.equal(room.controller.level, 5, 'levelled through RCL 4');
            assert.equal(count(room, STRUCTURE_EXTENSION), 20);
            assert.equal(count(room, STRUCTURE_TOWER), 1);
            assert.equal(count(room, STRUCTURE_STORAGE), 1);
            assert.equal(count(room, STRUCTURE_CONTAINER), 2, 'one container per source');
            ['Harvester', 'Upgrader', 'Builder', 'Miner'].forEach(role => assert.ok(seenRoles.has(role), role));
            const miners = Object.values(Game.creeps).filter(creep => creep.memory.role === 'Miner');
            assert.equal(miners.length, 2, 'one Miner per source');
            assert.deepEqual(miners.map(creep => creep.memory.source).sort(), ['s1', 's2']);
        });
    });
});
