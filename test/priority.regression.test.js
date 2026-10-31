const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const DefenseManager = require('../manager.defense');
const LogisticsManager = require('../manager.logistics');
const MainCache = require('../main.cache');
const MainMove = require('../main.move');
const MayorManager = require('../manager.mayor');
const TowerManager = require('../manager.tower');
const config = require('../main.config');
const Upgrader = require('../role.upgrader');

function plainRoom(options = {}) {
    const room = makeRoom('A', { memory: { base: { name: 'A', roleConfig: {} }, defense: {} }, energyAvailable: options.energy === undefined ? 300 : options.energy, energyCapacityAvailable: options.capacity || 300 });
    room.controller = { my: true, level: options.level || 5, pos: makePosition(room, 25, 25), id: 'controller', safeModeAvailable: 1, safeModeCooldown: 0 };
    Game.rooms.A = room;
    return room;
}

function hostile(room, parts, x, y, boost) {
    const body = [];
    Object.entries(parts).forEach(([type, count]) => {
        for (let index = 0; index < count; index++) body.push({ type, hits: 100, boost });
    });
    return {
        id: 'hostile-' + Math.random().toString(36).slice(2), room, body, pos: makePosition(room, x, y), owner: { username: 'Enemy' }, hits: 1000, hitsMax: 1000,
        getActiveBodyparts(type) {
            return this.body.filter(part => part.type === type && part.hits > 0).length;
        },
    };
}

