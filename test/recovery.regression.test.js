const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const BaseManager = require('../manager.base');
const LogisticsManager = require('../manager.logistics');
const LogisticsRunner = require('../logistics.runner');
const MainCache = require('../main.cache');
const MainInfo = require('../main.info');
const MainScheduler = require('../main.scheduler');
const RemoteManager = require('../manager.remote');
const config = require('../main.config');
const Miner = require('../role.miner');
const RemoteHauler = require('../role.remoteHauler');
const StoreKeeper = require('../role.storekeeper');
const Upgrader = require('../role.upgrader');

function baseRoom(name, options = {}) {
    const room = makeRoom(name, {
        memory: { base: { name, roleConfig: {} } },
        energyAvailable: options.energy === undefined ? 300 : options.energy,
        energyCapacityAvailable: options.capacity || 300,
    });
    room.controller = { my: true, level: 4, pos: makePosition(room, 30, 30), id: 'controller-' + name };
    Game.rooms[name] = room;
    return room;
}

function addStructure(room, type, id, x, y, store) {
    const structure = makeStructure(room, type, { id, pos: makePosition(room, x, y), store, extra: { my: true } });
    registerObject(structure, room.name);
    setFind(room, FIND_STRUCTURES, (room._find[FIND_STRUCTURES] || []).concat(structure));
    return structure;
}

