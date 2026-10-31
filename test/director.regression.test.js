const assert = require('node:assert/strict');
const {
    makeRoom, makeStore, makeLab, makeCreep, makePosition, setFind, resetScreeps, makeStructure,
} = require('./helpers/screeps');
const MainHeap = require('../main.heap');
const MainUtil = require('../main.util');
const allConfig = require('../main.config');
const Director = require('../manager.director');

const config = allConfig.DIRECTOR;
const ENTER_RCL_8 = config.STOCKPILE_ENTER[8];
const EXIT_RCL_8 = ENTER_RCL_8 + config.STOCKPILE_EXIT_MARGIN;

function baseRoom(options = {}) {
    const room = makeRoom('W1N1', { memory: { base: { name: 'W1N1', roleConfig: {} } } });
    room.controller = { my: true, level: options.level === undefined ? 8 : options.level, pos: makePosition(room, 40, 40) };
    if (options.energy !== undefined) {
        room.storage = makeStructure(room, STRUCTURE_STORAGE, { store: makeStore(1000000, Object.assign({ [RESOURCE_ENERGY]: options.energy }, options.contents)) });
    }
    Game.rooms.W1N1 = room;
    return room;
}

function setEnergy(room, energy) {
    room.storage.store.set(RESOURCE_ENERGY, energy);
}

// the next tick on which this room looks at its economic goal
function toEvaluationTick() {
    do Game.time++; while (!MainUtil.isRoomsTurn('W1N1', config.EVALUATE_INTERVAL));
}

function evaluate() {
    toEvaluationTick();
    Director.runAll();
}

function hostile(room, body) {
    return makeCreep(room, { name: 'raider', owner: { username: 'Raider' }, body, pos: makePosition(room, 10, 10) });
}

