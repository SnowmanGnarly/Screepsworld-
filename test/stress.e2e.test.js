const assert = require('node:assert/strict');
const { Simulator, buildStandardRoom } = require('./helpers/simulator');
const FactoryManager = require('../manager.factory');
const config = require('../main.config');

const TICKS = 2000;
const CRASH_AT = 500;
const RESET_AT = 1200;
const LATE_FROM = 1500; // long after the crash and the reset, and every first-generation creep is dead
const CPU_LIMIT = 20;
const SOURCE_INCOME = 2 * SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME;
const FIRST_GENERATION = ['miner-north', 'miner-south', 'hauler-1', 'hauler-2', 'hauler-3', 'courier', 'upgrader-1', 'upgrader-2'];

// Throws from the given tick on, not just once: a real bug would keep failing until someone fixes it.
const FAULTS = {
    room: { owner: FactoryManager.prototype, method: 'run' },
    job: { owner: FactoryManager, method: 'runAll' },
};

function runScenario(faultName) {
    const sim = new Simulator({ cpuLimit: CPU_LIMIT });
    const fault = FAULTS[faultName];
    const original = fault && fault.owner[fault.method];
    if (fault) {
        fault.owner[fault.method] = function (...args) {
            if (Game.time >= CRASH_AT) throw new Error('injected factory crash');
            return original.apply(this, args);
        };
    }
    try {
        buildStandardRoom(sim);
        const unserializable = [];
        for (let tick = 1; tick <= TICKS; tick++) {
            if (tick === RESET_AT) sim.globalReset();
            sim.tick();
            if (tick % 100 === 0) unserializable.push(...sim.findUnserializable());
        }
        const room = Game.rooms.W1N1;
        return {
            sim,
            unserializable,
            balance: sim.energyBalance(),
            creeps: Object.values(Game.creeps).map(creep => ({ name: creep.name, role: creep.memory.role, source: creep.memory.source, spawning: creep.spawning })),
            notifications: Game.notifications.slice(),
            energyAvailable: room.energyAvailable,
            energyCapacity: room.energyCapacityAvailable,
            storage: room.storage.store.getUsedCapacity(RESOURCE_ENERGY),
            tasks: room.memory.logistics.tasks.length,
            finalBucket: Game.cpu.bucket,
            memoryBytes: sim.storedMemory.length,
            statsSamples: Memory.stats.samples.length,
        };
    } finally {
        if (fault) fault.owner[fault.method] = original;
        sim.dispose();
    }
}

function summarize(name, result) {
    const { sim } = result;
    const hot = Object.entries(sim.jobCpu).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([job, cpu]) => job + ' ' + (cpu / TICKS).toFixed(2)).join(', ');
    return [
        name.padEnd(12),
        'mined ' + sim.total('harvested', LATE_FROM),
        'collected ' + sim.total('collected', LATE_FROM),
        'upgraded ' + sim.total('upgraded', LATE_FROM),
        'factory ' + sim.total('factory', CRASH_AT),
        'cpu ' + sim.averageCpu().toFixed(2) + '/' + CPU_LIMIT,
        'bucket ' + Math.round(result.finalBucket),
        'parses ' + sim.parses,
        'errors ' + sim.errors.length,
        'mail ' + result.notifications.length,
    ].join(' | ') + '\n' + ' '.repeat(12) + ' hottest jobs: ' + hot;
}

