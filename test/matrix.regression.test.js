const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeLab, makeStructure, makeTerminal, makePosition, makeSpawn, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const LabManager = require('../manager.lab');
const LabMatrix = require('../lab.matrix');
const MainHeap = require('../main.heap');
const TerminalManager = require('../manager.terminal');
const RolePrototype = require('../role.prototype');
const config = require('../main.config').LAB;

const XGH2O = RESOURCE_CATALYZED_GHODIUM_ACID;
const GH2O = RESOURCE_GHODIUM_ACID;
const X = RESOURCE_CATALYST;
const H = RESOURCE_HYDROGEN;
const O = RESOURCE_OXYGEN;
const OH = RESOURCE_HYDROXIDE;
const GH = RESOURCE_GHODIUM_HYDRIDE;

const THREE_LABS = [[24, 25], [25, 25], [24, 24]];
const TEN_LABS = [[24, 25], [25, 25], [23, 24], [24, 24], [25, 24], [26, 24], [23, 26], [24, 26], [25, 26], [26, 26]];

function labRoom(name, lab, stock, memory = {}, positions = THREE_LABS) {
    const room = makeRoom(name, {
        energyAvailable: 10000,
        memory: Object.assign({
            base: { name, roleConfig: {} },
            logistics: { tasks: [] },
            terminal: { enabled: true, emergencyReserve: 0, batchSize: 1000, cooldown: 0, resources: {} },
            lab: Object.assign({ enabled: true, goals: {}, reserves: {}, batchSize: 1000, maxDepth: 6, planningInterval: 1, requestExpiry: 1000 }, lab),
        }, memory),
    });
    room.controller = { my: true, level: 8, pos: makePosition(room, 30, 30), owner: { username: 'Me' } };
    const storage = makeStructure(room, STRUCTURE_STORAGE, {
        id: 'storage-' + name, pos: makePosition(room, 20, 20), store: makeStore(100000, stock || {}),
    });
    const terminal = makeTerminal(room, { pos: makePosition(room, 21, 20), store: makeStore(100000, {}) });
    room.storage = storage;
    Game.rooms[name] = room;
    const labs = positions.map((position, index) => makeLab(room, {
        id: name + '-lab-' + index, pos: makePosition(room, position[0], position[1]), contents: {},
    }));
    [storage, terminal, ...labs].forEach(object => registerObject(object, name));
    setFind(room, FIND_MY_STRUCTURES, [storage, terminal, ...labs]);
    setFind(room, FIND_STRUCTURES, [storage, terminal, ...labs]);
    return { room, storage, terminal, labs };
}

function runLabs(room, ticks = 1) {
    for (let tick = 0; tick < ticks; tick++) {
        Game.time++;
        new LabManager(room).run();
    }
}

function askForBoost(room, body) {
    const spawn = makeSpawn(room, { name: 'S-' + room.name, memory: { home: room.name } });
    return LabManager.planSpawnBoost(spawn, body, 'Upgrader', {}, {});
}

const upgraderPolicy = { boosts: { Upgrader: { work: XGH2O, required: true } } };
const tenWork = () => Array(10).fill(WORK).concat([MOVE]);

