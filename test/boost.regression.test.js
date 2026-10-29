const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeLab, makeCreep, makeSpawn, makePosition, setFind, resetScreeps,
} = require('./helpers/screeps');
const RolePrototype = require('../role.prototype');
const LabManager = require('../manager.lab');
const BaseManager = require('../manager.base');

function boostRoom(name = 'A', options = {}) {
    const room = makeRoom(name, {
        energyAvailable: 10000,
        memory: {
            base: { name, roleConfig: {}, outsourceSpawn: !!options.outsourceSpawn },
            lab: {
                enabled: true,
                goals: {},
                boosts: options.boosts || { Upgrader: { work: RESOURCE_CATALYZED_GHODIUM_ACID, required: true } },
            },
        },
    });
    room.controller = { my: true, level: 8, pos: makePosition(room, 30, 30) };
    Game.rooms[name] = room;
    return room;
}

function addLabs(room, positions, contents = {}) {
    const labs = positions.map((position, index) => makeLab(room, {
        id: 'lab-' + room.name + '-' + index,
        pos: makePosition(room, position[0], position[1]),
        contents: typeof contents === 'function' ? contents(index) : contents,
    }));
    labs.forEach(lab => { Game.objects[lab.id] = lab; });
    setFind(room, FIND_MY_STRUCTURES, labs);
    return labs;
}

function spawnRole(room, role, body = [WORK, WORK, MOVE]) {
    const spawn = makeSpawn(room, { name: 'Spawn-' + room.name, memory: { home: room.name } });
    Game.spawns[spawn.name] = spawn;
    const creep = role._spawnCreepWithBody(spawn, body, { role: role.roleName, home: room.name });
    return { spawn, creep };
}

