const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeTerminal, makeFactory, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const FactoryManager = require('../manager.factory');
const TerminalManager = require('../manager.terminal');
const LogisticsManager = require('../manager.logistics');

function factoryRoom(name, options = {}) {
    const room = makeRoom(name, {
        memory: {
            base: { name, roleConfig: {} },
            logistics: { tasks: [] },
            terminal: {
                enabled: true,
                emergencyReserve: options.emergencyReserve || 0,
                batchSize: 1000,
                cooldown: 0,
                resources: {},
            },
            factory: options.config || { enabled: true, goals: {}, batchSize: 1000, planningInterval: 1 },
        },
    });
    room.controller = { my: true, level: 7, pos: makePosition(room, 30, 30), owner: { username: 'Me' } };
    const storage = makeStructure(room, STRUCTURE_STORAGE, {
        id: 'storage-' + name,
        pos: makePosition(room, 24, 25),
        store: makeStore(100000, options.storage || {}),
    });
    const terminal = makeTerminal(room, {
        pos: makePosition(room, 26, 25),
        store: makeStore(100000, options.terminal || {}),
    });
    const factory = makeFactory(room, {
        id: 'factory-' + name,
        pos: makePosition(room, 25, 25),
        level: options.level || 0,
        cooldown: options.cooldown || 0,
        store: makeStore(100000, options.factoryStore || {}),
        memory: options.factoryMemory,
    });
    room.storage = storage;
    Game.rooms[name] = room;
    [storage, terminal, factory].forEach(object => registerObject(object, name));
    setFind(room, FIND_STRUCTURES, [storage, terminal, factory]);
    setFind(room, FIND_MY_STRUCTURES, [storage, terminal, factory]);
    return { room, storage, terminal, factory };
}

