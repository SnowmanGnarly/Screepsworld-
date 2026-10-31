const assert = require('node:assert/strict');
const { makeRoom, makeCreep, makePosition, resetScreeps } = require('./helpers/screeps');
const MainHeap = require('../main.heap');
const MainMove = require('../main.move');
const config = require('../main.config');

describe('Heap path cache', function () {
    let room;
    let creep;
    let searches;

    beforeEach(function () {
        resetScreeps();
        room = makeRoom('A');
        Game.rooms.A = room;
        creep = makeCreep(room, { name: 'walker', pos: makePosition(room, 5, 5) });
        Game.creeps.walker = creep;
        searches = 0;
        room.findPath = () => {
            searches++;
            return '0505222';
        };
        creep.moveByPath = path => {
            creep.followed = path;
            return OK;
        };
    });

    function walk(target, ticks) {
        let result;
        for (let tick = 0; tick < ticks; tick++) {
            result = MainMove.to(creep, target, { reusePath: 5 });
            Game.time++;
            creep.pos = makePosition(room, creep.pos.x + 1, creep.pos.y);
        }
        return result;
    }

    it('searches once for a whole walk rather than every few ticks', function () {
        const target = makePosition(room, 40, 5);
        assert.equal(walk(target, 20), OK);
        assert.equal(searches, 1);
        assert.equal(creep.followed, '0505222');
        assert.equal(creep.lastMoveTo, undefined, 'moveTo and its Memory path are not used');
        assert.equal(creep.memory._move, undefined);
    });

    it('marks the creep as moved, which the road heatmap reads', function () {
        MainMove.to(creep, makePosition(room, 40, 5));
        assert.equal(creep.movedThisTick, true);
    });

    it('searches again for a new target', function () {
        walk(makePosition(room, 40, 5), 2);
        walk(makePosition(room, 5, 40), 2);
        assert.equal(searches, 2);
    });

    it('searches again once the path is old, because the room may have changed', function () {
        const target = makePosition(room, 45, 5);
        MainMove.to(creep, target);
        Game.time += config.MOVEMENT.PATH_TTL;
        creep.pos = makePosition(room, 6, 5);
        MainMove.to(creep, target);
        assert.equal(searches, 2);
    });

    it('searches again when something pushed the creep off its path', function () {
        const target = makePosition(room, 40, 5);
        MainMove.to(creep, target);
        Game.time++;
        creep.pos = makePosition(room, 6, 9);
        const results = [ERR_NOT_FOUND, OK];
        creep.moveByPath = () => results.shift();
        assert.equal(MainMove.to(creep, target), OK);
        assert.equal(searches, 2);
        assert.equal(results.length, 0);
        assert.equal(creep.lastMoveTo, undefined);
    });

    it('falls back to moveTo when a fresh path does not contain the creep, without searching in a loop', function () {
        const target = makePosition(room, 40, 5);
        creep.moveByPath = () => ERR_NOT_FOUND;
        assert.equal(MainMove.to(creep, target), OK);
        assert.equal(creep.lastMoveTo, target);
        assert.equal(searches, 1, 'a path found this tick is not searched again');

        Game.time++;
        creep.pos = makePosition(room, 6, 5);
        creep.lastMoveTo = undefined;
        assert.equal(MainMove.to(creep, target), OK);
        assert.equal(creep.lastMoveTo, target);
        assert.equal(searches, 2, 'an older path gets one new search');
    });

    it('lets moveTo answer when there is no path, and does not search again on every tick', function () {
        room.findPath = () => {
            searches++;
            return '';
        };
        const target = makePosition(room, 40, 5);
        MainMove.to(creep, target);
        Game.time++;
        creep.pos = makePosition(room, 6, 5);
        MainMove.to(creep, target);
        assert.equal(creep.lastMoveTo, target);
        assert.equal(searches, 1);
    });

    it('drops the path and paths around traffic when stuck', function () {
        const target = makePosition(room, 40, 5);
        for (let tick = 0; tick <= config.MOVEMENT.STUCK_TICKS; tick++) {
            MainMove.to(creep, target);
            Game.time++;
        }
        assert.equal(creep.lastMoveTo, target);
        assert.equal(creep.moveOptions.ignoreCreeps, false);
        assert.equal(creep.moveOptions.reusePath, 0);
        assert.equal(MainHeap.namespace('paths').walker, undefined);
    });

    it('keeps walking around a blocker instead of searching straight back through it', function () {
        const target = makePosition(room, 40, 5);
        for (let tick = 0; tick <= config.MOVEMENT.STUCK_TICKS; tick++) {
            MainMove.to(creep, target);
            Game.time++;
        }
        const searchesWhenStuck = searches;
        creep.lastMoveTo = undefined;
        creep.pos = makePosition(room, 6, 6);
        MainMove.to(creep, target);
        assert.equal(searches, searchesWhenStuck, 'no path that ignores creeps yet');
        assert.equal(creep.lastMoveTo, target);
        assert.equal(creep.moveOptions.ignoreCreeps, false);
        assert.equal(creep.moveOptions.reusePath, undefined, 'the detour itself may be reused');

        Game.time += config.MOVEMENT.STUCK_REPATH_PAUSE;
        creep.pos = makePosition(room, 7, 7);
        creep.lastMoveTo = undefined;
        MainMove.to(creep, target);
        assert.equal(searches, searchesWhenStuck + 1, 'back to a stored path after the detour');
        assert.equal(creep.lastMoveTo, undefined);
    });

    it('uses moveTo close to the target, where other creeps matter', function () {
        const target = makePosition(room, 5, 5 + config.MOVEMENT.NEAR_RANGE);
        MainMove.to(creep, target);
        assert.equal(searches, 0);
        assert.equal(creep.lastMoveTo, target);
        assert.equal(creep.moveOptions.ignoreCreeps, false);
    });

    it('uses moveTo for another room, because findPath only covers this one', function () {
        const target = makePosition({ name: 'B' }, 25, 25);
        MainMove.to(creep, target);
        assert.equal(searches, 0);
        assert.equal(creep.lastMoveTo, target);
        assert.equal(creep.moveOptions.reusePath, config.MOVEMENT.LONG_REUSE_PATH);
    });

    it('accepts a game object as the target', function () {
        const target = { id: 'site', pos: makePosition(room, 40, 5) };
        MainMove.to(creep, target);
        assert.equal(searches, 1);
        assert.equal(creep.followed, '0505222');
    });

    it('draws paths through moveTo when path visuals are on', function () {
        Memory.settings = { pathVisuals: true };
        MainMove.to(creep, makePosition(room, 40, 5), { color: '#fff' });
        assert.equal(searches, 0);
        assert.deepEqual(creep.moveOptions.visualizePathStyle, { stroke: '#fff' });
    });

    it('survives a global reset by searching again', function () {
        const target = makePosition(room, 40, 5);
        MainMove.to(creep, target);
        MainHeap.reset();
        Game.time++;
        creep.pos = makePosition(room, 6, 5);
        assert.equal(MainMove.to(creep, target), OK);
        assert.equal(searches, 2);
    });

    it('forgets the paths of creeps that no longer exist', function () {
        MainMove.to(creep, makePosition(room, 40, 5));
        assert.ok(MainHeap.namespace('paths').walker);
        delete Game.creeps.walker;
        MainMove.prune();
        assert.equal(MainHeap.namespace('paths').walker, undefined);
    });

    it('stores only plain data on the heap', function () {
        MainMove.to(creep, { id: 'site', pos: makePosition(room, 40, 5) });
        const entry = MainHeap.namespace('paths').walker;
        Object.values(entry).forEach(value => assert.notEqual(typeof value, 'object'));
    });
});
