const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
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
});
