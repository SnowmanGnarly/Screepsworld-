const assert = require('node:assert/strict');
const {
    makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps,
} = require('./helpers/screeps');
const CpuManager = require('../manager.cpu');
const MemoryManager = require('../manager.memory');
const MainInfo = require('../main.info');
const RolePrototype = require('../role.prototype');
const Miner = require('../role.miner');
const Harvester = require('../role.harvester');
const Upgrader = require('../role.upgrader');
const Builder = require('../role.builder');
const BaseManager = require('../manager.base');

function economyRoom() {
    const roleConfig = {
        Harvester: { requiredNumber: 1 },
        Upgrader: { requiredNumber: 1 },
        Builder: { requiredNumber: 1 },
        Miner: { requiredNumber: 0 },
        Defender: { requiredNumber: 0 },
        Storekeeper: { requiredNumber: 0 },
        Courier: { requiredNumber: 0 },
        showIcons: false,
    };
    const room = makeRoom('A', {
        memory: { base: { name: 'A', roleConfig, showIcons: false } },
        energyAvailable: 1000,
    });
    room.controller = { my: true, level: 4, pos: makePosition(room, 30, 30) };
    Game.rooms.A = room;
    return room;
}

function addSpawn(room, name = 'Spawn1') {
    const spawn = makeSpawn(room, { name });
    Game.spawns[name] = spawn;
    setFind(room, FIND_MY_SPAWNS, [spawn]);
    return spawn;
}

describe('Cross-cutting RAS regressions', function () {
    beforeEach(function () {
        resetScreeps();
    });

    it('uses hysteresis for deferrable work at low CPU bucket', function () {
        Game.cpu = { bucket: 999 };
        CpuManager.initRound();
        assert.equal(CpuManager.shouldRunDeferred(), false);
        Game.cpu.bucket = 1200;
        CpuManager.initRound();
        assert.equal(CpuManager.shouldRunDeferred(), false);
        Game.cpu.bucket = 1501;
        CpuManager.initRound();
        assert.equal(CpuManager.shouldRunDeferred(), true);
    });

    it('measures serialized memory without serializing it again', function () {
        let calls = 0;
        global.RawMemory = {
            get() {
                calls++;
                return 'x'.repeat(12345);
            },
        };
        Game.time = 100;
        MemoryManager._measureMemory();
        MemoryManager._measureMemory();
        assert.equal(MemoryManager.getMemorySize(), 12345);
        assert.equal(calls, 1);
    });

    it('stores room names instead of live Room objects in console history', function () {
        const room = economyRoom();
        MainInfo.log = MainInfo.__originalLog;
        MainInfo.clearLines();
        MainInfo.log('hello', room);
        assert.equal(MainInfo._lineRooms[0], room.name);
    });

    it('delivers a partial load when no further source is available', function () {
        const room = economyRoom();
        const role = new RolePrototype('Test');
        role._baseRoom = room;
        role._findSources = () => [];
        let targetCalls = 0;
        let sourceCalls = 0;
        role._moveToClosestTarget = () => targetCalls++;
        role._moveToClosestSource = () => sourceCalls++;
        const creep = makeCreep(room, {
            memory: { working: false },
            store: require('./helpers/screeps').makeStore(300, { [RESOURCE_ENERGY]: 50 }),
        });
        role._commuteBetweenSourceAndTarget(creep, () => {});
        assert.equal(targetCalls, 1);
        assert.equal(sourceCalls, 0);
        assert.equal(creep.memory.working, true);
    });

    it('handles a missing moveToGameObject without aborting role work', function () {
        const room = economyRoom();
        const role = new RolePrototype('Test');
        let workCalls = 0;
        role._work = () => workCalls++;
        const creep = makeCreep(room, {
            memory: { home: 'A', moveToGameObject: 'missing' },
        });
        creep.pos.isNearTo = () => { throw new Error('null target dereference'); };
        role.run(creep, room);
        assert.equal(workCalls, 1);
        assert.equal(creep.memory.moveToGameObject, null);
    });

    it('queues Miner replacement through BaseManager instead of spawning in the work loop', function () {
        const room = economyRoom();
        const spawn = addSpawn(room);
        const requester = makeCreep(room, {
            name: 'miner-old', body: new Array(7).fill(WORK), ticksToLive: 120,
            memory: {
                role: 'Miner', home: 'A', homeSpawn: spawn.name, source: 'source-1',
                initialTicksToLive: 1500, ticksToSource: 1400,
            },
        });
        const harvester = makeCreep(room, { name: 'harvester', memory: { role: 'Harvester', home: 'A' } });
        const upgrader = makeCreep(room, { name: 'upgrader', memory: { role: 'Upgrader', home: 'A' } });
        Game.creeps = { [requester.name]: requester, harvester, upgrader };
        const miner = new Miner();
        miner._commuteBetweenSourceAndTarget = () => {};
        miner._baseRoom = room;
        miner._work(requester);
        assert.ok(Memory.minerReplacements && Memory.minerReplacements[requester.name]);
        const manager = new BaseManager(room, [miner, new Harvester(), new Upgrader()]);
        manager._repopulateCreeps();
        assert.equal(spawn.spawning.memory.role, 'Miner');
        assert.equal(spawn.spawning.memory.source, 'source-1');
        assert.equal(requester.memory.trainedReplacement, true);
        assert.equal(Memory.minerReplacements[requester.name], undefined);
    });

    it('proactively replaces the last aging Harvester before optional roles', function () {
        const room = economyRoom();
        const spawn = addSpawn(room);
        const harvester = makeCreep(room, {
            name: 'old-harvester', ticksToLive: 50,
            memory: { role: 'Harvester', home: 'A' },
        });
        const upgrader = makeCreep(room, { name: 'upgrader', memory: { role: 'Upgrader', home: 'A' } });
        Game.creeps = { 'old-harvester': harvester, upgrader };
        setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ structureType: STRUCTURE_CONTAINER, progress: 0, progressTotal: 100 }]);
        const manager = new BaseManager(room, [new Builder(), new Harvester(), new Upgrader()]);
        manager._repopulateCreeps();
        assert.equal(spawn.spawning.memory.role, 'Harvester');
    });

    it('preserves a recovery reserve while only one active Harvester remains', function () {
        const room = economyRoom();
        room.energyAvailable = 400;
        room.energyCapacityAvailable = 1000;
        const spawn = addSpawn(room);
        const harvester = makeCreep(room, {
            name: 'harvester', ticksToLive: 1000,
            memory: { role: 'Harvester', home: 'A' },
        });
        const upgrader = makeCreep(room, { name: 'upgrader', memory: { role: 'Upgrader', home: 'A' } });
        Game.creeps = { harvester, upgrader };
        setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ structureType: STRUCTURE_CONTAINER, progress: 0, progressTotal: 100 }]);
        const manager = new BaseManager(room, [new Builder(), new Harvester(), new Upgrader()]);
        manager._repopulateCreeps();
        assert.equal(spawn.spawning, null);
    });
});
