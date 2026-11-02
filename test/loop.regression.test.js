const assert = require('node:assert/strict');
const {
    makeRoom, makeCreep, makeSpawn, makeLab, makeStore, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const MainMemhack = require('../main.memhack');
const MainScheduler = require('../main.scheduler');
const MainUtil = require('../main.util');
const MainInfo = require('../main.info');
const config = require('../main.config');
const CpuManager = require('../manager.cpu');
const BaseManager = require('../manager.base');
const FactoryManager = require('../manager.factory');
const IntelManager = require('../manager.intel');
const LabManager = require('../manager.lab');
const MayorManager = require('../manager.mayor');
const MemoryManager = require('../manager.memory');
const TerminalManager = require('../manager.terminal');
const main = require('../main');

describe('Loop design', function () {
    let originalConsoleLog;

    beforeEach(function () {
        resetScreeps();
        originalConsoleLog = console.log;
        console.log = () => {};
    });

    afterEach(function () {
        console.log = originalConsoleLog;
        delete global.RawMemory;
        delete global.Memory;
        global.Memory = {};
    });

    describe('Memory on the heap', function () {
        // What @screeps/engine game.js and @screeps/driver runtime.js do around a tick: a new RawMemory,
        // a Memory that parses on first read, and a write of RawMemory._parsed afterwards.
        function installEngine(stored) {
            const engine = {
                stored,
                parses: 0,
                beginTick() {
                    global.RawMemory = { get: () => engine.stored };
                    delete global.Memory;
                    Object.defineProperty(global, 'Memory', {
                        configurable: true,
                        enumerable: true,
                        get() {
                            engine.parses++;
                            RawMemory._parsed = JSON.parse(engine.stored);
                            Object.defineProperty(global, 'Memory', { configurable: true, enumerable: true, value: RawMemory._parsed });
                            return RawMemory._parsed;
                        },
                    });
                },
                endTick() {
                    if (RawMemory._parsed) engine.stored = JSON.stringify(RawMemory._parsed);
                },
            };
            return engine;
        }

        function finishedTick(engine, work) {
            engine.beginTick();
            MainMemhack.initRound();
            work();
            MainMemhack.endRound();
            engine.endTick();
            Game.time++;
        }

        it('parses once across many ticks and still stores what they wrote', function () {
            const engine = installEngine('{"count":0}');
            for (let tick = 0; tick < 50; tick++) finishedTick(engine, () => { Memory.count++; });
            assert.equal(engine.parses, 1);
            assert.deepEqual(JSON.parse(engine.stored), { count: 50 });
        });

        it('keeps what a console command writes after the loop has run', function () {
            const engine = installEngine('{}');
            finishedTick(engine, () => {});
            engine.beginTick();
            MainMemhack.initRound();
            MainMemhack.endRound();
            Memory.fromConsole = 1;
            engine.endTick();
            Game.time++;
            finishedTick(engine, () => assert.equal(Memory.fromConsole, 1));
            assert.equal(JSON.parse(engine.stored).fromConsole, 1);
        });

        it('drops the writes of a tick that hit the CPU limit, as the game does', function () {
            const engine = installEngine('{"count":1}');
            finishedTick(engine, () => { Memory.count = 2; });

            // the tick is cut off inside the loop, so neither endRound nor the write happens
            engine.beginTick();
            MainMemhack.initRound();
            Memory.count = 999;
            Game.time++;

            finishedTick(engine, () => assert.equal(Memory.count, 2));
            assert.equal(engine.parses, 2);
        });

        it('reads the stored Memory again when ticks were skipped', function () {
            const engine = installEngine('{}');
            finishedTick(engine, () => {});
            Game.time += 5;
            finishedTick(engine, () => {});
            assert.equal(engine.parses, 2);
        });

        it('falls back on plain Memory if the engine stops exposing the parsed object', function () {
            global.RawMemory = {};
            global.Memory = { kept: true };
            for (let tick = 0; tick < 3; tick++) {
                MainMemhack.initRound();
                MainMemhack.endRound();
                Game.time++;
            }
            assert.deepEqual(Memory, { kept: true });
            assert.equal(MainMemhack._memory, null);
        });

        it('hands every tick the cached Memory through the full loop', function () {
            const engine = installEngine('{}');
            for (let tick = 0; tick < 5; tick++) {
                engine.beginTick();
                main.loop();
                engine.endTick();
                Game.time++;
            }
            assert.equal(engine.parses, 1);
            assert.ok(JSON.parse(engine.stored).empire, 'the bot wrote through it');
        });
    });

    describe('error boundaries', function () {
        it('keeps running jobs when a job cannot even say whether it is due', function () {
            const ran = [];
            MainScheduler.run([
                { name: 'broken', enabled: () => { throw new Error('injected'); }, run: () => ran.push('broken') },
                { name: 'next', run: () => ran.push('next') },
            ]);
            assert.deepEqual(ran, ['next']);
        });

        it('keeps running jobs when reporting the failure itself fails', function () {
            MainInfo.error = () => { throw new Error('the reporter is broken too'); };
            const ran = [];
            MainScheduler.run([
                { name: 'broken', run: () => { throw new Error('injected'); } },
                { name: 'next', run: () => ran.push('next') },
            ]);
            assert.deepEqual(ran, ['next']);
        });

        it('survives an error that is not an Error', function () {
            const ran = [];
            MainScheduler.run([
                { name: 'broken', run: () => { throw null; } },
                { name: 'next', run: () => ran.push('next') },
            ]);
            assert.deepEqual(ran, ['next']);
        });

        function baseRoom(name) {
            const room = makeRoom(name, { memory: { base: { name, roleConfig: {} } } });
            Game.rooms[name] = room;
            return room;
        }

        it('still runs creeps when adopting orphans throws', function () {
            const room = baseRoom('A');
            const original = BaseManager._adoptOrphans;
            const originalMove = BaseManager.prototype._moveCreeps;
            let moved = 0;
            BaseManager._adoptOrphans = () => { throw new Error('injected'); };
            BaseManager.prototype._moveCreeps = () => { moved++; };
            try {
                BaseManager.runAll([]);
            } finally {
                BaseManager._adoptOrphans = original;
                BaseManager.prototype._moveCreeps = originalMove;
            }
            assert.equal(moved, 1);
            assert.ok(room);
        });

        it('reports a room that keeps failing without a line per tick, and emails its owner', function () {
            baseRoom('A');
            const errors = [];
            MainInfo.error = message => errors.push(message);
            const original = FactoryManager.prototype.run;
            FactoryManager.prototype.run = () => { throw new Error('injected'); };
            try {
                for (let tick = 0; tick < 200; tick++) {
                    FactoryManager.runAll();
                    Game.time++;
                }
            } finally {
                FactoryManager.prototype.run = original;
            }
            assert.equal(errors.length, Math.ceil(200 / config.CPU.ERROR_LOG_INTERVAL));
            assert.equal(Game.notifications.length, 1);
            assert.match(Game.notifications[0], /Could not run factory for A: Error: injected/);
        });

        it('sends no more emails in a tick than the game accepts, and sends the rest on later ticks', function () {
            const sentAt = [];
            Game.notify = (message, groupMinutes) => sentAt.push({ tick: Game.time, message, groupMinutes });
            const room = baseRoom('A');
            room.memory.defense = {};
            for (let index = 0; index < 25; index++) {
                MainInfo.failure('problem:' + index, 'Problem ' + index, new Error('injected'));
            }
            const DefenseManager = require('../manager.defense');
            new DefenseManager(room)._handleAlerts({ level: config.DEFENSE.DEFENDER_THREAT_LEVEL, score: 300 });
            assert.equal(sentAt.length, config.CPU.NOTIFY_PER_TICK);
            for (let tick = 0; tick < 3; tick++) {
                Game.time++;
                MainInfo.flushNotifications();
            }
            const perTick = {};
            sentAt.forEach(entry => { perTick[entry.tick] = (perTick[entry.tick] || 0) + 1; });
            assert.ok(Object.values(perTick).every(count => count <= config.CPU.NOTIFY_PER_TICK), JSON.stringify(perTick));
            assert.equal(sentAt.length, 26, 'every problem and the alert reach the owner');
            assert.equal(sentAt.find(entry => /DEFENSE ALERT/.test(entry.message)).groupMinutes, 0, 'an invasion alert is never bundled');
        });

        it('sends the waiting emails on the next tick of the main loop', function () {
            const sent = [];
            Game.notify = message => sent.push(message);
            for (let index = 0; index < 25; index++) {
                MainInfo.failure('problem:' + index, 'Problem ' + index, new Error('injected'));
            }
            assert.equal(sent.length, config.CPU.NOTIFY_PER_TICK);
            Game.time++;
            main.loop();
            assert.ok(sent.some(message => /Problem 24:/.test(message)), 'the last problem went out a tick later');
        });

        it('lets the factories of other rooms carry on past a room that throws', function () {
            baseRoom('A');
            baseRoom('B');
            const ran = [];
            const original = FactoryManager.prototype.run;
            FactoryManager.prototype.run = function () {
                if (this._room.name === 'A') throw new Error('injected');
                ran.push(this._room.name);
            };
            try {
                FactoryManager.runAll();
            } finally {
                FactoryManager.prototype.run = original;
            }
            assert.deepEqual(ran, ['B']);
        });
    });

    describe('CPU budget', function () {
        it('skips work that can wait once the tick nears its limit, but never life-support', function () {
            const ran = [];
            Game.cpu = { bucket: 9000, tickLimit: 100, getUsed: () => 95 };
            MainScheduler.run([
                { name: 'deferred', tier: CpuManager.TIER_NORMAL, run: () => ran.push('deferred') },
                { name: 'degraded', tier: CpuManager.TIER_DEGRADED, run: () => ran.push('degraded') },
                { name: 'vital', run: () => ran.push('vital') },
            ]);
            assert.deepEqual(ran, ['vital']);
        });
    });

    describe('labs with a low bucket', function () {
        function labRoom() {
            const room = makeRoom('A', { memory: { base: { name: 'A', roleConfig: {} } } });
            room.controller = { my: true, level: 6, pos: makePosition(room, 40, 40) };
            room.storage = { id: 'storage', store: makeStore(100000, { [RESOURCE_HYDROGEN]: 3000, [RESOURCE_OXYGEN]: 3000 }), pos: makePosition(room, 20, 20), room, structureType: STRUCTURE_STORAGE };
            const labs = [
                makeLab(room, { id: 'lab-1', pos: makePosition(room, 25, 25), contents: { [RESOURCE_HYDROGEN]: 500 } }),
                makeLab(room, { id: 'lab-2', pos: makePosition(room, 26, 25), contents: { [RESOURCE_OXYGEN]: 500 } }),
                makeLab(room, { id: 'lab-3', pos: makePosition(room, 25, 26) }),
            ];
            labs.forEach(lab => registerObject(lab, 'A'));
            registerObject(room.storage, 'A');
            Game.rooms.A = room;
            setFind(room, FIND_MY_STRUCTURES, labs.concat(room.storage));
            setFind(room, FIND_STRUCTURES, labs.concat(room.storage));
            room.memory.lab = { goals: { [RESOURCE_HYDROXIDE]: 1000 }, planningInterval: 1 };
            return { room, labs };
        }

        it('pauses reactions, and the pause does not count as a stalled goal', function () {
            const { room, labs } = labRoom();
            LabManager.runAll();
            Game.time++;
            LabManager.runAll();
            const produced = () => labs.reduce((sum, lab) => sum + lab.reactions.length, 0);
            assert.ok(room.memory.lab.activeGoal, 'a goal is running');
            const before = produced();
            assert.ok(before > 0, 'the labs react with a healthy bucket');

            const pause = config.LAB.REACT_STALL + 100;
            for (let tick = 0; tick < pause; tick++) {
                Game.time++;
                LabManager.runAll(false);
            }
            assert.equal(produced(), before, 'nothing reacts during the pause');
            assert.ok(room.memory.lab.activeGoal, 'the goal is still there');

            labs.forEach(lab => { lab.cooldown = 0; });
            Game.time++;
            LabManager.runAll();
            assert.ok(room.memory.lab.activeGoal, 'the pause was not mistaken for a stall');
            assert.equal(room.memory.lab.fsm.blocked[RESOURCE_HYDROXIDE], undefined);
            assert.ok(produced() > before, 'reactions pick up again');
        });

        it('does not count ticks the job was skipped altogether as a stalled goal', function () {
            const { room, labs } = labRoom();
            LabManager.runAll();
            Game.time++;
            LabManager.runAll();
            const goal = room.memory.lab.activeGoal;
            assert.ok(goal, 'a goal is running');

            // below the critical bucket the scheduler does not call the lab job at all
            Game.time += config.LAB.REACT_STALL + 100;
            labs.forEach(lab => { lab.cooldown = 0; });
            LabManager.runAll();
            assert.equal(room.memory.lab.activeGoal, goal, 'the same goal carries on');
            assert.deepEqual(room.memory.lab.fsm.blocked, {});
        });

        it('still notices a goal that really has stalled', function () {
            const { room, labs } = labRoom();
            LabManager.runAll();
            Game.time++;
            LabManager.runAll();
            const startedAt = room.memory.lab.activeGoal.startedAt;
            labs.forEach(lab => {
                [RESOURCE_HYDROGEN, RESOURCE_OXYGEN].forEach(resourceType => lab.store.set(resourceType, 0));
            });
            room.storage.store.set(RESOURCE_HYDROGEN, 0);
            room.storage.store.set(RESOURCE_OXYGEN, 0);
            for (let tick = 0; tick <= config.LAB.REACT_STALL + config.LAB.ACQUIRE_TIMEOUT + 2; tick++) {
                Game.time++;
                LabManager.runAll();
            }
            const goal = room.memory.lab.activeGoal;
            assert.ok(!goal || goal.startedAt !== startedAt, 'the stalled goal was given up');
        });
    });

    describe('tick staggering', function () {
        it('runs a job on fixed ticks, so that a global reset does not move or bunch them', function () {
            const runs = [];
            const job = { name: 'periodic', every: 10, phase: 3, run: () => runs.push(Game.time) };
            for (Game.time = 1; Game.time <= 25; Game.time++) MainScheduler.run([job]);
            assert.deepEqual(runs, [3, 13, 23]);
        });

        it('spreads the rooms of a sector over the Mayor interval, one run per room', function () {
            for (let x = 1; x <= 4; x++) {
                for (let y = 1; y <= 4; y++) Game.rooms['W' + x + 'N' + y] = makeRoom('W' + x + 'N' + y);
            }
            const runs = {};
            const original = MayorManager.prototype.run;
            MayorManager.prototype.run = function () { (runs[this._room.name] = runs[this._room.name] || []).push(Game.time); };
            try {
                for (Game.time = 1; Game.time <= 3 * config.PLANNER.INTERVAL; Game.time++) MayorManager.runAll();
            } finally {
                MayorManager.prototype.run = original;
            }
            const perTick = {};
            Object.keys(Game.rooms).forEach(name => {
                assert.equal(runs[name].length, 3, name + ' runs once per interval');
                const turn = runs[name][0] % config.PLANNER.INTERVAL;
                perTick[turn] = (perTick[turn] || 0) + 1;
            });
            assert.ok(Math.max(...Object.values(perTick)) <= 4, 'at most 4 of 16 rooms share a tick: ' + JSON.stringify(perTick));
        });

        it('does not run the Mayor just because a reset happened', function () {
            Game.rooms.W1N1 = makeRoom('W1N1');
            const original = MayorManager.prototype.run;
            let ran = 0;
            MayorManager.prototype.run = () => { ran++; };
            try {
                Game.time = 1000;
                while (MainUtil.isRoomsTurn('W1N1', config.PLANNER.INTERVAL)) Game.time++;
                MayorManager.runAll();
            } finally {
                MayorManager.prototype.run = original;
            }
            assert.equal(ran, 0);
        });

        it('keeps periodic memory housekeeping apart', function () {
            const { MEASURE_INTERVAL, STUCK_PRUNE_INTERVAL, STUCK_PRUNE_PHASE, ROOM_PRUNE_INTERVAL, ROOM_PRUNE_PHASE, INTEL_CLEANUP_INTERVAL, INTEL_CLEANUP_PHASE } = config.MEMORY;
            for (let time = 0; time < 10000; time++) {
                const running = [time % MEASURE_INTERVAL === 0, time % STUCK_PRUNE_INTERVAL === STUCK_PRUNE_PHASE, time % ROOM_PRUNE_INTERVAL === ROOM_PRUNE_PHASE, time % INTEL_CLEANUP_INTERVAL === INTEL_CLEANUP_PHASE];
                assert.ok(running.filter(Boolean).length <= 1, 'tick ' + time);
            }
        });

        it('cleans up intel on its interval rather than every tick', function () {
            const original = IntelManager.cleanup;
            let cleanups = 0;
            IntelManager.cleanup = () => { cleanups++; };
            try {
                for (Game.time = 1; Game.time <= 10 * config.MEMORY.INTEL_CLEANUP_INTERVAL; Game.time++) MemoryManager._deleteUnusedMemory();
            } finally {
                IntelManager.cleanup = original;
            }
            assert.equal(cleanups, 10);
        });

        it('leaves intel cleanup to that interval while no room has a terminal', function () {
            const original = IntelManager.cleanup;
            let cleanups = 0;
            IntelManager.cleanup = () => { cleanups++; };
            try {
                TerminalManager.runAll();
            } finally {
                IntelManager.cleanup = original;
            }
            assert.equal(cleanups, 0);
        });
    });
});
