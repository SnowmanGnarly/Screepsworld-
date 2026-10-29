const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const MainCache = require('../main.cache');
const DefenseManager = require('../manager.defense');
const TowerManager = require('../manager.tower');
const Defender = require('../role.defender');

function defenseRoom() {
    const room = makeRoom('A', {
        memory: { base: { name: 'A', roleConfig: {} }, defense: {} },
    });
    room.controller = {
        my: true,
        level: 5,
        pos: makePosition(room, 25, 25),
        safeModeAvailable: 1,
        safeModeCooldown: 0,
        activateSafeMode() {
            this.activations = (this.activations || 0) + 1;
            return OK;
        },
    };
    Game.rooms.A = room;
    return room;
}

function hostile(room, parts, position, boosted = false) {
    const body = [];
    Object.entries(parts).forEach(([type, count]) => {
        for (let index = 0; index < count; index++) {
            body.push({ type, hits: 100, boost: boosted ? 'XGH2O' : undefined });
        }
    });
    return {
        id: 'hostile-' + Math.random().toString(36).slice(2),
        room,
        body,
        pos: position,
        owner: { username: 'Enemy' },
        getActiveBodyparts(type) {
            return this.body.filter(part => part.type === type && part.hits > 0).length;
        },
    };
}

function tower(room, position, energy = 1000) {
    return makeStructure(room, STRUCTURE_TOWER, {
        id: 'tower-' + Math.random().toString(36).slice(2),
        pos: position,
        store: makeStore(1000, { [RESOURCE_ENERGY]: energy }),
        extra: {
            attacks: [],
            repairs: [],
            heals: [],
            attack(target) { this.attacks.push(target); return OK; },
            repair(target) { this.repairs.push(target); return OK; },
            heal(target) { this.heals.push(target); return OK; },
        },
    });
}

