const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const BaseManager = require('../manager.base');
const EconomyManager = require('../manager.economy');
const LogisticsManager = require('../manager.logistics');
const MemoryManager = require('../manager.memory');
const MainCache = require('../main.cache');
const config = require('../main.config');
const Builder = require('../role.builder');
const Handyman = require('../role.handyman');
const Harvester = require('../role.harvester');
const Miner = require('../role.miner');
const StoreKeeper = require('../role.storekeeper');
const Upgrader = require('../role.upgrader');

function homeRoom(options = {}) {
    const room = makeRoom('A', {
        memory: { base: { name: 'A', roleConfig: Object.assign({ showIcons: false }, options.roleConfig) } },
        energyAvailable: options.energy === undefined ? 300 : options.energy,
        energyCapacityAvailable: options.capacity || 300,
    });
    room.controller = { my: true, level: options.level || 4, pos: makePosition(room, 30, 30) };
    const spawn = makeSpawn(room, { name: 'Spawn1', pos: makePosition(room, 25, 25), memory: { home: 'A' } });
    Game.rooms.A = room;
    Game.spawns.Spawn1 = spawn;
    setFind(room, FIND_MY_SPAWNS, [spawn]);
    return { room, spawn };
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

function addCreep(room, name, role, extra = {}) {
    const { memory, ...options } = extra;
    Game.creeps[name] = makeCreep(room, Object.assign({ name, memory: Object.assign({ role, home: 'A' }, memory) }, options));
    return Game.creeps[name];
}

function minedRoom(options = {}) {
    const setup = homeRoom(options);
    addSource(setup.room, 's1', 10, 10);
    addSource(setup.room, 's2', 40, 40);
    addStructure(setup.room, STRUCTURE_CONTAINER, 11, 11);
    addStructure(setup.room, STRUCTURE_CONTAINER, 39, 39);
    addCreep(setup.room, 'm1', 'Miner', { memory: { source: 's1' } });
    addCreep(setup.room, 'm2', 'Miner', { memory: { source: 's2' } });
    return setup;
}

function run(room, roles) {
    MainCache.initRound(roles);
    new BaseManager(room, roles)._repopulateCreeps();
}

describe('Harvesters only during bootstrap', function () {
    beforeEach(function () {
        resetScreeps();
        Memory.creeps = {};
    });

    describe('EconomyManager.getDesiredHarvesters', function () {
        it('wants none once Miners and a hauler run every source', function () {
            const { room } = minedRoom();
            addCreep(room, 'sk', 'Storekeeper');
            MainCache.initRound([]);
            assert.equal(EconomyManager.isSelfSustaining(room), true);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 0);
        });

        it('keeps one while there is no hauler to deliver what the Miners dig', function () {
            const { room } = minedRoom();
            MainCache.initRound([]);
            assert.equal(EconomyManager.isSelfSustaining(room), false);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 1);
        });

        it('keeps one when every Miner is gone', function () {
            const { room } = homeRoom();
            addSource(room, 's1', 10, 10);
            addStructure(room, STRUCTURE_CONTAINER, 11, 11);
            addCreep(room, 'sk', 'Storekeeper');
            MainCache.initRound([]);
            assert.equal(EconomyManager.isSelfSustaining(room), false);
            assert.ok(EconomyManager.getDesiredHarvesters(room) >= 1);
        });

        it('still staffs a source that cannot be mined statically yet', function () {
            const { room } = homeRoom();
            addSource(room, 's1', 10, 10);
            addSource(room, 's2', 40, 40);
            addStructure(room, STRUCTURE_CONTAINER, 11, 11);
            addCreep(room, 'm1', 'Miner', { memory: { source: 's1' } });
            addCreep(room, 'sk', 'Storekeeper');
            MainCache.initRound([]);
            assert.ok(EconomyManager.getDesiredHarvesters(room) >= 1);
        });

        it('does not ask for a Harvester while a Miner is only being replaced', function () {
            const { room } = minedRoom();
            addCreep(room, 'sk', 'Storekeeper');
            delete Game.creeps.m2;
            MainCache.initRound([]);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 0, 'the Miner queue handles this source');
        });

        it('does not count mission creeps as part of the local economy', function () {
            const { room } = minedRoom();
            addCreep(room, 'hauler', 'Storekeeper', { memory: { missionId: 'remote' } });
            MainCache.initRound([]);
            assert.equal(EconomyManager.isSelfSustaining(room), false);
        });
    });

    describe('spawning', function () {
        const roles = () => [new Harvester(), new Upgrader(), new Miner(), new StoreKeeper()];

        it('spawns no Harvester in a self-sustaining room', function () {
            const { room, spawn } = minedRoom({ energy: 1000, capacity: 1000, roleConfig: { Harvester: { requiredNumber: 0 } } });
            addCreep(room, 'sk', 'Storekeeper');
            addCreep(room, 'up', 'Upgrader');
            run(room, roles());
            assert.notEqual(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });

        it('removes the quota of 1 the old Mayor stored, once, in automatic rooms', function () {
            const { room } = minedRoom({ roleConfig: { Harvester: { requiredNumber: 1 }, Upgrader: { requiredNumber: 1 }, Builder: { requiredNumber: 3 } } });
            const roleConfig = MemoryManager._fetchRoomRoleConfig(room, []);
            assert.equal(roleConfig.Harvester.requiredNumber, 0);
            assert.equal(roleConfig.Upgrader.requiredNumber, 0);
            assert.equal(roleConfig.Builder.requiredNumber, 3, 'a higher count was chosen by someone');
            roleConfig.Harvester.requiredNumber = 1;
            MemoryManager._fetchRoomRoleConfig(room, []);
            assert.equal(roleConfig.Harvester.requiredNumber, 1, 'a count set afterwards stays');
        });

        it('leaves the quotas of a room the operator runs by hand', function () {
            const { room } = minedRoom({ roleConfig: { Harvester: { requiredNumber: 1 } } });
            room.memory.mayor = { mode: 'off' };
            const roleConfig = MemoryManager._fetchRoomRoleConfig(room, []);
            assert.equal(roleConfig.Harvester.requiredNumber, 1);
        });

        it('removes it when a room the operator ran by hand goes automatic', function () {
            const { room } = minedRoom({ roleConfig: { Harvester: { requiredNumber: 1 } } });
            room.memory.mayor = { mode: 'off' };
            MemoryManager._fetchRoomRoleConfig(room, []);
            room.memory.mayor.mode = 'auto';
            const roleConfig = MemoryManager._fetchRoomRoleConfig(room, []);
            assert.equal(roleConfig.Harvester.requiredNumber, 0);
        });

        it('no longer has the Mayor write counts into automatic rooms', function () {
            const MayorManager = require('../manager.mayor');
            const { room } = minedRoom({ roleConfig: { Harvester: { requiredNumber: 0 }, Upgrader: { requiredNumber: 0 }, Builder: { requiredNumber: 0 }, Handyman: { requiredNumber: 0 } } });
            room.memory.mayor = { mode: 'auto' };
            global.CONTROLLER_STRUCTURES = global.CONTROLLER_STRUCTURES || {};
            MainCache.initRound([]);
            new MayorManager(room).run();
            ['Harvester', 'Upgrader', 'Builder', 'Handyman'].forEach(role => {
                assert.equal(room.memory.base.roleConfig[role].requiredNumber, 0, role);
            });
        });

        it('honours a Harvester quota the operator raised', function () {
            const { room, spawn } = minedRoom({ energy: 1000, capacity: 1000, roleConfig: { Harvester: { requiredNumber: 2 } } });
            addCreep(room, 'sk', 'Storekeeper');
            addCreep(room, 'up', 'Upgrader');
            setFind(room, FIND_MY_STRUCTURES, [makeStructure(room, STRUCTURE_EXTENSION, { store: makeStore(50) })]);
            run(room, roles());
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });

        it('honours a quota of 1 set explicitly with setCreepCount', function () {
            const { room, spawn } = minedRoom({ energy: 1000, capacity: 1000 });
            room.memory.base.roleConfig.Harvester = { requiredNumber: 0 };
            room.memory.base.roleConfig.quotaVersion = MemoryManager.QUOTA_VERSION;
            addCreep(room, 'sk', 'Storekeeper');
            addCreep(room, 'up', 'Upgrader');
            setFind(room, FIND_MY_STRUCTURES, [makeStructure(room, STRUCTURE_EXTENSION, { store: makeStore(50) })]);
            require('../main');
            assert.equal(global.setCreepCount('A', 'Harvester', 1), true);
            run(room, roles());
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });

        it('honours the quota in a room the operator runs by hand', function () {
            const { room, spawn } = minedRoom({ energy: 1000, capacity: 1000, roleConfig: { Harvester: { requiredNumber: 1 } } });
            room.memory.mayor = { mode: 'off' };
            addCreep(room, 'sk', 'Storekeeper');
            addCreep(room, 'up', 'Upgrader');
            setFind(room, FIND_MY_STRUCTURES, [makeStructure(room, STRUCTURE_EXTENSION, { store: makeStore(50) })]);
            run(room, roles());
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });

        it('brings a Harvester back when the last hauler dies, even with auto off', function () {
            const { room, spawn } = minedRoom({ energy: 300, capacity: 1000, roleConfig: { Harvester: { requiredNumber: 0, auto: false } } });
            addCreep(room, 'up', 'Upgrader');
            run(room, roles());
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });

        it('does not hold energy back for a recovery Harvester in a self-sustaining room', function () {
            const { room, spawn } = minedRoom({ energy: 400, capacity: 1000 });
            require('../main.heap').namespace('spawnWait').A = Game.time - config.SPAWN.MAX_WAIT_TICKS;
            assert.ok(room.energyAvailable < config.SPAWN.RECOVERY_ENERGY_RESERVE);
            addCreep(room, 'sk', 'Storekeeper');
            addCreep(room, 'up', 'Upgrader');
            addCreep(room, 'old', 'Harvester', { ticksToLive: 1000 });
            const site = { id: 'site', structureType: STRUCTURE_CONTAINER, pos: makePosition(room, 20, 20), progress: 0, progressTotal: 100 };
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [site]);
            run(room, [new Builder(), new Harvester(), new Upgrader()]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Builder');
        });

        it('does not replace an ageing leftover Harvester in a self-sustaining room', function () {
            const { room, spawn } = minedRoom({ energy: 1000, capacity: 1000 });
            addCreep(room, 'sk', 'Storekeeper');
            addCreep(room, 'up', 'Upgrader');
            addCreep(room, 'old', 'Harvester', { ticksToLive: 10 });
            run(room, roles());
            assert.notEqual(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });

        it('keeps the spawn filled once the Harvesters are gone', function () {
            const { room, spawn } = minedRoom({ energy: 100, capacity: 300 });
            Object.assign(spawn, { id: 'spawn', structureType: STRUCTURE_SPAWN, my: true, store: makeStore(300, { [RESOURCE_ENERGY]: 100 }) });
            registerObject(spawn, 'A');
            setFind(room, FIND_MY_STRUCTURES, [spawn]);
            const container = room._find[FIND_STRUCTURES][0];
            container.store = makeStore(2000, { [RESOURCE_ENERGY]: 1000 });
            const hauler = addCreep(room, 'sk', 'Storekeeper', { pos: makePosition(room, 12, 12), capacity: 100 });
            MainCache.initRound([]);
            assert.equal(EconomyManager.isSelfSustaining(room), true);
            new LogisticsManager(room).run();
            const task = room.memory.logistics.tasks.find(entry => entry.targetId === 'spawn');
            assert.ok(task, 'the queue asks for energy at the spawn');
            assert.equal(task.sourceId, container.id);
            new StoreKeeper().run(hauler, room);
            assert.equal(hauler.memory.taskId, task.id, 'the hauler takes it');
            assert.equal(hauler.store.getUsedCapacity(RESOURCE_ENERGY) > 0, true, 'and loads from the container');
        });

        it('saves up for a full body when replacing a Storekeeper that is still working', function () {
            const { room, spawn } = minedRoom({ energy: 400, capacity: 1300 });
            addCreep(room, 'up', 'Upgrader');
            addCreep(room, 'sk', 'Storekeeper', { ticksToLive: 5 });
            room.memory.logistics = { tasks: [{ id: 't', remaining: 100, state: 'open', resourceType: RESOURCE_ENERGY, retryAfter: 0 }] };
            run(room, roles());
            assert.equal(spawn.spawning, null, 'an undersized body would stay that size for 1500 ticks');
            assert.ok(require('../main.heap').namespace('spawnWait').A, 'and the wait is bounded');
        });

        it('does not save up when no Storekeeper is left, because nothing refills the spawn', function () {
            const { room, spawn } = minedRoom({ energy: config.SPAWN.RECOVERY_ENERGY_RESERVE + 50, capacity: 1300 });
            addCreep(room, 'up', 'Upgrader');
            addCreep(room, 'h', 'Harvester');
            room.memory.logistics = { tasks: [{ id: 't', remaining: 100, state: 'open', resourceType: RESOURCE_ENERGY, retryAfter: 0 }] };
            run(room, roles());
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Storekeeper');
        });

        it('skips a required boost when recovering from nothing', function () {
            const LabManager = require('../manager.lab');
            const { room, spawn } = homeRoom({ energy: 300 });
            const seen = [];
            const original = LabManager.planSpawnBoost;
            LabManager.planSpawnBoost = (who, body, role, memory, options) => {
                seen.push(options && options.emergency);
                return { allow: Boolean(options && options.emergency), plan: null };
            };
            try {
                addSource(room, 's1', 10, 10);
                run(room, roles());
            } finally {
                LabManager.planSpawnBoost = original;
            }
            assert.deepEqual(seen, [true]);
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });

        it('still recovers from losing every creep', function () {
            const { room, spawn } = homeRoom({ energy: 300 });
            addSource(room, 's1', 10, 10);
            run(room, roles());
            assert.equal(spawn.spawning && spawn.spawning.memory.role, 'Harvester');
        });
    });
});