describe('Lab reaction matrix', function () {
    beforeEach(function () {
        resetScreeps();
        MainHeap.reset();
        Game.market.calcTransactionCost = () => 0;
    });

    it('moves past an unobtainable goal to a fully stocked one', function () {
        const { room } = labRoom('A', { goals: { [GH]: 5, [OH]: 5 } }, { [H]: 1000, [O]: 1000 });

        runLabs(room);
        assert.equal(room.memory.lab.activeGoal.resourceType, GH);
        assert.equal(room.memory.lab.fsm.phase, 'acquire');

        runLabs(room, config.ACQUIRE_TIMEOUT + 2);

        assert.equal(room.memory.lab.activeGoal.resourceType, OH);
        assert.equal(room.memory.lab.lastCancelledGoal.reason, 'imports did not arrive');
        assert.ok(room.memory.lab.fsm.blocked[GH] > Game.time);
    });

    it('retries a blocked goal once its backoff ends', function () {
        const { room } = labRoom('A', { goals: { [GH]: 5 } }, {});
        runLabs(room, config.ACQUIRE_TIMEOUT + 3);
        assert.equal(room.memory.lab.activeGoal, null);

        runLabs(room, config.BLOCK_TICKS + 2);

        assert.equal(room.memory.lab.activeGoal.resourceType, GH);
    });

    it('keeps waiting while imports are still arriving', function () {
        const { room } = labRoom('A', { goals: { [GH]: 1000 } }, {});
        runLabs(room);
        const request = TerminalManager.getResourceRequests({ targetRoom: 'A', status: 'open' })[0];
        for (let step = 0; step < 3; step++) {
            runLabs(room, config.ACQUIRE_TIMEOUT - 10);
            request.remaining -= 100;
        }
        assert.equal(room.memory.lab.activeGoal.resourceType, GH);
    });

    it('turns an unmet spawn request into a goal on the next run, ahead of the timer', function () {
        const { room } = labRoom('A', Object.assign({ planningInterval: 1000 }, upgraderPolicy), { [X]: 3000, [GH2O]: 3000 });
        runLabs(room);
        assert.equal(room.memory.lab.activeGoal, null);

        assert.equal(askForBoost(room, tenWork()).allow, false);
        runLabs(room);

        const goal = room.memory.lab.activeGoal;
        assert.equal(goal.resourceType, XGH2O);
        assert.equal(goal.tier, LabMatrix.TIER.BOOST);
        assert.equal(goal.configuredTarget, 10 * LAB_BOOST_MINERAL * config.BOOST_SPAWNS_AHEAD);
    });

    it('makes no goal or import request when a derived goal has no possible supply', function () {
        const { room } = labRoom('A', upgraderPolicy, {});
        askForBoost(room, tenWork());

        runLabs(room);

        assert.equal(room.memory.lab.activeGoal, null);
        assert.equal(TerminalManager.getResourceRequests({ targetRoom: 'A', status: 'open' }).length, 0);
        assert.ok(room.memory.lab.fsm.blocked[XGH2O] > Game.time);
    });

    it('shrinks a derived batch to the reagents it can obtain', function () {
        const { room } = labRoom('A', upgraderPolicy, { [X]: 200, [GH2O]: 3000 });
        askForBoost(room, tenWork());

        runLabs(room);

        assert.equal(room.memory.lab.activeGoal.target, 200);
        assert.deepEqual(room.memory.lab.activeGoal.imports, {});
    });

    it('counts reagents another owned room can send as supply', function () {
        const { room } = labRoom('A', upgraderPolicy, { [GH2O]: 3000 });
        const donor = makeRoom('B', { memory: { base: { name: 'B', roleConfig: {} } } });
        donor.controller = { my: true, level: 8, owner: { username: 'Me' } };
        donor.terminal = makeTerminal(donor, { pos: makePosition(donor, 21, 20), store: makeStore(100000, { [X]: 600 }) });
        Game.rooms.B = donor;
        askForBoost(room, tenWork());

        runLabs(room);

        assert.equal(room.memory.lab.activeGoal.imports[X], 600);
    });

    it('lets a derived goal finish its batch after the demand expires', function () {
        const { room } = labRoom('A', upgraderPolicy, { [X]: 3000, [GH2O]: 3000 });
        askForBoost(room, tenWork());
        runLabs(room);
        MainHeap.reset();

        runLabs(room, 5);

        assert.equal(room.memory.lab.activeGoal.resourceType, XGH2O);
    });

    it('ranks a boost shortfall above a manual goal', function () {
        const { room } = labRoom('A', Object.assign({ goals: { [OH]: 500 } }, upgraderPolicy),
            { [X]: 3000, [GH2O]: 3000, [H]: 3000, [O]: 3000 });
        askForBoost(room, tenWork());

        runLabs(room);

        assert.equal(room.memory.lab.activeGoal.resourceType, XGH2O);
    });

    it('orders by tier even when a lower tier scores far higher', function () {
        LabMatrix.noteBoostDemand('A', XGH2O, 1, false);

        const ranked = LabMatrix.rankCandidates('A', { [OH]: 100 }, () => 0, [{ resourceType: GH, target: 100, rate: 1000000 }]);

        assert.deepEqual(ranked.map(candidate => candidate.resourceType), [XGH2O, OH, GH]);
    });

    it('stops asking once the stock covers the demand', function () {
        const { room } = labRoom('A', upgraderPolicy, { [XGH2O]: 600 });
        askForBoost(room, tenWork());

        runLabs(room);

        assert.equal(room.memory.lab.activeGoal, null);
    });

    it('continues a goal saved before the matrix existed', function () {
        const { room } = labRoom('A', { goals: { [OH]: 5 } }, { [H]: 1000, [O]: 1000 });
        runLabs(room);
        delete room.memory.lab.fsm;
        delete room.memory.lab.activeGoal.tier;

        runLabs(room);

        assert.equal(room.memory.lab.activeGoal.resourceType, OH);
        assert.equal(room.memory.lab.fsm.phase, 'react');
    });

    describe('per-tick cost', function () {
        function countRangeChecks(labs, run) {
            const proto = Object.getPrototypeOf(labs[0].pos);
            const original = proto.inRangeTo;
            let calls = 0;
            proto.inRangeTo = function (...args) { calls++; return original.apply(this, args); };
            try {
                run();
            } finally {
                proto.inRangeTo = original;
            }
            return calls;
        }

        function setLabs(room, storage, terminal, labs) {
            setFind(room, FIND_MY_STRUCTURES, [storage, terminal, ...labs]);
            setFind(room, FIND_STRUCTURES, [storage, terminal, ...labs]);
        }

        it('searches for a layout once and not again while the labs stay the same', function () {
            const { room, labs } = labRoom('A', { planningInterval: 10 }, {}, {}, TEN_LABS);
            runLabs(room);
            assert.equal(room.memory.lab.assignments.outputs.length, 8);

            const calls = countRangeChecks(labs, () => runLabs(room, 1000));

            assert.equal(calls, 0);
            assert.equal(room.memory.lab.assignments.outputs.length, 8);
        });

        it('does not repeat a search that found no possible layout', function () {
            const far = TEN_LABS.map((position, index) => [5 + index * 4, 5 + index * 4]);
            const { room, labs } = labRoom('A', {}, {}, {}, far);
            runLabs(room);
            assert.equal(room.memory.lab.assignments.inputA, null);

            assert.equal(countRangeChecks(labs, () => runLabs(room, 100)), 0);
        });

        it('searches again when a lab is built', function () {
            const { room, storage, terminal, labs } = labRoom('A', {}, {});
            runLabs(room);
            assert.equal(room.memory.lab.assignments.outputs.length, 1);

            const built = makeLab(room, { id: 'A-lab-new', pos: makePosition(room, 25, 24), contents: {} });
            registerObject(built, 'A');
            setLabs(room, storage, terminal, [...labs, built]);
            runLabs(room);

            assert.equal(room.memory.lab.assignments.outputs.length, 2);
            assert.ok(room.memory.lab.assignments.outputs.includes(built.id));
        });

        it('searches again when a lab is destroyed', function () {
            const { room, storage, terminal, labs } = labRoom('A', {}, {}, {}, TEN_LABS);
            runLabs(room);
            const destroyed = room.memory.lab.assignments.inputA;

            setLabs(room, storage, terminal, labs.filter(lab => lab.id !== destroyed));
            runLabs(room);

            const assignments = room.memory.lab.assignments;
            assert.notEqual(assignments.inputA, destroyed);
            assert.notEqual(assignments.inputB, destroyed);
            assert.ok(assignments.inputA);
            assert.ok(!assignments.outputs.includes(destroyed));
        });

        it('searches again when a lab is taken out of reactions for manual stocking', function () {
            const { room, labs } = labRoom('A', {}, {}, {}, TEN_LABS);
            runLabs(room);
            const stocked = labs.find(lab => lab.id === room.memory.lab.assignments.outputs[0]);

            Memory.structures[stocked.id].inputResourceType = XGH2O;
            Memory.structures[stocked.id].labManaged = false;
            runLabs(room);

            assert.ok(!room.memory.lab.assignments.outputs.includes(stocked.id));
        });

        it('keeps the saved layout through a global reset', function () {
            const { room, labs } = labRoom('A', {}, {}, {}, TEN_LABS);
            runLabs(room);
            const saved = JSON.stringify(room.memory.lab.assignments);
            MainHeap.reset();

            const calls = countRangeChecks(labs, () => runLabs(room));

            assert.ok(calls > 0);
            assert.equal(JSON.stringify(room.memory.lab.assignments), saved);
        });

        it('searches again when the saved layout is wiped from memory', function () {
            const { room } = labRoom('A', {}, {});
            runLabs(room);
            room.memory.lab.assignments = { inputA: null, inputB: null, outputs: [] };

            runLabs(room);

            assert.ok(room.memory.lab.assignments.inputA);
        });

        it('projects lab metadata once per tick', function () {
            const { room } = labRoom('A', { goals: { [OH]: 1000 } }, { [H]: 3000, [O]: 3000 });
            const original = LabManager.prototype._projectLabMetadata;
            let writes = 0;
            LabManager.prototype._projectLabMetadata = function (...args) { writes++; return original.apply(this, args); };
            try {
                runLabs(room, 50);
            } finally {
                LabManager.prototype._projectLabMetadata = original;
            }
            assert.equal(writes, 50);
        });

        it('shows logistics the new state on the tick a reaction finishes the goal', function () {
            const { room, labs } = labRoom('A', { goals: { [OH]: 5 } }, {});
            runLabs(room);
            const { inputA, inputB, outputs } = room.memory.lab.assignments;
            const byId = id => labs.find(lab => lab.id === id);
            byId(inputA).store.set(room.memory.lab.activeGoal.steps[0].reagents[0], 5);
            byId(inputB).store.set(room.memory.lab.activeGoal.steps[0].reagents[1], 5);

            runLabs(room);

            assert.equal(byId(outputs[0]).store.getUsedCapacity(OH), 5);
            assert.equal(room.memory.lab.activeGoal, null);
            assert.equal(Memory.structures[inputA].targetAmount, 0);
            assert.equal(Memory.structures[outputs[0]].labRole, 'drain');
            assert.equal(Memory.structures[outputs[0]].outputResourceType, OH);
        });
    });

    describe('profit tier', function () {
        const history = { [OH]: 40, [H]: 5, [O]: 5, [GH]: 30, [RESOURCE_GHODIUM]: 10 };
        const marketMemory = {
            market: { enabled: true, sell: true, resources: { [OH]: { sell: true, sellAbove: 1000, batchSize: 500 }, [GH]: { sell: true, sellAbove: 1000, batchSize: 500 } } },
        };

        function installHistory(calls) {
            Game.market.getHistory = resourceType => {
                calls.count++;
                return history[resourceType] === undefined ? [] : [{ avgPrice: history[resourceType], stddevPrice: 1 }];
            };
        }

        it('reads no prices unless the room opts in', function () {
            const calls = { count: 0 };
            installHistory(calls);
            const { room } = labRoom('A', {}, { [H]: 3000, [O]: 3000 }, marketMemory);

            runLabs(room, 3);

            assert.equal(calls.count, 0);
            assert.equal(room.memory.lab.activeGoal, null);
        });

        it('reads prices at most once per ttl and makes a profitable product the market may sell', function () {
            const calls = { count: 0 };
            installHistory(calls);
            const { room } = labRoom('A', { autoProfit: true }, { [H]: 3000, [O]: 3000 }, marketMemory);

            runLabs(room);
            const afterFirstRead = calls.count;
            runLabs(room, 20);

            assert.ok(afterFirstRead > 0);
            assert.equal(calls.count, afterFirstRead);
            assert.equal(room.memory.lab.activeGoal.resourceType, OH);
            assert.equal(room.memory.lab.activeGoal.tier, LabMatrix.TIER.PROFIT);
            assert.equal(room.memory.lab.activeGoal.configuredTarget, 1500);
        });

        it('skips a product that costs more to make than it sells for', function () {
            const prices = { [OH]: { sell: 5, buy: 6 }, [H]: { sell: 4, buy: 6 }, [O]: { sell: 4, buy: 6 } };
            MainHeap.cached('labPrices', undefined, () => prices);
            const recipes = LabManager.buildRecipeIndex();
            const goals = LabMatrix.rankProfit({ enabled: true, sell: true, resources: { [OH]: { sell: true, max: 100, batchSize: 100 } } }, recipes);
            assert.deepEqual(goals, []);
        });

        it('values time, so a slower chain with a larger margin can lose', function () {
            const recipes = {
                fast: { reagents: ['a', 'b'], cooldown: 10 },
                slow: { reagents: ['a', 'b'], cooldown: 100 },
            };
            const prices = { a: { sell: 0, buy: 1 }, b: { sell: 0, buy: 1 }, fast: { sell: 12, buy: 12 }, slow: { sell: 42, buy: 42 } };
            MainHeap.cached('labPrices', undefined, () => prices);
            const rules = { fast: { sell: true, max: 1, batchSize: 1 }, slow: { sell: true, max: 1, batchSize: 1 } };
            const goals = LabMatrix.rankProfit({ enabled: true, sell: true, resources: rules }, recipes);
            const ranked = LabMatrix.rankCandidates('A', {}, () => 0, goals);
            assert.deepEqual(ranked.map(candidate => candidate.resourceType), ['fast', 'slow']);
        });
    });
});
