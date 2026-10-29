const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const BaseManager = require('../manager.base');
const CpuManager = require('../manager.cpu');
const DefenseManager = require('../manager.defense');
const LogisticsManager = require('../manager.logistics');
const MayorManager = require('../manager.mayor');
const RemoteManager = require('../manager.remote');
const RoomManager = require('../manager.room');
const TileArray = require('../tile.array');
const Builder = require('../role.builder');
const Defender = require('../role.defender');
const Explorer = require('../role.explorer');
const Harvester = require('../role.harvester');
const Scout = require('../role.scout');
const Upgrader = require('../role.upgrader');

const EXTENSION_LIMITS = { 0: 0, 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 };

function homeRoom(options = {}) {
    const room = makeRoom('A', Object.assign({
        memory: {
            base: {
                name: 'A', showIcons: false,
                roleConfig: {
                    Harvester: { requiredNumber: 1 }, Upgrader: { requiredNumber: 1 }, Builder: { requiredNumber: 1 },
                    Defender: { requiredNumber: 0 }, showIcons: false,
                },
            },
        },
        energyAvailable: 300,
        energyCapacityAvailable: 300,
    }, options));
    room.controller = { my: true, level: 2, pos: makePosition(room, 30, 30) };
    const spawn = makeSpawn(room, { name: 'Spawn1' });
    Game.rooms.A = room;
    Game.spawns.Spawn1 = spawn;
    setFind(room, FIND_MY_SPAWNS, [spawn]);
    return { room, spawn };
}

function addEstablishedCreeps(room) {
    const harvester = makeCreep(room, { name: 'harvester', memory: { role: 'Harvester', home: 'A' } });
    const upgrader = makeCreep(room, { name: 'upgrader', memory: { role: 'Upgrader', home: 'A' } });
    Game.creeps.harvester = harvester;
    Game.creeps.upgrader = upgrader;
}

function boostedHostile(room, healParts, position, boost) {
    const body = [];
    for (let index = 0; index < healParts; index++) body.push({ type: HEAL, hits: 100, boost });
    return {
        id: 'hostile-' + Math.random().toString(36).slice(2),
        room, body, pos: position, owner: { username: 'Enemy' },
        getActiveBodyparts(type) {
            return this.body.filter(part => part.type === type && part.hits > 0).length;
        },
    };
}

function installStructureLimits(room) {
    global.CONTROLLER_STRUCTURES = {
        [STRUCTURE_SPAWN]: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
        [STRUCTURE_EXTENSION]: EXTENSION_LIMITS,
        [STRUCTURE_TOWER]: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
        [STRUCTURE_STORAGE]: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
        [STRUCTURE_LINK]: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 3, 7: 4, 8: 6 },
    };
    room.memory.mayor = {};
    room.memory.roomManager = {};
}

