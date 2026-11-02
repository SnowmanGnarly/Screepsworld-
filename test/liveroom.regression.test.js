const assert = require('node:assert/strict');
const { resetScreeps, makePosition } = require('./helpers/screeps');
const { loadLiveRoom } = require('./helpers/liveroom');
const fixture = require('./fixtures/W13S14.json');
const BaseManager = require('../manager.base');
const EconomyManager = require('../manager.economy');
const LogisticsManager = require('../manager.logistics');
const MayorManager = require('../manager.mayor');
const MemoryManager = require('../manager.memory');
const RoomManager = require('../manager.room');
const MainCache = require('../main.cache');
const TileArray = require('../tile.array');
const config = require('../main.config');

/*
 * The real managers on a snapshot of a live room (refresh it with test/fixtures/fetch-live-room.js).
 * Where the snapshot shows what the game really did, such as where the Miners stand, the tests
 * compare against that rather than against numbers worked out by hand.
 */

describe('Live room ' + fixture.shard + '/' + fixture.room + ' at tick ' + fixture.time, function () {
    let room;

    beforeEach(function () {
        resetScreeps({ cpu: { bucket: 10000, limit: 20, tickLimit: 500, getUsed: () => 0 } });
        room = loadLiveRoom(fixture);
        MainCache.initRound(BaseManager.fetchAllRoles());
    });

    const BUILT_TYPES = [STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_STORAGE];
    const buildingTiles = new Set(RoomManager.TILES_TO_BE_BUILD.map(tile => tile.character));
    const tileOf = structureType => (RoomManager.TILES_TO_BE_BUILD.find(tile => tile.structureType === structureType) || {}).character;

    function plannedTiles(array) {
        const tiles = [];
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (buildingTiles.has(array.get(x, y))) tiles.push({ x, y, character: array.get(x, y) });
            }
        }
        return tiles;
    }

    // the layout as the live room saved it, before any change made here
    function fixtureLayout() {
        const layout = new TileArray(50, 50);
        layout.fromCompactString(fixture.memory.room.roomManager.layout, { emptyValue: ' ' });
        return layout;
    }

    function savedLayout() {
        const manager = new RoomManager(room);
        manager._initArrayIfNecessary();
        return manager._array;
    }

    function isWall(x, y) {
        return room.getTerrain().get(x, y) === TERRAIN_MASK_WALL;
    }

    it('reads the terrain the way the game stores it', function () {
        const built = room.find(FIND_STRUCTURES).filter(structure => BUILT_TYPES.includes(structure.structureType));
        assert.ok(built.length > 100);
        assert.deepEqual(built.filter(structure => isWall(structure.pos.x, structure.pos.y)).map(structure => structure.id), []);
    });

    it('puts each Miner on the tile where the live Miner stands', function () {
        const miners = Object.values(Game.creeps).filter(creep => creep.memory.role === 'Miner');
        assert.equal(miners.length, room.find(FIND_SOURCES).length);
        miners.forEach(miner => {
            const source = Game.getObjectById(miner.memory.source);
            assert.deepEqual(EconomyManager.getMinerPost(room, source), { x: miner.pos.x, y: miner.pos.y });
        });
    });

    it('mines both sources statically, sustains itself and needs no Harvesters', function () {
        assert.equal(EconomyManager.getMinableSources(room).length, 2);
        assert.equal(EconomyManager.isSelfSustaining(room), true);
        assert.equal(EconomyManager.getDesiredHarvesters(room), 0);
    });

    it('derives about the workforce the live room runs with', function () {
        const base = new BaseManager(room, BaseManager.fetchAllRoles());
        const live = roleName => Object.values(Game.creeps).filter(creep => creep.memory.role === roleName).length;
        const derived = roleName => base._getRequiredNumber(BaseManager.fetchAllRoles().find(role => role.roleName === roleName));
        assert.equal(derived('Miner'), live('Miner'));
        ['Upgrader', 'Handyman'].forEach(roleName => {
            assert.ok(Math.abs(derived(roleName) - live(roleName)) <= 1, roleName + ': derived ' + derived(roleName) + ', live ' + live(roleName));
        });
    });

    it('never plans a building on a wall, in the saved layout or a fresh one', function () {
        const fresh = new RoomManager(room)._generateLayout(new TileArray(50, 50));
        [savedLayout(), fresh].forEach(array => {
            assert.deepEqual(plannedTiles(array).filter(tile => isWall(tile.x, tile.y)), []);
        });
    });

    it('plans the full RCL 8 extension, spawn, tower and lab counts on this terrain, quickly', function () {
        const started = Date.now();
        const fresh = new RoomManager(room)._generateLayout(new TileArray(50, 50));
        assert.ok(Date.now() - started < 2000);
        const count = character => plannedTiles(fresh).filter(tile => tile.character === character).length;
        [STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_LAB, STRUCTURE_STORAGE].forEach(structureType => {
            assert.equal(count(tileOf(structureType)), CONTROLLER_STRUCTURES[structureType][8], structureType);
        });
    });

    it('keeps every existing building where it stands in a fresh layout', function () {
        const fresh = new RoomManager(room)._generateLayout(new TileArray(50, 50));
        const moved = room.find(FIND_STRUCTURES).filter(structure => tileOf(structure.structureType))
            .filter(structure => fresh.get(structure.pos.x, structure.pos.y) !== tileOf(structure.structureType));
        assert.deepEqual(moved.map(structure => structure.structureType + '@' + structure.pos.x + ',' + structure.pos.y), []);
    });

    // The live layout was saved before the storage was built, so it planned a storage at 17,36 with
    // the terminal and factory beside it, ten tiles from the real one at 19,26.
    it('moves the saved layout onto the buildings that really stand', function () {
        const saved = savedLayout();
        const moved = room.find(FIND_STRUCTURES).filter(structure => tileOf(structure.structureType))
            .filter(structure => saved.get(structure.pos.x, structure.pos.y) !== tileOf(structure.structureType));
        assert.deepEqual(moved.map(structure => structure.structureType + '@' + structure.pos.x + ',' + structure.pos.y), []);
        const tiles = character => plannedTiles(saved).filter(tile => tile.character === character);
        assert.deepEqual(tiles(tileOf(STRUCTURE_STORAGE)).map(tile => tile.x + ',' + tile.y), ['19,26']);
        // walls and the mineral leave no free planned tile within 2 of this storage, so the
        // terminal and factory are left to the Mayor, which builds them beside it
        assert.deepEqual(tiles(tileOf(STRUCTURE_TERMINAL)).concat(tiles(tileOf(STRUCTURE_FACTORY))), []);
        const mayor = new MayorManager(room);
        [STRUCTURE_TERMINAL, STRUCTURE_FACTORY].forEach(structureType => {
            const position = mayor._findSmartPlacementPosition(structureType);
            assert.ok(position && position.inRangeTo(room.storage.pos, 2), structureType + ' would go to ' + JSON.stringify(position));
        });
    });

    it('plans the wall again once the storage tile moved, and not again once the layout is settled', function () {
        room.memory.roomManager.rampartPlanVersion = RoomManager.RAMPART_PLAN_VERSION;
        savedLayout();
        assert.equal(room.memory.roomManager.rampartPlanVersion, undefined);
        const settled = room.memory.roomManager.layout;
        room.memory.roomManager.rampartPlanVersion = RoomManager.RAMPART_PLAN_VERSION;
        savedLayout();
        assert.equal(room.memory.roomManager.layout, settled);
        assert.equal(room.memory.roomManager.rampartPlanVersion, RoomManager.RAMPART_PLAN_VERSION);
    });

    it('gives a construction site its tile and keeps the RCL 8 count', function () {
        // the open tile nearest the spawn that the saved plan leaves empty
        const layout = fixtureLayout();
        const spawn = room.find(FIND_MY_SPAWNS)[0].pos;
        const occupied = new Set(room.find(FIND_STRUCTURES).map(structure => structure.pos.x + ',' + structure.pos.y));
        let free = null;
        for (let x = 2; x < 48; x++) {
            for (let y = 2; y < 48; y++) {
                if (isWall(x, y) || buildingTiles.has(layout.get(x, y)) || occupied.has(x + ',' + y)) continue;
                if (!free || spawn.getRangeTo(x, y) < spawn.getRangeTo(free.x, free.y)) free = { x, y };
            }
        }
        const site = { id: 'tower-site', room, pos: makePosition(room, free.x, free.y), structureType: STRUCTURE_TOWER, my: true, progress: 0, progressTotal: 5000 };
        room._find[FIND_CONSTRUCTION_SITES].push(site);
        room._find[FIND_MY_CONSTRUCTION_SITES].push(site);
        MainCache.initRound(BaseManager.fetchAllRoles());
        const saved = savedLayout();
        assert.equal(saved.get(free.x, free.y), tileOf(STRUCTURE_TOWER));
        assert.equal(plannedTiles(saved).filter(tile => tile.character === tileOf(STRUCTURE_TOWER)).length, CONTROLLER_STRUCTURES[STRUCTURE_TOWER][8]);
    });

    it('never clears the tile of a storage that stands, even when a stray one is nearer the spawn', function () {
        const layout = fixtureLayout();
        const spawn = room.find(FIND_MY_SPAWNS)[0].pos;
        const near = plannedTiles(layout).filter(tile => tile.character === tileOf(STRUCTURE_EXTENSION))
            .sort((a, b) => spawn.getRangeTo(a.x, a.y) - spawn.getRangeTo(b.x, b.y))[0];
        assert.ok(spawn.getRangeTo(near.x, near.y) < spawn.getRangeTo(room.storage.pos), 'the stray tile has to be nearer than the real storage');
        layout.set(near.x, near.y, tileOf(STRUCTURE_STORAGE));
        room.memory.roomManager.layout = layout.toCompactString();
        const saved = savedLayout();
        assert.equal(saved.get(room.storage.pos.x, room.storage.pos.y), tileOf(STRUCTURE_STORAGE));
        assert.equal(plannedTiles(saved).filter(tile => tile.character === tileOf(STRUCTURE_STORAGE)).length, 1);
    });

    it('changes only the tiles that clashed with the room, and keeps the RCL 8 counts', function () {
        const before = fixtureLayout();
        const after = savedLayout();
        const standing = new Set(room.find(FIND_STRUCTURES).filter(structure => tileOf(structure.structureType)).map(structure => structure.pos.x + ',' + structure.pos.y));
        const replanned = new Set([tileOf(STRUCTURE_STORAGE), tileOf(STRUCTURE_TERMINAL), tileOf(STRUCTURE_FACTORY), tileOf(STRUCTURE_EXTENSION)]);
        const changed = [];
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                const was = before.get(x, y);
                const now = after.get(x, y);
                if (was === now) continue;
                changed.push(x + ',' + y);
                // only the types that had to be planned again may move, apart from what really stands
                const other = character => buildingTiles.has(character) && !replanned.has(character);
                const allowed = standing.has(x + ',' + y) || (!other(was) && !other(now));
                assert.ok(allowed, x + ',' + y + ' changed from ' + JSON.stringify(was) + ' to ' + JSON.stringify(now));
            }
        }
        assert.ok(changed.length > 0 && changed.length <= 10, changed.join(' '));
        const count = character => plannedTiles(after).filter(tile => tile.character === character).length;
        [STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_LAB, STRUCTURE_STORAGE].forEach(structureType => {
            assert.equal(count(tileOf(structureType)), CONTROLLER_STRUCTURES[structureType][8], structureType);
        });
        assert.deepEqual(plannedTiles(after).filter(tile => isWall(tile.x, tile.y)), []);
    });

    it('leaves alone a saved layout that already agrees with the room', function () {
        const layout = savedLayout().toCompactString();
        room.memory.roomManager.layout = layout;
        const again = new RoomManager(room);
        again._initArrayIfNecessary();
        assert.equal(again._array.toCompactString(), layout);
        assert.equal(room.memory.roomManager.layout, layout);
    });

    it('closes the base off from every exit with its rampart plan', function () {
        const manager = new RoomManager(room);
        assert.equal(manager.planRamparts(), true);
        const ramparts = new Set(manager.fetchBuildingSitePositionsForTile(RoomManager.TILE_RAMPART).map(pos => pos.x + ',' + pos.y));
        assert.ok(ramparts.size > 0);
        const protectedTiles = plannedTiles(manager._array).map(tile => tile.x + ',' + tile.y).concat(room.controller.pos.x + ',' + room.controller.pos.y);
        // walk in from every open edge tile, as an attacker would, through anything but walls and ramparts
        const seen = new Set();
        const queue = [];
        for (let i = 0; i < 50; i++) {
            [[i, 0], [i, 49], [0, i], [49, i]].forEach(([x, y]) => {
                const key = x + ',' + y;
                if (!isWall(x, y) && !seen.has(key)) { seen.add(key); queue.push([x, y]); }
            });
        }
        while (queue.length > 0) {
            const [x, y] = queue.shift();
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const nx = x + dx;
                    const ny = y + dy;
                    const key = nx + ',' + ny;
                    if (nx < 0 || ny < 0 || nx > 49 || ny > 49 || seen.has(key) || isWall(nx, ny) || ramparts.has(key)) continue;
                    seen.add(key);
                    queue.push([nx, ny]);
                }
            }
        }
        assert.deepEqual(protectedTiles.filter(key => seen.has(key)), []);
    });

    it('sends the haulers to every source container worth a trip, into the storage', function () {
        new LogisticsManager(room).run();
        const tasks = room.memory.logistics.tasks;
        const worthATrip = room.find(FIND_STRUCTURES).filter(structure => structure.structureType === STRUCTURE_CONTAINER &&
            structure.store.getUsedCapacity(RESOURCE_ENERGY) >= config.LOGISTICS.CONTAINER_COLLECT_MIN);
        assert.ok(worthATrip.length > 0);
        worthATrip.forEach(container => {
            const task = tasks.find(candidate => candidate.sourceId === container.id && candidate.resourceType === RESOURCE_ENERGY);
            assert.ok(task, 'no task for container at ' + container.pos.x + ',' + container.pos.y);
            assert.equal(task.targetId, room.storage.id);
        });
        // claims held by live haulers survive the run
        fixture.memory.room.logistics.tasks.filter(task => task.assignedCreep && tasks.some(candidate => candidate.id === task.id)).forEach(task => {
            assert.equal(tasks.find(candidate => candidate.id === task.id).assignedCreep, task.assignedCreep);
        });
    });

    it('drops the bases left from before the respawn and keeps the live room untouched', function () {
        // the names and shapes of what the live Memory held on 2026-11-02
        Memory.rooms.E58N16 = { base: { name: 'Spawn' }, roadManager: {}, stats: {} };
        Memory.rooms.E46S38 = { base: { name: 'E46S38' }, roomManager: {} };
        Memory.spawns = { Spawn: { home: 'Spawn' }, Spawn1: { home: 'Spawn1' } };
        MemoryManager._pruneRoomMemory();
        Game.time += config.MEMORY.ROOM_PRUNE_INTERVAL;
        MemoryManager._pruneRoomMemory();
        assert.deepEqual(Object.keys(Memory.rooms), [fixture.room]);
        assert.deepEqual(Memory.rooms[fixture.room], fixture.memory.room);
        assert.deepEqual(Object.keys(Memory.spawns), ['Spawn1']);
    });

    it('lets the Mayor run on the live room without adding containers to sources that have them', function () {
        new MayorManager(room).run();
        assert.deepEqual(room.createdSites.filter(site => site.structureType === STRUCTURE_CONTAINER), []);
        assert.ok(room.createdSites.filter(site => site.structureType !== STRUCTURE_ROAD).length <= config.PLANNER.MAX_OPEN_SITES);
    });
});
