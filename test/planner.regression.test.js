const assert = require('node:assert/strict');
const {
    makeRoom, makeStructure, makePosition, setFind, resetScreeps,
} = require('./helpers/screeps');
const MayorManager = require('../manager.mayor');
const RoomManager = require('../manager.room');
const TileArray = require('../tile.array');
const constants = require('../main.constants');

function controllerStructures(type, counts) {
    return { [type]: counts };
}

function plannerRoom(level) {
    const room = makeRoom('A', {
        controller: { my: true, level, pos: null },
        memory: { base: { name: 'A', roleConfig: {} }, mayor: { enableNuker: false }, roomManager: {} },
    });
    room.controller.pos = makePosition(room, 30, 30);
    Game.rooms.A = room;
    return room;
}

describe('RCL placement regressions', function () {
    beforeEach(function () {
        resetScreeps();
        global.CONTROLLER_STRUCTURES = {
            ...controllerStructures(STRUCTURE_TOWER, { 2: 0, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 }),
            ...controllerStructures(STRUCTURE_LINK, { 4: 0, 5: 2, 6: 3, 7: 4, 8: 6 }),
            ...controllerStructures(STRUCTURE_LAB, { 5: 0, 6: 3, 7: 6, 8: 10 }),
            ...controllerStructures(STRUCTURE_EXTRACTOR, { 5: 0, 6: 1, 7: 1, 8: 1 }),
            ...controllerStructures(STRUCTURE_NUKER, { 7: 0, 8: 1 }),
        };
    });

    it('clusters new labs with existing construction sites', function () {
        const room = plannerRoom(6);
        const spawn = makeStructure(room, STRUCTURE_SPAWN, { id: 'spawn', pos: makePosition(room, 25, 25) });
        const labSite = { id: 'lab-site', structureType: STRUCTURE_LAB, pos: makePosition(room, 24, 25), progress: 10, progressTotal: 100 };
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, []);
        setFind(room, FIND_MY_CONSTRUCTION_SITES, [labSite]);
        const position = new MayorManager(room)._findSmartPlacementPosition(STRUCTURE_LAB);
        assert.ok(position);
        assert.ok(position.inRangeTo(labSite.pos, 2));
    });

    it('counts pending source links and plans a controller receiver', function () {
        const room = plannerRoom(5);
        const spawn = makeStructure(room, STRUCTURE_SPAWN, { id: 'spawn', pos: makePosition(room, 25, 25) });
        const source = { id: 'source', pos: makePosition(room, 20, 20), energy: 3000 };
        const sourceLinkSite = { id: 'source-link-site', structureType: STRUCTURE_LINK, pos: makePosition(room, 21, 20) };
        setFind(room, FIND_MY_SPAWNS, [spawn]);
        setFind(room, FIND_MY_STRUCTURES, []);
        setFind(room, FIND_MY_CONSTRUCTION_SITES, [sourceLinkSite]);
        setFind(room, FIND_SOURCES, [source]);
        const position = new MayorManager(room)._findSmartPlacementPosition(STRUCTURE_LINK);
        assert.ok(position);
        assert.ok(position.inRangeTo(room.controller.pos, 2));
        assert.equal(room.memory.roomManager.linkRoles[position.x + ',' + position.y], constants.LINK_TYPE_TARGET);
    });

    it('places the extractor directly on the mineral', function () {
        const room = plannerRoom(6);
        const mineral = { id: 'mineral', pos: makePosition(room, 18, 19) };
        setFind(room, FIND_MINERALS, [mineral]);
        const position = new MayorManager(room)._findSmartPlacementPosition(STRUCTURE_EXTRACTOR);
        assert.equal(position, mineral.pos);
    });

    it('makes Nuker construction explicitly opt-in', function () {
        const room = plannerRoom(8);
        const mayor = new MayorManager(room);
        assert.equal(mayor._isStructureEnabled(STRUCTURE_NUKER), false);
        room.memory.mayor.enableNuker = true;
        assert.equal(mayor._isStructureEnabled(STRUCTURE_NUKER), true);
    });

    it('uses controller and site counts for available structure slots', function () {
        const room = plannerRoom(3);
        const manager = new RoomManager(room);
        assert.equal(manager.fetchFreeBuildingSlots(RoomManager.TILE_TOWER), 1);
        setFind(room, FIND_MY_CONSTRUCTION_SITES, [{ structureType: STRUCTURE_TOWER }]);
        setFind(room, FIND_STRUCTURES, []);
        assert.equal(manager.fetchFreeBuildingSlots(RoomManager.TILE_TOWER), 0);
    });

    it('does not call lookAt for every generated terrain cell', function () {
        const room = plannerRoom(1);
        let lookAtCalls = 0;
        let terrainCalls = 0;
        room.lookAt = () => { lookAtCalls++; return []; };
        room.getTerrain = () => { terrainCalls++; return { get: () => 0 }; };
        setFind(room, FIND_MY_SPAWNS, []);
        setFind(room, FIND_STRUCTURES, []);
        setFind(room, FIND_SOURCES, []);
        setFind(room, FIND_MINERALS, []);
        new RoomManager(room)._generateExistingTiles(new TileArray(2, 2));
        assert.equal(lookAtCalls, 0);
        assert.equal(terrainCalls, 1);
    });

    it('applies planned roles to completed unlabeled links', function () {
        const LinkManager = require('../manager.link');
        const room = plannerRoom(5);
        const source = makeStructure(room, STRUCTURE_LINK, {
            id: 'source-link',
            pos: makePosition(room, 20, 20),
            store: require('./helpers/screeps').makeStore(800, { [RESOURCE_ENERGY]: 400 }),
            memory: { type: constants.LINK_TYPE_SOURCE },
            extra: {
                cooldown: 0,
                transferEnergy(target) {
                    this.sentTo = target;
                    return OK;
                },
            },
        });
        const target = makeStructure(room, STRUCTURE_LINK, {
            id: 'target-link',
            pos: makePosition(room, 30, 30),
            store: require('./helpers/screeps').makeStore(800),
            memory: {},
        });
        room.memory.roomManager.linkRoles = { '30,30': constants.LINK_TYPE_TARGET };
        setFind(room, FIND_MY_STRUCTURES, [source, target]);
        new LinkManager(room).runLinks();
        assert.equal(target.memory.type, constants.LINK_TYPE_TARGET);
        assert.equal(source.sentTo, target);
    });

    it('marks a new construction site occupied immediately', function () {
        const room = plannerRoom(3);
        const mayor = new MayorManager(room);
        mayor._cache = { constructionSites: [] };
        const position = makePosition(room, 22, 22);
        assert.equal(mayor._isPositionBuildable(position), true);
        mayor._buildStructureAtPosition(position, { structureType: STRUCTURE_TOWER });
        assert.equal(mayor._isPositionBuildable(position), false);
        assert.equal(room.createdSites.length, 1);
    });
});