describe('Looting through the logistics queue', function () {
    beforeEach(function () {
        resetScreeps();
    });

    function pile(room) {
        const value = { id: 'pile', room, pos: makePosition(room, 26, 25), resourceType: RESOURCE_ENERGY, amount: 200 };
        setFind(room, FIND_DROPPED_RESOURCES, [value]);
        return value;
    }

    function worker(room) {
        const creep = addCreep(room, 'worker', 'Upgrader');
        const role = new Upgrader();
        let worked = 0;
        role._work = () => worked++;
        return { creep, role, worked: () => worked };
    }

    it('leaves piles to the haulers when the room has them', function () {
        const { room } = homeRoom();
        const dropped = pile(room);
        addCreep(room, 'sk', 'Storekeeper');
        const { creep, role, worked } = worker(room);
        role.run(creep, room);
        assert.equal(dropped.amount, 200);
        assert.equal(worked(), 1);
    });

    it('does not scan for loot at all when the room has haulers', function () {
        const { room } = homeRoom();
        addCreep(room, 'sk', 'Storekeeper');
        const { creep, role } = worker(room);
        const finds = [];
        const original = room.find;
        room.find = function (type, options) {
            finds.push(type);
            return original.call(this, type, options);
        };
        role.run(creep, room);
        [FIND_DROPPED_RESOURCES, FIND_TOMBSTONES, FIND_RUINS].forEach(type => assert.ok(!finds.includes(type), type));
    });

    it('has the queue collect the pile instead', function () {
        const { room } = homeRoom();
        room.storage = makeStructure(room, STRUCTURE_STORAGE, { id: 'storage', store: makeStore(100000) });
        registerObject(room.storage, 'A');
        setFind(room, FIND_MY_STRUCTURES, [room.storage]);
        setFind(room, FIND_STRUCTURES, [room.storage]);
        registerObject(pile(room), 'A');
        const manager = new LogisticsManager(room);
        manager.run();
        assert.ok(room.memory.logistics.tasks.some(task => task.sourceId === 'pile' && task.kind === 'collect'));
    });

    it('still loots in a room with no haulers, such as a new base', function () {
        const { room } = homeRoom();
        const dropped = pile(room);
        const { creep, role, worked } = worker(room);
        role.run(creep, room);
        assert.equal(dropped.amount, 0);
        assert.equal(worked(), 1);
    });

    it('does not count a hauler that is still spawning', function () {
        const { room } = homeRoom();
        const dropped = pile(room);
        addCreep(room, 'sk', 'Storekeeper', { spawning: true });
        const { creep, role } = worker(room);
        role.run(creep, room);
        assert.equal(dropped.amount, 0);
    });

    it('takes from a tombstone and walks to one that is out of reach', function () {
        const { room } = homeRoom();
        const near = { id: 'near', room, pos: makePosition(room, 26, 25), store: makeStore(1000, { [RESOURCE_ENERGY]: 50 }) };
        setFind(room, FIND_TOMBSTONES, [near]);
        const first = worker(room);
        first.role.run(first.creep, room);
        assert.equal(near.store.getUsedCapacity(RESOURCE_ENERGY), 0);
        assert.equal(first.worked(), 1);

        const far = { id: 'far', room, pos: makePosition(room, 28, 25), store: makeStore(1000, { [RESOURCE_ENERGY]: 50 }) };
        setFind(room, FIND_TOMBSTONES, []);
        setFind(room, FIND_RUINS, [far]);
        MainCache.initRound([]);
        const second = worker(room);
        second.role.run(second.creep, room);
        assert.equal(second.creep.lastMoveTo, far);
        assert.equal(second.worked(), 0);
    });
});

