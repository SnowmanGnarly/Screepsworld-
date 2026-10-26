const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeSpawn, makePosition, setFind, resetScreeps,
} = require('./helpers/screeps');
const main = require('../main');

describe('Main loop integration', function () {
    beforeEach(function () {
        resetScreeps();
        Game.cpu = { bucket: 9000, getUsed: () => 0 };
        global.CONTROLLER_STRUCTURES = {};
        for (const type of [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_STORAGE, STRUCTURE_EXTENSION,
            STRUCTURE_LINK, STRUCTURE_EXTRACTOR, STRUCTURE_TERMINAL, STRUCTURE_LAB, STRUCTURE_FACTORY,
            STRUCTURE_POWER_SPAWN, STRUCTURE_OBSERVER, STRUCTURE_NUKER]) {
            global.CONTROLLER_STRUCTURES[type] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0 };
        }
        global.CONTROLLER_STRUCTURES[STRUCTURE_SPAWN][1] = 1;
    });

    it('spawns an emergency Harvester through the full loop with no creeps', function () {
        const room = makeRoom('A', { energyAvailable: 200 });
        room.controller = { my: true, level: 1, pos: makePosition(room, 30, 30) };
        const spawn = makeSpawn(room, { name: 'Spawn1', memory: {} });
        spawn.store = makeStore(300, { [RESOURCE_ENERGY]: 200 });
        Game.rooms.A = room;
        Game.spawns.Spawn1 = spawn;
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, [spawn]);
        setFind(room, FIND_STRUCTURES, [spawn]);

        main.loop();

        const creeps = Object.values(Game.creeps);
        assert.equal(creeps.length, 1);
        assert.equal(creeps[0].memory.role, 'Harvester');
        assert.deepEqual(creeps[0].body, [WORK, CARRY, MOVE]);
        assert.equal(room.memory.base.roleConfig.Harvester.requiredNumber, 1);
        assert.equal(room.memory.base.roleConfig.Upgrader.requiredNumber, 1);
    });
});
