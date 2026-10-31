const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeLab, makeStructure, makeTerminal, makeCreep, makeSpawn, makePosition,
    setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const LabManager = require('../manager.lab');
const LabMatrix = require('../lab.matrix');
const LogisticsManager = require('../manager.logistics');
const MainHeap = require('../main.heap');
const RolePrototype = require('../role.prototype');
const BaseManager = require('../manager.base');
const Courier = require('../role.courier');
const mainConfig = require('../main.config');

const config = mainConfig.LAB;
const PRIORITY = mainConfig.LOGISTICS.PRIORITY;
const XGH2O = RESOURCE_CATALYZED_GHODIUM_ACID;
const XKH2O = RESOURCE_CATALYZED_KEANIUM_ACID;
const OH = RESOURCE_HYDROXIDE;
const H = RESOURCE_HYDROGEN;
const O = RESOURCE_OXYGEN;
const FULL_ENERGY = { [RESOURCE_ENERGY]: 2000 };

const THREE_LABS = [{ x: 24, y: 25 }, { x: 25, y: 25 }, { x: 24, y: 24 }];
const requiredPolicy = { Upgrader: { work: XGH2O, required: true } };

function preloadRoom(options = {}) {
    const name = options.name || 'A';
    const room = makeRoom(name, {
        energyAvailable: 10000,
        memory: {
            base: { name, roleConfig: {} },
            logistics: { tasks: [] },
            terminal: { enabled: true, emergencyReserve: 0, batchSize: 1000, cooldown: 0, resources: {} },
            lab: Object.assign({
                enabled: true, goals: {}, reserves: {}, batchSize: 1000, maxDepth: 6, planningInterval: 1, requestExpiry: 1000,
                boosts: options.boosts || requiredPolicy,
            }, options.lab),
        },
    });
    room.controller = { my: true, level: 8, pos: makePosition(room, 30, 30), owner: { username: 'Me' } };
    const storage = makeStructure(room, STRUCTURE_STORAGE, {
        id: 'storage-' + name, pos: makePosition(room, 10, 25),
        store: makeStore(100000, options.storage === undefined ? { [XGH2O]: 3000, [RESOURCE_ENERGY]: 50000 } : options.storage),
    });
    const terminal = makeTerminal(room, { pos: makePosition(room, 12, 25), store: makeStore(100000, options.terminal || {}) });
    room.storage = storage;
    Game.rooms[name] = room;
    const labs = (options.labs || THREE_LABS).map((spec, index) => makeLab(room, {
        id: spec.id || name + '-lab-' + index,
        pos: makePosition(room, spec.x, spec.y),
        contents: spec.contents === undefined ? FULL_ENERGY : spec.contents,
        memory: spec.memory,
    }));
    [storage, terminal, ...labs].forEach(object => registerObject(object, name));
    setFind(room, FIND_MY_STRUCTURES, [storage, terminal, ...labs]);
    setFind(room, FIND_STRUCTURES, [storage, terminal, ...labs]);
    const spawn = makeSpawn(room, { name: 'Spawn-' + name, memory: { home: name } });
    Game.spawns[spawn.name] = spawn;
    return { room, storage, terminal, labs, spawn };
}

const tenWork = () => Array(10).fill(WORK).concat([MOVE]);
const lab = id => Game.getObjectById(id);
const memoryOf = target => Memory.structures[target.id];
const preloads = room => room.memory.lab.preloads || {};
const tick = () => { Game.time++; };

function ask(spawn, body = tenWork(), roleName = 'Upgrader', options = {}) {
    return LabManager.planSpawnBoost(spawn, body, roleName, {}, options);
}

function runLabs(room) {
    new LabManager(room).run();
}

function runAll(room) {
    runLabs(room);
    new LogisticsManager(room).run();
}