describe('E2E: W1N1 runs 2000 ticks through the real main loop', function () {
    this.timeout(120000);
    const results = {};

    before(function () {
        results.healthy = runScenario(null);
        results.room = runScenario('room');
        results.job = runScenario('job');
        console.log('\n      window for mined/collected/upgraded: ticks ' + LATE_FROM + '-' + TICKS + '; factory: energy used from tick ' + CRASH_AT);
        Object.keys(results).forEach(name => console.log('      ' + summarize(name, results[name]).replace('\n', '\n      ')));
    });

    describe('without a crash', function () {
        it('runs clean: no error, and the factory and labs both produce', function () {
            const { sim } = results.healthy;
            assert.deepEqual(sim.errors, []);
            assert.ok(sim.total('factory') > 0, 'the factory used energy');
            assert.ok(sim.total('reacted') > 0, 'the labs reacted');
        });
    });

    ['room', 'job'].forEach(fault => {
        describe('with the factory ' + (fault === 'room' ? 'throwing inside a room from' : 'job throwing from') + ' tick ' + CRASH_AT, function () {
            const result = () => results[fault];

            it('the crash really happened: the factory worked before it and never after', function () {
                const { sim } = result();
                assert.ok(sim.total('factory', 1, CRASH_AT - 1) > 0);
                assert.equal(sim.total('factory', CRASH_AT), 0);
            });

            it('reports only the crash, at a bounded rate, and emails its owner', function () {
                const { sim, notifications } = result();
                assert.ok(sim.errors.length > 0, 'the crash reached the log');
                sim.errors.forEach(error => assert.match(error.message, /injected factory crash/, error.message));
                // one extra line for the reset, which forgets when the last one was written
                const crashTicks = TICKS - CRASH_AT + 1;
                assert.ok(sim.errors.length <= Math.ceil(crashTicks / config.CPU.ERROR_LOG_INTERVAL) + 1, sim.errors.length + ' lines');
                assert.ok(notifications.length >= 1 && notifications.length <= 3, notifications.length + ' emails');
            });

            it('keeps mining, hauling and upgrading at the healthy rate at tick 2000', function () {
                const { sim } = result();
                const healthy = results.healthy.sim;
                // collected rather than hauled, because hauled also counts energy that goes from the storage back to it
                ['harvested', 'collected', 'upgraded'].forEach(metric => {
                    const amount = sim.total(metric, LATE_FROM);
                    assert.ok(amount >= healthy.total(metric, LATE_FROM) * 0.9, metric + ': ' + amount + ' vs ' + healthy.total(metric, LATE_FROM));
                });
                const lateTicks = TICKS - LATE_FROM + 1;
                assert.ok(sim.total('harvested', LATE_FROM) >= SOURCE_INCOME * lateTicks * 0.6, 'mines at least 60% of what the sources give');
            });

            it('keeps the labs reacting, since only the factory is broken', function () {
                assert.ok(result().sim.total('reacted', CRASH_AT) > 0);
            });

            it('replaces the whole workforce after the crash', function () {
                const { creeps } = result();
                const alive = creeps.filter(creep => !creep.spawning);
                FIRST_GENERATION.forEach(name => assert.ok(!creeps.some(creep => creep.name === name), name + ' is long dead'));
                ['source-north', 'source-south'].forEach(source => {
                    assert.ok(alive.some(creep => creep.role === 'Miner' && creep.source === source), 'a Miner works ' + source);
                });
                ['Storekeeper', 'Upgrader'].forEach(role => assert.ok(alive.some(creep => creep.role === role), role + ' alive'));
            });

            it('keeps the spawn fed', function () {
                const { energyAvailable, energyCapacity } = result();
                assert.ok(energyAvailable >= energyCapacity * 0.5, energyAvailable + '/' + energyCapacity);
            });

            it('stays within the CPU limit and does not drain the bucket', function () {
                const { sim, finalBucket } = result();
                assert.ok(sim.averageCpu() < CPU_LIMIT, 'average ' + sim.averageCpu());
                assert.ok(sim.averageCpu(CRASH_AT) < CPU_LIMIT, 'average after the crash ' + sim.averageCpu(CRASH_AT));
                assert.equal(sim.overLimit, 0, 'no tick hit the limit');
                assert.ok(finalBucket > 9000, 'bucket ' + finalBucket);
            });

            it('balances the energy books exactly', function () {
                const { balance } = result();
                assert.equal(balance.actual, balance.expected);
            });

            it('parses Memory once per global reset, and only stores what JSON can hold', function () {
                const { sim, unserializable, memoryBytes, tasks, statsSamples } = result();
                assert.equal(sim.parses, 2, 'the first tick and the reset');
                assert.deepEqual(unserializable, []);
                assert.ok(memoryBytes < 100000, memoryBytes + ' bytes');
                assert.ok(tasks <= 100, tasks + ' logistics tasks');
                assert.ok(statsSamples <= config.CPU.STATS_SAMPLES);
            });
        });
    });

    describe('with the bucket held low, then critical', function () {
        const LOW_FROM = 300;
        const CRITICAL_FROM = 500;
        const LOW_UNTIL = 1200; // longer than a goal may stall, so that only a real pause keeps it
        let sim;
        let creepsAtEnd;
        let goalBefore;
        let goalAfter;
        let blockedAfter;

        before(function () {
            sim = new Simulator({ cpuLimit: CPU_LIMIT });
            try {
                buildStandardRoom(sim);
                for (let tick = 1; tick <= LOW_UNTIL + 300; tick++) {
                    if (tick === LOW_FROM - 1) sim.pinnedBucket = config.CPU.DEGRADED_BUCKET - 200;
                    if (tick === CRITICAL_FROM - 1) sim.pinnedBucket = config.CPU.CRITICAL_BUCKET - 100;
                    if (tick === LOW_UNTIL - 1) sim.pinnedBucket = config.CPU.RECOVERED_BUCKET + 1;
                    if (tick === LOW_UNTIL) sim.pinnedBucket = null;
                    sim.tick();
                    if (tick === LOW_FROM - 1) goalBefore = Game.rooms.W1N1.memory.lab.activeGoal;
                    if (tick === LOW_UNTIL) {
                        creepsAtEnd = Object.values(Game.creeps).filter(creep => !creep.spawning).map(creep => creep.memory.role);
                        goalAfter = Game.rooms.W1N1.memory.lab.activeGoal;
                        blockedAfter = Object.assign({}, Game.rooms.W1N1.memory.lab.fsm.blocked);
                    }
                }
            } finally {
                sim.dispose();
            }
        });

        it('stops factory, lab, and planning work', function () {
            assert.equal(sim.total('factory', LOW_FROM, LOW_UNTIL - 1), 0);
            assert.equal(sim.total('reacted', LOW_FROM, LOW_UNTIL - 1), 0);
            assert.equal(sim.total('sitesPlaced', LOW_FROM, LOW_UNTIL - 1), 0);
        });

        it('keeps creeps working and being replaced', function () {
            assert.ok(sim.total('harvested', LOW_FROM, LOW_UNTIL) > 0);
            assert.ok(sim.total('hauled', LOW_FROM, LOW_UNTIL) > 0);
            assert.ok(sim.total('upgraded', LOW_FROM, LOW_UNTIL) > 0);
            ['Miner', 'Storekeeper', 'Upgrader'].forEach(role => assert.ok(creepsAtEnd.includes(role), role + ' alive at tick ' + LOW_UNTIL));
        });

        it('picks the labs up again once the bucket recovers, with the same goal and nothing blocked', function () {
            assert.ok(goalBefore, 'a goal was running when the bucket fell');
            assert.ok(goalAfter, 'it is still there');
            assert.equal(goalAfter.resourceType, goalBefore.resourceType);
            assert.equal(goalAfter.startedAt, goalBefore.startedAt, 'the same goal, not a new one');
            assert.deepEqual(blockedAfter, {});
            assert.ok(sim.total('reacted', LOW_UNTIL) > 0, 'the labs resumed');
            assert.deepEqual(sim.errors, []);
        });
    });
});
