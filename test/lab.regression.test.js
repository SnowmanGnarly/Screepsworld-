const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeLab, makeStructure, makeTerminal, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const LabManager = require('../manager.lab');
const TerminalManager = require('../manager.terminal');
const LogisticsManager = require('../manager.logistics');

const H = RESOURCE_HYDROGEN;
const O = RESOURCE_OXYGEN;
const U = RESOURCE_UTRIUM;
const X = RESOURCE_CATALYST;
const OH = RESOURCE_HYDROXIDE;
const UH = RESOURCE_UTRIUM_HYDRIDE;
const UH2O = RESOURCE_UTRIUM_ACID;
const XUH2O = RESOURCE_CATALYZED_UTRIUM_ACID;

const THREE_LAB_POSITIONS = [
    [24, 25], [25, 25], [24, 24],
];
const TEN_LAB_POSITIONS = [
    [24, 25], [25, 25],
    [23, 24], [24, 24], [25, 24], [26, 24],
    [23, 26], [24, 26], [25, 26], [26, 26],
];

function labRoom(name, options = {}) {
    const room = makeRoom(name, {
        memory: {
            base: { name, roleConfig: {} },
            logistics: options.logistics || { tasks: [] },
            terminal: options.terminalConfig || {
                enabled: true,
                emergencyReserve: 0,
                batchSize: 1000,
                cooldown: 0,
                resources: {},
            },
            lab: options.config || {
                enabled: true,
                goals: {},
                reserves: {},
                batchSize: 5,
                maxDepth: 6,
                planningInterval: 1,
                requestExpiry: 1000,
            },
        },
    });
    room.controller = { my: true, level: 8, pos: makePosition(room, 30, 30), owner: { username: 'Me' } };
    const storage = makeStructure(room, STRUCTURE_STORAGE, {
        id: 'storage-' + name,
        pos: makePosition(room, 24, 25),
        store: makeStore(100000, options.storage || {}),
    });
    const terminal = makeTerminal(room, {
        pos: makePosition(room, 26, 25),
        store: makeStore(100000, options.terminal || {}),
    });
    room.storage = storage;
    Game.rooms[name] = room;

    const positions = options.labCount === 10 ? TEN_LAB_POSITIONS : THREE_LAB_POSITIONS;
    let specs = options.labs || positions.map((position, index) => ({
        id: 'lab-' + String(index).padStart(2, '0'),
        x: position[0],
        y: position[1],
    }));
    if (options.reverseLabs) specs = specs.slice().reverse();
    const labs = specs.map((spec, index) => makeLab(room, {
        id: spec.id || 'lab-' + String(index).padStart(2, '0'),
        pos: makePosition(room, spec.x === undefined ? 25 : spec.x, spec.y === undefined ? 25 : spec.y),
        contents: spec.contents || {},
        memory: spec.memory,
        cooldown: spec.cooldown || 0,
    }));

    [storage, terminal, ...labs].forEach(object => registerObject(object, name));
    setFind(room, FIND_STRUCTURES, [storage, terminal, ...labs]);
    setFind(room, FIND_MY_STRUCTURES, [storage, terminal, ...labs]);
    setFind(room, FIND_HOSTILE_CREEPS, []);
    setFind(room, FIND_DROPPED_RESOURCES, []);
    setFind(room, FIND_TOMBSTONES, []);
    setFind(room, FIND_RUINS, []);
    return { room, storage, terminal, labs };
}

function runLabs(room) {
    new LabManager(room).run();
}

function reactionConfig(resourceType, target, overrides = {}) {
    return Object.assign({
        enabled: true,
        goals: { [resourceType]: target },
        reserves: {},
        batchSize: target,
        maxDepth: 6,
        planningInterval: 1,
        requestExpiry: 1000,
    }, overrides);
}