describe('Defense reliability regressions', function () {
    beforeEach(function () {
        resetScreeps();
    });

    it('does not activate Safe Mode while critical structures remain protected', function () {
        const room = defenseRoom();
        const spawn = makeStructure(room, STRUCTURE_SPAWN, { id: 'spawn', pos: makePosition(room, 25, 25) });
        const rampart = makeStructure(room, STRUCTURE_RAMPART, { id: 'rampart', pos: spawn.pos, hits: 100000, hitsMax: 300000 });
        const defenderTower = tower(room, makePosition(room, 24, 25));
        const invader = hostile(room, { [ATTACK]: 4 }, makePosition(room, 26, 25));
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, [rampart, defenderTower]);
        setFind(room, FIND_MY_CREEPS, []);
        const manager = new DefenseManager(room);
        const report = manager._assessThreat([invader]);
        assert.equal(report.level, 3);
        manager._evaluateSafeMode(report, [invader]);
        assert.equal(room.controller.activations, undefined);
    });

    it('allows Safe Mode for an unprotected critical breach', function () {
        const room = defenseRoom();
        const spawn = makeStructure(room, STRUCTURE_SPAWN, { id: 'spawn', pos: makePosition(room, 25, 25) });
        const invader = hostile(room, { [ATTACK]: 6 }, makePosition(room, 26, 25));
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, []);
        setFind(room, FIND_MY_CREEPS, []);
        const manager = new DefenseManager(room);
        const report = manager._assessThreat([invader]);
        manager._evaluateSafeMode(report, [invader]);
        assert.equal(room.controller.activations, 1);
    });

    it('does not treat a token defender as adequate against an overwhelming breach', function () {
        const room = defenseRoom();
        const spawn = makeStructure(room, STRUCTURE_SPAWN, { id: 'spawn', pos: makePosition(room, 25, 25) });
        const weakDefender = makeCreep(room, {
            body: [ATTACK], memory: { role: 'Defender' }, pos: makePosition(room, 24, 25),
        });
        weakDefender.getActiveBodyparts = function (type) {
            return this.body.filter(part => part === type || part.type === type).length;
        };
        const invader = hostile(room, { [ATTACK]: 12 }, makePosition(room, 26, 25), true);
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, []);
        setFind(room, FIND_MY_CREEPS, [weakDefender]);
        const manager = new DefenseManager(room);
        const report = manager._assessThreat([invader]);
        manager._evaluateSafeMode(report, [invader]);
        assert.equal(room.controller.activations, 1);
    });

    it('lets a tower repair instead of attacking beyond effective range', function () {
        const room = defenseRoom();
        const defenderTower = tower(room, makePosition(room, 10, 10));
        const rampart = makeStructure(room, STRUCTURE_RAMPART, {
            id: 'rampart', pos: makePosition(room, 11, 10), hits: 100, hitsMax: 300000,
        });
        const invader = hostile(room, { [ATTACK]: 2 }, makePosition(room, 45, 45));
        setFind(room, FIND_MY_STRUCTURES, [defenderTower, rampart]);
        setFind(room, FIND_HOSTILE_CREEPS, [invader]);
        setFind(room, FIND_MY_CREEPS, []);
        setFind(room, FIND_MY_SPAWNS, []);
        new TowerManager(room).runTowers();
        assert.equal(defenderTower.attacks.length, 0);
        assert.equal(defenderTower.repairs[0], rampart);
    });

    it('does not waste tower energy when enemy healing exceeds focused damage', function () {
        const room = defenseRoom();
        const defenderTower = tower(room, makePosition(room, 25, 25));
        const invader = hostile(room, { [HEAL]: 13 }, makePosition(room, 25, 25));
        invader.body.forEach(part => { part.boost = 'XLHO2'; });
        setFind(room, FIND_MY_STRUCTURES, [defenderTower]);
        setFind(room, FIND_HOSTILE_CREEPS, [invader]);
        setFind(room, FIND_MY_CREEPS, []);
        setFind(room, FIND_MY_SPAWNS, []);
        new TowerManager(room).runTowers();
        assert.equal(defenderTower.attacks.length, 0);
    });

    it('does not add storage to the cached spawn list when Safe Mode protects a spawnless room', function () {
        const room = defenseRoom();
        room.storage = makeStructure(room, STRUCTURE_STORAGE, { id: 'storage', pos: makePosition(room, 25, 25) });
        const invader = hostile(room, { [ATTACK]: 6 }, makePosition(room, 26, 25));
        setFind(room, FIND_HOSTILE_CREEPS, [invader]);
        setFind(room, FIND_MY_SPAWNS, []);
        setFind(room, FIND_MY_STRUCTURES, []);
        setFind(room, FIND_MY_CREEPS, []);
        new DefenseManager(room).run();
        assert.equal(room.controller.activations, 1);
        assert.deepEqual(MainCache.find(room, FIND_MY_SPAWNS), []);
    });

    it('alerts immediately and then honors the per-room rate limit', function () {
        const room = defenseRoom();
        const manager = new DefenseManager(room);
        const report = { level: 2, score: 300 };
        Game.time = 10;
        manager._handleAlerts(report);
        manager._handleAlerts(report);
        assert.equal(Game.notifications.length, 1);
        Game.time = 109;
        manager._handleAlerts(report);
        assert.equal(Game.notifications.length, 1);
        Game.time = 110;
        manager._handleAlerts(report);
        assert.equal(Game.notifications.length, 2);
    });

    it('rejects a saved target that is no longer in the defended room', function () {
        const room = defenseRoom();
        const outside = hostile(makeRoom('Other'), { [ATTACK]: 1 }, makePosition(room, 25, 25));
        registerObject(outside, 'Other');
        Game.rooms.Other = outside.room;
        room.memory.defense.primaryTargetId = outside.id;
        setFind(room, FIND_HOSTILE_CREEPS, []);
        assert.equal(DefenseManager.getPriorityTarget(room), null);
    });

    it('retires defenders during peacetime instead of patrolling', function () {
        const room = defenseRoom();
        room.memory.defense.threatLevel = 0;
        const spawn = makeStructure(room, STRUCTURE_SPAWN, { id: 'spawn', pos: makePosition(room, 25, 25) });
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_HOSTILE_CREEPS, []);
        const creep = makeCreep(room, { pos: makePosition(room, 20, 20) });
        new Defender()._work(creep);
        assert.equal(creep.memory.selfdestruct, true);
    });

    it('provides a ranged body when the defense profile calls for ranged defense', function () {
        const room = defenseRoom();
        room.memory.defense.preferredStyle = 'ranged';
        room.energyAvailable = 2000;
        const spawn = makeSpawn(room);
        const creep = new Defender().spawnCreep(spawn);
        assert.ok(creep.body.some(part => part === RANGED_ATTACK || part.type === RANGED_ATTACK));
    });
});