describe('Hardening regressions', function () {
    beforeEach(function () {
        resetScreeps();
    });

    afterEach(function () {
        delete global.CONTROLLER_STRUCTURES;
    });

    describe('tower healing estimate', function () {
        it('fires on a target whose real healing is below tower damage', function () {
            const { room } = homeRoom();
            const tower = makeStructure(room, STRUCTURE_TOWER, {
                id: 'tower', pos: makePosition(room, 25, 25), store: makeStore(1000, { [RESOURCE_ENERGY]: 1000 }),
            });
            const invader = boostedHostile(room, 6, makePosition(room, 26, 26));
            setFind(room, FIND_HOSTILE_CREEPS, [invader]);
            const plan = DefenseManager.getTowerPlan(room, [tower]);
            assert.equal(plan.target, invader);
        });

        it('uses the real boost factor when healing does outpace tower damage', function () {
            const { room } = homeRoom();
            const tower = makeStructure(room, STRUCTURE_TOWER, {
                id: 'tower', pos: makePosition(room, 25, 25), store: makeStore(1000, { [RESOURCE_ENERGY]: 1000 }),
            });
            const invader = boostedHostile(room, 13, makePosition(room, 26, 26), 'XLHO2');
            setFind(room, FIND_HOSTILE_CREEPS, [invader]);
            assert.equal(DefenseManager._estimateHealing(invader, [invader]), 13 * 12 * 4);
            assert.equal(DefenseManager.getTowerPlan(room, [tower]).target, null);
        });

        it('counts healers at range 2 or 3 at ranged heal power', function () {
            const { room } = homeRoom();
            const target = boostedHostile(room, 0, makePosition(room, 26, 26));
            const nearby = boostedHostile(room, 10, makePosition(room, 28, 26));
            const distant = boostedHostile(room, 10, makePosition(room, 30, 26));
            assert.equal(DefenseManager._estimateHealing(target, [target, nearby, distant]), 10 * 4);
        });
    });

    describe('recovery reserve', function () {
        it('lets a Builder spawn at full capacity in a room that cannot hold 450 energy', function () {
            const { room, spawn } = homeRoom();
            addEstablishedCreeps(room);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ structureType: STRUCTURE_EXTENSION, progress: 0, progressTotal: 3000 }]);
            new BaseManager(room, [new Builder(), new Harvester(), new Upgrader()])._repopulateCreeps();
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Builder');
        });

        it('still waits below capacity while only one Harvester is active', function () {
            const { room, spawn } = homeRoom({ energyAvailable: 299 });
            addEstablishedCreeps(room);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ structureType: STRUCTURE_EXTENSION, progress: 0, progressTotal: 3000 }]);
            new BaseManager(room, [new Builder(), new Harvester(), new Upgrader()])._repopulateCreeps();
            assert.equal(spawn.spawning, null);
        });
    });

    describe('extension layout', function () {
        it('plans every RCL 8 extension when the layout is first generated at RCL 2', function () {
            const { room } = homeRoom();
            installStructureLimits(room);
            const positions = new RoomManager(room).fetchBuildingSitePositionsForTile(RoomManager.TILE_EXTENSION);
            assert.equal(positions.length, 60);
        });

        it('tops up a layout saved at a lower RCL without moving existing tiles', function () {
            const { room } = homeRoom();
            installStructureLimits(room);
            const legacy = new TileArray(50, 50);
            for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) legacy.set(x, y, ' ');
            const saved = [[24, 24], [26, 24], [24, 26], [26, 26], [23, 25]];
            saved.forEach(([x, y]) => legacy.set(x, y, RoomManager.TILE_EXTENSION));
            room.memory.roomManager.layout = legacy.toCompactString();
            const positions = new RoomManager(room).fetchBuildingSitePositionsForTile(RoomManager.TILE_EXTENSION);
            assert.equal(positions.length, 60);
            saved.forEach(([x, y]) => assert.ok(positions.some(pos => pos.x === x && pos.y === y)));
            assert.equal((room.memory.roomManager.layout.match(/o/g) || []).length, 60);
        });

        it('does not let an unplaceable extension block later structures', function () {
            const { room, spawn } = homeRoom();
            installStructureLimits(room);
            CONTROLLER_STRUCTURES[STRUCTURE_TOWER] = { 5: 0 };
            room.controller.level = 5;
            room.controller.pos = makePosition(room, 40, 40);
            // Only odd-parity tiles are open, so the even-parity extension pattern has no tile at all.
            room.getTerrain = () => ({ get: (x, y) => ((x + y) % 2 === 1 ? 0 : TERRAIN_MASK_WALL) });
            const source = { id: 'source', pos: makePosition(room, 10, 10) };
            setFind(room, FIND_SOURCES, [source]);
            setFind(room, FIND_STRUCTURES, [spawn, makeStructure(room, STRUCTURE_STORAGE, { pos: makePosition(room, 24, 24) })]);
            spawn.structureType = STRUCTURE_SPAWN;
            const mayor = new MayorManager(room);
            mayor._cache = { constructionSites: [] };
            mayor.warnings = [];
            mayor._validateBuildings();
            const planned = mayor.warnings.map(warning => warning.text);
            assert.ok(planned.includes('Buildable structure ' + STRUCTURE_LINK), planned.join(', '));
            assert.ok(!planned.includes('Buildable structure ' + STRUCTURE_EXTENSION), planned.join(', '));
        });
    });

    describe('spawn order under threat', function () {
        afterEach(function () {
            BaseManager.unregisterMissionSpawnProvider('test');
        });

        it('spawns a needed local Defender ahead of remote mission requests', function () {
            const { room, spawn } = homeRoom({ energyAvailable: 1000, energyCapacityAvailable: 1000 });
            addEstablishedCreeps(room);
            room.memory.defense = { threatLevel: 2, desiredDefenders: 1, preferredStyle: 'melee' };
            room.memory.base.roleConfig.Scout = { requiredNumber: 0 };
            BaseManager.registerMissionSpawnProvider('test', () => [{
                id: 'scout', home: 'A', role: 'Scout', priority: 30, body: [MOVE], exactBody: [MOVE], memory: { role: 'Scout', home: 'A' },
            }]);
            new BaseManager(room, [new Defender(), new Harvester(), new Upgrader(), new Scout()])._repopulateCreeps();
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Defender');
        });

        it('resumes remote requests once local defenders are in place', function () {
            const { room, spawn } = homeRoom({ energyAvailable: 1000, energyCapacityAvailable: 1000 });
            addEstablishedCreeps(room);
            Game.creeps.guard = makeCreep(room, { name: 'guard', memory: { role: 'Defender', home: 'A' } });
            room.memory.defense = { threatLevel: 2, desiredDefenders: 1, preferredStyle: 'melee' };
            room.memory.base.roleConfig.Scout = { requiredNumber: 0 };
            BaseManager.registerMissionSpawnProvider('test', () => [{
                id: 'scout', home: 'A', role: 'Scout', priority: 30, body: [MOVE], exactBody: [MOVE], memory: { role: 'Scout', home: 'A' },
            }]);
            new BaseManager(room, [new Defender(), new Harvester(), new Upgrader(), new Scout()])._repopulateCreeps();
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Scout');
        });
    });

    describe('remote bodies and demand', function () {
        function mission(home, options = {}) {
            return RemoteManager.configure('A', 'B', Object.assign({ homeRoom: home.name, reserve: true }, options));
        }

        it('sends two CLAIM parts when the home room can afford them', function () {
            const { room } = homeRoom({ energyAvailable: 1800, energyCapacityAvailable: 1800 });
            assert.deepEqual(RemoteManager.getReserverBody(room), [CLAIM, CLAIM, MOVE, MOVE]);
        });

        it('falls back to one CLAIM part below that capacity', function () {
            const { room } = homeRoom({ energyAvailable: 800, energyCapacityAvailable: 800 });
            assert.deepEqual(RemoteManager.getReserverBody(room), [CLAIM, MOVE]);
        });

        it('requests a replacement Reserver before the current one expires', function () {
            const { room } = homeRoom({ energyAvailable: 1800, energyCapacityAvailable: 1800 });
            const remote = mission(room);
            remote.sources = [{ id: 's1', x: 20, y: 20 }];
            Game.creeps.reserver = makeCreep(room, {
                name: 'reserver', ticksToLive: 10,
                memory: { role: 'Reserver', home: 'A', missionId: remote.id },
            });
            const requests = [];
            RemoteManager._addReserverRequest(remote, requests, room);
            assert.equal(requests.length, 1);
            assert.equal(requests[0].role, 'Reserver');
        });

        it('does not cut derived hauler demand for two reserved sources', function () {
            const { room } = homeRoom({ energyAvailable: 1800, energyCapacityAvailable: 1800 });
            const remote = mission(room, { distance: 1 });
            remote.distance = 1;
            remote.travelTicks = 50;
            remote.sources = [{ id: 's1', output: 10 }, { id: 's2', output: 10 }];
            const demand = RemoteManager.calculateRouteDemand(remote, { baseRoom: room });
            assert.equal(demand.haulers, 6);
        });

        it('raises a stored legacy hauler cap once and then respects explicit values', function () {
            const { room } = homeRoom();
            const remote = mission(room);
            remote.maxHaulers = 3;
            delete remote.haulerCapVersion;
            RemoteManager._normalizeMission(remote);
            assert.equal(remote.maxHaulers, RemoteManager.DEFAULT_MAX_HAULERS);
            remote.maxHaulers = 3;
            RemoteManager._normalizeMission(remote);
            assert.equal(remote.maxHaulers, 3);
        });

        it('sizes a remote miner to what the home room can actually afford', function () {
            const { room } = homeRoom({ energyAvailable: 550, energyCapacityAvailable: 550 });
            const remote = mission(room);
            remote.controller = { reservation: { username: 'Me', ticksToEnd: 2000 } };
            const body = RemoteManager.getMinerBody(remote, { id: 's1', output: 10 }, room);
            const cost = body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
            assert.ok(cost <= 550, 'cost ' + cost);
            assert.ok(body.includes(WORK) && body.includes(CARRY) && body.includes(MOVE));
        });
    });

    describe('expansion flags', function () {
        it('does not send an Explorer to a remote mission flag', function () {
            const { spawn } = homeRoom({ energyAvailable: 2000, energyCapacityAvailable: 2000 });
            Game.flags['Remote:A:B'] = { name: 'Remote:A:B', pos: makePosition({ name: 'B' }, 25, 25), memory: {} };
            assert.equal(new Explorer().spawnCreep(spawn), false);
            assert.equal(spawn.spawning, null);
        });

        it('still sends an Explorer to an expansion flag', function () {
            const { spawn } = homeRoom({ energyAvailable: 2000, energyCapacityAvailable: 2000 });
            Game.flags['Remote:A:B'] = { name: 'Remote:A:B', pos: makePosition({ name: 'B' }, 25, 25), memory: {} };
            Game.flags.Expand = { name: 'Expand', pos: makePosition({ name: 'C' }, 25, 25), memory: {} };
            new Explorer().spawnCreep(spawn);
            assert.equal(spawn.spawning.memory.targetFlag || spawn.spawning.memory.target, 'Expand');
        });
    });

    describe('CPU state after a global reset', function () {
        it('stays degraded inside the hysteresis band when no previous state exists', function () {
            CpuManager._degraded = undefined;
            Game.cpu = { bucket: 1200 };
            CpuManager.initRound();
            assert.equal(CpuManager.shouldRunDeferred(), false);
            CpuManager._degraded = undefined;
        });
    });

    describe('tick safety', function () {
        const main = require('../main');
        const managers = {
            MemoryManager: [require('../manager.memory'), 'initRound'],
            IntelManager: [require('../manager.intel'), 'runAll'],
            RemoteManager: [RemoteManager, 'runAll'],
            DefenseManager: [DefenseManager, 'runAll'],
            TowerManager: [require('../manager.tower'), 'runAll'],
            LinkManager: [require('../manager.link'), 'runAll'],
            FactoryManager: [require('../manager.factory'), 'runAll'],
            LabManager: [require('../manager.lab'), 'runAll'],
            TerminalManager: [require('../manager.terminal'), 'runAll'],
            MarketManager: [require('../manager.market'), 'runAll'],
            LogisticsManager: [LogisticsManager, 'runAll'],
            BaseManager: [BaseManager, 'runAll'],
            RoadManager: [require('../manager.road'), 'watchAllRooms'],
            MayorManager: [MayorManager, 'runAll'],
        };
        let originals;
        let calls;

        function stubManagers(failing) {
            originals = {};
            calls = [];
            Object.keys(managers).forEach(name => {
                const [manager, method] = managers[name];
                originals[name] = manager[method];
                manager[method] = () => {
                    calls.push(name);
                    if (name === failing) throw new Error('injected');
                };
            });
        }

        afterEach(function () {
            if (!originals) return;
            Object.keys(originals).forEach(name => {
                const [manager, method] = managers[name];
                manager[method] = originals[name];
            });
            originals = null;
        });

        Object.keys(managers).forEach(name => {
            it('keeps towers and creeps running when ' + name + ' throws', function () {
                stubManagers(name);
                main.loop();
                assert.ok(calls.includes('TowerManager'));
                assert.ok(calls.includes('BaseManager'));
            });
        });

        it('runs towers and links ahead of spawning', function () {
            stubManagers();
            main.loop();
            assert.ok(calls.indexOf('TowerManager') < calls.indexOf('BaseManager'));
            assert.ok(calls.indexOf('LinkManager') < calls.indexOf('BaseManager'));
        });

        it('reduces work by CPU tier without ever dropping defense or creeps', function () {
            stubManagers();
            Game.cpu.bucket = 100;
            main.loop();
            ['MemoryManager', 'DefenseManager', 'TowerManager', 'LogisticsManager', 'BaseManager'].forEach(name => {
                assert.ok(calls.includes(name), name);
            });
            ['FactoryManager', 'LabManager', 'MayorManager', 'RoadManager'].forEach(name => {
                assert.ok(!calls.includes(name), name);
            });
        });

        it('keeps factories and labs running in degraded mode', function () {
            stubManagers();
            Game.cpu.bucket = 800;
            main.loop();
            ['FactoryManager', 'LabManager', 'TerminalManager'].forEach(name => assert.ok(calls.includes(name), name));
            ['MayorManager', 'RoadManager'].forEach(name => assert.ok(!calls.includes(name), name));
        });

        it('runs the Mayor on its first tick and then at its own cadence', function () {
            stubManagers();
            const runs = [];
            for (let tick = 0; tick < 21; tick++) {
                calls.length = 0;
                main.loop();
                if (calls.includes('MayorManager')) runs.push(Game.time);
                Game.time++;
            }
            assert.deepEqual(runs, [1, 11, 21]);
        });

        it('only draws room overlays while the visuals setting is on', function () {
            stubManagers();
            const MainInfo = require('../main.info');
            const original = MainInfo.visualize;
            let drawn = 0;
            MainInfo.visualize = () => { drawn++; };
            try {
                main.loop();
                assert.equal(drawn, 1);
                global.setSetting('visuals', false);
                Game.time++;
                main.loop();
                assert.equal(drawn, 1);
            } finally {
                MainInfo.visualize = original;
            }
        });

        it('rejects unknown settings', function () {
            assert.equal(global.setSetting('nope', true), false);
            assert.equal(Memory.settings, undefined);
        });

        it('keeps a bounded per-job CPU history that survives a reset', function () {
            stubManagers();
            let used = 0;
            Game.cpu.getUsed = () => { used += 1; return used; };
            for (let tick = 0; tick < 700; tick++) {
                main.loop();
                Game.time++;
            }
            const config = require('../main.config');
            assert.equal(Memory.stats.samples.length, config.CPU.STATS_SAMPLES);
            const sample = Memory.stats.samples[Memory.stats.samples.length - 1];
            assert.ok(sample.cpu > 0);
            assert.equal(sample.bucket, Game.cpu.bucket);
            assert.ok(Object.keys(sample.jobs).length <= config.CPU.STATS_TOP_JOBS);
            assert.match(global.cpuReport(), /CPU over 60 samples/);
        });

        it('still runs creeps when spawning throws inside a base', function () {
            const { room } = homeRoom();
            const manager = new BaseManager(room, []);
            let moved = 0;
            manager._repopulateCreeps = () => { throw new Error('injected'); };
            manager._moveCreeps = () => { moved++; };
            manager.runBase();
            assert.equal(moved, 1);
        });
    });

    describe('heap and Memory', function () {
        const MainHeap = require('../main.heap');
        const EconomyManager = require('../manager.economy');
        const MemoryManager = require('../manager.memory');

        it('measures a route once and again only after a global reset', function () {
            const { room, spawn } = homeRoom();
            let searches = 0;
            spawn.id = 'spawn';
            spawn.pos.findPathTo = () => { searches++; return new Array(42); };
            const source = { id: 's1', pos: makePosition(room, 10, 10) };
            assert.equal(EconomyManager.getRouteLength(room, spawn, source), 42);
            Game.time += 100;
            assert.equal(EconomyManager.getRouteLength(room, spawn, source), 42);
            assert.equal(searches, 1);
            MainHeap.reset();
            assert.equal(EconomyManager.getRouteLength(room, spawn, source), 42);
            assert.equal(searches, 2);
        });

        it('falls back to an estimate when no path can be found', function () {
            const { room, spawn } = homeRoom();
            spawn.id = 'spawn';
            spawn.pos.findPathTo = () => [];
            const source = { id: 's1', pos: makePosition(room, 25, 15) };
            assert.equal(EconomyManager.getRouteLength(room, spawn, source), 13);
        });

        it('keeps the heap bounded and expires entries by age', function () {
            const config = require('../main.config');
            for (let index = 0; index < config.HEAP.MAX_ENTRIES + 50; index++) MainHeap.cached('k' + index, undefined, () => index);
            assert.equal(MainHeap._cache.size, config.HEAP.MAX_ENTRIES);
            let computed = 0;
            MainHeap.cached('ttl', 10, () => { computed++; return 1; });
            MainHeap.cached('ttl', 10, () => { computed++; return 1; });
            Game.time += 10;
            MainHeap.cached('ttl', 10, () => { computed++; return 1; });
            assert.equal(computed, 2);
        });

        it('stores only plain data on the heap after a full tick', function () {
            const main = require('../main');
            const { room } = homeRoom();
            addEstablishedCreeps(room);
            setFind(room, FIND_MY_CREEPS, Object.values(Game.creeps));
            main.loop();
            const heapValues = { namespaces: MainHeap._namespaces, cache: Array.from(MainHeap._cache.values()) };
            assert.deepEqual(JSON.parse(JSON.stringify(heapValues)), heapValues);
        });

        it('no longer writes display and transient fields to Memory', function () {
            const main = require('../main');
            const { room } = homeRoom();
            room.memory.roleInfo = { Harvester: { currentNumber: 1 } };
            addEstablishedCreeps(room);
            setFind(room, FIND_MY_CREEPS, Object.values(Game.creeps));
            main.loop();
            assert.equal(room.memory.roleInfo, undefined);
            Object.values(Game.creeps).forEach(creep => {
                assert.equal(creep.memory.moving, undefined);
                assert.equal(creep.memory.destination, undefined);
            });
        });

        it('leaves the room role list available to the overlay', function () {
            const main = require('../main');
            const { room } = homeRoom();
            addEstablishedCreeps(room);
            setFind(room, FIND_MY_CREEPS, Object.values(Game.creeps));
            const drawn = [];
            room.visual = { text: label => drawn.push(label) };
            main.loop();
            assert.ok(drawn.some(label => String(label).includes('Harvester 1')), drawn.join('|'));
        });

        it('prunes memory for rooms that are out of sight and out of use', function () {
            const { room } = homeRoom();
            Memory.rooms = { A: room.memory, gone: { cpu: {} }, ownedElsewhere: { base: { name: 'X' } }, outpost: { defense: {} } };
            Memory.empire = { missions: { m: { id: 'm', type: 'remote', targetRoom: 'outpost', homeRoom: 'A', home: 'A' } } };
            Memory.structures = { old: { _roomName: 'gone' }, kept: { _roomName: 'outpost' } };
            MemoryManager._pruneRoomMemory();
            assert.deepEqual(Object.keys(Memory.rooms).sort(), ['A', 'outpost', 'ownedElsewhere']);
            assert.deepEqual(Object.keys(Memory.structures), ['kept']);
        });
    });

    describe('movement', function () {
        const MainMove = require('../main.move');
        const MainHeap = require('../main.heap');

        function walker(room, x = 10, y = 10) {
            const creep = makeCreep(room, { name: 'walker', pos: makePosition(room, x, y) });
            Game.creeps.walker = creep;
            return creep;
        }

        it('ignores traffic on the way and treats creeps as obstacles near the target', function () {
            const { room } = homeRoom();
            const creep = walker(room);
            MainMove.to(creep, makePosition(room, 40, 40), { reusePath: 5 });
            assert.equal(creep.moveOptions.ignoreCreeps, true);
            assert.equal(creep.moveOptions.reusePath, 5);
            Game.time++;
            creep.pos = makePosition(room, 38, 38);
            MainMove.to(creep, makePosition(room, 40, 40), { reusePath: 5 });
            assert.equal(creep.moveOptions.ignoreCreeps, false);
        });

        it('repaths around traffic once a creep has not moved for a while', function () {
            const { room } = homeRoom();
            const creep = walker(room);
            const target = makePosition(room, 40, 40);
            MainMove.to(creep, target, { reusePath: 5 });
            Game.time++;
            MainMove.to(creep, target, { reusePath: 5 });
            assert.equal(creep.moveOptions.reusePath, 5);
            Game.time++;
            MainMove.to(creep, target, { reusePath: 5 });
            assert.equal(creep.moveOptions.reusePath, 0);
            assert.equal(creep.moveOptions.ignoreCreeps, false);
            Game.time++;
            creep.pos = makePosition(room, 11, 11);
            MainMove.to(creep, target, { reusePath: 5 });
            assert.equal(creep.moveOptions.reusePath, 5);
        });

        it('does not search every tick for a creep waiting in a queue', function () {
            const { room } = homeRoom();
            const creep = walker(room);
            const target = makePosition(room, 40, 40);
            let searches = 0;
            for (let tick = 0; tick < 30; tick++) {
                MainMove.to(creep, target, { reusePath: 5 });
                if (creep.moveOptions.reusePath === 0) searches++;
                Game.time++;
            }
            assert.equal(searches, 3);
        });

        it('does not treat waiting out fatigue as being stuck', function () {
            const { room } = homeRoom();
            const creep = walker(room);
            const target = makePosition(room, 40, 40);
            creep.fatigue = 4;
            for (let tick = 0; tick < 5; tick++) {
                MainMove.to(creep, target, { reusePath: 5 });
                Game.time++;
            }
            assert.equal(creep.moveOptions.reusePath, 5);
        });

        it('keeps paths longer for trips to another room', function () {
            const { room } = homeRoom();
            const creep = walker(room);
            MainMove.to(creep, new RoomPosition(25, 25, 'B'), { reusePath: 5 });
            assert.equal(creep.moveOptions.reusePath, require('../main.config').MOVEMENT.LONG_REUSE_PATH);
        });

        it('only draws paths when the setting is on', function () {
            const { room } = homeRoom();
            const creep = walker(room);
            MainMove.to(creep, makePosition(room, 40, 40), { color: '#fff' });
            assert.equal(creep.moveOptions.visualizePathStyle, undefined);
            Memory.settings = { pathVisuals: true };
            MainMove.to(creep, makePosition(room, 40, 40), { color: '#fff' });
            assert.deepEqual(creep.moveOptions.visualizePathStyle, { stroke: '#fff' });
        });

        it('forgets stuck state for creeps that are gone', function () {
            const { room } = homeRoom();
            const creep = walker(room);
            MainMove.to(creep, makePosition(room, 40, 40));
            delete Game.creeps.walker;
            MainMove.prune();
            assert.deepEqual(MainHeap.namespace('stuck'), {});
        });
    });

    describe('work assignment', function () {
        const Miner = require('../role.miner');

        function claimedRoom() {
            const { room, spawn } = homeRoom();
            const claimed = makeStructure(room, STRUCTURE_EXTENSION, { id: 'claimed', pos: makePosition(room, 26, 26), store: makeStore(50), extra: { my: true } });
            const free = makeStructure(room, STRUCTURE_EXTENSION, { id: 'free', pos: makePosition(room, 24, 24), store: makeStore(50), extra: { my: true } });
            setFind(room, FIND_MY_STRUCTURES, [claimed, free]);
            room.memory.logistics = {
                tasks: [{ id: 't', kind: 'supply', targetId: 'claimed', sourceId: 'storage', assignedCreep: 'hauler', resourceType: RESOURCE_ENERGY, remaining: 50 }],
            };
            return { room, spawn };
        }

        it('keeps a Harvester away from a target a hauler has claimed', function () {
            const { room } = claimedRoom();
            const targets = new Harvester()._findTargets(room).map(target => target.id);
            assert.ok(targets.includes('free'));
            assert.ok(!targets.includes('claimed'));
        });

        it('leaves a pile to the hauler that claimed it', function () {
            const { room } = homeRoom();
            const pile = { id: 'pile', room, pos: makePosition(room, 26, 25), resourceType: RESOURCE_ENERGY, amount: 500 };
            setFind(room, FIND_DROPPED_RESOURCES, [pile]);
            room.memory.logistics = {
                tasks: [{ id: 't', kind: 'collect', sourceId: 'pile', targetId: 'storage', assignedCreep: 'hauler', resourceType: RESOURCE_ENERGY, remaining: 500 }],
            };
            const creep = makeCreep(room, { name: 'worker', memory: { role: 'Upgrader', home: 'A' } });
            const role = new Upgrader();
            let worked = 0;
            role._work = () => worked++;
            role.run(creep, room);
            assert.equal(pile.amount, 500);
            assert.equal(worked, 1);
        });

        it('still picks up an unclaimed pile', function () {
            const { room } = homeRoom();
            const pile = { id: 'pile', room, pos: makePosition(room, 26, 25), resourceType: RESOURCE_ENERGY, amount: 100 };
            setFind(room, FIND_DROPPED_RESOURCES, [pile]);
            const creep = makeCreep(room, { name: 'worker', memory: { role: 'Upgrader', home: 'A' } });
            const role = new Upgrader();
            role._work = () => {};
            role.run(creep, room);
            assert.equal(pile.amount, 0);
        });

        it('keeps a Miner on its post instead of walking to loot', function () {
            assert.equal(new Miner()._disableAutomaticLoot, true);
        });

        it('keeps a Builder on its site even when another looks better', function () {
            const { room } = homeRoom();
            const first = registerObject({ id: 'first', room, pos: makePosition(room, 26, 26), progress: 0, progressTotal: 1000 }, 'A');
            const better = registerObject({ id: 'better', room, pos: makePosition(room, 25, 26), progress: 990, progressTotal: 1000 }, 'A');
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [first]);
            const creep = makeCreep(room, { name: 'builder', memory: { role: 'Builder', home: 'A' } });
            const role = new Builder();
            role._baseRoom = room;
            assert.equal(role._findClosestTarget(creep), first);
            require('../main.cache').initRound([]);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [first, better]);
            assert.equal(role._findClosestTarget(creep), first);
            first.destroyed = true;
            require('../main.cache').initRound([]);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [better]);
            assert.equal(role._findClosestTarget(creep), better);
            assert.equal(creep.memory.buildTarget, 'better');
        });

        it('asks a role if it is necessary only once per base run', function () {
            const { room } = homeRoom();
            const role = new Upgrader();
            let asked = 0;
            role.isNecessary = () => { asked++; return true; };
            const manager = new BaseManager(room, [role]);
            manager._findNecessaryMandatoryRole('Upgrader');
            manager._findNecessaryMandatoryRole('Upgrader');
            assert.equal(asked, 1);
        });
    });

    describe('base planner', function () {
        const FULL_LIMITS = {
            [STRUCTURE_SPAWN]: { 1: 1, 7: 2, 8: 3 }, [STRUCTURE_EXTENSION]: EXTENSION_LIMITS,
            [STRUCTURE_TOWER]: { 3: 1, 5: 2, 7: 3, 8: 6 }, [STRUCTURE_STORAGE]: { 4: 1, 8: 1 },
            [STRUCTURE_TERMINAL]: { 6: 1, 8: 1 }, [STRUCTURE_LAB]: { 6: 3, 7: 6, 8: 10 },
            [STRUCTURE_FACTORY]: { 7: 1, 8: 1 }, [STRUCTURE_POWER_SPAWN]: { 8: 1 },
            [STRUCTURE_NUKER]: { 8: 1 }, [STRUCTURE_OBSERVER]: { 8: 1 },
        };

        function plannedRoom() {
            const { room, spawn } = homeRoom();
            room.memory.mayor = {};
            room.memory.roomManager = {};
            global.CONTROLLER_STRUCTURES = FULL_LIMITS;
            spawn.structureType = STRUCTURE_SPAWN;
            setFind(room, FIND_STRUCTURES, [spawn]);
            setFind(room, FIND_SOURCES, [{ id: 's1', pos: makePosition(room, 10, 10) }, { id: 's2', pos: makePosition(room, 40, 40) }]);
            setFind(room, FIND_MINERALS, [{ id: 'm', pos: makePosition(room, 10, 40) }]);
            return { room, spawn };
        }

        function tiles(room, character) {
            return new RoomManager(room).fetchBuildingSitePositionsForTile(character);
        }

        it('finds open ground with the distance transform', function () {
            const { room } = plannedRoom();
            const array = new TileArray(50, 50);
            for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) array.set(x, y, RoomManager.TILE_TERRAIN_PLAIN);
            array.set(25, 25, RoomManager.TILE_TERRAIN_WALL);
            const distances = new RoomManager(room)._distanceTransform(array);
            assert.equal(distances.at(25, 25), 0);
            assert.equal(distances.at(26, 25), 1);
            assert.equal(distances.at(28, 25), 3);
            assert.equal(distances.at(0, 0), 1);
            assert.equal(distances.at(4, 4), 5);
        });

        it('covers every structure the room will ever hold', function () {
            const { room } = plannedRoom();
            const expected = {
                [RoomManager.TILE_EXTENSION]: 60, [RoomManager.TILE_TOWER]: 6, [RoomManager.TILE_STORAGE]: 1,
                [RoomManager.TILE_TERMINAL]: 1, [RoomManager.TILE_FACTORY]: 1, [RoomManager.TILE_LAB]: 10,
                [RoomManager.TILE_POWER_SPAWN]: 1, [RoomManager.TILE_NUKER]: 1, [RoomManager.TILE_OBSERVER]: 1,
            };
            Object.keys(expected).forEach(character => {
                assert.equal(tiles(room, character).length, expected[character], character);
            });
            // the first spawn already stands, on its own tile
            assert.equal(tiles(room, RoomManager.TILE_SPAWN).length, 3);
        });

        it('never builds on tiles that have to stay open', function () {
            const { room, spawn } = plannedRoom();
            const planned = [RoomManager.TILE_EXTENSION, RoomManager.TILE_TOWER, RoomManager.TILE_LAB, RoomManager.TILE_STORAGE]
                .flatMap(character => tiles(room, character));
            planned.forEach(pos => {
                assert.ok(pos.getRangeTo(spawn.pos) > 1, 'spawn exit ' + pos.x + ',' + pos.y);
                assert.ok(pos.getRangeTo(room.controller.pos) > 3, 'upgrade area ' + pos.x + ',' + pos.y);
                room._find[FIND_SOURCES].forEach(source => assert.ok(pos.getRangeTo(source.pos) > 2, 'mining spot'));
                assert.ok(pos.x >= 2 && pos.x <= 47 && pos.y >= 2 && pos.y <= 47, 'edge');
            });
        });

        it('lays out labs so two inputs reach all the others and haulers reach the inputs', function () {
            const { room } = plannedRoom();
            const labs = tiles(room, RoomManager.TILE_LAB);
            const minX = Math.min(...labs.map(lab => lab.x));
            const minY = Math.min(...labs.map(lab => lab.y));
            const inputs = labs.filter(lab => lab.y === minY + 1);
            assert.equal(inputs.length, 2);
            labs.forEach(lab => inputs.forEach(input => assert.ok(lab.getRangeTo(input) <= 2)));
            [[minX, minY + 1], [minX + 3, minY + 1]].forEach(([x, y]) => {
                assert.ok(!labs.some(lab => lab.x === x && lab.y === y), 'hauler gap');
            });
        });

        it('puts the terminal and factory beside the planned storage', function () {
            const { room } = plannedRoom();
            const storage = tiles(room, RoomManager.TILE_STORAGE)[0];
            assert.ok(tiles(room, RoomManager.TILE_TERMINAL)[0].getRangeTo(storage) <= 2);
            assert.ok(tiles(room, RoomManager.TILE_FACTORY)[0].getRangeTo(storage) <= 2);
        });

        it('does not start a second lab cluster in a room that already has labs', function () {
            const { room, spawn } = plannedRoom();
            setFind(room, FIND_STRUCTURES, [spawn, makeStructure(room, STRUCTURE_LAB, { pos: makePosition(room, 30, 20) })]);
            const labs = tiles(room, RoomManager.TILE_LAB);
            assert.equal(labs.length, 1, 'only the lab that already stands');
            assert.ok(labs[0].x === 30 && labs[0].y === 20);
        });

        it('plans once, then only reads the stored plan', function () {
            const { room } = plannedRoom();
            tiles(room, RoomManager.TILE_TOWER);
            assert.equal(room.memory.roomManager.planVersion, RoomManager.PLAN_VERSION);
            const manager = new RoomManager(room);
            manager._planCoreStructures = () => { throw new Error('planned again'); };
            assert.equal(manager.fetchBuildingSitePositionsForTile(RoomManager.TILE_TOWER).length, 6);
        });

        it('counts structures standing outside the plan when topping up an old layout', function () {
            const { room, spawn } = plannedRoom();
            const offPlan = makeStructure(room, STRUCTURE_TOWER, { pos: makePosition(room, 20, 30) });
            setFind(room, FIND_STRUCTURES, [spawn, offPlan]);
            const legacy = new TileArray(50, 50);
            for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) legacy.set(x, y, ' ');
            room.memory.roomManager.layout = legacy.toCompactString();
            assert.equal(tiles(room, RoomManager.TILE_TOWER).length, 5);
        });

        it('builds from the plan and places a container beside an unserved source', function () {
            const { room } = plannedRoom();
            global.CONTROLLER_STRUCTURES = Object.assign({}, FULL_LIMITS, { [STRUCTURE_CONTAINER]: { 3: 5 } });
            room.controller.level = 3;
            setFind(room, FIND_STRUCTURES, [Game.spawns.Spawn1, makeStructure(room, STRUCTURE_TOWER, { pos: makePosition(room, 28, 25) })]);
            const mayor = new MayorManager(room);
            mayor._cache = { constructionSites: [] };
            mayor.warnings = [];
            mayor._validateBuildings();
            assert.equal(mayor.warnings[0].text, 'Source without a container');
            mayor.warnings[0].act();
            const site = room.createdSites[0];
            assert.equal(site.structureType, STRUCTURE_CONTAINER);
            assert.ok(site.pos.inRangeTo(room._find[FIND_SOURCES][0].pos, 1));
        });

        it('leaves containers alone when derived demand is turned off', function () {
            const { room } = plannedRoom();
            global.CONTROLLER_STRUCTURES = Object.assign({}, FULL_LIMITS, { [STRUCTURE_CONTAINER]: { 3: 5 } });
            room.controller.level = 3;
            room.memory.base.autoDemand = false;
            const mayor = new MayorManager(room);
            mayor._cache = { constructionSites: [] };
            mayor.warnings = [];
            assert.equal(mayor._queueSourceContainer(), false);
        });
    });

    describe('logistics endpoints', function () {
        function logisticsRoom() {
            const { room } = homeRoom();
            const storage = makeStructure(room, STRUCTURE_STORAGE, {
                id: 'storage', pos: makePosition(room, 20, 20), store: makeStore(100000, { [RESOURCE_ENERGY]: 50000 }),
            });
            room.storage = storage;
            registerObject(storage, 'A');
            setFind(room, FIND_STRUCTURES, [storage]);
            return { room, storage };
        }

        it('refills a hub source link whose role is only stored in Memory', function () {
            const { room, storage } = logisticsRoom();
            const link = makeStructure(room, STRUCTURE_LINK, { id: 'hub-link', pos: makePosition(room, 21, 21), store: makeStore(800) });
            registerObject(link, 'A');
            Memory.structures = { 'hub-link': { type: 'source' } };
            setFind(room, FIND_MY_STRUCTURES, [storage, link]);
            setFind(room, FIND_STRUCTURES, [storage, link]);
            setFind(room, FIND_SOURCES, [{ id: 'source', pos: makePosition(room, 40, 40) }]);
            new LogisticsManager(room).run();
            assert.ok(room.memory.logistics.tasks.some(task => task.targetId === 'hub-link'));
        });

        it('does not haul stored energy to a link that already sits at a source', function () {
            const { room, storage } = logisticsRoom();
            const link = makeStructure(room, STRUCTURE_LINK, { id: 'mine-link', pos: makePosition(room, 39, 39), store: makeStore(800) });
            registerObject(link, 'A');
            Memory.structures = { 'mine-link': { type: 'source' } };
            setFind(room, FIND_MY_STRUCTURES, [storage, link]);
            setFind(room, FIND_STRUCTURES, [storage, link]);
            setFind(room, FIND_SOURCES, [{ id: 'source', pos: makePosition(room, 40, 40) }]);
            new LogisticsManager(room).run();
            assert.ok(!room.memory.logistics.tasks.some(task => task.targetId === 'mine-link'));
        });

        it('keeps the claiming creep in sync when a destroyed source is replaced', function () {
            const { room, storage } = logisticsRoom();
            const creep = makeCreep(room, { name: 'hauler', memory: { role: 'Storekeeper', home: 'A', taskId: 'A:gone:spawn:energy' } });
            Game.creeps.hauler = creep;
            const target = makeStructure(room, STRUCTURE_SPAWN, {
                id: 'spawn', pos: makePosition(room, 25, 25), store: makeStore(300),
            });
            registerObject(target, 'A');
            setFind(room, FIND_MY_STRUCTURES, [storage, target]);
            room.memory.logistics = {
                tasks: [{
                    id: 'A:gone:spawn:energy', kind: 'supply', sourceId: 'gone', targetId: 'spawn', resourceType: RESOURCE_ENERGY,
                    amount: 100, remaining: 100, priority: 100, state: 'open', assignedCreep: 'hauler',
                    sourceRoomName: 'A', targetRoomName: 'A', created: 1,
                }],
                overflow: 0,
            };
            new LogisticsManager(room).run();
            const task = room.memory.logistics.tasks.find(entry => entry.targetId === 'spawn');
            assert.equal(task.sourceId, 'storage');
            assert.equal(creep.memory.taskId, task.id);
            assert.equal(LogisticsManager.assignTask(creep, {}), task);
        });
    });
});