describe('Derived bodies', function () {
    beforeEach(function () {
        resetScreeps();
    });

    function count(body, part) {
        return body.filter(value => value === part).length;
    }

    function spawnBody(role, spawn) {
        const creep = role.spawnCreep(spawn);
        assert.ok(creep, 'spawned');
        return creep.body;
    }

    it('sizes an Upgrader by what the sources can pay for', function () {
        const { room, spawn } = homeRoom({ energy: 12900, capacity: 12900, level: 7 });
        addSource(room, 's1', 10, 10);
        addSource(room, 's2', 40, 40);
        assert.equal(count(spawnBody(new Upgrader(), spawn), WORK), Math.ceil(20 * config.ECONOMY.SPENDING_SHARE));
    });

    it('gives a one-source room a smaller Upgrader', function () {
        const { room, spawn } = homeRoom({ energy: 12900, capacity: 12900, level: 7 });
        addSource(room, 's1', 10, 10);
        assert.equal(count(spawnBody(new Upgrader(), spawn), WORK), Math.ceil(10 * config.ECONOMY.SPENDING_SHARE));
    });

    it('stays within what the room can afford today', function () {
        const { room, spawn } = homeRoom({ energy: 500, capacity: 550, level: 2 });
        addSource(room, 's1', 10, 10);
        addSource(room, 's2', 40, 40);
        assert.equal(count(spawnBody(new Upgrader(), spawn), WORK), 2);
    });

    it('never exceeds the 50 part limit', function () {
        const { room, spawn } = homeRoom({ energy: 12900, capacity: 12900, level: 7 });
        ['a', 'b', 'c', 'd', 'e', 'f'].forEach((id, index) => addSource(room, id, 5 + index, 10));
        assert.ok(spawnBody(new Upgrader(), spawn).length <= MAX_CREEP_SIZE);
    });

    it('caps an RCL 8 Upgrader at the upgrade limit', function () {
        const { room } = homeRoom({ level: 8 });
        ['a', 'b', 'c', 'd', 'e', 'f'].forEach((id, index) => addSource(room, id, 5 + index, 10));
        assert.equal(EconomyManager.getSpendingWorkParts(room), CONTROLLER_MAX_UPGRADE_PER_TICK);
    });

    it('sizes a Harvester to empty one source and no more', function () {
        const { room, spawn } = homeRoom({ energy: 12900, capacity: 12900, level: 7 });
        addSource(room, 's1', 10, 10);
        assert.equal(count(spawnBody(new Harvester(), spawn), WORK), SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME / HARVEST_POWER);
    });

    it('sizes a Builder by how fast the room can pay for building', function () {
        const { room, spawn } = homeRoom({ energy: 12900, capacity: 12900, level: 7 });
        addSource(room, 's1', 10, 10);
        addSource(room, 's2', 40, 40);
        assert.equal(count(spawnBody(new Builder(), spawn), WORK), Math.ceil(20 / BUILD_POWER));
    });

    it('keeps a Handyman at the default size, which is plenty for repairs', function () {
        const { room, spawn } = homeRoom({ energy: 12900, capacity: 12900, level: 7 });
        addSource(room, 's1', 10, 10);
        assert.equal(count(spawnBody(new Handyman(), spawn), WORK), config.BODY.DEFAULT_UNITS);
    });

    it('wants a Handyman only once something is getting worn', function () {
        const { room } = homeRoom();
        const road = addStructure(room, STRUCTURE_ROAD, 20, 20, { hits: 4000, hitsMax: 5000 });
        const handyman = new Handyman();
        assert.equal(handyman.getDemand(room), 0, '80% is not worth a creep');
        road.hits = 2000;
        MainCache.initRound([]);
        assert.equal(handyman.getDemand(room), 1);
    });

    it('wants a Handyman for a rampart below its target', function () {
        const { room } = homeRoom();
        addStructure(room, STRUCTURE_RAMPART, 20, 20, { hits: 1, hitsMax: 300000 });
        assert.equal(new Handyman().getDemand(room), 1);
    });

    it('makes one big Storekeeper instead of many small ones when distance needs it', function () {
        const { room, spawn } = homeRoom({ energy: 2500, capacity: 2500, level: 6 });
        room.storage = makeStructure(room, STRUCTURE_STORAGE, { pos: makePosition(room, 10, 40) });
        addSource(room, 's1', 40, 40);
        addStructure(room, STRUCTURE_CONTAINER, 39, 39);
        const need = EconomyManager.getHaulingCarryParts(room);
        assert.ok(need > config.BODY.DEFAULT_UNITS, 'the route needs more than the old limit of 5');
        const body = spawnBody(new StoreKeeper(), spawn);
        assert.equal(count(body, CARRY), Math.min(need, Math.floor(MAX_CREEP_SIZE / 2)));
        assert.equal(EconomyManager.getDesiredStorekeepers(room, count(body, CARRY)), config.ECONOMY.WORKERS_FALLBACK);
    });

    it('asks for fewer Storekeepers because each one carries more', function () {
        const { room } = homeRoom({ capacity: 2500, level: 6 });
        room.storage = makeStructure(room, STRUCTURE_STORAGE, { pos: makePosition(room, 10, 40) });
        addSource(room, 's1', 40, 40);
        addStructure(room, STRUCTURE_CONTAINER, 39, 39);
        const need = EconomyManager.getHaulingCarryParts(room);
        const perCreep = LogisticsManager._getStorekeeperCarryParts(room);
        assert.equal(perCreep, Math.min(need, Math.floor(MAX_CREEP_SIZE / 2)));
        assert.ok(EconomyManager.getDesiredStorekeepers(room, perCreep) <= EconomyManager.getDesiredStorekeepers(room, config.BODY.DEFAULT_UNITS));
    });

    it('keeps the fixed size for roles without a derived size', function () {
        const Courier = require('../role.courier');
        const { room, spawn } = homeRoom({ energy: 12900, capacity: 12900, level: 7 });
        addSource(room, 's1', 10, 10);
        assert.equal(count(spawnBody(new Courier(), spawn), WORK), config.BODY.DEFAULT_UNITS);
    });

    it('lets an operator limit still win', function () {
        const { room, spawn } = homeRoom({ energy: 12900, capacity: 12900, level: 7, roleConfig: { partsMaxMultiplier: 3 } });
        addSource(room, 's1', 10, 10);
        addSource(room, 's2', 40, 40);
        assert.equal(count(spawnBody(new Upgrader(), spawn), WORK), 3);
    });

    it('removes the old default of 5 from saved rooms once, and keeps other values', function () {
        const { room } = homeRoom({ roleConfig: { partsMaxMultiplier: 5 } });
        MemoryManager._fetchRoomRoleConfig(room, []);
        assert.equal(room.memory.base.roleConfig.partsMaxMultiplier, undefined);
        assert.equal(room.memory.base.roleConfig.bodyVersion, MemoryManager.BODY_VERSION);

        room.memory.base.roleConfig.partsMaxMultiplier = 5;
        MemoryManager._fetchRoomRoleConfig(room, []);
        assert.equal(room.memory.base.roleConfig.partsMaxMultiplier, 5, 'set after the migration, so it was chosen');

        const other = makeRoom('B', { memory: { base: { name: 'B', roleConfig: { partsMaxMultiplier: 8 } } } });
        MemoryManager._fetchRoomRoleConfig(other, []);
        assert.equal(other.memory.base.roleConfig.partsMaxMultiplier, 8);
    });

    it('does not write a default limit into new rooms', function () {
        const { room } = homeRoom();
        MemoryManager._fetchRoomRoleConfig(room, []);
        assert.equal(room.memory.base.roleConfig.partsMaxMultiplier, undefined);
    });
});