describe('Boost pre-loading', function () {
    beforeEach(function () {
        resetScreeps();
        MainHeap.reset();
        Game.market.calcTransactionCost = () => 0;
    });

    describe('the request', function () {
        it('queues a required compound held in storage and designates a lab', function () {
            const { room, spawn } = preloadRoom();

            const decision = ask(spawn);

            assert.equal(decision.allow, false);
            const entry = preloads(room)[XGH2O];
            assert.ok(lab(entry.labId));
            assert.equal(entry.amount, 10 * LAB_BOOST_MINERAL);
            assert.equal(entry.askedAt, Game.time);
        });

        it('finds the compound in the terminal as well', function () {
            const { room, spawn } = preloadRoom({ storage: {}, terminal: { [XGH2O]: 300 } });
            ask(spawn);
            assert.ok(preloads(room)[XGH2O]);
        });

        it('queues nothing when the stock cannot cover the whole body', function () {
            const { room, spawn } = preloadRoom({ storage: { [XGH2O]: 299 } });

            assert.equal(ask(spawn).allow, false);

            assert.deepEqual(preloads(room), {});
        });

        it('counts what the designated lab already holds towards the amount', function () {
            const { room, spawn } = preloadRoom({
                storage: { [XGH2O]: 200 },
                labs: [{ x: 24, y: 25, contents: { [XGH2O]: 100, [RESOURCE_ENERGY]: 2000 } }],
            });
            ask(spawn);
            assert.equal(preloads(room)[XGH2O].labId, 'A-lab-0');
        });

        it('leaves optional policies spawning unboosted', function () {
            const { room, spawn } = preloadRoom({ boosts: { Upgrader: { work: XGH2O, required: false } } });

            const decision = ask(spawn);

            assert.equal(decision.allow, true);
            assert.equal(decision.plan, null);
            assert.deepEqual(preloads(room), {});
        });

        it('never queues for an emergency spawn', function () {
            const { room, spawn } = preloadRoom();

            assert.equal(ask(spawn, tenWork(), 'Upgrader', { emergency: true }).allow, true);

            assert.deepEqual(preloads(room), {});
        });

        it('keeps one entry per compound across repeated attempts, sized for the largest body', function () {
            const { room, spawn } = preloadRoom();
            ask(spawn);
            const labId = preloads(room)[XGH2O].labId;
            tick();

            ask(spawn, Array(5).fill(WORK).concat([MOVE]));

            assert.equal(Object.keys(preloads(room)).length, 1);
            assert.equal(preloads(room)[XGH2O].labId, labId);
            assert.equal(preloads(room)[XGH2O].amount, 10 * LAB_BOOST_MINERAL);
            assert.equal(preloads(room)[XGH2O].askedAt, Game.time);
        });

        describe('with two roles sharing a compound', function () {
            const sharing = {
                Upgrader: { work: XGH2O, required: true },
                Builder: { work: XGH2O, carry: XKH2O, required: true },
            };

            it('keeps one role loading when the other can never be supplied', function () {
                const { room, spawn } = preloadRoom({ boosts: sharing, storage: { [XGH2O]: 3000, [RESOURCE_ENERGY]: 50000 } });
                for (let step = 0; step < 3; step++) {
                    tick();
                    runAll(room);
                    ask(spawn, [WORK, MOVE]);
                    ask(spawn, [WORK, CARRY, MOVE], 'Builder');
                }
                tick();
                runAll(room);

                const entry = preloads(room)[XGH2O];
                assert.ok(entry);
                assert.equal(memoryOf(lab(entry.labId)).inputResourceType, XGH2O);
                assert.ok(room.memory.logistics.tasks.some(task => task.targetId === entry.labId && task.resourceType === XGH2O));
                assert.equal(preloads(room)[XKH2O], undefined);
            });

            it('lets go once only the role that cannot be supplied is still asking', function () {
                const { room, spawn } = preloadRoom({ boosts: sharing, storage: { [XGH2O]: 3000, [RESOURCE_ENERGY]: 50000 } });
                ask(spawn, [WORK, MOVE]);
                for (let step = 0; step < 3; step++) {
                    Game.time += config.PRELOAD_TTL / 2;
                    ask(spawn, [WORK, CARRY, MOVE], 'Builder');
                    runLabs(room);
                }
                assert.deepEqual(preloads(room), {});
            });

            it('does not let a body too large for the stock remove a smaller one that fits', function () {
                const { room, spawn } = preloadRoom({ boosts: sharing, storage: { [XGH2O]: 60, [RESOURCE_ENERGY]: 50000 } });
                const huge = Array(10).fill(WORK).concat([MOVE]);

                ask(spawn, [WORK, MOVE]);
                ask(spawn, huge, 'Builder');

                assert.equal(preloads(room)[XGH2O].amount, LAB_BOOST_MINERAL);
            });

            it('loads enough for the larger body whichever role asks first', function () {
                const { room, spawn } = preloadRoom({ boosts: sharing, storage: { [XGH2O]: 3000, [XKH2O]: 3000 }, labs: [{ id: 'one', x: 24, y: 25 }, { id: 'two', x: 25, y: 25 }] });

                ask(spawn, Array(5).fill(WORK).concat([MOVE]));
                ask(spawn, Array(2).fill(WORK).concat([CARRY, MOVE]), 'Builder');

                assert.equal(preloads(room)[XGH2O].amount, 5 * LAB_BOOST_MINERAL);
            });

            it('drops an entry the stock can no longer cover, and the role that fits asks again', function () {
                const { room, spawn, storage } = preloadRoom({ boosts: sharing, storage: { [XGH2O]: 3000, [XKH2O]: 3000 }, labs: [{ id: 'one', x: 24, y: 25 }, { id: 'two', x: 25, y: 25 }] });
                ask(spawn, Array(10).fill(WORK).concat([MOVE]));
                assert.equal(preloads(room)[XGH2O].amount, 300);
                storage.store.set(XGH2O, 60);

                ask(spawn, [WORK, MOVE]);

                assert.equal(preloads(room)[XGH2O].amount, 30);
            });
        });

        it('leaves reaction planning asleep while a compound is only being loaded', function () {
            const { room, spawn } = preloadRoom();

            ask(spawn);

            assert.ok(preloads(room)[XGH2O]);
            assert.equal(LabMatrix.takeWake(room.name), false);
        });

        it('wakes reaction planning when it cannot queue because stock is short', function () {
            const { room, spawn } = preloadRoom({ storage: { [RESOURCE_CATALYST]: 3000, [RESOURCE_GHODIUM_ACID]: 3000 }, lab: { planningInterval: 1000 } });
            runLabs(room);
            tick();

            ask(spawn);
            runLabs(room);

            assert.equal(room.memory.lab.activeGoal.resourceType, XGH2O);
        });
    });

    describe('choosing a lab', function () {
        it('never takes a reaction input lab', function () {
            const { room, spawn } = preloadRoom();
            runLabs(room);
            const { inputA, inputB, outputs } = room.memory.lab.assignments;
            tick();

            ask(spawn);

            const chosen = preloads(room)[XGH2O].labId;
            assert.notEqual(chosen, inputA);
            assert.notEqual(chosen, inputB);
            assert.equal(chosen, outputs[0]);
        });

        it('prefers a lab already holding the compound, then an empty one nearest the hub, then one to drain', function () {
            const specs = {
                other: { id: 'other', x: 11, y: 25, contents: { [OH]: 50, [RESOURCE_ENERGY]: 2000 } },
                far: { id: 'far', x: 40, y: 25 },
                near: { id: 'near', x: 15, y: 25 },
                holding: { id: 'holding', x: 45, y: 25, contents: { [XGH2O]: 30, [RESOURCE_ENERGY]: 2000 } },
            };
            let setup = preloadRoom({ labs: [specs.other, specs.far, specs.near, specs.holding] });
            ask(setup.spawn);
            assert.equal(preloads(setup.room)[XGH2O].labId, 'holding');

            resetScreeps();
            MainHeap.reset();
            setup = preloadRoom({ labs: [specs.other, specs.far, specs.near] });
            ask(setup.spawn);
            assert.equal(preloads(setup.room)[XGH2O].labId, 'near');

            resetScreeps();
            MainHeap.reset();
            setup = preloadRoom({ labs: [specs.other] });
            ask(setup.spawn);
            assert.equal(preloads(setup.room)[XGH2O].labId, 'other');
        });

        it('gives each compound its own lab', function () {
            const { room, spawn } = preloadRoom({
                boosts: { Upgrader: { work: XGH2O, carry: XKH2O, required: true } },
                storage: { [XGH2O]: 3000, [XKH2O]: 3000 },
                labs: [{ id: 'one', x: 24, y: 25 }, { id: 'two', x: 25, y: 25 }],
            });

            ask(spawn, [WORK, CARRY, MOVE]);

            assert.notEqual(preloads(room)[XGH2O].labId, preloads(room)[XKH2O].labId);
        });

        it('leaves a manually stocked lab alone', function () {
            const { room, spawn } = preloadRoom({
                labs: [{ id: 'manual', x: 24, y: 25, memory: { inputResourceType: OH, targetAmount: 1000 } }],
            });

            assert.equal(ask(spawn).allow, false);

            assert.deepEqual(preloads(room), {});
            assert.equal(lab('manual').memory.inputResourceType, OH);
        });

        it('skips a lab reserved for a different compound', function () {
            const { room, spawn } = preloadRoom({
                labs: [{ id: 'busy', x: 24, y: 25, contents: { [XKH2O]: 30, [RESOURCE_ENERGY]: 2000 } }],
            });
            room.memory.lab.boostRequests = {
                waiting: { steps: [{ labId: 'busy', resourceType: XKH2O, count: 1, done: false }] },
            };

            ask(spawn);

            assert.deepEqual(preloads(room), {});
        });

        it('queues nothing for a body when too few labs are free, then recovers when one is built', function () {
            const { room, spawn, storage, terminal, labs } = preloadRoom({
                boosts: { Upgrader: { work: XGH2O, carry: XKH2O, required: true } },
                storage: { [XGH2O]: 3000, [XKH2O]: 3000 },
                labs: [{ id: 'only', x: 24, y: 25 }],
            });

            ask(spawn, [WORK, CARRY, MOVE]);
            assert.deepEqual(preloads(room), {});

            const built = makeLab(room, { id: 'built', pos: makePosition(room, 25, 25), contents: FULL_ENERGY });
            registerObject(built, 'A');
            setFind(room, FIND_MY_STRUCTURES, [storage, terminal, ...labs, built]);
            setFind(room, FIND_STRUCTURES, [storage, terminal, ...labs, built]);
            tick();

            ask(spawn, [WORK, CARRY, MOVE]);
            assert.equal(Object.keys(preloads(room)).length, 2);
        });

        it('queues nothing for a body when one of its compounds is short', function () {
            const { room, spawn } = preloadRoom({
                boosts: { Upgrader: { work: XGH2O, carry: XKH2O, required: true } },
                storage: { [XGH2O]: 3000 },
                labs: [{ id: 'one', x: 24, y: 25 }, { id: 'two', x: 25, y: 25 }],
            });

            ask(spawn, [WORK, CARRY, MOVE]);

            assert.deepEqual(preloads(room), {});
        });

        it('does not hand a new compound the lab of a compound already queued for the same body', function () {
            const { room, spawn } = preloadRoom({
                boosts: {
                    Builder: { carry: XKH2O, required: true },
                    Upgrader: { work: XGH2O, carry: XKH2O, required: true },
                },
                storage: { [XGH2O]: 3000, [XKH2O]: 3000 },
                labs: [{ id: 'near', x: 15, y: 25 }, { id: 'far', x: 40, y: 25 }],
            });
            ask(spawn, [CARRY, MOVE], 'Builder');
            assert.equal(preloads(room)[XKH2O].labId, 'near');

            ask(spawn, [WORK, CARRY, MOVE]);

            assert.equal(preloads(room)[XKH2O].labId, 'near');
            assert.equal(preloads(room)[XGH2O].labId, 'far');
        });

        it('does not give a lab held for one body to a different compound', function () {
            const { room, spawn } = preloadRoom({
                boosts: {
                    Upgrader: { work: XGH2O, required: true },
                    Builder: { carry: XKH2O, required: true },
                },
                storage: { [XGH2O]: 3000, [XKH2O]: 3000 },
                labs: [{ id: 'only', x: 24, y: 25 }],
            });
            ask(spawn, [WORK, MOVE]);
            assert.equal(preloads(room)[XGH2O].labId, 'only');

            ask(spawn, [CARRY, MOVE], 'Builder');

            assert.equal(preloads(room)[XKH2O], undefined);
            assert.equal(preloads(room)[XGH2O].labId, 'only');
        });
    });

    describe('the logistics', function () {
        it('hands the lab to logistics as a prioritised exact-amount supply task', function () {
            const { room, spawn, storage } = preloadRoom();
            ask(spawn);
            const target = lab(preloads(room)[XGH2O].labId);
            tick();

            runAll(room);

            assert.equal(memoryOf(target).labRole, 'boost');
            assert.equal(memoryOf(target).labManaged, true);
            assert.equal(memoryOf(target).inputResourceType, XGH2O);
            assert.equal(memoryOf(target).targetAmount, 300);
            const task = room.memory.logistics.tasks.find(candidate => candidate.targetId === target.id && candidate.resourceType === XGH2O);
            assert.ok(task);
            assert.equal(task.sourceId, storage.id);
            assert.equal(task.remaining, 300);
            assert.equal(task.labInput, true);
            assert.equal(task.priority, PRIORITY.LAB_BOOST);
        });

        it('ranks pre-loading above ordinary lab work and below defence', function () {
            assert.ok(PRIORITY.LAB_BOOST > PRIORITY.LAB_INPUT);
            assert.ok(PRIORITY.LAB_BOOST > PRIORITY.LAB_OUTPUT);
            assert.ok(PRIORITY.LAB_BOOST < PRIORITY.TOWER_UNDER_ATTACK);
            assert.ok(PRIORITY.LAB_BOOST < PRIORITY.CORE);
        });

        it('loads energy at the same priority so the compound does not wait on it', function () {
            const { room, spawn } = preloadRoom({ labs: [{ id: 'dry', x: 24, y: 25, contents: {} }] });
            ask(spawn);
            tick();

            runAll(room);

            const energy = room.memory.logistics.tasks.find(task => task.targetId === 'dry' && task.resourceType === RESOURCE_ENERGY);
            assert.ok(energy);
            assert.equal(energy.priority, PRIORITY.LAB_BOOST);
        });

        it('makes the room want a Courier, the only role that carries compounds', function () {
            const { room, spawn } = preloadRoom();
            ask(spawn);
            tick();

            runAll(room);

            const courier = new Courier();
            assert.equal(courier.isNecessary(room), true);
            assert.ok(courier.getDemand(room) >= 1);
        });

        it('drains another mineral first and never mixes', function () {
            const { room, spawn } = preloadRoom({
                labs: [{ id: 'dirty', x: 24, y: 25, contents: { [OH]: 50, [RESOURCE_ENERGY]: 2000 } }],
            });
            ask(spawn);
            tick();
            runAll(room);

            let tasks = room.memory.logistics.tasks;
            assert.ok(tasks.some(task => task.sourceId === 'dirty' && task.resourceType === OH && task.kind === LogisticsManager.KIND_COLLECT));
            assert.ok(!tasks.some(task => task.targetId === 'dirty' && task.resourceType === XGH2O));
            assert.equal(lab('dirty').memory.reservedBoostAmount, 0);

            lab('dirty').store.set(OH, 0);
            tick();
            runAll(room);

            tasks = room.memory.logistics.tasks;
            assert.ok(tasks.some(task => task.targetId === 'dirty' && task.resourceType === XGH2O));
        });

        it('protects loaded compound from collection while the spawn is pending', function () {
            const { room, spawn } = preloadRoom();
            ask(spawn);
            const target = lab(preloads(room)[XGH2O].labId);
            target.store.set(XGH2O, 300);
            tick();

            runAll(room);

            assert.equal(memoryOf(target).reservedBoostAmount, 300);
            assert.ok(!room.memory.logistics.tasks.some(task => task.sourceId === target.id && task.resourceType === XGH2O));
        });

        it('keeps reactions off a designated output lab', function () {
            const { room, spawn } = preloadRoom({
                lab: { goals: { [OH]: 500 } },
                storage: { [XGH2O]: 3000, [H]: 3000, [O]: 3000 },
                labs: [
                    { id: 'in-a', x: 24, y: 25, contents: { [H]: 100, [RESOURCE_ENERGY]: 2000 } },
                    { id: 'in-b', x: 25, y: 25, contents: { [O]: 100, [RESOURCE_ENERGY]: 2000 } },
                    { id: 'out', x: 24, y: 24 },
                ],
            });
            runLabs(room);
            assert.equal(preloads(room)[XGH2O], undefined);
            tick();
            lab('out').cooldown = 0;
            lab('out').store.set(OH, 0);
            lab('out').reactions.length = 0;

            ask(spawn);
            assert.equal(preloads(room)[XGH2O].labId, 'out');
            tick();
            runLabs(room);

            assert.equal(lab('out').reactions.length, 0);
            assert.equal(memoryOf(lab('out')).labRole, 'boost');
        });
    });

    describe('the unblock', function () {
        it('spawns once the lab is stocked and hands the entry to the boost request', function () {
            const { room, spawn } = preloadRoom();
            const role = new RolePrototype('Upgrader');
            assert.equal(role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' }), false);
            const target = lab(preloads(room)[XGH2O].labId);
            target.store.set(XGH2O, 300);
            tick();
            runLabs(room);

            const creep = role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' });

            assert.ok(creep);
            assert.deepEqual(preloads(room), {});
            assert.deepEqual(room.memory.lab.boostRequests[creep.name].steps.map(step => [step.labId, step.count]), [[target.id, 10]]);
        });

        it('does not spawn on a part-loaded lab', function () {
            const { room, spawn } = preloadRoom();
            const role = new RolePrototype('Upgrader');
            role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' });
            lab(preloads(room)[XGH2O].labId).store.set(XGH2O, 270);
            tick();

            assert.equal(role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' }), false);
            assert.ok(preloads(room)[XGH2O]);
        });

        it('waits for every compound on a body with more than one', function () {
            const { room, spawn } = preloadRoom({
                boosts: { Upgrader: { work: XGH2O, carry: XKH2O, required: true } },
                storage: { [XGH2O]: 3000, [XKH2O]: 3000 },
                labs: [{ id: 'one', x: 24, y: 25 }, { id: 'two', x: 25, y: 25 }],
            });
            const body = [WORK, CARRY, MOVE];
            ask(spawn, body);
            lab(preloads(room)[XGH2O].labId).store.set(XGH2O, 30);
            tick();
            runLabs(room);

            assert.equal(ask(spawn, body).allow, false);
            assert.ok(preloads(room)[XGH2O], 'the finished compound stays protected while the other loads');

            lab(preloads(room)[XKH2O].labId).store.set(XKH2O, 30);
            tick();
            runLabs(room);

            const decision = ask(spawn, body);
            assert.equal(decision.allow, true);
            assert.equal(decision.plan.steps.length, 2);
        });

        it('loads for a second creep on top of what the first has reserved', function () {
            const { room, spawn } = preloadRoom();
            const role = new RolePrototype('Upgrader');
            role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' });
            const target = lab(preloads(room)[XGH2O].labId);
            target.store.set(XGH2O, 300);
            tick();
            const first = role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' });
            assert.ok(first);
            first.memory.labBoost = { room: 'A' };

            const second = makeSpawn(room, { name: 'Second', memory: { home: 'A' } });
            assert.equal(ask(second).allow, false);
            assert.equal(preloads(room)[XGH2O].labId, target.id);
            tick();
            runAll(room);

            assert.equal(memoryOf(target).targetAmount, 600);
            assert.equal(memoryOf(target).reservedBoostAmount, 300 + 300);
        });
    });

    describe('letting go', function () {
        it('releases the lab when nothing has asked for a while, and the compound goes back', function () {
            const { room, spawn } = preloadRoom();
            ask(spawn);
            const target = lab(preloads(room)[XGH2O].labId);
            target.store.set(XGH2O, 300);
            tick();
            runLabs(room);
            Game.time += config.PRELOAD_TTL + 1;

            runAll(room);

            assert.deepEqual(preloads(room), {});
            assert.equal(memoryOf(target).labRole, 'drain');
            assert.equal(memoryOf(target).reservedBoostAmount, 0);
            assert.ok(room.memory.logistics.tasks.some(task => task.sourceId === target.id && task.resourceType === XGH2O));
        });

        it('keeps the entry while spawn attempts keep arriving', function () {
            const { room, spawn } = preloadRoom();
            for (let step = 0; step < 5; step++) {
                ask(spawn);
                Game.time += config.PRELOAD_TTL - 1;
                runLabs(room);
            }
            assert.ok(preloads(room)[XGH2O]);
        });

        it('drops the entry when the hub stock can no longer cover it', function () {
            const { room, spawn, storage } = preloadRoom();
            ask(spawn);
            tick();
            storage.store.set(XGH2O, 100);

            ask(spawn);

            assert.deepEqual(preloads(room), {});
        });

        it('drains a delivery that arrives after the lab was released, instead of stranding it', function () {
            const { room, spawn, storage } = preloadRoom({ labs: [{ id: 'spare', x: 40, y: 40 }] });
            const courier = new Courier();
            courier._moveToLocation = () => {};
            const hauler = makeCreep(room, { name: 'hauler', capacity: 100, pos: storage.pos, memory: { role: 'Courier', home: 'A' } });
            hauler.spawning = false;
            Game.creeps.hauler = hauler;
            ask(spawn);
            tick();
            runAll(room);
            courier._work(hauler);
            assert.ok(hauler.store.getUsedCapacity(XGH2O) > 0);

            // the entry expires while the hauler is still on its way
            room.memory.lab.preloads = {};
            tick();
            runAll(room);
            assert.equal(memoryOf(lab('spare')).labManaged, true, 'the lab stays managed while cargo is inbound');

            hauler.store.set(XGH2O, 0);
            hauler.memory.taskId = null;
            room.memory.logistics.tasks = [];
            lab('spare').store.set(XGH2O, 100);
            tick();
            runAll(room);

            assert.equal(memoryOf(lab('spare')).labRole, 'drain');
            assert.ok(room.memory.logistics.tasks.some(task => task.sourceId === 'spare' && task.resourceType === XGH2O));
        });

        it('forgets an entry whose lab was destroyed', function () {
            const { room, spawn, storage, terminal } = preloadRoom();
            ask(spawn);
            setFind(room, FIND_MY_STRUCTURES, [storage, terminal]);
            setFind(room, FIND_STRUCTURES, [storage, terminal]);
            tick();

            runLabs(room);

            assert.deepEqual(preloads(room), {});
        });

        it('forgets every entry when the lab manager is disabled', function () {
            const { room, spawn } = preloadRoom();
            ask(spawn);
            room.memory.lab.enabled = false;
            tick();

            runLabs(room);

            assert.deepEqual(preloads(room), {});
        });

        it('normalizes memory saved before the queue existed', function () {
            const { room, spawn } = preloadRoom();
            delete room.memory.lab.preloads;
            ask(spawn);
            assert.ok(preloads(room)[XGH2O]);
            room.memory.lab.preloads = 'corrupt';
            assert.deepEqual(LabManager.getConfig(room).preloads, {});
        });

        it('costs nothing per tick for a room with no queue', function () {
            const { room } = preloadRoom();
            runLabs(room);
            const before = JSON.stringify(room.memory.lab.preloads);
            for (let step = 0; step < 20; step++) {
                tick();
                runLabs(room);
            }
            assert.equal(JSON.stringify(room.memory.lab.preloads), before);
        });
    });

    it('lets the rest of the spawn queue carry on while a required body loads', function () {
        const { room } = preloadRoom();
        const makeRole = (name, priority) => {
            const role = new RolePrototype(name);
            role.priority = priority;
            role.alwaysDerived = true;
            role.getDemand = () => 1;
            role.defaultMaxNumber = 1;
            role.isNecessary = () => true;
            role.spawnCreep = (target, options) => role._spawnCreepWithBody(target, name === 'Upgrader' ? tenWork() : [CARRY, MOVE], { role: name, home: 'A' }, options);
            return role;
        };
        const upgrader = makeRole('Upgrader', 90);
        const hauler = makeRole('Storekeeper', 10);
        const base = new BaseManager(room, [upgrader, hauler]);

        const spawned = base._runSpawnQueue('A', false);

        assert.equal(spawned, true);
        assert.ok(preloads(room)[XGH2O], 'the blocked role still queued its compound');
        assert.deepEqual(Object.values(Game.creeps).map(creep => creep.memory.role), ['Storekeeper']);
    });

    it('does not lose its entry while a Courier is carrying the last of the stock', function () {
        const { room, storage, spawn } = preloadRoom({ storage: { [XGH2O]: 300, [RESOURCE_ENERGY]: 50000 } });
        const role = new RolePrototype('Upgrader');
        const courier = new Courier();
        courier._moveToLocation = () => {};
        const hauler = makeCreep(room, { name: 'hauler', capacity: 100, pos: storage.pos, memory: { role: 'Courier', home: 'A' } });
        hauler.spawning = false;
        Game.creeps.hauler = hauler;
        role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' });
        const entry = preloads(room)[XGH2O];
        tick();
        runAll(room);
        courier._work(hauler);
        assert.equal(hauler.store.getUsedCapacity(XGH2O) > 0 ? storage.store.getUsedCapacity(XGH2O) < 300 : false, true, 'the cargo has left the hub');

        tick();
        assert.equal(role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' }), false);

        assert.equal(preloads(room)[XGH2O].labId, entry.labId);
    });

    it('still completes when the stock is exactly one body', function () {
        const { room, storage, spawn } = preloadRoom({ storage: { [XGH2O]: 300, [RESOURCE_ENERGY]: 50000 } });
        const role = new RolePrototype('Upgrader');
        const courier = new Courier();
        courier._moveToLocation = (worker, target) => { worker.pos = target.pos; };
        const hauler = makeCreep(room, { name: 'hauler', capacity: 100, pos: storage.pos, memory: { role: 'Courier', home: 'A' } });
        hauler.spawning = false;
        Game.creeps.hauler = hauler;

        let creep = false;
        for (let step = 0; step < 60 && !creep; step++) {
            tick();
            runAll(room);
            courier._work(hauler);
            creep = role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' });
        }

        assert.ok(creep);
        assert.equal(storage.store.getUsedCapacity(XGH2O), 0);
    });

    it('runs the whole path with a real Courier: blocked, loaded, spawned, boosted, released', function () {
        const { room, storage, spawn } = preloadRoom();
        const role = new RolePrototype('Upgrader');
        const courier = new Courier();
        courier._moveToLocation = (worker, target) => { worker.pos = target.pos; };
        const hauler = makeCreep(room, {
            name: 'hauler', capacity: 100, pos: storage.pos,
            memory: { role: 'Courier', home: 'A' },
        });
        hauler.spawning = false;
        Game.creeps.hauler = hauler;

        let creep = false;
        let spawnedAt = 0;
        const startedAt = Game.time;
        for (let step = 0; step < 60 && !creep; step++) {
            tick();
            runAll(room);
            courier._work(hauler);
            creep = role._spawnCreepWithBody(spawn, tenWork(), { role: 'Upgrader', home: 'A' });
            spawnedAt = Game.time;
        }

        assert.ok(creep, 'the required spawn is no longer blocked');
        assert.ok(spawnedAt - startedAt > 3, 'three trips of 100 had to happen first');
        const labId = room.memory.lab.boostRequests[creep.name].steps[0].labId;
        const target = lab(labId);
        assert.equal(target.store.getUsedCapacity(XGH2O), 300);
        assert.equal(storage.store.getUsedCapacity(XGH2O), 2700);
        assert.deepEqual(preloads(room), {});

        creep.spawning = false;
        creep.pos = target.pos;
        Game.creeps[creep.name] = creep;
        tick();
        runAll(room);
        assert.equal(memoryOf(target).labRole, 'boost');
        LabManager.runCreep(creep, role);
        assert.equal(creep.body.filter(part => part.boost === XGH2O).length, 10);
        assert.equal(target.store.getUsedCapacity(XGH2O), 0);
        assert.equal(creep.memory.labBoost, undefined);

        tick();
        runAll(room);
        assert.equal(memoryOf(target).labRole, 'idle');
        assert.equal(memoryOf(target).labManaged, false);
        assert.equal(memoryOf(target).inputResourceType, null);
        assert.equal(memoryOf(target).reservedBoostAmount, 0);
    });
});
