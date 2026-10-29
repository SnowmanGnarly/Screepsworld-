const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const MainCache = require('../main.cache');
const MemoryManager = require('../manager.memory');
const IntelManager = require('../manager.intel');
const RemoteManager = require('../manager.remote');
const DefenseManager = require('../manager.defense');
const BaseManager = require('../manager.base');
const Reserver = require('../role.reserver');
const RemoteMiner = require('../role.remoteMiner');
const RemoteHauler = require('../role.remoteHauler');
const Defender = require('../role.defender');

function baseRoom(name = 'A') {
    const room = makeRoom(name, {
        memory: {
            base: {
                name,
                remoteRooms: [],
                roleConfig: {
                    Harvester: { requiredNumber: 1 },
                    Upgrader: { requiredNumber: 1 },
                    Defender: { requiredNumber: 0 },
                    Storekeeper: { requiredNumber: 0 },
                    Courier: { requiredNumber: 0 },
                    showIcons: false,
                },
                showIcons: false,
            },
        },
        energyAvailable: 1800,
        energyCapacityAvailable: 1800,
    });
    room.controller = { my: true, level: 5, pos: makePosition(room, 30, 30), owner: { username: 'Me' } };
    const spawn = makeSpawn(room, { name: 'Spawn-' + name, memory: { home: name } });
    const storage = makeStructure(room, STRUCTURE_STORAGE, {
        id: 'storage-' + name,
        pos: makePosition(room, 24, 25),
        store: makeStore(10000),
    });
    room.storage = storage;
    Game.rooms[name] = room;
    Game.spawns[spawn.name] = spawn;
    setFind(room, FIND_MY_SPAWNS, [spawn]);
    setFind(room, FIND_MY_STRUCTURES, [spawn, storage]);
    setFind(room, FIND_STRUCTURES, [spawn, storage]);
    return { room, spawn, storage };
}

function remoteRoom(name = 'B') {
    const room = makeRoom(name, { controller: null });
    room.controller = { my: false, level: 0, pos: makePosition(room, 25, 25) };
    Game.rooms[name] = room;
    setFind(room, FIND_HOSTILE_CREEPS, []);
    setFind(room, FIND_HOSTILE_STRUCTURES, []);
    setFind(room, FIND_STRUCTURES, []);
    setFind(room, FIND_CONSTRUCTION_SITES, []);
    setFind(room, FIND_MY_CONSTRUCTION_SITES, []);
    return room;
}

function addSource(room, id = 'source-B', x = 20, y = 20) {
    const source = { id, room, pos: makePosition(room, x, y), energy: 3000, energyCapacity: 3000 };
    setFind(room, FIND_SOURCES, [source]);
    registerObject(source, room.name);
    return source;
}

function configuredMission(home, targetRoom, options = {}) {
    const mission = RemoteManager.configure(home.memory.base.name, targetRoom.name, Object.assign({
        homeRoom: home.name,
        reserve: false,
    }, options));
    mission.distanceValid = true;
    return mission;
}

function missionCreep(room, mission, role, options = {}) {
    return makeCreep(room, Object.assign({
        memory: {
            role,
            home: mission.home,
            missionId: mission.id,
            targetRoom: mission.targetRoom,
            homeRoom: mission.homeRoom,
        },
    }, options));
}

