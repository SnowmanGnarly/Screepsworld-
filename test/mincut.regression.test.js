const assert = require('node:assert/strict');
const { makeRoom, makeStructure, makePosition, setFind, resetScreeps, registerObject } = require('./helpers/screeps');
const MinCut = require('../main.mincut');
const MainCache = require('../main.cache');
const RoomManager = require('../manager.room');
const MayorManager = require('../manager.mayor');
const config = require('../main.config');

const open = () => false;

function square(x1, y1, x2, y2) {
    const tiles = [];
    for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) tiles.push({ x, y });
    }
    return tiles;
}

// the proof that matters: nothing can walk from the protected area to an exit past the cut
function canEscape(isWall, protectedTiles, cut) {
    const blocked = new Set(cut.map(tile => tile.x + ',' + tile.y));
    const seen = new Set();
    const stack = protectedTiles.filter(tile => !isWall(tile.x, tile.y));
    stack.forEach(tile => seen.add(tile.x + ',' + tile.y));
    while (stack.length > 0) {
        const { x, y } = stack.pop();
        if (x === 0 || y === 0 || x === 49 || y === 49) return true;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const nx = x + dx;
                const ny = y + dy;
                const key = nx + ',' + ny;
                if (nx < 0 || ny < 0 || nx > 49 || ny > 49 || seen.has(key) || blocked.has(key) || isWall(nx, ny)) continue;
                seen.add(key);
                stack.push({ x: nx, y: ny });
            }
        }
    }
    return false;
}

describe('Minimum cut', function () {
    it('rings a base in the open with the smallest closed line', function () {
        const base = square(20, 20, 24, 24);
        const cut = MinCut.solve(open, base);
        assert.equal(canEscape(open, base, []), true, 'the room is open without the cut');
        assert.equal(canEscape(open, base, cut), false);
        assert.equal(cut.length, 24, 'the 7 by 7 ring around a 5 by 5 base');
    });

    it('closes the only way out with as many tiles as it is wide', function () {
        // a walled-in pocket, open to the rest of the room through one 3 tile corridor
        const pocket = (x, y) => x >= 15 && x <= 25 && y >= 15 && y <= 25;
        const corridor = (x, y) => x >= 26 && x <= 35 && y >= 19 && y <= 21;
        const isWall = (x, y) => x >= 13 && x <= 35 && y >= 13 && y <= 27 && !pocket(x, y) && !corridor(x, y);
        const base = square(18, 18, 22, 22);
        const cut = MinCut.solve(isWall, base);
        assert.equal(canEscape(isWall, base, cut), false);
        assert.equal(cut.length, 3);
        cut.forEach(tile => assert.ok(!isWall(tile.x, tile.y), 'no rampart on terrain walls'));
    });

    it('needs nothing when terrain already closes the base in', function () {
        const pocket = (x, y) => x >= 20 && x <= 30 && y >= 20 && y <= 30;
        const isWall = (x, y) => !pocket(x, y) && x >= 15 && x <= 35 && y >= 15 && y <= 35;
        assert.deepEqual(MinCut.solve(isWall, square(23, 23, 27, 27)), []);
    });

    it('protects two separate areas with one cut', function () {
        const areas = square(10, 10, 12, 12).concat(square(37, 37, 39, 39));
        const cut = MinCut.solve(open, areas);
        assert.equal(canEscape(open, areas, cut), false);
    });

    it('never places a tile beside an exit, where a rampart cannot be built', function () {
        const cut = MinCut.solve(open, square(3, 3, 8, 8));
        assert.ok(cut.length > 0);
        cut.forEach(tile => {
            assert.ok(tile.x >= 2 && tile.y >= 2 && tile.x <= 47 && tile.y <= 47, tile.x + ',' + tile.y);
        });
    });

    it('may use the border row where terrain walls leave no exit next to it', function () {
        const isWall = (x, y) => x === 0 || (x === 1 && y !== 25) ;
        const cut = MinCut.solve(isWall, square(3, 20, 6, 30));
        assert.equal(canEscape(isWall, square(3, 20, 6, 30), cut), false);
    });

    it('reports when the area touches an exit and cannot be closed', function () {
        assert.equal(MinCut.solve(open, [{ x: 0, y: 25 }]), null);
        assert.equal(MinCut.solve(open, [{ x: 1, y: 25 }]), null);
    });

    it('ignores protected tiles on terrain walls, and has nothing to do without any', function () {
        const isWall = (x, y) => x === 25 && y === 25;
        assert.deepEqual(MinCut.solve(isWall, [{ x: 25, y: 25 }]), []);
        assert.deepEqual(MinCut.solve(open, []), []);
    });

    it('closes the base in a maze of walls', function () {
        // deterministic noise, so a failure reproduces
        const isWall = (x, y) => ((x * 7 + y * 13 + x * y) % 5) === 0 && x > 1 && y > 1 && x < 48 && y < 48;
        const base = square(23, 23, 27, 27);
        const cut = MinCut.solve(isWall, base);
        assert.equal(canEscape(isWall, base, cut), false);
    });

    it('is fast enough to run once on a full open room', function () {
        const started = Date.now();
        MinCut.solve(open, square(10, 10, 39, 39));
        assert.ok(Date.now() - started < 1000);
    });
});

