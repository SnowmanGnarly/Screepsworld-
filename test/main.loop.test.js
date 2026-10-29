const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const MainCache = require('../main.cache');
const main = require('../main');

describe('Main loop integration', function () {
    beforeEach(function () {
        resetScreeps();
        Game.cpu = { bucket: 9000, getUsed: () => 0 };
        global.CONTROLLER_STRUCTURES = {};
        for (const type of [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_STORAGE, STRUCTURE_EXTENSION,
            STRUCTURE_LINK, STRUCTURE_EXTRACTOR, STRUCTURE_TERMINAL, STRUCTURE_LAB, STRUCTURE_FACTORY,
            STRUCTURE_POWER_SPAWN, STRUCTURE_OBSERVER, STRUCTURE_NUKER]) {
            global.CONTROLLER_STRUCTURES[type] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
        }
        global.CONTROLLER_STRUCTURES[STRUCTURE_SPAWN][1] = 1;
    });

    it('spawns an emergency Harvester through the full loop with no creeps', function () {
        const room = makeRoom('A', { energyAvailable: 200 });
        room.controller = { my: true, level: 1, pos: makePosition(room, 30, 30) };
        const spawn = makeSpawn(room, { name: 'Spawn1', memory: {} });
        spawn.store = makeStore(300, { [RESOURCE_ENERGY]: 200 });
        Game.rooms.A = room;
        Game.spawns.Spawn1 = spawn;
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, [spawn]);
        setFind(room, FIND_STRUCTURES, [spawn]);

        main.loop();

        const creeps = Object.values(Game.creeps);
        assert.equal(creeps.length, 1);
        assert.equal(creeps[0].memory.role, 'Harvester');
        assert.deepEqual(creeps[0].body, [WORK, CARRY, MOVE]);
        assert.equal(room.memory.base.roleConfig.Harvester.requiredNumber, 1);
        assert.equal(room.memory.base.roleConfig.Upgrader.requiredNumber, 1);
    });

    it('runs a configured home and remote economy through the full loop', function () {
        const home = makeRoom('A', {
            memory: {
                base: {
                    name: 'A', remoteRooms: ['B'], showIcons: false,
                    roleConfig: {
                        Harvester: { requiredNumber: 1 }, Upgrader: { requiredNumber: 1 },
                        Defender: { requiredNumber: 0 }, Storekeeper: { requiredNumber: 0 }, Courier: { requiredNumber: 0 },
                        showIcons: false,
                    },
                },
            },
            energyAvailable: 1800,
            energyCapacityAvailable: 1800,
        });
        home.controller = { my: true, level: 5, owner: { username: 'Me' }, pos: makePosition(home, 30, 30) };
        const spawn = makeSpawn(home, { name: 'Spawn-A', memory: { home: 'A' } });
        const storage = makeStructure(home, STRUCTURE_STORAGE, {
            id: 'storage-A', pos: makePosition(home, 24, 25), store: makeStore(10000),
        });
        home.storage = storage;
        Game.rooms.A = home;
        Game.spawns['Spawn-A'] = spawn;
        setFind(home, FIND_MY_SPAWNS, [spawn]);
        setFind(home, FIND_MY_STRUCTURES, [spawn, storage]);
        setFind(home, FIND_STRUCTURES, [spawn, storage]);

        const remote = makeRoom('B', { controller: null });
        remote.controller = { my: false, level: 0, pos: makePosition(remote, 25, 25) };
        const source = { id: 'source-B', room: remote, pos: makePosition(remote, 20, 20), energy: 3000, energyCapacity: 3000 };
        const container = makeStructure(remote, STRUCTURE_CONTAINER, {
            id: 'container-B', pos: makePosition(remote, 20, 21), store: makeStore(1000, { [RESOURCE_ENERGY]: 200 }),
        });
        Game.rooms.B = remote;
        registerObject(source, remote.name);
        setFind(remote, FIND_SOURCES, [source]);
        setFind(remote, FIND_STRUCTURES, [container]);

        const harvester = makeCreep(home, { name: 'harvester', memory: { role: 'Harvester', home: 'A' } });
        const upgrader = makeCreep(home, { name: 'upgrader', memory: { role: 'Upgrader', home: 'A' } });
        const miner = makeCreep(remote, {
            name: 'remote-miner', body: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE], pos: source.pos, store: makeStore(100),
            memory: {
                role: 'RemoteMiner', home: 'A', missionId: 'remote:A:B', targetRoom: 'B', homeRoom: 'A',
                sourceId: source.id, sourcePos: { roomName: 'B', x: 20, y: 20 },
            },
        });
        const hauler = makeCreep(home, {
            name: 'remote-hauler', body: [CARRY, CARRY, MOVE], pos: storage.pos,
            store: makeStore(200, { [RESOURCE_ENERGY]: 100 }),
            memory: {
                role: 'RemoteHauler', home: 'A', missionId: 'remote:A:B', targetRoom: 'B', homeRoom: 'A', working: true,
                homePos: { roomName: 'A', x: 24, y: 25 }, sourcePos: { roomName: 'B', x: 20, y: 20 },
            },
        });
        Game.creeps = { harvester, upgrader, miner, hauler };

        main.loop();

        assert.equal(Memory.empire.intel.B.sources[0].id, source.id);
        assert.equal(Memory.empire.missions['remote:A:B'].stats.energyHarvested, 10);
        assert.equal(Memory.empire.missions['remote:A:B'].stats.energyDelivered, 100);
        assert.equal(container.store.getUsedCapacity(RESOURCE_ENERGY), 210);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_ENERGY), 100);
        assert.equal(spawn.spawning.memory.role, 'Reserver');
        assert.deepEqual(spawn.spawning.body, [CLAIM, MOVE]);
    });

    it('spawns an automatic MineralMiner through the full loop at RCL 6', function () {
        const room = makeRoom('A', {
            memory: {
                base: {
                    name: 'A', showIcons: false,
                    roleConfig: {
                        Harvester: { requiredNumber: 1 }, Upgrader: { requiredNumber: 1 },
                        MineralMiner: { requiredNumber: 0, maxNumber: 1 }, showIcons: false,
                    },
                },
            },
            energyAvailable: 1000,
            energyCapacityAvailable: 1000,
        });
        room.controller = { my: true, level: 6, owner: { username: 'Me' }, pos: makePosition(room, 30, 30) };
        const spawn = makeSpawn(room, { name: 'Spawn-A', memory: { home: 'A' } });
        const storage = makeStructure(room, STRUCTURE_STORAGE, {
            id: 'storage-A', pos: makePosition(room, 24, 25), store: makeStore(10000),
        });
        const mineral = {
            id: 'mineral-A', room, pos: makePosition(room, 20, 20),
            mineralType: RESOURCE_OXYGEN, mineralAmount: 500,
        };
        const extractor = makeStructure(room, STRUCTURE_EXTRACTOR, {
            id: 'extractor-A', pos: mineral.pos, extra: { my: true, cooldown: 0 },
        });
        room.storage = storage;
        Game.rooms.A = room;
        Game.spawns[spawn.name] = spawn;
        Game.creeps = {
            harvester: makeCreep(room, { name: 'harvester', memory: { role: 'Harvester', home: 'A' } }),
            upgrader: makeCreep(room, { name: 'upgrader', memory: { role: 'Upgrader', home: 'A' } }),
        };
        [mineral, extractor, storage, spawn].forEach(object => registerObject(object, room.name));
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, [spawn, storage, extractor]);
        setFind(room, FIND_STRUCTURES, [spawn, storage, extractor]);
        setFind(room, FIND_MINERALS, [mineral]);

        main.loop();

        assert.equal(spawn.spawning.memory.role, 'MineralMiner');
        assert.equal(spawn.spawning.memory.source, mineral.id);
        assert.deepEqual(spawn.spawning.body, [MOVE, CARRY, WORK, WORK, WORK, WORK, WORK]);
    });

    describe('multi-tick scenarios', function () {
        // Stands in for the engine between ticks: spawning finishes, each requested
        // move arrives at its destination, and live creep memory is linked into
        // Memory.creeps, while a dead creep's memory stays until the bot cleans it up.
        function syncEngineState() {
            Memory.creeps = Memory.creeps || {};
            const creeps = Object.values(Game.creeps);
            creeps.forEach(creep => { Memory.creeps[creep.name] = creep.memory; });
            Object.values(Game.rooms).forEach(room => {
                setFind(room, FIND_MY_CREEPS, creeps.filter(creep => creep.room === room));
            });
        }

        function runTick() {
            syncEngineState();
            main.loop();
        }

        function nextTick() {
            Game.time++;
            Object.values(Game.spawns).forEach(spawn => { spawn.spawning = null; });
            Object.values(Game.creeps).forEach(creep => {
                creep.spawning = false;
                const destination = creep.lastMoveTo && (creep.lastMoveTo.pos || creep.lastMoveTo);
                if (destination) creep.pos = new RoomPosition(destination.x, destination.y, destination.roomName);
                creep.lastMoveTo = null;
            });
            runTick();
        }

        function scenarioBase(options = {}) {
            const energy = options.energy || 1000;
            const room = makeRoom('A', {
                memory: {
                    base: {
                        name: 'A', showIcons: false,
                        roleConfig: Object.assign({
                            Harvester: { requiredNumber: 1 }, Upgrader: { requiredNumber: 1 },
                            Storekeeper: { requiredNumber: 0, maxNumber: 0 }, Courier: { requiredNumber: 0, maxNumber: 0 },
                            useStorageAsSource: false, showIcons: false,
                        }, options.roleConfig),
                    },
                },
                energyAvailable: energy,
                energyCapacityAvailable: energy,
            });
            room.controller = Object.assign({
                my: true, level: options.level || 4, owner: { username: 'Me' }, pos: makePosition(room, 30, 30),
            }, options.controller);
            const spawn = makeSpawn(room, { name: 'Spawn-A', memory: { home: 'A' } });
            spawn.id = 'spawn-A';
            spawn.store = makeStore(300, { [RESOURCE_ENERGY]: 300 });
            Game.rooms.A = room;
            Game.spawns[spawn.name] = spawn;
            setFind(room, FIND_MY_SPAWNS, [spawn]);
            return { room, spawn };
        }

        function setStructures(room, structures) {
            structures.forEach(structure => registerObject(structure, room.name));
            setFind(room, FIND_MY_STRUCTURES, structures);
            setFind(room, FIND_STRUCTURES, structures);
        }

        function addCreep(room, name, role, options = {}) {
            const creep = makeCreep(room, Object.assign({
                name, memory: { role, home: room.name }, pos: makePosition(room, 10, 10),
            }, options));
            Game.creeps[name] = creep;
            return creep;
        }

        it('defers road watching and visuals while the CPU bucket recovers but keeps spawning', function () {
            const { room, spawn } = scenarioBase({ level: 1, energy: 300 });
            setStructures(room, [spawn]);
            addCreep(room, 'harvester', 'Harvester');
            addCreep(room, 'upgrader', 'Upgrader');
            const drawn = [];
            room.visual = { text: label => drawn.push(label) };
            const tickWithBucket = bucket => {
                drawn.length = 0;
                Game.cpu.bucket = bucket;
                nextTick();
            };

            runTick();
            assert.equal(room.memory.roadManager.tick, 1);
            assert.ok(drawn.includes('CPU Watcher'));
            assert.equal(spawn.spawning, null);

            delete Game.creeps.harvester;
            tickWithBucket(999);
            assert.equal(room.memory.roadManager.tick, 1, 'road watching is deferred');
            assert.ok(!drawn.includes('CPU Watcher'), 'visuals are deferred');
            assert.equal(spawn.spawning.memory.role, 'Harvester', 'replacement spawning continues in degraded mode');

            tickWithBucket(1200);
            assert.equal(room.memory.roadManager.tick, 1, 'hysteresis keeps deferring until the bucket passes 1500');
            assert.ok(!drawn.includes('CPU Watcher'));

            tickWithBucket(1501);
            assert.equal(room.memory.roadManager.tick, 2);
            assert.ok(drawn.includes('CPU Watcher'));
        });

        it('cleans up a dead creep and spawns exactly one replacement', function () {
            const { room, spawn } = scenarioBase({ energy: 300 });
            setStructures(room, [spawn]);
            const harvester = addCreep(room, 'harvester', 'Harvester');
            addCreep(room, 'upgrader', 'Upgrader');

            runTick();
            assert.equal(spawn.spawning, null);
            assert.equal(Memory.creeps.harvester, harvester.memory);

            delete Game.creeps.harvester;
            nextTick();
            assert.equal(Memory.creeps.harvester, undefined);
            const replacement = spawn.spawning;
            assert.equal(replacement.memory.role, 'Harvester');
            assert.equal(replacement.memory.home, 'A');

            nextTick();
            assert.equal(spawn.spawning, null, 'the live replacement satisfies the quota');
            assert.equal(Memory.creeps[replacement.name], replacement.memory);
            assert.deepEqual(Object.values(Game.creeps).map(creep => creep.memory.role).sort(), ['Harvester', 'Upgrader']);
        });

        it('claims, picks up, delivers, and retires an energy supply task', function () {
            const { room, spawn } = scenarioBase({ roleConfig: { Storekeeper: { requiredNumber: 0 } } });
            const storage = makeStructure(room, STRUCTURE_STORAGE, {
                id: 'storage-A', pos: makePosition(room, 10, 25), store: makeStore(10000, { [RESOURCE_ENERGY]: 5000 }),
            });
            const extension = makeStructure(room, STRUCTURE_EXTENSION, {
                id: 'extension-A', pos: makePosition(room, 40, 25), store: makeStore(50),
            });
            room.storage = storage;
            setStructures(room, [spawn, storage, extension]);
            addCreep(room, 'harvester', 'Harvester');
            addCreep(room, 'upgrader', 'Upgrader');
            const storekeeper = addCreep(room, 'storekeeper', 'Storekeeper', {
                body: [CARRY, CARRY, MOVE, MOVE], capacity: 100, pos: makePosition(room, 25, 40),
            });
            const extensionTask = () => room.memory.logistics.tasks.find(task => task.targetId === extension.id);

            runTick();
            assert.equal(extensionTask().sourceId, storage.id);
            assert.equal(extensionTask().remaining, 50);
            assert.equal(extensionTask().assignedCreep, storekeeper.name);
            assert.equal(storekeeper.memory.taskId, extensionTask().id);
            assert.equal(storekeeper.lastMoveTo, storage);
            assert.equal(spawn.spawning, null, 'the existing Storekeeper covers the task');

            nextTick();
            assert.equal(storekeeper.store.getUsedCapacity(RESOURCE_ENERGY), 50);
            assert.equal(storage.store.getUsedCapacity(RESOURCE_ENERGY), 4950);

            nextTick();
            assert.equal(storekeeper.lastMoveTo, extension);

            nextTick();
            assert.equal(extension.store.getUsedCapacity(RESOURCE_ENERGY), 50);
            assert.equal(storekeeper.store.getUsedCapacity(RESOURCE_ENERGY), 0);

            nextTick();
            assert.equal(extensionTask(), undefined);
            assert.equal(storekeeper.memory.taskId, undefined);
            assert.equal(spawn.spawning, null);
        });

        it('alerts, fires towers, and spawns and recycles a defender over an invasion', function () {
            const { room, spawn } = scenarioBase({
                level: 5,
                controller: {
                    safeModeAvailable: 1,
                    safeModeCooldown: 0,
                    activateSafeMode() {
                        this.activations = (this.activations || 0) + 1;
                        return OK;
                    },
                },
            });
            const storage = makeStructure(room, STRUCTURE_STORAGE, {
                id: 'storage-A', pos: makePosition(room, 20, 20), store: makeStore(10000, { [RESOURCE_ENERGY]: 5000 }),
            });
            const tower = makeStructure(room, STRUCTURE_TOWER, {
                id: 'tower-A', pos: makePosition(room, 24, 25), store: makeStore(1000, { [RESOURCE_ENERGY]: 500 }),
                extra: { attacks: [], attack(target) { this.attacks.push(target); return OK; } },
            });
            room.storage = storage;
            setStructures(room, [spawn, storage, tower]);
            addCreep(room, 'harvester', 'Harvester');
            addCreep(room, 'upgrader', 'Upgrader');
            const invader = registerObject({
                id: 'invader', room, pos: makePosition(room, 27, 25), owner: { username: 'Invader' },
                body: [{ type: ATTACK, hits: 100 }, { type: ATTACK, hits: 100 }, { type: MOVE, hits: 100 }],
                getActiveBodyparts(type) {
                    return this.body.filter(part => part.type === type && part.hits > 0).length;
                },
            }, room.name);
            const towerTask = () => room.memory.logistics.tasks.find(task => task.targetId === tower.id);
            const defenders = () => Object.values(Game.creeps).filter(creep => creep.memory.role === 'Defender');

            runTick();
            assert.equal(room.memory.defense.threatLevel, 0);
            assert.equal(towerTask().priority, 60);
            assert.equal(spawn.spawning, null);

            setFind(room, FIND_HOSTILE_CREEPS, [invader]);
            nextTick();
            assert.equal(room.memory.defense.threatLevel, 3);
            assert.equal(room.memory.defense.primaryTargetId, invader.id);
            assert.equal(room.memory.defense.desiredDefenders, 1);
            assert.equal(Game.notifications.length, 1);
            assert.deepEqual(tower.attacks, [invader]);
            assert.equal(towerTask().priority, 95, 'tower refill is escalated under attack');
            assert.equal(room.controller.activations, undefined, 'tower coverage makes Safe Mode unnecessary');
            assert.deepEqual(MainCache.find(room, FIND_MY_SPAWNS), [spawn], 'the shared spawn cache stays unpolluted');
            const defender = spawn.spawning;
            assert.equal(defender.memory.role, 'Defender');

            nextTick();
            assert.equal(defender.lastMoveTo, invader);
            assert.equal(defenders().length, 1, 'no duplicate defender while one is active');
            assert.equal(Game.notifications.length, 1, 'alerts are rate limited');

            nextTick();
            assert.equal(defender.attacked, invader);
            assert.equal(tower.attacks.length, 3);

            invader.destroyed = true;
            setFind(room, FIND_HOSTILE_CREEPS, []);
            nextTick();
            assert.equal(room.memory.defense.threatLevel, 0);
            assert.equal(room.memory.defense.desiredDefenders, 0);
            assert.equal(tower.attacks.length, 3);
            assert.equal(defender.memory.selfdestruct, true);

            nextTick();
            assert.equal(defender.lastMoveTo, spawn);

            nextTick();
            assert.equal(defender.recycled, true);
            assert.equal(Game.creeps[defender.name], undefined);

            nextTick();
            assert.equal(Memory.creeps[defender.name], undefined);
            assert.equal(spawn.spawning, null, 'no defender is requested in peacetime');
        });
    });
});