describe('Behaviour the audit found no test would notice breaking', function () {
    beforeEach(function () {
        resetScreeps();
        Memory.creeps = {};
    });

    describe('threat scoring', function () {
        it('scores a hostile higher the closer it gets to the core', function () {
            const room = plainRoom();
            const spawn = makeSpawn(room, { pos: makePosition(room, 25, 25) });
            setFind(room, FIND_MY_SPAWNS, [spawn]);
            const manager = new DefenseManager(room);
            const far = manager._assessThreat([hostile(room, { [ATTACK]: 1 }, 25, 2)]);
            const near = manager._assessThreat([hostile(room, { [ATTACK]: 1 }, 25, 20)]);
            assert.ok(near.score > far.score);
        });

        it('scores a boosted hostile higher than a plain one', function () {
            const room = plainRoom();
            const plain = DefenseManager._getThreatScore(hostile(room, { [ATTACK]: 2 }, 10, 10));
            const boosted = DefenseManager._getThreatScore(hostile(room, { [ATTACK]: 2 }, 10, 10, 'XUH2O'));
            assert.equal(boosted, plain * config.DEFENSE.BOOSTED_THREAT_MULTIPLIER);
        });

        it('calls a weak hostile with no attack parts a level 1 threat, and a strong one level 2', function () {
            const room = plainRoom();
            const manager = new DefenseManager(room);
            assert.equal(manager._assessThreat([hostile(room, { [MOVE]: 1 }, 3, 3)]).level, 1);
            assert.equal(manager._assessThreat([hostile(room, { [ATTACK]: 1 }, 3, 3)]).level, 2);
        });

        it('calls a hostile at the core level 3', function () {
            const room = plainRoom();
            const spawn = makeSpawn(room, { pos: makePosition(room, 25, 25) });
            setFind(room, FIND_MY_SPAWNS, [spawn]);
            assert.equal(new DefenseManager(room)._assessThreat([hostile(room, { [ATTACK]: 1 }, 26, 26)]).level, 3);
        });

        it('asks for Defenders from level 2, and for none below it', function () {
            const room = plainRoom();
            const manager = new DefenseManager(room);
            manager._coordinateDefenders({ level: 1, score: 10, healerCount: 0, preferredStyle: 'melee' });
            assert.equal(manager._memory.desiredDefenders, 0);
            manager._coordinateDefenders({ level: 2, score: 10, healerCount: 0, preferredStyle: 'melee' });
            assert.equal(manager._memory.desiredDefenders, 1);
            manager._coordinateDefenders({ level: 2, score: config.DEFENSE.SECOND_DEFENDER_SCORE + 1, healerCount: 0, preferredStyle: 'melee' });
            assert.equal(manager._memory.desiredDefenders, 2);
        });
    });

    describe('estimating enemy healing', function () {
        it('counts the real boost factor from the engine table', function () {
            const room = plainRoom();
            const target = hostile(room, { [ATTACK]: 1 }, 10, 10);
            const plain = hostile(room, { [HEAL]: 2 }, 11, 10);
            const boosted = hostile(room, { [HEAL]: 2 }, 11, 10, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE);
            assert.equal(DefenseManager._estimateHealing(target, [plain]), 2 * HEAL_POWER);
            assert.equal(DefenseManager._estimateHealing(target, [boosted]), 2 * HEAL_POWER * BOOSTS[HEAL][RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE].heal);
        });

        it('uses ranged healing beyond one tile, and no healing beyond three', function () {
            const room = plainRoom();
            const target = hostile(room, { [ATTACK]: 1 }, 10, 10);
            assert.equal(DefenseManager._estimateHealing(target, [hostile(room, { [HEAL]: 1 }, 13, 10)]), RANGED_HEAL_POWER);
            assert.equal(DefenseManager._estimateHealing(target, [hostile(room, { [HEAL]: 1 }, 14, 10)]), 0);
        });

        it('does not count a HEAL part that has been shot off', function () {
            const room = plainRoom();
            const target = hostile(room, { [ATTACK]: 1 }, 10, 10);
            const healer = hostile(room, { [HEAL]: 2, [MOVE]: 1 }, 11, 10);
            healer.body[0].hits = 0;
            assert.equal(DefenseManager._estimateHealing(target, [healer]), HEAL_POWER);
        });
    });

    describe('keeping to one target', function () {
        it('stays on the saved target while it is here', function () {
            const room = plainRoom();
            const first = registerObject(hostile(room, { [ATTACK]: 1 }, 10, 10), 'A');
            const second = registerObject(hostile(room, { [ATTACK]: 1 }, 12, 10), 'A');
            setFind(room, FIND_HOSTILE_CREEPS, [first, second]);
            room.memory.defense.primaryTargetId = second.id;
            assert.equal(DefenseManager.getPriorityTarget(room), second);
        });

        it('moves on when the saved target has left the room', function () {
            const room = plainRoom();
            const here = registerObject(hostile(room, { [ATTACK]: 1 }, 10, 10), 'A');
            const other = makeRoom('B');
            Game.rooms.B = other;
            const gone = registerObject(hostile(other, { [ATTACK]: 1 }, 10, 10), 'B');
            setFind(room, FIND_HOSTILE_CREEPS, [here]);
            room.memory.defense.primaryTargetId = gone.id;
            assert.equal(DefenseManager.getPriorityTarget(room), here);
        });

        it('moves on when the saved target is dead', function () {
            const room = plainRoom();
            const here = registerObject(hostile(room, { [ATTACK]: 1 }, 10, 10), 'A');
            setFind(room, FIND_HOSTILE_CREEPS, [here]);
            room.memory.defense.primaryTargetId = 'dead';
            assert.equal(DefenseManager.getPriorityTarget(room), here);
        });
    });

    describe('deciding on safe mode', function () {
        function breachedRoom() {
            const room = plainRoom();
            const intruder = hostile(room, { [ATTACK]: 2 }, 26, 26);
            setFind(room, FIND_HOSTILE_CREEPS, [intruder]);
            return room;
        }

        it('does not mistake another building for a tower', function () {
            const room = breachedRoom();
            const lab = makeStructure(room, STRUCTURE_LAB, { store: makeStore(1000, { [RESOURCE_ENERGY]: 1000 }), extra: { my: true } });
            setFind(room, FIND_MY_STRUCTURES, [lab]);
            setFind(room, FIND_MY_CREEPS, []);
            assert.equal(new DefenseManager(room)._hasAdequateDefense({ score: 100 }), false);
        });

        it('counts a tower that can beat the target', function () {
            const room = breachedRoom();
            const value = makeStructure(room, STRUCTURE_TOWER, { pos: makePosition(room, 27, 27), store: makeStore(1000, { [RESOURCE_ENERGY]: 1000 }), extra: { my: true } });
            setFind(room, FIND_MY_STRUCTURES, [value]);
            setFind(room, FIND_MY_CREEPS, []);
            assert.equal(new DefenseManager(room)._hasAdequateDefense({ score: 100 }), true);
        });
    });

    describe('healer Defenders', function () {
        it('walk to a hurt creep out of reach, and stay when they can heal it', function () {
            const Defender = require('../role.defender');
            const room = plainRoom();
            const hurt = makeCreep(room, { name: 'hurt', pos: makePosition(room, 20, 20), hits: 10, hitsMax: 100 });
            setFind(room, FIND_MY_CREEPS, [hurt]);
            const role = new Defender();
            role._baseRoom = room;
            const far = makeCreep(room, { name: 'far', pos: makePosition(room, 30, 30), body: [HEAL, MOVE] });
            role._support(far);
            assert.equal(far.lastMoveTo, hurt);
            const near = makeCreep(room, { name: 'near', pos: makePosition(room, 21, 20), body: [HEAL, MOVE] });
            role._support(near);
            assert.equal(near.lastMoveTo, undefined);
            assert.equal(near.healed, hurt);
        });
    });

    describe('tower energy', function () {
        function towerWith(room, energy) {
            const calls = { heal: 0, repair: 0, attack: 0 };
            const value = makeStructure(room, STRUCTURE_TOWER, {
                id: 'tower', pos: makePosition(room, 25, 25), store: makeStore(1000, { [RESOURCE_ENERGY]: energy }),
                extra: {
                    my: true,
                    heal() { calls.heal++; return OK; },
                    repair() { calls.repair++; return OK; },
                    attack() { calls.attack++; return OK; },
                },
            });
            setFind(room, FIND_MY_STRUCTURES, [value]);
            return calls;
        }

        function damaged(room) {
            const creep = makeCreep(room, { name: 'hurt', hits: 10, hitsMax: 100 });
            setFind(room, FIND_MY_CREEPS, [creep]);
        }

        it('keeps its reserve instead of healing', function () {
            const room = plainRoom();
            const calls = towerWith(room, config.DEFENSE.TOWER_ENERGY_RESERVE);
            damaged(room);
            new TowerManager(room).runTowers();
            assert.equal(calls.heal, 0);
        });

        it('heals once it has energy above the reserve', function () {
            const room = plainRoom();
            const calls = towerWith(room, config.DEFENSE.TOWER_ENERGY_RESERVE + TOWER_ENERGY_COST);
            damaged(room);
            new TowerManager(room).runTowers();
            assert.equal(calls.heal, 1);
        });

        it('still attacks from inside the reserve, which is what the reserve is for', function () {
            const room = plainRoom();
            const calls = towerWith(room, TOWER_ENERGY_COST);
            setFind(room, FIND_HOSTILE_CREEPS, [hostile(room, { [ATTACK]: 1 }, 28, 25)]);
            setFind(room, FIND_MY_CREEPS, []);
            new TowerManager(room).runTowers();
            assert.equal(calls.attack, 1);
        });
    });

    describe('hauling priorities', function () {
        function taskRoom(tasks) {
            const room = plainRoom();
            room.memory.logistics = { tasks };
            const creep = makeCreep(room, { name: 'sk', pos: makePosition(room, 25, 25), capacity: 100 });
            Game.creeps.sk = creep;
            return { room, creep };
        }

        const task = (id, extra) => Object.assign({ id, sourceId: 'src-' + id, targetId: 'dst-' + id, resourceType: RESOURCE_ENERGY, remaining: 100, priority: 50, state: 'open', retryAfter: 0, created: 1, assignedCreep: null }, extra);

        it('serves the highest priority first, so spawns fill before anything else', function () {
            const { creep } = taskRoom([task('low', { priority: 10 }), task('core', { priority: config.LOGISTICS.PRIORITY.CORE }), task('mid', { priority: 50 })]);
            assert.equal(LogisticsManager.assignTask(creep).id, 'core');
        });

        it('skips tasks that are taken, finished, unavailable or backing off', function () {
            const { creep } = taskRoom([
                task('taken', { priority: 99, assignedCreep: 'other' }),
                task('done', { priority: 98, remaining: 0 }),
                task('gone', { priority: 97, state: 'unavailable' }),
                task('waiting', { priority: 96, retryAfter: Game.time + 10 }),
                task('free', { priority: 1 }),
            ]);
            assert.equal(LogisticsManager.assignTask(creep).id, 'free');
        });

        it('only gives a Storekeeper energy', function () {
            const { creep } = taskRoom([task('oxygen', { priority: 99, resourceType: RESOURCE_OXYGEN }), task('energy', { priority: 1 })]);
            assert.equal(LogisticsManager.assignTask(creep, { resourceType: RESOURCE_ENERGY }).id, 'energy');
        });

        it('breaks a tie by distance to the pickup', function () {
            const { room, creep } = taskRoom([task('far'), task('near')]);
            const place = (id, x) => registerObject(makeStructure(room, STRUCTURE_CONTAINER, { id, pos: makePosition(room, x, 25) }), 'A');
            place('src-far', 45);
            place('src-near', 27);
            assert.equal(LogisticsManager.assignTask(creep).id, 'near');
        });

        it('refills from the nearest store', function () {
            const room = plainRoom();
            const near = makeStructure(room, STRUCTURE_CONTAINER, { id: 'near', pos: makePosition(room, 27, 25), store: makeStore(2000, { [RESOURCE_ENERGY]: 100 }) });
            const far = makeStructure(room, STRUCTURE_CONTAINER, { id: 'far', pos: makePosition(room, 45, 25), store: makeStore(2000, { [RESOURCE_ENERGY]: 100 }) });
            setFind(room, FIND_STRUCTURES, [far, near]);
            const target = makeStructure(room, STRUCTURE_EXTENSION, { id: 'ext', pos: makePosition(room, 25, 25) });
            assert.equal(new LogisticsManager(room)._findBestResourceSourceFor(target, RESOURCE_ENERGY), near);
        });
    });

    describe('spawn timing', function () {
        it('starts a replacement earlier for a bigger body', function () {
            const room = plainRoom();
            const role = new Upgrader();
            const small = makeCreep(room, { name: 's', body: [WORK, CARRY, MOVE], ticksToLive: 100 });
            const large = makeCreep(room, { name: 'l', body: new Array(50).fill(WORK), ticksToLive: 100 });
            assert.equal(role.needsReplacement(small), false);
            assert.equal(role.needsReplacement(large), true);
        });

        it('does not use one spawn twice in a tick', function () {
            const room = plainRoom({ energy: 2000, capacity: 2000 });
            const spawn = makeSpawn(room, { name: 'Spawn1', memory: { home: 'A' } });
            spawn.spawnCreep = function (body, name, options) {
                Game.creeps[name] = makeCreep(this.room, { name, body, memory: options.memory, spawning: true });
                return OK; // the engine only marks a spawn as busy from the next tick
            };
            Game.spawns.Spawn1 = spawn;
            MainCache.initRound([]);
            assert.equal(MainCache.getFreeSpawns('A').length, 1);
            const role = new Upgrader();
            assert.ok(role.spawnCreep(spawn));
            assert.equal(MainCache.getFreeSpawns('A').length, 0);
        });
    });

    describe('movement', function () {
        it('does not count waiting out fatigue as being stuck', function () {
            const room = plainRoom();
            const creep = makeCreep(room, { name: 'heavy', pos: makePosition(room, 5, 5) });
            creep.fatigue = 10;
            Game.creeps.heavy = creep;
            const target = makePosition(room, 40, 5);
            for (let tick = 0; tick < 10; tick++) {
                MainMove.to(creep, target);
                assert.equal(creep.moveOptions.ignoreCreeps, true, 'tick ' + tick);
                Game.time++;
            }
        });
    });

    describe('planning', function () {
        it('counts only non-road sites against the open-site limit', function () {
            const room = plainRoom({ level: 5 });
            room.memory.mayor = { mode: 'auto' };
            const spawn = makeSpawn(room, { pos: makePosition(room, 25, 25) });
            setFind(room, FIND_MY_SPAWNS, [spawn]);
            const roadSites = [0, 1, 2, 3].map(index => ({ id: 'road' + index, structureType: STRUCTURE_ROAD, pos: makePosition(room, 10 + index, 10), progress: 0, progressTotal: 300 }));
            setFind(room, FIND_CONSTRUCTION_SITES, roadSites);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, roadSites);
            const mayor = new MayorManager(room);
            mayor.run();
            assert.ok(mayor.warnings.some(warning => /Buildable structure/.test(warning.text)), 'roads alone do not stop other building');
        });

        it('stops placing buildings at the open-site limit', function () {
            const room = plainRoom({ level: 5 });
            room.memory.mayor = { mode: 'auto' };
            const spawn = makeSpawn(room, { pos: makePosition(room, 25, 25) });
            setFind(room, FIND_MY_SPAWNS, [spawn]);
            const sites = [0, 1].map(index => ({ id: 'ext' + index, structureType: STRUCTURE_EXTENSION, pos: makePosition(room, 10 + index, 10), progress: 0, progressTotal: 3000 }));
            setFind(room, FIND_CONSTRUCTION_SITES, sites);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, sites);
            const mayor = new MayorManager(room);
            mayor.run();
            assert.ok(!mayor.warnings.some(warning => /Buildable structure/.test(warning.text)));
        });

        it('keeps a third lab within reaction range of the first two', function () {
            const room = plainRoom({ level: 6 });
            const spawn = makeSpawn(room, { pos: makePosition(room, 25, 25) });
            setFind(room, FIND_MY_SPAWNS, [spawn]);
            const first = makeStructure(room, STRUCTURE_LAB, { id: 'lab1', pos: makePosition(room, 30, 30), extra: { my: true } });
            const second = makeStructure(room, STRUCTURE_LAB, { id: 'lab2', pos: makePosition(room, 31, 30), extra: { my: true } });
            setFind(room, FIND_MY_STRUCTURES, [first, second]);
            setFind(room, FIND_STRUCTURES, [first, second]);
            const position = new MayorManager(room)._findSmartPlacementPosition(STRUCTURE_LAB);
            assert.ok(position.inRangeTo(first.pos, 2));
            assert.ok(position.inRangeTo(second.pos, 2));
        });

        it('does not build a power spawn or observer that no code uses, unless asked', function () {
            const room = plainRoom({ level: 8 });
            room.memory.mayor = {};
            const mayor = new MayorManager(room);
            mayor._memory = room.memory.mayor;
            assert.equal(mayor._isStructureEnabled(STRUCTURE_POWER_SPAWN), false);
            assert.equal(mayor._isStructureEnabled(STRUCTURE_OBSERVER), false);
            room.memory.mayor.enablePowerSpawn = true;
            assert.equal(mayor._isStructureEnabled(STRUCTURE_POWER_SPAWN), true);
        });

        it('still builds roads in an automatic room with no stored Builder count', function () {
            const RoadManager = require('../manager.road');
            const room = plainRoom({ level: 3 });
            room.memory.mayor = { mode: 'auto' };
            room.memory.base.roleConfig.Builder = { requiredNumber: 0 };
            const original = RoadManager.prototype.fetchPositionsOverThreshold;
            const mayor = new MayorManager(room);
            mayor._cache = { myCreeps: [{}], constructionSites: [], roadConstructionSites: null };
            mayor.warnings = [];
            RoadManager.prototype.fetchPositionsOverThreshold = () => [makePosition(room, 10, 10)];
            try {
                mayor._validateRoads();
            } finally {
                RoadManager.prototype.fetchPositionsOverThreshold = original;
            }
            assert.ok(mayor.warnings.some(warning => warning.text === 'Roads are missing.'));
        });
    });
});