describe('Lab boost spawning regressions', function () {
    beforeEach(function () {
        resetScreeps();
    });

    it('reserves full compound and energy costs before a required spawn', function () {
        const room = boostRoom();
        addLabs(room, [[25, 25]], {
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 60,
            [RESOURCE_ENERGY]: 40,
        });
        const role = new RolePrototype('Upgrader');
        const { creep } = spawnRole(room, role);
        assert.ok(creep);
        assert.deepEqual(room.memory.lab.boostRequests[creep.name].steps.map(step => step.count), [2]);
        assert.equal(room.memory.lab.boostRequests[creep.name].steps[0].resourceType, RESOURCE_CATALYZED_GHODIUM_ACID);
        assert.equal(creep.memory.labBoost.room, room.name);

        const secondSpawn = makeSpawn(room, { name: 'Second', memory: { home: room.name } });
        assert.equal(role._spawnCreepWithBody(secondSpawn, [WORK, WORK, MOVE], { role: 'Upgrader', home: room.name }), false);
        assert.equal(Object.keys(room.memory.lab.boostRequests).length, 1);
    });

    it('falls back only for optional boosts and leaves no request after spawn failure', function () {
        const room = boostRoom('A', {
            boosts: { Upgrader: { work: RESOURCE_CATALYZED_GHODIUM_ACID, required: false } },
        });
        addLabs(room, [[25, 25]]);
        const role = new RolePrototype('Upgrader');
        const optional = spawnRole(room, role).creep;
        assert.ok(optional);
        assert.equal(optional.memory.labBoost, undefined);

        room.memory.lab.boosts.Upgrader.required = true;
        const blockedSpawn = makeSpawn(room, { name: 'Blocked', memory: { home: room.name } });
        assert.equal(role._spawnCreepWithBody(blockedSpawn, [WORK, MOVE], { role: 'Upgrader', home: room.name }), false);

        room.memory.lab.boosts.Upgrader.required = false;
        const failedSpawn = makeSpawn(room, { name: 'Failed', memory: { home: room.name } });
        failedSpawn.spawnCreep = () => ERR_BUSY;
        assert.equal(role._spawnCreepWithBody(failedSpawn, [WORK, MOVE], { role: 'Upgrader', home: room.name }), false);
        assert.deepEqual(room.memory.lab.boostRequests, {});
    });

    it('never blocks emergency recovery for a boost policy', function () {
        const room = boostRoom();
        addLabs(room, [[25, 25]]);
        const role = new RolePrototype('Harvester');
        room.memory.lab.boosts.Harvester = { work: RESOURCE_CATALYZED_GHODIUM_ACID, required: true };
        const spawn = makeSpawn(room, { name: 'Recovery', memory: { home: room.name } });
        const creep = role._spawnCreepWithParts(spawn, [WORK, CARRY, MOVE], [], { exact: true, emergency: true });
        assert.ok(creep);
        assert.equal(creep.memory.labBoost, undefined);
        assert.equal(room.memory.lab.boostRequests, undefined);
    });

    it('consumes exact resources and resumes normal dispatch after boosting', function () {
        const room = boostRoom();
        const labs = addLabs(room, [[25, 25]], {
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 90,
            [RESOURCE_ENERGY]: 100,
        });
        const role = new RolePrototype('Upgrader');
        role.isNecessary = () => true;
        let workCalls = 0;
        role.run = () => workCalls++;
        const { creep } = spawnRole(room, role);
        creep.spawning = false;
        Game.creeps[creep.name] = creep;
        const base = new BaseManager(room, [role]);

        base._moveCreeps();
        assert.equal(workCalls, 0);
        assert.equal(creep.body.filter(part => part.boost === RESOURCE_CATALYZED_GHODIUM_ACID).length, 2);
        assert.equal(labs[0].store.getUsedCapacity(RESOURCE_CATALYZED_GHODIUM_ACID), 30);
        assert.equal(labs[0].store.getUsedCapacity(RESOURCE_ENERGY), 60);
        assert.equal(creep.memory.labBoost, undefined);
        assert.deepEqual(room.memory.lab.boostRequests, {});

        base._moveCreeps();
        assert.equal(workCalls, 1);
    });

    it('keeps a manually stocked boost lab configured and filled after boosting', function () {
        const room = boostRoom();
        const labs = addLabs(room, [[25, 25]], {
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 90,
            [RESOURCE_ENERGY]: 100,
        });
        const lab = labs[0];
        lab.memory = { inputResourceType: RESOURCE_CATALYZED_GHODIUM_ACID, targetAmount: 3000 };
        const role = new RolePrototype('Upgrader');
        const { creep } = spawnRole(room, role);
        assert.ok(creep);

        LabManager.runAll();
        assert.equal(lab.memory.labRole, 'boost');
        assert.equal(lab.memory.inputResourceType, RESOURCE_CATALYZED_GHODIUM_ACID);
        assert.ok(!lab.memory.outputResourceType);

        creep.spawning = false;
        creep.pos = lab.pos;
        LabManager.runCreep(creep, role);
        assert.equal(creep.memory.labBoost, undefined);

        LabManager.runAll();
        assert.equal(lab.memory.labRole, 'stock');
        assert.equal(lab.memory.inputResourceType, RESOURCE_CATALYZED_GHODIUM_ACID);
        assert.equal(lab.memory.targetAmount, 3000);
        assert.ok(!lab.memory.outputResourceType);
        assert.equal(lab.memory.reservedBoostAmount, 0);

        const nextSpawn = makeSpawn(room, { name: 'Next', memory: { home: room.name } });
        const next = role._spawnCreepWithBody(nextSpawn, [WORK, MOVE], { role: 'Upgrader', home: room.name });
        assert.ok(next);
        assert.equal(next.memory.labBoost.room, room.name);
    });

    it('moves between multiple reserved labs until every planned part is boosted', function () {
        const room = boostRoom();
        const labs = addLabs(room, [[25, 25], [27, 25]], index => ({
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 30,
            [RESOURCE_ENERGY]: 20 + index,
        }));
        const role = new RolePrototype('Upgrader');
        const { creep } = spawnRole(room, role);
        creep.spawning = false;
        creep.pos = makePosition(room, 20, 20);
        role._moveToLocation = (worker, target) => { worker.lastMoveTo = target; };

        assert.equal(LabManager.runCreep(creep, role), true);
        assert.equal(creep.lastMoveTo, labs[0]);
        assert.equal(labs[0].boosts.length, 0);
        creep.pos = labs[0].pos;
        LabManager.runCreep(creep, role);
        assert.equal(labs[0].boosts[0].count, 1);
        assert.equal(creep.memory.labBoost.room, room.name);

        LabManager.runCreep(creep, role);
        assert.equal(creep.lastMoveTo, labs[1]);
        creep.pos = labs[1].pos;
        LabManager.runCreep(creep, role);
        assert.equal(labs[1].boosts[0].count, 1);
        assert.equal(creep.body.filter(part => part.boost === RESOURCE_CATALYZED_GHODIUM_ACID).length, 2);
        assert.equal(creep.memory.labBoost, undefined);
    });

    it('cleans dead-creep reservations and skips reaction use of reserved labs', function () {
        const room = boostRoom();
        const labs = addLabs(room, [[25, 25], [26, 25], [25, 26]], {
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 60,
            [RESOURCE_ENERGY]: 100,
        });
        const role = new RolePrototype('Upgrader');
        const { creep } = spawnRole(room, role);
        LabManager.runAll();
        assert.ok(labs.some(lab => lab.memory.reservedBoostAmount > 0));
        assert.ok(labs.some(lab => lab.memory.labRole === 'boost'));

        delete Game.creeps[creep.name];
        LabManager.runAll();
        assert.deepEqual(room.memory.lab.boostRequests, {});
        assert.ok(labs.every(lab => lab.memory.reservedBoostAmount === 0));
    });

    it('uses the physical outsource spawn room for boost planning and preserves home ownership', function () {
        const home = boostRoom('A', { outsourceSpawn: true, boosts: {} });
        const outsource = boostRoom('B');
        addLabs(outsource, [[25, 25]], {
            [RESOURCE_CATALYZED_GHODIUM_ACID]: 150,
            [RESOURCE_ENERGY]: 100,
        });
        const spawn = makeSpawn(outsource, { name: 'Spawn-B', memory: { home: 'B' } });
        Game.spawns[spawn.name] = spawn;
        const role = new RolePrototype('Upgrader');
        const base = new BaseManager(home, [role]);
        const creep = base._spawnCreepForRole(role);
        assert.ok(creep);
        assert.equal(creep.memory.home, 'A');
        assert.equal(creep.memory.labBoost.room, 'B');
        assert.ok(outsource.memory.lab.boostRequests[creep.name]);
        assert.equal(home.memory.lab.boostRequests, undefined);
    });
});