describe('Factory production chain regressions', function () {
    beforeEach(function () {
        resetScreeps();
        Game.market.calcTransactionCost = () => 0;
    });

    it('does not produce without goals and waits for recipe level and cooldown eligibility', function () {
        const idle = factoryRoom('Idle', { factoryStore: { [RESOURCE_ENERGY]: 1000 } });
        FactoryManager.runAll();
        assert.equal(idle.factory.produced.length, 0);
        assert.equal(FactoryManager.getActiveGoal(idle.factory), null);

        const gated = factoryRoom('A', {
            level: 0,
            config: { enabled: true, goals: { [RESOURCE_OXIDANT]: 10 }, batchSize: 10, planningInterval: 1 },
            factoryStore: { [RESOURCE_COMPOSITE]: 20, [RESOURCE_ENERGY]: 100 },
        });
        Game.time = 2;
        FactoryManager.runAll();
        assert.equal(gated.factory.produced.length, 0);
        assert.equal(gated.factory.memory.activeGoal.resourceType, RESOURCE_OXIDANT);
        gated.factory.level = 2;
        FactoryManager.runAll();
        assert.equal(gated.factory.produced.length, 1);
        assert.equal(gated.factory.store.getUsedCapacity(RESOURCE_OXIDANT), 10);
        FactoryManager.runAll();
        assert.equal(gated.factory.produced.length, 1);
    });

    it('plans recursive dependencies, requests raw components once, and advances in order', function () {
        const { room, factory } = factoryRoom('A', {
            level: 2,
            config: { enabled: true, goals: { [RESOURCE_OXIDANT]: 10 }, batchSize: 10, planningInterval: 1 },
        });
        FactoryManager.runAll();
        FactoryManager.runAll();
        const goal = FactoryManager.getActiveGoal(factory);
        assert.equal(goal.resourceType, RESOURCE_OXIDANT);
        assert.deepEqual(goal.steps.map(step => step.resourceType), [RESOURCE_COMPOSITE, RESOURCE_OXIDANT]);
        assert.equal(factory.memory.activeRecipe, RESOURCE_COMPOSITE);
        const requests = TerminalManager.getResourceRequests({ targetRoom: room.name, status: 'open' });
        assert.equal(requests.length, 3);
        assert.equal(requests.filter(request => request.resourceType === RESOURCE_HYDROGEN)[0].remaining, 50);
        assert.equal(requests.filter(request => request.resourceType === RESOURCE_OXYGEN)[0].remaining, 50);
        assert.equal(requests.filter(request => request.resourceType === RESOURCE_ENERGY)[0].remaining, 100);

        factory.store.set(RESOURCE_HYDROGEN, 50);
        factory.store.set(RESOURCE_OXYGEN, 50);
        FactoryManager.runAll();
        assert.equal(factory.store.getUsedCapacity(RESOURCE_COMPOSITE), 20);
        assert.equal(factory.memory.activeRecipe, RESOURCE_OXIDANT);
        factory.cooldown = 0;
        factory.store.set(RESOURCE_ENERGY, 100);
        FactoryManager.runAll();
        assert.equal(factory.store.getUsedCapacity(RESOURCE_OXIDANT), 10);
        assert.equal(FactoryManager.getActiveGoal(factory), null);
        assert.ok(TerminalManager.getResourceRequests().every(request => request.status !== 'open'));
    });

    it('tracks partial batches and keeps the active root goal stable', function () {
        const { factory } = factoryRoom('A', {
            config: {
                enabled: true,
                goals: { [RESOURCE_COMPOSITE]: 45 },
                batchSize: 45,
                planningInterval: 1,
            },
            factoryStore: { [RESOURCE_HYDROGEN]: 150, [RESOURCE_OXYGEN]: 150, [RESOURCE_ENERGY]: 500 },
        });
        FactoryManager.runAll();
        assert.equal(factory.memory.activeGoal.target, 60);
        assert.equal(factory.memory.activeGoal.produced, 20);
        assert.equal(factory.memory.activeGoal.pending, 40);
        factory.room.memory.factory.batteryTarget = 100;
        factory.cooldown = 0;
        FactoryManager.runAll();
        assert.equal(factory.memory.activeGoal.resourceType, RESOURCE_COMPOSITE);
        assert.equal(factory.memory.activeGoal.pending, 20);
        factory.cooldown = 0;
        FactoryManager.runAll();
        assert.equal(factory.produced.length, 3);
        assert.equal(factory.store.getUsedCapacity(RESOURCE_COMPOSITE), 60);
        assert.equal(FactoryManager.getActiveGoal(factory), null);
        assert.equal(factory.memory.lastCompletedGoal.produced, 60);
        factory.cooldown = 0;
        FactoryManager.runAll();
        assert.equal(factory.produced.length, 3);
    });

    it('creates actual component supply and all configured output collection tasks', function () {
        const { room, factory } = factoryRoom('A', {
            storage: { [RESOURCE_HYDROGEN]: 100, [RESOURCE_OXYGEN]: 100 },
            config: { enabled: true, goals: { [RESOURCE_COMPOSITE]: 40 }, batchSize: 40, planningInterval: 1 },
            factoryStore: { [RESOURCE_HYDROGEN]: 100, [RESOURCE_OXYGEN]: 100, manualOut: 5 },
            factoryMemory: { outputResourceType: 'manualOut' },
        });
        FactoryManager.runAll();
        factory.store.set(RESOURCE_HYDROGEN, 25);
        factory.store.set(RESOURCE_OXYGEN, 25);
        new LogisticsManager(room).run();
        const tasks = room.memory.logistics.tasks;
        assert.ok(tasks.some(task => task.targetId === factory.id && task.resourceType === RESOURCE_HYDROGEN && task.factoryInput));
        assert.ok(tasks.some(task => task.targetId === factory.id && task.resourceType === RESOURCE_OXYGEN && task.factoryInput));
        assert.ok(tasks.some(task => task.sourceId === factory.id && task.resourceType === RESOURCE_COMPOSITE));
        assert.ok(tasks.some(task => task.sourceId === factory.id && task.resourceType === 'manualOut'));
        assert.ok(tasks.length <= LogisticsManager.TASK_CAP);
    });

    it('cancels stale goals and terminal reservations with explicit cleanup', function () {
        const { room, factory } = factoryRoom('A', {
            level: 2,
            config: { enabled: true, goals: { [RESOURCE_OXIDANT]: 10 }, batchSize: 10, planningInterval: 1 },
        });
        FactoryManager.runAll();
        assert.ok(TerminalManager.getResourceRequests({ status: 'open' }).length > 0);
        assert.equal(FactoryManager.cancelGoal(factory, 'test cancellation'), true);
        assert.equal(FactoryManager.getActiveGoal(factory), null);
        assert.deepEqual(factory.memory.inputResources, {});
        assert.ok(TerminalManager.getResourceRequests().every(request => request.status !== 'open'));
        room.memory.factory.enabled = false;
        FactoryManager.runAll();
        assert.equal(FactoryManager.getActiveGoal(factory), null);
    });

    it('never uses emergency-reserve energy for battery input or production', function () {
        const { room, storage, factory } = factoryRoom('A', {
            emergencyReserve: 1000,
            storage: { [RESOURCE_ENERGY]: 600 },
            terminal: { [RESOURCE_ENERGY]: 400 },
            config: { enabled: true, goals: {}, batteryTarget: 100, batchSize: 100, planningInterval: 1 },
        });
        FactoryManager.runAll();
        new LogisticsManager(room).run();
        assert.equal(factory.produced.length, 0);
        assert.ok(!room.memory.logistics.tasks.some(task => task.targetId === factory.id && task.resourceType === RESOURCE_ENERGY));
        const energyRequest = TerminalManager.getResourceRequests({ targetRoom: room.name, resourceType: RESOURCE_ENERGY })[0];
        assert.equal(energyRequest.remaining, 500);

        storage.store.set(RESOURCE_ENERGY, 1100);
        energyRequest.status = 'complete';
        Game.time = 2;
        FactoryManager.runAll();
        new LogisticsManager(room).run();
        const input = room.memory.logistics.tasks.find(task => task.targetId === factory.id && task.resourceType === RESOURCE_ENERGY);
        assert.equal(input.amount, 500);
        storage.store.set(RESOURCE_ENERGY, 600);
        factory.store.set(RESOURCE_ENERGY, 500);
        FactoryManager.runAll();
        assert.equal(factory.store.getUsedCapacity(RESOURCE_BATTERY), 100);
        assert.equal(TerminalManager.getTotalStock(room, RESOURCE_ENERGY), 1000);
    });

    it('bounds cyclic planning without activating an invalid goal', function () {
        global.COMMODITIES = {
            A: { amount: 1, cooldown: 1, components: { B: 1 } },
            B: { amount: 1, cooldown: 1, components: { A: 1 } },
        };
        const { room, factory } = factoryRoom('A', {
            config: { enabled: true, goals: { A: 1 }, batchSize: 1, planningInterval: 1 },
        });
        const plan = FactoryManager.planRecipe(room, factory, 'A', 1, { maxDepth: 4 });
        assert.ok(plan.invalid.some(error => error.startsWith('cycle:')));
        FactoryManager.runAll();
        assert.equal(FactoryManager.getActiveGoal(factory), null);
        assert.equal(factory.produced.length, 0);
    });

    it('guards missing recipe data without producing arbitrary commodities', function () {
        delete global.COMMODITIES;
        const { factory } = factoryRoom('A', {
            config: { enabled: true, goals: { [RESOURCE_COMPOSITE]: 20 }, batchSize: 20, planningInterval: 1 },
            factoryStore: { [RESOURCE_HYDROGEN]: 50, [RESOURCE_OXYGEN]: 50 },
        });
        assert.doesNotThrow(() => FactoryManager.runAll());
        assert.equal(FactoryManager.getActiveGoal(factory), null);
        assert.equal(factory.produced.length, 0);
    });

    it('completes a two-room chain without duplicate intermediate requests', function () {
        const target = factoryRoom('A', {
            level: 2,
            config: { enabled: true, goals: { [RESOURCE_OXIDANT]: 10 }, batchSize: 10, maxDepth: 0, planningInterval: 1 },
            factoryStore: { [RESOURCE_ENERGY]: 100 },
        });
        const source = factoryRoom('B', {
            config: { enabled: true, goals: { [RESOURCE_COMPOSITE]: 20 }, batchSize: 20, planningInterval: 1 },
            factoryStore: { [RESOURCE_HYDROGEN]: 50, [RESOURCE_OXYGEN]: 50 },
        });
        FactoryManager.runAll();
        FactoryManager.runAll();
        const intermediateRequests = TerminalManager.getResourceRequests({ targetRoom: 'A', resourceType: RESOURCE_COMPOSITE });
        assert.equal(intermediateRequests.length, 1);
        assert.equal(intermediateRequests[0].remaining, 20);
        assert.equal(source.factory.store.getUsedCapacity(RESOURCE_COMPOSITE), 20);

        source.factory.store.set(RESOURCE_COMPOSITE, 0);
        source.terminal.store.set(RESOURCE_COMPOSITE, 20);
        TerminalManager.runAll();
        assert.equal(source.terminal.sent.length, 1);
        assert.equal(target.terminal.store.getUsedCapacity(RESOURCE_COMPOSITE), 20);
        target.terminal.store.set(RESOURCE_COMPOSITE, 0);
        target.factory.store.set(RESOURCE_COMPOSITE, 20);
        FactoryManager.runAll();
        assert.equal(target.factory.store.getUsedCapacity(RESOURCE_OXIDANT), 10);
        assert.equal(TerminalManager.getResourceRequests({ targetRoom: 'A', resourceType: RESOURCE_COMPOSITE }).length, 1);
        assert.equal(source.terminal.sent.length, 1);
    });
});