describe('Remote outpost and empire regressions', function () {
    beforeEach(function () {
        resetScreeps();
    });

    it('normalizes intel and bounds empire cleanup without dropping active offscreen state', function () {
        const { room } = baseRoom();
        const source = addSource(room, 'source-A');
        Memory.legacy = { keep: true };
        Memory.empire = {
            intel: { Old: { lastSeen: -5000 }, Off: { lastSeen: 1 } },
            missions: { active: { id: 'active', type: 'remote', targetRoom: 'Off', status: 'active' } },
            squads: {},
            custom: 'keep',
        };
        for (let index = 0; index < 130; index++) Memory.empire.intel['R' + index] = { lastSeen: 4000 };
        for (let index = 0; index < 60; index++) Memory.empire.missions['done-' + index] = { status: 'complete', created: index };
        for (let index = 0; index < 40; index++) Memory.empire.squads['squad-' + index] = { created: index };

        const observation = IntelManager.observeRoom(room);
        assert.equal(observation.sources[0].id, source.id);
        assert.equal(observation.sources[0].x, source.pos.x);
        assert.equal(observation.sources[0].pos, undefined);
        Game.time = 4000;
        MemoryManager._deleteUnusedMemory();

        assert.equal(Memory.empire.version, 1);
        assert.equal(Memory.empire.custom, 'keep');
        assert.equal(Memory.legacy.keep, true);
        assert.equal(Memory.empire.intel.Old, undefined);
        assert.equal(Memory.empire.intel.Off.stale, true);
        assert.ok(Object.keys(Memory.empire.intel).length <= IntelManager.MAX_INTEL_ROOMS);
        assert.ok(Object.keys(Memory.empire.missions).length <= IntelManager.MAX_MISSIONS);
        assert.ok(Object.keys(Memory.empire.squads).length <= IntelManager.MAX_SQUADS);
        assert.ok(Memory.empire.alliances);
    });

    it('requires explicit nearby rooms or flags and enforces default distance one', function () {
        const { room } = baseRoom();
        room.memory.base.remoteRooms = ['B', 'C'];
        Game.map.getRoomLinearDistance = (home, target) => ({ B: 1, C: 2, D: 1 }[target]);
        Game.flags.remote = { name: 'Remote:A:D', pos: makePosition(remoteRoom('D'), 25, 25), memory: {} };

        RemoteManager.runAll(false);

        const near = RemoteManager.getMission('remote:A:B');
        const far = RemoteManager.getMission('remote:A:C');
        const flagged = RemoteManager.getMission('remote:A:D');
        assert.equal(near.maxDistance, 1);
        assert.equal(near.distanceValid, true);
        assert.equal(far.distanceValid, false);
        assert.equal(flagged.distanceValid, true);
        assert.ok(RemoteManager.getSpawnRequests('A', room).every(request => request.memory.targetRoom !== 'C'));
    });

    it('reserves neutral controllers and rejects hostile owned or reserved controllers', function () {
        const { room: home } = baseRoom();
        const remote = remoteRoom();
        const mission = configuredMission(home, remote);
        const role = new Reserver();
        role._baseRoom = home;
        const neutral = missionCreep(remote, mission, 'Reserver', { pos: remote.controller.pos, body: [CLAIM, MOVE] });
        role._work(neutral);
        assert.equal(neutral.reserved, remote.controller);
        assert.equal(mission.status, 'active');

        remote.controller = { my: false, owner: { username: 'Enemy' }, pos: makePosition(remote, 25, 25) };
        const owned = missionCreep(remote, mission, 'Reserver', { pos: remote.controller.pos, body: [CLAIM, MOVE] });
        role._work(owned);
        assert.equal(owned.reserved, undefined);
        assert.equal(owned.memory.retiring, true);
        assert.equal(mission.status, 'blacklisted');

        mission.status = 'active';
        remote.controller = { my: false, reservation: { username: 'Enemy', ticksToEnd: 100 }, pos: makePosition(remote, 25, 25) };
        assert.equal(role.canReserveController(neutral, remote.controller), false);
    });

    it('travels offscreen using persisted room and coordinates', function () {
        const { room: home } = baseRoom();
        const mission = RemoteManager.configure('A', 'B', { homeRoom: 'A', reserve: false });
        const creep = missionCreep(home, mission, 'RemoteMiner', {
            memory: {
                role: 'RemoteMiner', home: 'A', missionId: mission.id, targetRoom: 'B', homeRoom: 'A',
                sourceId: 'offscreen-source', sourcePos: { roomName: 'B', x: 10, y: 11 },
            },
        });
        new RemoteMiner()._work(creep);
        assert.equal(creep.lastMoveTo.roomName, 'B');
        assert.equal(creep.lastMoveTo.x, 10);
        assert.equal(creep.lastMoveTo.y, 11);
    });

    it('mines into nearby containers and records travel and output', function () {
        const { room: home } = baseRoom();
        const remote = remoteRoom();
        const source = addSource(remote);
        const container = makeStructure(remote, STRUCTURE_CONTAINER, {
            id: 'container-B', pos: makePosition(remote, 20, 21), store: makeStore(1000),
        });
        setFind(remote, FIND_STRUCTURES, [container]);
        const mission = configuredMission(home, remote);
        const miner = missionCreep(remote, mission, 'RemoteMiner', {
            body: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE],
            pos: source.pos,
            store: makeStore(100),
            memory: {
                role: 'RemoteMiner', home: 'A', missionId: mission.id, targetRoom: 'B', homeRoom: 'A',
                sourceId: source.id, sourcePos: { roomName: 'B', x: 20, y: 20 },
            },
        });
        new RemoteMiner()._work(miner);
        assert.equal(source.energy, 2990);
        assert.equal(container.store.getUsedCapacity(RESOURCE_ENERGY), 10);
        assert.equal(mission.stats.energyHarvested, 10);
        assert.equal(miner.memory.ticksToSource, 1500);
        assert.equal(mission.travelTicks, 20);
    });

    it('builds remote sites and drops energy when no delivery container exists', function () {
        const { room: home } = baseRoom();
        const remote = remoteRoom();
        const source = addSource(remote);
        source.energy = 0;
        const site = { id: 'site', room: remote, structureType: STRUCTURE_CONTAINER, pos: makePosition(remote, 20, 21), progress: 0, progressTotal: 5000 };
        setFind(remote, FIND_CONSTRUCTION_SITES, [site]);
        const mission = configuredMission(home, remote);
        const miner = missionCreep(remote, mission, 'RemoteMiner', {
            body: [WORK, WORK, WORK, WORK, WORK, CARRY, MOVE], pos: source.pos, store: makeStore(100, { [RESOURCE_ENERGY]: 50 }),
            memory: {
                role: 'RemoteMiner', home: 'A', missionId: mission.id, targetRoom: 'B', homeRoom: 'A',
                sourceId: source.id, sourcePos: { roomName: 'B', x: 20, y: 20 },
            },
        });
        const role = new RemoteMiner();
        role._work(miner);
        assert.equal(site.progress, 25);
        setFind(remote, FIND_CONSTRUCTION_SITES, []);
        MainCache.invalidateRoom(remote);
        role._work(miner);
        assert.ok(remote.find(FIND_DROPPED_RESOURCES).some(drop => drop.resourceType === RESOURCE_ENERGY && drop.amount > 0));
    });

    it('withdraws remote energy, delivers it home, and recovers foreign cargo', function () {
        const { room: home, storage } = baseRoom();
        const remote = remoteRoom();
        const container = makeStructure(remote, STRUCTURE_CONTAINER, {
            id: 'container-B', pos: makePosition(remote, 20, 20), store: makeStore(1000, { [RESOURCE_ENERGY]: 200 }),
        });
        setFind(remote, FIND_STRUCTURES, [container]);
        const mission = configuredMission(home, remote);
        const hauler = missionCreep(remote, mission, 'RemoteHauler', {
            body: [CARRY, CARRY, MOVE], pos: container.pos, capacity: 200,
            memory: {
                role: 'RemoteHauler', home: 'A', missionId: mission.id, targetRoom: 'B', homeRoom: 'A',
                homePos: { roomName: 'A', x: 24, y: 25 }, sourcePos: { roomName: 'B', x: 20, y: 20 },
            },
        });
        const role = new RemoteHauler();
        role._baseRoom = home;
        role._work(hauler);
        assert.equal(hauler.store.getUsedCapacity(RESOURCE_ENERGY), 200);
        hauler.room = home;
        hauler.pos = storage.pos;
        role._work(hauler);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_ENERGY), 200);
        assert.equal(mission.stats.energyDelivered, 200);

        hauler.store.set(RESOURCE_OXYGEN, 25);
        role._work(hauler);
        assert.equal(hauler.store.getUsedCapacity(RESOURCE_OXYGEN), 0);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_OXYGEN), 25);
    });

    it('bounds route demand and ROI and suspends sustained losses with a cooldown', function () {
        const { room: home } = baseRoom();
        const remote = remoteRoom();
        const mission = configuredMission(home, remote, { maxHaulers: 2 });
        mission.sources = [{ id: 'one', x: 10, y: 10, output: 10 }, { id: 'two', x: 20, y: 20, output: 10 }];
        mission.travelTicks = 600;
        const demand = RemoteManager.calculateRouteDemand(mission, { baseRoom: home });
        assert.equal(demand.miners, 2);
        assert.equal(demand.haulers, 2);
        assert.equal(demand.roundTripTicks, 1220);
        assert.ok(demand.capacity > 0);

        Game.time = 2000;
        mission.stats.energySpent = 10000;
        mission.stats.energyDelivered = 0;
        RemoteManager._updateROI(mission, true);
        RemoteManager._updateROI(mission, true);
        assert.ok(Number.isFinite(mission.stats.roi));
        assert.equal(mission.status, 'suspended');
        assert.ok(mission.suspendedUntil >= 3000);
        mission.stats.energyDelivered = Infinity;
        assert.ok(Number.isFinite(RemoteManager.calculateROI(mission)));
        RemoteManager.recordEnergyDelivered(mission.id, Number.MAX_VALUE);
        assert.ok(mission.stats.energyDelivered <= RemoteManager.MAX_METRIC);
    });

    it('caps neutral container and road construction and reuses road heatmaps', function () {
        const { room: home } = baseRoom();
        const remote = remoteRoom();
        addSource(remote);
        remote.memory.roadManager = { threshold: 100, tiles: {}, lastTiles: { '10,10': 200, '11,11': 300 } };
        const mission = configuredMission(home, remote, { maxSites: 2 });
        mission.sources = [{ id: 'source-B', x: 20, y: 20, energyCapacity: 3000 }];
        Game.time = 100;
        RemoteManager._planConstruction(mission);
        Game.time = 130;
        RemoteManager._planConstruction(mission);

        assert.equal(remote.createdSites.length, 2);
        assert.equal(remote.createdSites.filter(site => site.structureType === STRUCTURE_CONTAINER).length, 1);
        assert.equal(remote.createdSites.filter(site => site.structureType === STRUCTURE_ROAD).length, 1);
        assert.equal(remote.controller.my, false);
    });

    it('assesses outpost Invader Cores without safe mode and keeps peaceful-home defenders on mission', function () {
        const { room: home } = baseRoom();
        const remote = remoteRoom();
        remote.controller.activateSafeMode = function () { this.activations = (this.activations || 0) + 1; return OK; };
        const core = makeStructure(remote, STRUCTURE_INVADER_CORE, { id: 'core-B', pos: makePosition(remote, 25, 25) });
        registerObject(core, remote.name);
        setFind(remote, FIND_HOSTILE_STRUCTURES, [core]);
        const mission = configuredMission(home, remote);

        DefenseManager.runAll();
        assert.equal(mission.defense.threatLevel, 2);
        assert.equal(mission.defense.desiredDefenders, 1);
        assert.equal(remote.controller.activations, undefined);
        assert.equal(DefenseManager.getPriorityTarget(remote), core);

        const defender = missionCreep(home, mission, 'Defender', {
            body: [ATTACK, MOVE], memory: {
                role: 'Defender', home: 'A', missionId: mission.id, targetRoom: 'B', homeRoom: 'A',
                homePos: { roomName: 'A', x: 25, y: 25 }, targetPos: { roomName: 'B', x: 25, y: 25 },
            },
        });
        const role = new Defender();
        role._work(defender);
        assert.equal(defender.memory.selfdestruct, undefined);
        assert.equal(defender.lastMoveTo.roomName, 'B');
        defender.room = remote;
        defender.pos = core.pos;
        role._work(defender);
        assert.equal(defender.attacked, core);

        mission.defense.threatLevel = 0;
        remote.memory.defense.threatLevel = 0;
        setFind(remote, FIND_HOSTILE_STRUCTURES, []);
        MainCache.invalidateRoom(remote);
        role._work(defender);
        assert.equal(defender.memory.selfdestruct, undefined);
        defender.room = home;
        defender.pos = makePosition(home, 25, 25);
        role._work(defender);
        assert.equal(defender.memory.selfdestruct, true);
    });

    it('spawns exact remote mission bodies with arbitrary memory through BaseManager', function () {
        const { room: home, spawn } = baseRoom();
        const harvester = makeCreep(home, { name: 'harvester', memory: { role: 'Harvester', home: 'A' } });
        const upgrader = makeCreep(home, { name: 'upgrader', memory: { role: 'Upgrader', home: 'A' } });
        Game.creeps = { harvester, upgrader };
        const mission = RemoteManager.configure('A', 'B', {
            homeRoom: 'A', reserve: true, creepMemory: { custom: { value: 7 } },
        });
        mission.distanceValid = true;
        mission.sources = [{ id: 'source-B', x: 20, y: 20, energyCapacity: 1500 }];
        mission.controller = { my: false, x: 25, y: 25, reservation: null };

        new BaseManager(home)._repopulateCreeps();
        assert.ok(spawn.spawning);
        assert.equal(spawn.spawning.memory.role, 'Reserver');
        assert.deepEqual(spawn.spawning.body, [CLAIM, CLAIM, MOVE, MOVE]);
        assert.deepEqual(spawn.spawning.memory.custom, { value: 7 });
        assert.equal(spawn.spawning.memory.home, 'A');
        assert.equal(mission.stats.energySpent, 1300);
        const roleNames = BaseManager.fetchAllRoles().map(role => role.roleName);
        for (const roleName of ['Scout', 'Reserver', 'RemoteMiner', 'RemoteHauler']) assert.ok(roleNames.includes(roleName));
    });
});
