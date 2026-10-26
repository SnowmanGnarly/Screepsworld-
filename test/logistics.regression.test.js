const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const LogisticsManager = require('../manager.logistics');
const Courier = require('../role.courier');
const Storekeeper = require('../role.storekeeper');

function baseRoom(name = 'A') {
    const room = makeRoom(name, {
        memory: {
            base: {
                name,
                roleConfig: {
                    Courier: { requiredNumber: 1 },
                    Storekeeper: { requiredNumber: 1 },
                },
            },
        },
    });
    Game.rooms[name] = room;
    return room;
}

describe('Logistics reliability regressions', function () {
    beforeEach(function () {
        resetScreeps();
    });

    it('keeps a WORK-capable legacy Courier body', function () {
        const room = baseRoom();
        const spawn = makeSpawn(room);
        room.energyAvailable = 1000;
        const courier = new Courier();
        const creep = courier.spawnCreep(spawn);
        assert.ok(creep.body.some(part => part === WORK || part.type === WORK));
    });

    it('imports the legacy route as an oxygen standing task', function () {
        const room = baseRoom();
        room.memory.source = 'legacy-source';
        room.memory.target = 'legacy-target';
        new LogisticsManager(room).run();
        const tasks = room.memory.logistics.tasks;
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].resourceType, RESOURCE_OXYGEN);
        assert.equal(tasks[0].sourceId, 'legacy-source');
        assert.equal(tasks[0].targetId, 'legacy-target');
        assert.equal(tasks[0].standing, true);
    });

    it('retains active tasks when endpoints are offscreen', function () {
        const room = baseRoom();
        const task = {
            id: 'standing', sourceId: 'offscreen-source', targetId: 'offscreen-target',
            sourceRoomName: 'Offscreen', targetRoomName: 'Offscreen',
            resourceType: RESOURCE_OXYGEN, amount: 100, remaining: 100,
            priority: 50, standing: true, assignedCreep: 'carrier', created: 1,
        };
        room.memory.logistics = { tasks: [task] };
        Game.creeps.carrier = makeCreep(room, { name: 'carrier', store: makeStore(300, { [RESOURCE_OXYGEN]: 20 }) });
        new LogisticsManager(room).run();
        assert.ok(room.memory.logistics.tasks.includes(task));
        assert.ok(task.remaining > 0);
    });

    it('reconciles a partial load without completing the remaining demand', function () {
        const room = baseRoom();
        const source = makeStructure(room, STRUCTURE_CONTAINER, {
            id: 'source', store: makeStore(1000, { [RESOURCE_ENERGY]: 200 }),
        });
        const target = makeStructure(room, STRUCTURE_SPAWN, {
            id: 'target', store: makeStore(1000),
        });
        registerObject(source, room.name);
        registerObject(target, room.name);
        setFind(room, FIND_STRUCTURES, [source]);
        setFind(room, FIND_MY_STRUCTURES, [target]);
        const task = {
            id: 'partial', sourceId: source.id, targetId: target.id,
            sourceRoomName: room.name, targetRoomName: room.name,
            resourceType: RESOURCE_ENERGY, amount: 500, remaining: 500,
            priority: 100, standing: true, assignedCreep: null, created: Game.time,
        };
        room.memory.logistics = { tasks: [task] };
        const creep = makeCreep(room, { name: 'carrier', capacity: 300, pos: source.pos });
        Game.creeps[creep.name] = creep;
        const courier = new Courier();
        const manager = new LogisticsManager(room);
        courier._work(creep);
        manager.run();
        courier._work(creep);
        manager.run();
        assert.equal(target.store.getUsedCapacity(RESOURCE_ENERGY), 200);
        assert.equal(room.memory.logistics.tasks[0].remaining, 300);
    });

    it('does not keep Storekeepers necessary without eligible work', function () {
        const room = baseRoom();
        assert.equal(new Storekeeper().isNecessary(room), false);
    });

    it('bounds the queue and uses stable IDs', function () {
        const room = baseRoom();
        const storage = makeStructure(room, STRUCTURE_STORAGE, {
            id: 'storage', store: makeStore(10000, { [RESOURCE_ENERGY]: 5000 }),
        });
        room.storage = storage;
        registerObject(storage, room.name);
        const drops = [];
        for (let index = 0; index < 150; index++) {
            const drop = {
                id: 'drop-' + index, resourceType: RESOURCE_ENERGY, amount: 100,
                pos: { getRangeTo: () => 1 },
            };
            drops.push(drop);
            registerObject(drop, room.name);
        }
        setFind(room, FIND_DROPPED_RESOURCES, drops);
        setFind(room, FIND_STRUCTURES, [storage]);
        setFind(room, FIND_MY_STRUCTURES, [storage]);
        new LogisticsManager(room).run();
        const tasks = room.memory.logistics.tasks;
        assert.ok(tasks.length <= 100);
        assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length);
        const ids = tasks.map(task => task.id);
        new LogisticsManager(room).run();
        assert.deepEqual(room.memory.logistics.tasks.map(task => task.id), ids);
    });
});