describe('Director', function () {
    beforeEach(function () {
        resetScreeps();
    });

    describe('stockpile trigger', function () {
        it('starts in UPGRADE with plenty of energy', function () {
            const room = baseRoom({ energy: 500000 });
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });

        it('moves to STOCKPILE below the threshold, and only on the turn of the room', function () {
            const room = baseRoom({ energy: 500000 });
            evaluate();
            setEnergy(room, ENTER_RCL_8 - 1);
            Game.time++;
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE, 'not its turn yet');
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_STOCKPILE);
        });

        it('does not flip-flop: it returns to UPGRADE only above the entry level plus the margin', function () {
            const room = baseRoom({ energy: ENTER_RCL_8 - 1 });
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_STOCKPILE);
            setEnergy(room, EXIT_RCL_8 - 1);
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_STOCKPILE, 'inside the band it keeps saving');
            setEnergy(room, EXIT_RCL_8);
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
            setEnergy(room, EXIT_RCL_8 - 1);
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE, 'inside the band it keeps spending');
        });

        it('counts the terminal, so that moving stock between the two is not a loss', function () {
            const room = baseRoom({ energy: ENTER_RCL_8 - 1 });
            room.terminal = makeStructure(room, STRUCTURE_TERMINAL, { store: makeStore(300000, { [RESOURCE_ENERGY]: 100 }) });
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });

        it('leaves a young room alone, or it could never save up to the RCL 8 line', function () {
            const room = baseRoom({ level: 4, energy: config.STOCKPILE_ENTER[4] + 1 });
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });

        it('never stockpiles without a storage', function () {
            const room = baseRoom({ level: 3 });
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });

        it('waits for a normal CPU tier', function () {
            const room = baseRoom({ energy: 500000 });
            evaluate();
            setEnergy(room, 1);
            Game.cpu.bucket = 100;
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });
    });

    describe('defense trigger', function () {
        it('reacts on the same tick, in any CPU tier, to a body that can do harm', function () {
            const room = baseRoom({ energy: 500000 });
            Director.runAll();
            setFind(room, FIND_HOSTILE_CREEPS, [hostile(room, [ATTACK, MOVE])]);
            Game.cpu.bucket = 100;
            Game.time++;
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_DEFENSE);
        });

        it('does not stop the economy for a scout', function () {
            const room = baseRoom({ energy: 500000 });
            setFind(room, FIND_HOSTILE_CREEPS, [hostile(room, [MOVE])]);
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });

        it('stands down only after the room has been clear for a while, and into the right goal', function () {
            const room = baseRoom({ energy: ENTER_RCL_8 - 1 });
            setFind(room, FIND_HOSTILE_CREEPS, [hostile(room, [ATTACK, MOVE])]);
            Director.runAll();
            setFind(room, FIND_HOSTILE_CREEPS, []);
            Game.time += config.DEFENSE_CLEAR_TICKS - 1;
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_DEFENSE);
            Game.time++;
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_STOCKPILE, 'energy is still low');
        });

        it('starts wall repairs when a defense ends, if the room uses fortification', function () {
            const room = baseRoom({ energy: 500000 });
            room.memory.mayor = { enableFortification: true };
            setFind(room, FIND_STRUCTURES, [makeStructure(room, STRUCTURE_RAMPART, { hits: 1 })]);
            setFind(room, FIND_HOSTILE_CREEPS, [hostile(room, [ATTACK, MOVE])]);
            Director.runAll();
            setFind(room, FIND_HOSTILE_CREEPS, []);
            Game.time += config.DEFENSE_CLEAR_TICKS;
            Director.runAll();
            assert.ok(Director.hasMission(room, Director.MISSION_REBUILD_WALLS));
            assert.equal(Director.getPlan(room).wallsFirst, true);
        });
    });

    describe('expand trigger', function () {
        function ready(room) {
            Game.gcl = { level: 2 };
            Game.flags.Expand = { name: 'Expand', pos: makePosition({ name: 'W2N2' }, 25, 25), memory: {} };
            return room;
        }

        it('needs RCL 8, spare energy, a full bucket, GCL and a flag', function () {
            const room = ready(baseRoom({ energy: config.EXPAND_MIN_ENERGY }));
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_EXPAND);
            assert.equal(Director.getPlan(room).expand, true);
            assert.ok(Director.hasMission(room, Director.MISSION_CLAIM_ROOM));
        });

        [
            ['the GCL pays for no more rooms', () => { Game.gcl.level = 1; }],
            ['the bucket is not full', () => { Game.cpu.bucket = config.EXPAND_BUCKET - 1; }],
            ['no flag says where to go', () => { delete Game.flags.Expand; }],
        ].forEach(([reason, spoil]) => {
            it('stays in UPGRADE when ' + reason, function () {
                const room = ready(baseRoom({ energy: config.EXPAND_MIN_ENERGY }));
                spoil();
                evaluate();
                assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
            });
        });

        it('lets only one room expand at a time', function () {
            const room = ready(baseRoom({ energy: config.EXPAND_MIN_ENERGY }));
            Game.gcl.level = 5;
            MainHeap.namespace('director').W9N9 = { goal: Director.GOAL_EXPAND, missions: [], plan: Director.getPlan(room), retryAfter: {} };
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });
    });

    describe('missions and plans', function () {
        function labRoom(contents) {
            const room = baseRoom({ energy: 500000, contents });
            const lab = makeLab(room, { id: 'lab', pos: makePosition(room, 25, 25) });
            setFind(room, FIND_MY_STRUCTURES, [lab]);
            return { room, lab };
        }

        it('keeps towers above lab loading, and both above the core, during a defense', function () {
            const { room } = labRoom({ [RESOURCE_CATALYZED_UTRIUM_ACID]: 900 });
            setFind(room, FIND_HOSTILE_CREEPS, [hostile(room, [ATTACK, MOVE])]);
            Director.runAll();
            const core = allConfig.LOGISTICS.PRIORITY.CORE;
            const tower = Director.getLogisticsPriority(room, 'TOWER_UNDER_ATTACK', 0);
            const lab = Director.getLogisticsPriority(room, 'LAB_BOOST', 0);
            assert.ok(tower > lab && lab > core, tower + ' > ' + lab + ' > ' + core);
            assert.equal(Director.getPlan(room).labReactions, false);
            assert.equal(Director.getPlan(room).haltSpending, true);
            assert.deepEqual(Director.getPlan(room).preload, [{ resourceType: RESOURCE_CATALYZED_UTRIUM_ACID, amount: 900 }]);
        });

        it('starts no boost mission for compounds the room does not hold', function () {
            const { room } = labRoom({});
            setFind(room, FIND_HOSTILE_CREEPS, [hostile(room, [ATTACK, MOVE])]);
            Director.runAll();
            assert.equal(Director.hasMission(room, Director.MISSION_BOOST_QUEUE), false);
        });

        it('ends the upgrade boost mission once the compound is loaded, and lets reactions run meanwhile', function () {
            const { room, lab } = labRoom({ [RESOURCE_CATALYZED_GHODIUM_ACID]: 900 });
            room.memory.lab = { boosts: { Upgrader: { [WORK]: RESOURCE_CATALYZED_GHODIUM_ACID } } };
            Director.runAll();
            assert.ok(Director.hasMission(room, Director.MISSION_BOOST_QUEUE));
            assert.equal(Director.getPlan(room).labReactions, true, 'or the compound could never be made');
            assert.equal(Director.getLogisticsPriority(room, 'LAB_BOOST', 0), config.LAB_BOOST_PRIORITY);

            lab.store.set(RESOURCE_CATALYZED_GHODIUM_ACID, 900);
            do Game.time++; while (!MainUtil.isRoomsTurn('W1N1', config.MISSION_INTERVAL));
            Director.runAll();
            assert.equal(Director.hasMission(room, Director.MISSION_BOOST_QUEUE), false);
            assert.equal(Director.getLogisticsPriority(room, 'LAB_BOOST', 72), 72, 'the override ends with the mission');
        });

        it('gives up on a mission at its time limit and does not restart it at once', function () {
            const { room } = labRoom({ [RESOURCE_CATALYZED_GHODIUM_ACID]: 900 });
            room.memory.lab = { boosts: { Upgrader: { [WORK]: RESOURCE_CATALYZED_GHODIUM_ACID } } };
            Director.runAll();
            Game.time += 1500;
            do Game.time++; while (!MainUtil.isRoomsTurn('W1N1', config.MISSION_INTERVAL));
            Director.runAll();
            assert.equal(Director.hasMission(room, Director.MISSION_BOOST_QUEUE), false);
        });

        it('does not sell anything unless the room has the market switched on', function () {
            const room = baseRoom({ energy: 1 });
            room.terminal = makeStructure(room, STRUCTURE_TERMINAL, { store: makeStore(300000) });
            evaluate();
            assert.equal(Director.getGoal(room), Director.GOAL_STOCKPILE);
            assert.equal(Director.getPlan(room).marketDump, false);

            room.memory.market = { enabled: true };
            do Game.time++; while (!MainUtil.isRoomsTurn('W1N1', config.MISSION_INTERVAL));
            Director.runAll();
            assert.equal(Director.getPlan(room).marketDump, true);
        });

        it('caps what a stockpiling room derives, but life-support roles stay uncapped', function () {
            const room = baseRoom({ energy: 1 });
            evaluate();
            assert.equal(Director.getSpawnCap(room, 'Upgrader', 5), 1);
            assert.equal(Director.getSpawnCap(room, 'Builder', 3), 1);
            ['Miner', 'Storekeeper', 'Harvester', 'Defender'].forEach(role => assert.equal(Director.getSpawnCap(room, role, 4), 4, role));
        });

        it('does not compress energy while short of it', function () {
            const room = baseRoom({ energy: 1 });
            evaluate();
            assert.equal(Director.getPlan(room).factory, Director.FACTORY_DECOMPRESS);
        });
    });

    describe('state', function () {
        it('keeps only the goal in Memory, and writes it only when it changes', function () {
            const room = baseRoom({ energy: 500000 });
            Director.runAll();
            assert.equal(room.memory.director, undefined, 'nothing to save yet');
            setEnergy(room, 1);
            evaluate();
            assert.deepEqual(room.memory.director, { goal: Director.GOAL_STOCKPILE });
            const saved = room.memory.director;
            evaluate();
            assert.equal(room.memory.director, saved, 'the same object: no write');
        });

        it('keeps the goal across a global reset, inside the band too, and starts its missions again', function () {
            const room = baseRoom({ energy: 1 });
            room.terminal = makeStructure(room, STRUCTURE_TERMINAL, { store: makeStore(300000) });
            room.memory.market = { enabled: true };
            evaluate();
            setEnergy(room, EXIT_RCL_8 - 1);
            MainHeap.reset();
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_STOCKPILE);
            assert.ok(Director.hasMission(room, Director.MISSION_MARKET_DUMP));
        });

        it('treats a stored goal it does not know as the default', function () {
            const room = baseRoom({ energy: 500000 });
            room.memory.director = { goal: 'nonsense' };
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });

        it('stays defending through a reset until the room has been clear for the full time', function () {
            const room = baseRoom({ energy: 500000 });
            room.memory.director = { goal: Director.GOAL_DEFENSE };
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_DEFENSE);
            Game.time += config.DEFENSE_CLEAR_TICKS;
            Director.runAll();
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
        });

        it('never changes the shared config: a plan belongs to one room', function () {
            const before = JSON.stringify(allConfig.LOGISTICS.PRIORITY);
            const room = baseRoom({ energy: 500000 });
            setFind(room, FIND_HOSTILE_CREEPS, [hostile(room, [ATTACK, MOVE])]);
            Director.runAll();
            assert.equal(JSON.stringify(allConfig.LOGISTICS.PRIORITY), before);
        });

        it('gives a room with no state the default plan, which changes nothing', function () {
            const room = baseRoom({ energy: 500000 });
            assert.equal(Director.getGoal(room), Director.GOAL_UPGRADE);
            assert.equal(Director.getLogisticsPriority(room, 'CORE', 100), 100);
            assert.equal(Director.getSpawnCap(room, 'Upgrader', 5), 5);
            assert.equal(Director.getPlan(room).labReactions, true);
        });

        it('freezes plans, so that no manager can change one for the others', function () {
            const room = baseRoom({ energy: 500000 });
            Director.runAll();
            assert.ok(Object.isFrozen(Director.getPlan(room)));
        });

        it('skips rooms that are not bases, and carries on past a room that throws', function () {
            baseRoom({ energy: 500000 });
            const broken = makeRoom('W9N9', { memory: { base: { name: 'W9N9' } } });
            broken.controller = { my: true, level: 8 };
            Object.defineProperty(broken, 'storage', { get() { throw new Error('injected'); } });
            Game.rooms.W9N9 = broken;
            Game.rooms.W5N5 = makeRoom('W5N5');
            const second = makeRoom('W2N2', { memory: { base: { name: 'W2N2' } } });
            second.controller = { my: true, level: 1 };
            Game.rooms.W2N2 = second;
            const originalConsoleLog = console.log;
            console.log = () => {};
            try {
                for (let tick = 0; tick < config.EVALUATE_INTERVAL * 2; tick++) {
                    Game.time++;
                    assert.doesNotThrow(() => Director.runAll());
                }
            } finally {
                console.log = originalConsoleLog;
            }
            assert.equal(MainHeap.namespace('director').W5N5, undefined);
            assert.ok(MainHeap.namespace('director').W2N2);
        });
    });
});