describe('Getting out of stuck states', function () {
    beforeEach(function () {
        resetScreeps();
        Memory.creeps = {};
    });

    describe('workers whose source is destroyed', function () {
        it('pick another store instead of waiting for it forever', function () {
            const room = baseRoom('A');
            const storage = addStructure(room, STRUCTURE_STORAGE, 'storage', 26, 25, makeStore(100000, { [RESOURCE_ENERGY]: 5000 }));
            room.storage = storage;
            const creep = makeCreep(room, { name: 'up', pos: makePosition(room, 26, 26), capacity: 50, memory: { role: 'Upgrader', home: 'A', source: 'destroyed-container' } });
            Game.creeps.up = creep;
            new Upgrader().run(creep, room);
            assert.equal(creep.memory.source, 'storage');
            assert.equal(creep.store.getUsedCapacity(RESOURCE_ENERGY), 50);
        });

        it('do not fill the error log', function () {
            const room = baseRoom('A');
            const errors = [];
            MainInfo.error = message => errors.push(message);
            const creep = makeCreep(room, { name: 'up', memory: { role: 'Upgrader', home: 'A', source: 'destroyed-container' } });
            Game.creeps.up = creep;
            new Upgrader().run(creep, room);
            assert.deepEqual(errors, []);
        });
    });

    describe('haulers on a task that cannot progress', function () {
        function taskRoom() {
            const room = baseRoom('A');
            const empty = addStructure(room, STRUCTURE_STORAGE, 'storage', 20, 20, makeStore(100000));
            const target = addStructure(room, STRUCTURE_EXTENSION, 'ext', 22, 22, makeStore(50));
            setFind(room, FIND_MY_STRUCTURES, [target]);
            room.memory.logistics = {
                tasks: [{ id: 'A:storage:ext:energy', kind: 'supply', sourceId: 'storage', targetId: 'ext', resourceType: RESOURCE_ENERGY, amount: 50, remaining: 50, priority: 100, state: 'open', assignedCreep: 'sk', created: 1, lastProgress: 1, retryAfter: 0 }],
            };
            const creep = makeCreep(room, { name: 'sk', pos: makePosition(room, 20, 21), capacity: 100, memory: { role: 'Storekeeper', home: 'A', taskId: 'A:storage:ext:energy' } });
            Game.creeps.sk = creep;
            return { room, creep, empty };
        }

        it('let go at once when the source is empty', function () {
            const { room, creep } = taskRoom();
            LogisticsRunner.run(creep, new StoreKeeper(), { resourceType: RESOURCE_ENERGY });
            assert.equal(creep.memory.taskId, undefined);
            assert.equal(room.memory.logistics.tasks[0].assignedCreep, null);
            assert.ok(room.memory.logistics.tasks[0].retryAfter > Game.time, 'and it is not claimed again straight away');
        });

        it('lose a claim with no progress for too long', function () {
            const { room, creep } = taskRoom();
            Game.time = 1 + config.LOGISTICS.CLAIM_TIMEOUT;
            room.memory.logistics.tasks[0].lastProgress = 1;
            new LogisticsManager(room)._reconcileClaims();
            assert.equal(room.memory.logistics.tasks[0].assignedCreep, null);
            assert.equal(creep.memory.taskId, undefined);
        });

        it('keep a claim that is moving cargo', function () {
            const { room, creep } = taskRoom();
            Game.time = 1 + config.LOGISTICS.CLAIM_TIMEOUT;
            room.memory.logistics.tasks[0].lastProgress = Game.time - 1;
            new LogisticsManager(room)._reconcileClaims();
            assert.equal(room.memory.logistics.tasks[0].assignedCreep, 'sk');
            assert.equal(creep.memory.taskId, 'A:storage:ext:energy');
        });

        it('get the full timeout from when they took the task', function () {
            const { room, creep } = taskRoom();
            room.memory.logistics.tasks[0].assignedCreep = null;
            delete creep.memory.taskId;
            room.storage = room._find[FIND_STRUCTURES][0];
            room.storage.store.set(RESOURCE_ENERGY, 100);
            Game.time = 5000;
            LogisticsManager.assignTask(creep, { resourceType: RESOURCE_ENERGY });
            assert.equal(room.memory.logistics.tasks[0].lastProgress, 5000);
        });
    });

    describe('outsourced spawning', function () {
        it('sends a Miner to the source of the room it works for', function () {
            const home = baseRoom('W1N1', { energy: 0, capacity: 300 });
            home.memory.base.outsourceSpawn = true;
            const donor = baseRoom('W2N1', { energy: 1000, capacity: 1000 });
            const ownSource = { id: 'own', room: home, pos: makePosition(home, 10, 10), energy: 3000, energyCapacity: 3000 };
            const donorSource = { id: 'donor', room: donor, pos: makePosition(donor, 10, 10), energy: 3000, energyCapacity: 3000 };
            setFind(home, FIND_SOURCES, [ownSource]);
            setFind(donor, FIND_SOURCES, [donorSource]);
            addStructure(home, STRUCTURE_CONTAINER, 'c1', 11, 11, makeStore(2000));
            addStructure(donor, STRUCTURE_CONTAINER, 'c2', 11, 11, makeStore(2000));
            const spawn = makeSpawn(donor, { name: 'Donor', memory: { home: 'W2N1' } });
            Game.spawns.Donor = spawn;
            const miner = new Miner();
            MainCache.initRound([miner]);
            const creep = new BaseManager(home, [miner])._spawnCreepForRole(miner);
            assert.ok(creep);
            assert.equal(creep.memory.source, 'own');
            assert.equal(creep.memory.home, 'W1N1');
        });
    });

    describe('creeps of a lost base', function () {
        it('join the nearest base that remains and run again', function () {
            const near = baseRoom('W2N1');
            const far = baseRoom('W9N1');
            const creep = makeCreep(near, { name: 'orphan', pos: makePosition(near, 25, 25), memory: { role: 'Upgrader', home: 'GONE' } });
            Game.creeps.orphan = creep;
            assert.ok(far);
            MainCache.initRound([]);
            BaseManager._adoptOrphans();
            assert.equal(creep.memory.home, 'W2N1');
            assert.deepEqual(MainCache.getCreepsByHome('W2N1'), [creep]);
        });

        it('leave a creep whose base still exists alone', function () {
            const room = baseRoom('A');
            const creep = makeCreep(room, { name: 'c', memory: { role: 'Upgrader', home: 'A' } });
            Game.creeps.c = creep;
            MainCache.initRound([]);
            BaseManager._adoptOrphans();
            assert.equal(creep.memory.home, 'A');
        });

        it('wait if no base is left', function () {
            const room = makeRoom('W5N5', { controller: null });
            Game.rooms.W5N5 = room;
            const creep = makeCreep(room, { name: 'c', memory: { role: 'Upgrader', home: 'GONE' } });
            Game.creeps.c = creep;
            MainCache.initRound([]);
            BaseManager._adoptOrphans();
            assert.equal(creep.memory.home, 'GONE');
        });
    });

    describe('running out of CPU in a tick', function () {
        function roomWithCreeps(count) {
            const room = baseRoom('A');
            room.controller.pos = makePosition(room, 30, 30);
            for (let index = 0; index < count; index++) {
                Game.creeps['c' + index] = makeCreep(room, { name: 'c' + index, memory: { role: 'Upgrader', home: 'A' } });
            }
            return room;
        }

        it('stops running creeps before the tick would be thrown away', function () {
            const room = roomWithCreeps(3);
            let ran = 0;
            const upgrader = new Upgrader();
            upgrader.run = () => { ran++; used += 50; };
            let used = 0;
            Game.cpu = { bucket: 100, tickLimit: 100, getUsed: () => used };
            MainCache.initRound([upgrader]);
            new BaseManager(room, [upgrader])._moveCreeps();
            assert.equal(ran, 2, 'the third would pass the 90 CPU line');
        });

        it('takes rooms in turn, so the same one is not always last', function () {
            baseRoom('A');
            baseRoom('B');
            const order = [];
            const original = BaseManager.prototype.runBase;
            BaseManager.prototype.runBase = function () { order.push(this._room.name); };
            try {
                Game.time = 10;
                BaseManager.runAll([]);
                Game.time = 11;
                BaseManager.runAll([]);
            } finally {
                BaseManager.prototype.runBase = original;
            }
            assert.deepEqual(order, ['A', 'B', 'B', 'A']);
        });

        it('runs everyone when the game reports no limit', function () {
            const room = roomWithCreeps(3);
            let ran = 0;
            const upgrader = new Upgrader();
            upgrader.run = () => { ran++; };
            Game.cpu = { bucket: 9000, getUsed: () => 1000 };
            MainCache.initRound([upgrader]);
            new BaseManager(room, [upgrader])._moveCreeps();
            assert.equal(ran, 3);
        });
    });

    describe('telling the owner', function () {
        it('emails once about a problem that keeps happening', function () {
            MainInfo.notify('problem', 'something broke');
            MainInfo.notify('problem', 'something broke');
            assert.equal(Game.notifications.length, 1);
            Game.time += config.CPU.NOTIFY_INTERVAL;
            MainInfo.notify('problem', 'something broke');
            assert.equal(Game.notifications.length, 2);
        });

        it('keeps different problems apart', function () {
            MainInfo.notify('one', 'a');
            MainInfo.notify('two', 'b');
            assert.equal(Game.notifications.length, 2);
        });

        it('emails when spawning fails in a room', function () {
            const room = baseRoom('A');
            BaseManager._guard(room, 'spawn creeps', () => { throw new Error('broken'); });
            assert.ok(Game.notifications.some(message => /spawn creeps/.test(message) && /broken/.test(message)));
        });

        it('emails when a scheduled job keeps failing', function () {
            MainScheduler.run([{ name: 'Broken', run: () => { throw new Error('broken'); } }]);
            assert.ok(Game.notifications.some(message => /Broken/.test(message)));
        });

        it('emails when a room has no creeps and cannot spawn any', function () {
            const room = baseRoom('A', { energy: 0 });
            const manager = new BaseManager(room, []);
            manager._warnAboutRecovery();
            assert.ok(Game.notifications.some(message => /no creeps/.test(message)));
        });

        it('logs an error as its text rather than as an empty object', function () {
            const lines = [];
            const original = console.log;
            console.log = line => lines.push(line);
            const log = MainInfo.__originalLog;
            try {
                log.call(MainInfo, new Error('readable'));
            } finally {
                console.log = original;
            }
            assert.ok(lines.some(line => /readable/.test(line)));
        });
    });
});