describe('Lab reaction and logistics regressions', function () {
    beforeEach(function () {
        resetScreeps();
        Game.market.calcTransactionCost = () => 0;
    });

    it('deterministically assigns and uses a valid three-lab topology', function () {
        const { room, labs } = labRoom('A', {
            config: reactionConfig(OH, 5),
            reverseLabs: true,
        });
        const inputA = Game.getObjectById('lab-00');
        const inputB = Game.getObjectById('lab-01');
        const output = Game.getObjectById('lab-02');
        inputA.store.set(H, 5);
        inputB.store.set(O, 5);

        runLabs(room);

        assert.deepEqual(room.memory.lab.assignments, {
            inputA: 'lab-00', inputB: 'lab-01', outputs: ['lab-02'],
        });
        assert.equal(output.reactions.length, 1);
        assert.deepEqual(output.reactions[0], {
            inputA: inputA.id, inputB: inputB.id, product: OH, amount: 5,
        });
        assert.equal(output.store.getUsedCapacity(OH), 5);
        assert.equal(inputA.store.getUsedCapacity(H), 0);
        assert.equal(inputB.store.getUsedCapacity(O), 0);
        assert.equal(labs.filter(lab => lab.reactions.length > 0).length, 1);
    });

    it('uses all eight outputs in a deterministic valid ten-lab topology', function () {
        const { room, labs } = labRoom('A', {
            config: reactionConfig(OH, 40),
            labCount: 10,
            reverseLabs: true,
        });
        Game.getObjectById('lab-00').store.set(H, 100);
        Game.getObjectById('lab-01').store.set(O, 100);

        runLabs(room);

        assert.deepEqual(room.memory.lab.assignments, {
            inputA: 'lab-00',
            inputB: 'lab-01',
            outputs: ['lab-02', 'lab-03', 'lab-04', 'lab-05', 'lab-06', 'lab-07', 'lab-08', 'lab-09'],
        });
        const outputs = room.memory.lab.assignments.outputs.map(id => Game.getObjectById(id));
        assert.ok(outputs.every(lab => lab.reactions.length === 1));
        assert.ok(outputs.every(lab => lab.store.getUsedCapacity(OH) === 5));
        assert.equal(labs.filter(lab => lab.reactions.length > 0).length, 8);
        assert.equal(room.memory.lab.lastCompletedGoal.produced, 40);
        assert.equal(Game.getObjectById('lab-00').store.getUsedCapacity(H), 60);
        assert.equal(Game.getObjectById('lab-01').store.getUsedCapacity(O), 60);
    });

    it('plans base, T1, T2, and T3 dependencies before their consumers', function () {
        const { room } = labRoom('A');

        const plan = LabManager.planRecipe(room, XUH2O, 5);

        assert.deepEqual(plan.steps.map(step => step.resourceType), [OH, UH, UH2O, XUH2O]);
        assert.deepEqual(plan.steps.map(step => step.amount), [5, 5, 5, 5]);
        assert.deepEqual(plan.steps.map(step => step.cooldown), [20, 10, 5, 60]);
        assert.deepEqual(plan.imports, { [H]: 10, [O]: 5, [U]: 5, [X]: 5 });
        assert.deepEqual(plan.invalid, []);
    });

    it('accounts for storage, terminal, lab stock, intermediate stock, and reserves', function () {
        const { room } = labRoom('A', {
            storage: { [H]: 4, [OH]: 5, [U]: 5 },
            terminal: { [H]: 4, [X]: 5 },
            labs: [{
                id: 'stock-lab', x: 24, y: 25, contents: { [H]: 2 },
            }],
            config: reactionConfig(XUH2O, 5, { reserves: { [H]: 6 } }),
        });

        const plan = LabManager.planRecipe(room, XUH2O, 5);

        assert.deepEqual(plan.steps.map(step => step.resourceType), [UH, UH2O, XUH2O]);
        assert.deepEqual(plan.imports, { [H]: 1 });
        assert.deepEqual(plan.invalid, []);
    });

    it('bounds recursive planning by depth and reports cycles', function () {
        const { room } = labRoom('A');

        const rootOnly = LabManager.planRecipe(room, XUH2O, 5, { maxDepth: 0 });
        assert.deepEqual(rootOnly.steps.map(step => step.resourceType), [XUH2O]);
        assert.deepEqual(rootOnly.imports, { [UH2O]: 5, [X]: 5 });

        const oneLevel = LabManager.planRecipe(room, XUH2O, 5, { maxDepth: 1 });
        assert.deepEqual(oneLevel.steps.map(step => step.resourceType), [UH2O, XUH2O]);
        assert.deepEqual(oneLevel.imports, { [OH]: 5, [UH]: 5, [X]: 5 });

        global.REACTIONS = {
            B: { C: 'A' },
            A: { C: 'B' },
        };
        const cyclic = LabManager.planRecipe(room, 'A', 5, { maxDepth: 10 });
        assert.ok(cyclic.invalid.some(error => error === 'cycle:A'));
    });

    it('creates deduplicated lab-prefixed terminal imports', function () {
        const { room } = labRoom('A', {
            config: reactionConfig(OH, 5, { maxDepth: 0 }),
        });

        runLabs(room);
        Game.time = 2;
        runLabs(room);

        const requests = TerminalManager.getResourceRequests({ targetRoom: room.name });
        const ownedIds = ['lab:A:' + H, 'lab:A:' + O].sort();
        assert.deepEqual(requests.map(request => request.id).sort(), ownedIds);
        assert.ok(requests.every(request => request.amount === 5 && request.remaining === 5));
        assert.ok(requests.every(request => request.status === 'open' && request.reason === 'lab:' + OH));
        assert.deepEqual(room.memory.lab.activeGoal.requestIds.slice().sort(), ownedIds);
    });

    it('reuses shared lab imports but cancels only owned requests on goal removal', function () {
        const { room } = labRoom('A', {
            config: reactionConfig(OH, 5, { maxDepth: 0 }),
        });
        const shared = TerminalManager.requestResource(room, H, 5, {
            id: 'lab:shared:' + H, reason: 'lab:another-goal', priority: 60,
        });

        runLabs(room);

        assert.equal(TerminalManager.getResourceRequests({ targetRoom: room.name }).length, 2);
        assert.deepEqual(room.memory.lab.activeGoal.sharedRequestIds, [shared.id]);
        assert.deepEqual(room.memory.lab.activeGoal.requestIds, ['lab:A:' + O]);

        room.memory.lab.goals = {};
        Game.time = 2;
        runLabs(room);

        assert.equal(room.memory.lab.activeGoal, null);
        assert.equal(room.memory.lab.lastCancelledGoal.reason, 'goal removed');
        assert.equal(TerminalManager.getResourceRequests().find(request => request.id === shared.id).status, 'open');
        assert.equal(TerminalManager.getResourceRequests().find(request => request.id === 'lab:A:' + O).status, 'cancelled');
    });

    it('cancels owned imports when the configured goal completes from room stock', function () {
        const { room, terminal } = labRoom('A', {
            config: reactionConfig(OH, 5, { maxDepth: 0 }),
        });
        runLabs(room);
        assert.equal(TerminalManager.getResourceRequests({ status: 'open' }).length, 2);

        terminal.store.set(OH, 5);
        Game.time = 2;
        runLabs(room);

        assert.equal(room.memory.lab.activeGoal, null);
        assert.equal(room.memory.lab.lastCompletedGoal.resourceType, OH);
        assert.ok(TerminalManager.getResourceRequests().every(request => request.id.indexOf('lab:') !== 0 || request.status !== 'open'));
    });

    it('projects input metadata and executes five-unit reactions with cooldown and completion', function () {
        const { room } = labRoom('A', {
            config: reactionConfig(OH, 10),
        });
        const inputA = Game.getObjectById('lab-00');
        const inputB = Game.getObjectById('lab-01');
        const output = Game.getObjectById('lab-02');

        runLabs(room);

        assert.equal(inputA.memory.labRole, 'inputA');
        assert.equal(inputA.memory.inputResourceType, H);
        assert.equal(inputA.memory.targetAmount, 10);
        assert.equal(inputB.memory.labRole, 'inputB');
        assert.equal(inputB.memory.inputResourceType, O);
        assert.equal(inputB.memory.targetAmount, 10);
        assert.equal(output.memory.labRole, 'output');
        assert.equal(output.memory.activeReaction, OH);
        assert.equal(output.memory.outputResourceType, OH);
        assert.equal(output.reactions.length, 0);

        inputA.store.set(H, 10);
        inputB.store.set(O, 10);
        Game.time = 2;
        runLabs(room);

        assert.equal(output.reactions.length, 1);
        assert.equal(output.reactions[0].amount, 5);
        assert.equal(output.store.getUsedCapacity(OH), 5);
        assert.equal(output.cooldown, 20);
        assert.equal(inputA.store.getUsedCapacity(H), 5);
        assert.equal(inputB.store.getUsedCapacity(O), 5);
        assert.equal(room.memory.lab.activeGoal.produced, 5);
        assert.equal(room.memory.lab.activeGoal.pending, 5);
        assert.equal(inputA.memory.targetAmount, 5);
        assert.equal(inputB.memory.targetAmount, 5);

        runLabs(room);
        assert.equal(output.reactions.length, 1);

        output.cooldown = 0;
        Game.time = 3;
        runLabs(room);

        assert.equal(output.reactions.length, 2);
        assert.ok(output.reactions.every(reaction => reaction.amount === 5));
        assert.equal(output.store.getUsedCapacity(OH), 10);
        assert.equal(inputA.store.getUsedCapacity(H), 0);
        assert.equal(inputB.store.getUsedCapacity(O), 0);
        assert.equal(room.memory.lab.activeGoal, null);
        assert.equal(room.memory.lab.lastCompletedGoal.produced, 10);
    });

    it('does not react unless the output has five units of free capacity', function () {
        const { room } = labRoom('A', {
            config: reactionConfig(OH, 3001, { batchSize: 5, maxDepth: 0 }),
        });
        const inputA = Game.getObjectById('lab-00');
        const inputB = Game.getObjectById('lab-01');
        const output = Game.getObjectById('lab-02');
        inputA.store.set(H, 5);
        inputB.store.set(O, 5);
        output.store.set(OH, 2996);

        runLabs(room);

        assert.equal(output.store.getFreeCapacity(OH), 4);
        assert.equal(output.reactions.length, 0);
        assert.equal(room.memory.lab.activeGoal.steps[0].produced, 0);
        assert.equal(inputA.store.getUsedCapacity(H), 5);
        assert.equal(inputB.store.getUsedCapacity(O), 5);

        output.store.set(OH, 2995);
        Game.time = 2;
        runLabs(room);

        assert.equal(output.reactions.length, 1);
        assert.equal(output.reactions[0].amount, 5);
        assert.equal(output.store.getUsedCapacity(OH), 3000);
        assert.equal(room.memory.lab.lastCompletedGoal.produced, 5);
    });

    it('advances sequential dependency steps only after draining the previous output', function () {
        const { room } = labRoom('A', {
            storage: { [H]: 10, [O]: 5, [U]: 5 },
            config: reactionConfig(UH2O, 5),
        });
        const inputA = Game.getObjectById('lab-00');
        const inputB = Game.getObjectById('lab-01');
        const output = Game.getObjectById('lab-02');

        runLabs(room);
        assert.deepEqual(room.memory.lab.activeGoal.steps.map(step => step.resourceType), [OH, UH, UH2O]);

        inputA.store.set(H, 5);
        inputB.store.set(O, 5);
        Game.time = 2;
        runLabs(room);
        assert.equal(room.memory.lab.activeGoal.stepIndex, 1);
        assert.equal(output.store.getUsedCapacity(OH), 5);
        assert.equal(output.memory.labRole, 'drain');
        assert.equal(output.memory.outputResourceType, OH);
        assert.equal(output.memory.activeReaction, null);

        output.store.set(OH, 0);
        output.cooldown = 0;
        inputA.store.set(U, 5);
        inputB.store.set(H, 5);
        Game.time = 3;
        runLabs(room);
        assert.equal(room.memory.lab.activeGoal.stepIndex, 2);
        assert.equal(output.store.getUsedCapacity(UH), 5);
        assert.equal(output.memory.labRole, 'drain');
        assert.equal(output.memory.outputResourceType, UH);

        output.store.set(UH, 0);
        output.cooldown = 0;
        inputA.store.set(OH, 5);
        inputB.store.set(UH, 5);
        Game.time = 4;
        runLabs(room);

        assert.deepEqual(output.reactions.map(reaction => reaction.product), [OH, UH, UH2O]);
        assert.ok(output.reactions.every(reaction => reaction.amount === 5));
        assert.equal(output.store.getUsedCapacity(UH2O), 5);
        assert.equal(room.memory.lab.activeGoal, null);
        assert.equal(room.memory.lab.lastCompletedGoal.produced, 5);
    });

    it('creates logistics for exact input deficits and actual output amounts', function () {
        const { room, storage } = labRoom('A', {
            storage: { [H]: 1000 },
            labs: [
                {
                    id: 'input-lab', x: 24, y: 25,
                    contents: { [H]: 30, [RESOURCE_ENERGY]: 2000 },
                    memory: { labManaged: true, labRole: 'inputA', inputResourceType: H, targetAmount: 100 },
                },
                {
                    id: 'output-lab', x: 25, y: 25,
                    contents: { [OH]: 25, [RESOURCE_ENERGY]: 2000 },
                    memory: { labManaged: true, labRole: 'output', outputResourceType: OH },
                },
            ],
        });

        new LogisticsManager(room).run();

        const tasks = room.memory.logistics.tasks;
        const input = tasks.find(task => task.targetId === 'input-lab' && task.resourceType === H);
        const output = tasks.find(task => task.sourceId === 'output-lab' && task.resourceType === OH);
        assert.ok(input);
        assert.equal(input.labInput, true);
        assert.equal(input.kind, LogisticsManager.KIND_SUPPLY);
        assert.equal(input.sourceId, storage.id);
        assert.equal(input.amount, 70);
        assert.equal(input.remaining, 70);
        assert.ok(output);
        assert.equal(output.kind, LogisticsManager.KIND_COLLECT);
        assert.equal(output.targetId, storage.id);
        assert.equal(output.amount, 25);
        assert.equal(output.remaining, 25);
        assert.equal(tasks.length, 2);
    });

    it('drains incompatible minerals before reassignment and never supplies a second mineral type', function () {
        const { room } = labRoom('A', {
            storage: { [H]: 100, [U]: 100 },
            config: reactionConfig(UH, 5),
            labs: [
                { id: 'lab-00', x: 24, y: 25, contents: { [RESOURCE_OXYGEN]: 5, [RESOURCE_ENERGY]: 2000 } },
                { id: 'lab-01', x: 25, y: 25, contents: { [RESOURCE_ENERGY]: 2000 } },
                { id: 'lab-02', x: 24, y: 24, contents: { [OH]: 5, [RESOURCE_ENERGY]: 2000 } },
            ],
        });
        const inputA = Game.getObjectById('lab-00');
        const output = Game.getObjectById('lab-02');

        runLabs(room);
        new LogisticsManager(room).run();

        assert.equal(inputA.memory.labRole, 'drain');
        assert.equal(inputA.memory.inputResourceType, null);
        assert.equal(inputA.memory.outputResourceType, RESOURCE_OXYGEN);
        assert.equal(output.memory.labRole, 'drain');
        assert.equal(output.memory.outputResourceType, OH);
        let tasks = room.memory.logistics.tasks;
        assert.ok(tasks.some(task => task.sourceId === inputA.id && task.resourceType === RESOURCE_OXYGEN && task.kind === LogisticsManager.KIND_COLLECT));
        assert.ok(tasks.some(task => task.sourceId === output.id && task.resourceType === OH && task.kind === LogisticsManager.KIND_COLLECT));
        assert.ok(!tasks.some(task => task.targetId === inputA.id && task.resourceType === U));
        assert.ok(!tasks.some(task => task.targetId === output.id && task.resourceType === UH));

        inputA.store.set(RESOURCE_OXYGEN, 0);
        output.store.set(OH, 0);
        Game.time = 2;
        runLabs(room);
        new LogisticsManager(room).run();

        tasks = room.memory.logistics.tasks;
        assert.equal(inputA.memory.labRole, 'inputA');
        assert.ok([H, U].includes(inputA.memory.inputResourceType));
        assert.equal(output.memory.labRole, 'output');
        assert.equal(output.memory.activeReaction, UH);
        const replacement = tasks.find(task => task.targetId === inputA.id && task.resourceType === inputA.memory.inputResourceType);
        assert.ok(replacement);
        assert.equal(replacement.amount, 5);
        assert.ok(!tasks.some(task => task.sourceId === inputA.id && task.resourceType === RESOURCE_OXYGEN));
        assert.ok(!tasks.some(task => task.sourceId === output.id && task.resourceType === OH));
    });

    it('keeps lab energy loading inside the terminal emergency reserve', function () {
        const { room, storage } = labRoom('A', {
            emergencyReserve: 1000,
            terminalConfig: {
                enabled: true, emergencyReserve: 1000, batchSize: 500, cooldown: 0, resources: {},
            },
            storage: { [RESOURCE_ENERGY]: 600 },
            terminal: { [RESOURCE_ENERGY]: 400 },
            labs: [{ id: 'energy-lab', x: 25, y: 25 }],
        });

        new LogisticsManager(room).run();
        assert.ok(!room.memory.logistics.tasks.some(task => task.targetId === 'energy-lab'));

        storage.store.set(RESOURCE_ENERGY, 1100);
        new LogisticsManager(room).run();

        const energy = room.memory.logistics.tasks.find(task => task.targetId === 'energy-lab' && task.resourceType === RESOURCE_ENERGY);
        assert.ok(energy);
        assert.equal(energy.labInput, true);
        assert.equal(energy.amount, 500);
        assert.equal(energy.remaining, 500);
    });

    it('keeps manually stocked boost labs out of the reaction topology', function () {
        const { room } = labRoom('A', {
            config: reactionConfig(OH, 5),
            labs: THREE_LAB_POSITIONS.map((position, index) => ({
                id: 'lab-' + String(index).padStart(2, '0'), x: position[0], y: position[1],
            })).concat([{
                id: 'stock-lab', x: 25, y: 24,
                contents: { [XUH2O]: 300, [RESOURCE_ENERGY]: 200 },
                memory: { inputResourceType: XUH2O, targetAmount: 3000 },
            }]),
        });
        const stockLab = Game.getObjectById('stock-lab');

        runLabs(room);

        assert.ok(room.memory.lab.assignments.inputA);
        assert.ok(![room.memory.lab.assignments.inputA, room.memory.lab.assignments.inputB]
            .concat(room.memory.lab.assignments.outputs).includes('stock-lab'));
        assert.ok(!stockLab.memory.labManaged);
        assert.equal(stockLab.memory.inputResourceType, XUH2O);
        assert.equal(stockLab.memory.targetAmount, 3000);
        assert.ok(!stockLab.memory.outputResourceType);
    });

    it('protects reservedBoostAmount from output collection', function () {
        const { room } = labRoom('A', {
            labs: [{
                id: 'reserved-lab', x: 25, y: 25,
                contents: { [OH]: 100, [RESOURCE_ENERGY]: 2000 },
                memory: { labManaged: true, labRole: 'output', outputResourceType: OH, reservedBoostAmount: 30 },
            }],
        });
        const lab = Game.getObjectById('reserved-lab');

        new LogisticsManager(room).run();

        assert.equal(LogisticsManager.getResourceAmount(lab, OH), 70);
        const collection = room.memory.logistics.tasks.find(task => task.sourceId === lab.id && task.resourceType === OH);
        assert.ok(collection);
        assert.equal(collection.amount, 70);
        assert.equal(collection.remaining, 70);

        lab.memory.reservedBoostAmount = 100;
        new LogisticsManager(room).run();
        assert.equal(LogisticsManager.getResourceAmount(lab, OH), 0);
        assert.ok(!room.memory.logistics.tasks.some(task => task.sourceId === lab.id && task.resourceType === OH));
    });

    it('preserves manual standing tasks when the logistics queue is capped', function () {
        const standingTasks = Array.from({ length: LogisticsManager.TASK_CAP }, (_, index) => ({
            id: 'manual-' + index,
            sourceId: 'manual-source-' + index,
            targetId: 'manual-target-' + index,
            sourceRoomName: 'Offscreen',
            targetRoomName: 'Offscreen',
            resourceType: H,
            kind: 'route',
            amount: 1,
            remaining: 1,
            priority: 80,
            standing: true,
            created: 1,
        }));
        const { room } = labRoom('A', {
            storage: { [H]: 100 },
            logistics: { tasks: standingTasks, overflow: 0 },
            labs: [{
                id: 'capped-lab', x: 25, y: 25,
                contents: { [RESOURCE_ENERGY]: 2000 },
                memory: { labManaged: true, labRole: 'inputA', inputResourceType: H, targetAmount: 5 },
            }],
        });

        new LogisticsManager(room).run();

        assert.equal(room.memory.logistics.tasks.length, LogisticsManager.TASK_CAP);
        assert.equal(room.memory.logistics.overflow, 1);
        assert.ok(room.memory.logistics.tasks.every(task => task.standing));
        assert.ok(!room.memory.logistics.tasks.some(task => task.targetId === 'capped-lab'));
    });
});