describe('Rampart planning', function () {
    const LIMITS = {
        tower: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 },
        spawn: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 2, 8: 3 },
        extension: { 1: 0, 2: 5, 3: 10, 4: 20, 5: 30, 6: 40, 7: 50, 8: 60 },
        storage: { 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
        rampart: { 2: 2500, 3: 2500, 4: 2500, 5: 2500, 6: 2500, 7: 2500, 8: 2500 },
    };

    beforeEach(function () {
        resetScreeps();
        global.CONTROLLER_STRUCTURES = LIMITS;
    });

    afterEach(function () {
        delete global.CONTROLLER_STRUCTURES;
    });

    function fortifiedRoom(options = {}) {
        const room = makeRoom('A', { memory: { base: { name: 'A', roleConfig: {} }, mayor: { enableFortification: options.enabled !== false, mode: 'auto' } } });
        room.controller = { my: true, level: options.level || 4, pos: makePosition(room, 30, 30), id: 'controller' };
        const spawn = makeStructure(room, STRUCTURE_SPAWN, { id: 'spawn', pos: makePosition(room, 25, 25), extra: { my: true } });
        Game.rooms.A = room;
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, [spawn]);
        setFind(room, FIND_STRUCTURES, [spawn]);
        return room;
    }

    function plannedRamparts(room) {
        return new RoomManager(room).fetchBuildingSitePositionsForTile(RoomManager.TILE_RAMPART);
    }

    it('walls in every planned building and the controller', function () {
        const room = fortifiedRoom();
        const manager = new RoomManager(room);
        assert.equal(manager.planRamparts(), true);
        const ramparts = plannedRamparts(room);
        assert.ok(ramparts.length > 0);

        const buildings = [];
        const check = new RoomManager(room);
        check._initArrayIfNecessary();
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (RoomManager.TILES_TO_BE_BUILD.some(tile => tile.character === check._array.get(x, y))) buildings.push({ x, y });
            }
        }
        assert.ok(buildings.length > 0);
        buildings.push(room.controller.pos);
        assert.equal(canEscape(open, buildings, ramparts), false);
    });

    it('keeps enemy ranged attackers off the buildings', function () {
        const room = fortifiedRoom();
        new RoomManager(room).planRamparts();
        const check = new RoomManager(room);
        check._initArrayIfNecessary();
        const ramparts = plannedRamparts(room);
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (!RoomManager.TILES_TO_BE_BUILD.some(tile => tile.character === check._array.get(x, y))) continue;
                ramparts.forEach(rampart => {
                    const range = Math.max(Math.abs(rampart.x - x), Math.abs(rampart.y - y));
                    assert.ok(range > config.PLANNER.RAMPART_MARGIN, 'range ' + range);
                });
            }
        }
    });

    it('plans once, even after the layout is read again', function () {
        const room = fortifiedRoom();
        assert.equal(new RoomManager(room).planRamparts(), true);
        assert.equal(new RoomManager(room).planRamparts(), false);
    });

    it('reports a search that found no wall, rather than pretending it planned one', function () {
        const MainInfo = require('../main.info');
        const room = fortifiedRoom();
        const errors = [];
        MainInfo.error = message => errors.push(message);
        const original = MinCut.solve;
        MinCut.solve = () => null;
        try {
            assert.equal(new RoomManager(room).planRamparts(), true);
        } finally {
            MinCut.solve = original;
        }
        assert.equal(errors.length, 1);
        assert.deepEqual(plannedRamparts(room), []);
    });

    it('leaves the structure plan intact', function () {
        const room = fortifiedRoom();
        const before = new RoomManager(room).fetchBuildingSitePositionsForTile(RoomManager.TILE_EXTENSION).length;
        new RoomManager(room).planRamparts();
        assert.equal(new RoomManager(room).fetchBuildingSitePositionsForTile(RoomManager.TILE_EXTENSION).length, before);
    });

    it('plans again after the layout is generated from scratch', function () {
        const room = fortifiedRoom();
        new RoomManager(room).planRamparts();
        RoomManager.generateLayoutForRoom(room);
        assert.equal(new RoomManager(room).planRamparts(), true);
    });

    function runMayor(room) {
        MainCache.initRound([]);
        const mayor = new MayorManager(room);
        mayor.run();
        return mayor;
    }

    it('does nothing until fortification is switched on', function () {
        const room = fortifiedRoom({ enabled: false });
        runMayor(room);
        assert.equal(room.memory.roomManager && room.memory.roomManager.rampartPlanVersion, undefined);
        assert.ok(!room.createdSites.some(site => site.structureType === STRUCTURE_RAMPART));
    });

    it('waits for the room level that can afford to hold a wall', function () {
        const room = fortifiedRoom({ level: config.PLANNER.RAMPART_RCL - 1 });
        runMayor(room);
        assert.equal(room.memory.roomManager && room.memory.roomManager.rampartPlanVersion, undefined);
    });

    it('waits for spare CPU, because one search is expensive', function () {
        const room = fortifiedRoom();
        Game.cpu.bucket = config.PLANNER.RAMPART_PLAN_BUCKET - 1;
        runMayor(room);
        assert.equal(room.memory.roomManager && room.memory.roomManager.rampartPlanVersion, undefined);
    });

    it('plans and starts building once fortification is on', function () {
        const room = fortifiedRoom();
        runMayor(room);
        assert.equal(room.memory.roomManager.rampartPlanVersion, RoomManager.RAMPART_PLAN_VERSION);
    });

    function plannedRampartMayor(room) {
        MainCache.initRound([]);
        const roomManager = new RoomManager(room);
        roomManager.planRamparts();
        const mayor = new MayorManager(room);
        mayor._memory = room.memory.mayor;
        const tile = RoomManager.TILES_ENDLESS_STRUCTURES.find(entry => entry.structureType === STRUCTURE_RAMPART);
        return { mayor, roomManager, tile };
    }

    it('places a rampart over a road crossing the line, or the wall would have a hole', function () {
        const room = fortifiedRoom();
        const { mayor, roomManager, tile } = plannedRampartMayor(room);
        const first = roomManager.fetchBuildingSitePositionsForTile(RoomManager.TILE_RAMPART)[0];
        const road = makeStructure(room, STRUCTURE_ROAD, { id: 'road', pos: makePosition(room, first.x, first.y) });
        registerObject(road, 'A');
        setFind(room, FIND_STRUCTURES, room._find[FIND_STRUCTURES].concat(road));
        MainCache.initRound([]);
        const positions = mayor._fetchBuildingSitePositionsForTile(roomManager, tile);
        assert.ok(positions.some(pos => pos.x === first.x && pos.y === first.y));
    });

    it('does not place a second rampart on one that stands', function () {
        const room = fortifiedRoom();
        const { mayor, roomManager, tile } = plannedRampartMayor(room);
        const first = roomManager.fetchBuildingSitePositionsForTile(RoomManager.TILE_RAMPART)[0];
        const rampart = makeStructure(room, STRUCTURE_RAMPART, { id: 'rampart', pos: makePosition(room, first.x, first.y) });
        registerObject(rampart, 'A');
        setFind(room, FIND_STRUCTURES, room._find[FIND_STRUCTURES].concat(rampart));
        MainCache.initRound([]);
        const positions = mayor._fetchBuildingSitePositionsForTile(roomManager, tile);
        assert.ok(!positions.some(pos => pos.x === first.x && pos.y === first.y));
    });

    it('does not place a second site on one that is open', function () {
        const room = fortifiedRoom();
        const { mayor, roomManager, tile } = plannedRampartMayor(room);
        const first = roomManager.fetchBuildingSitePositionsForTile(RoomManager.TILE_RAMPART)[0];
        const site = { id: 'site', structureType: STRUCTURE_RAMPART, pos: makePosition(room, first.x, first.y), progress: 0, progressTotal: 1 };
        setFind(room, FIND_CONSTRUCTION_SITES, [site]);
        MainCache.initRound([]);
        const positions = mayor._fetchBuildingSitePositionsForTile(roomManager, tile);
        assert.ok(!positions.some(pos => pos.x === first.x && pos.y === first.y));
    });
});