describe('Remote mining accounting', function () {
    beforeEach(function () {
        resetScreeps();
        Memory.creeps = {};
    });

    function mission(extra = {}) {
        return Object.assign({
            id: 'm1', home: 'A', homeRoom: 'A', targetRoom: 'W2N2', status: 'active', sources: [{ id: 's', x: 10, y: 10 }],
            distance: 1, maxHaulers: 8, reserve: true, created: 1,
        }, extra);
    }

    it('records delivered energy in the tick of the transfer, when the store has not changed yet', function () {
        const room = baseRoom('A');
        const storage = addStructure(room, STRUCTURE_STORAGE, 'storage', 25, 25, makeStore(100000));
        room.storage = storage;
        const creep = makeCreep(room, {
            name: 'hauler', pos: makePosition(room, 25, 26), store: makeStore(400, { [RESOURCE_ENERGY]: 400 }),
            memory: { role: 'RemoteHauler', home: 'A', homeRoom: 'A', missionId: 'm1', working: true },
        });
        creep.transfer = () => OK; // the real engine only queues the transfer
        const recorded = [];
        const original = RemoteManager.recordEnergyDelivered;
        RemoteManager.recordEnergyDelivered = (id, amount) => recorded.push(amount);
        try {
            const role = new RemoteHauler();
            role._baseRoom = room;
            role._deliverHome(creep, [RESOURCE_ENERGY]);
        } finally {
            RemoteManager.recordEnergyDelivered = original;
        }
        assert.deepEqual(recorded, [400]);
    });

    it('records only what fits', function () {
        const room = baseRoom('A');
        const storage = addStructure(room, STRUCTURE_STORAGE, 'storage', 25, 25, makeStore(100, { [RESOURCE_ENERGY]: 40 }));
        room.storage = storage;
        const creep = makeCreep(room, {
            name: 'hauler', pos: makePosition(room, 25, 26), store: makeStore(400, { [RESOURCE_ENERGY]: 400 }),
            memory: { role: 'RemoteHauler', home: 'A', homeRoom: 'A', missionId: 'm1', working: true },
        });
        creep.transfer = () => OK;
        const recorded = [];
        const original = RemoteManager.recordEnergyDelivered;
        RemoteManager.recordEnergyDelivered = (id, amount) => recorded.push(amount);
        try {
            const role = new RemoteHauler();
            role._baseRoom = room;
            role._deliverHome(creep, [RESOURCE_ENERGY]);
        } finally {
            RemoteManager.recordEnergyDelivered = original;
        }
        assert.deepEqual(recorded, [60]);
    });

    it('times a route at the source, not at the room edge', function () {
        const remote = baseRoom('W2N2');
        setFind(remote, FIND_DROPPED_RESOURCES, []);
        setFind(remote, FIND_STRUCTURES, []);
        const recorded = [];
        const original = RemoteManager.recordHaulerArrival;
        RemoteManager.recordHaulerArrival = (id, ticks) => recorded.push(ticks);
        try {
            const role = new RemoteHauler();
            const creep = makeCreep(remote, {
                name: 'walker', pos: makePosition(remote, 0, 25), ticksToLive: CREEP_LIFE_TIME - 40,
                memory: { missionId: 'm1', targetRoom: 'W2N2', sourcePos: { roomName: 'W2N2', x: 25, y: 25 } },
            });
            role._collectRemote(creep);
            assert.deepEqual(recorded, [], 'still walking');
            creep.pos = makePosition(remote, 24, 25);
            creep.ticksToLive = CREEP_LIFE_TIME - 65;
            role._collectRemote(creep);
            assert.deepEqual(recorded, [65]);
        } finally {
            RemoteManager.recordHaulerArrival = original;
        }
    });

    it('keeps the fastest walk, since one blocked hauler says nothing about the route', function () {
        Memory.empire = undefined;
        const original = RemoteManager.getMission;
        const stored = mission();
        RemoteManager.getMission = () => stored;
        try {
            RemoteManager.recordHaulerArrival('m1', 80);
            RemoteManager.recordHaulerArrival('m1', 200);
            RemoteManager.recordHaulerArrival('m1', 60);
        } finally {
            RemoteManager.getMission = original;
        }
        assert.equal(stored.haulerTravelTicks, 60);
    });

    it('measures a route from a hauler on its first walk only', function () {
        const room = baseRoom('A');
        const recorded = [];
        const original = RemoteManager.recordHaulerArrival;
        RemoteManager.recordHaulerArrival = (id, ticks) => recorded.push(ticks);
        try {
            const role = new RemoteHauler();
            const fresh = makeCreep(room, { name: 'fresh', ticksToLive: CREEP_LIFE_TIME - 60, memory: { missionId: 'm1' } });
            role._recordArrival(fresh);
            role._recordArrival(fresh);
            const old = makeCreep(room, { name: 'old', ticksToLive: 200, memory: { missionId: 'm1', trips: 3 } });
            role._recordArrival(old);
        } finally {
            RemoteManager.recordHaulerArrival = original;
        }
        assert.deepEqual(recorded, [60]);
    });

    it('sends a defender big enough to matter, within what the room can pay for', function () {
        const small = RemoteManager.getDefenderBody('melee', { energyCapacityAvailable: 300 });
        assert.deepEqual(small, [ATTACK, MOVE, ATTACK, MOVE]);
        const large = RemoteManager.getDefenderBody('ranged', { energyCapacityAvailable: 5000 });
        assert.equal(large.filter(part => part === RANGED_ATTACK).length, config.REMOTE.DEFENDER_UNITS);
        assert.equal(large.filter(part => part === MOVE).length, config.REMOTE.DEFENDER_UNITS);
        assert.ok(RemoteManager.getDefenderBody('support', { energyCapacityAvailable: 100 }).length >= 2, 'never an empty body');
    });

    it('sizes a hauler for the route, so fewer are needed', function () {
        const home = { energyCapacityAvailable: 5000 };
        const near = RemoteManager.getHaulerBody(mission(), home, 8);
        assert.equal(near.filter(part => part === CARRY).length, 8);
        const far = RemoteManager.getHaulerBody(mission(), home, 100);
        assert.ok(far.length <= MAX_CREEP_SIZE);
        assert.equal(far.filter(part => part === CARRY).length, config.REMOTE.HAULER_PAIRS_MAX * 2);
    });

    it('stays within what the room can pay for', function () {
        const body = RemoteManager.getHaulerBody(mission(), { energyCapacityAvailable: 450 }, 100);
        assert.equal(body.filter(part => part === CARRY).length, 6);
    });

    it('lets a chosen hauler size win', function () {
        const body = RemoteManager.getHaulerBody(mission({ haulerPairs: 2 }), { energyCapacityAvailable: 5000 }, 100);
        assert.equal(body.filter(part => part === CARRY).length, 4);
    });

    it('times a route by a hauler once one has walked it, not by the slow Miner', function () {
        const slowMiner = RemoteManager.calculateRouteDemand(mission({ travelTicks: 300 }), { baseRoom: { energyCapacityAvailable: 5000 } });
        const measured = RemoteManager.calculateRouteDemand(mission({ travelTicks: 300, haulerTravelTicks: 60 }), { baseRoom: { energyCapacityAvailable: 5000 } });
        assert.ok(measured.roundTripTicks < slowMiner.roundTripTicks);
        assert.equal(measured.roundTripTicks, 60 * (1 + config.REMOTE.HAULER_TICKS_PER_TILE_LOADED) + 20);
    });
});
