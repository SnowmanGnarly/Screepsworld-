const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeTerminal, makeCreep, makeSpawn, makePosition,
    setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const MineralManager = require('../manager.mineral');
const MineralMiner = require('../role.miner.mineral');
const info = require('../main.info');

function mineralRoom(name = 'A', options = {}) {
    const room = makeRoom(name, {
        memory: { base: { name } },
        controller: {
            my: options.controllerMy === undefined ? true : options.controllerMy,
            level: options.level === undefined ? 6 : options.level,
        },
    });
    Game.rooms[name] = room;

    const storage = makeStructure(room, STRUCTURE_STORAGE, {
        id: 'storage-' + name,
        pos: makePosition(room, 20, 21),
        store: makeStore(options.storageCapacity === undefined ? 10000 : options.storageCapacity,
            options.storageContents || {}),
    });
    if (options.storage !== false) room.storage = storage;
    const terminal = makeTerminal(room, {
        id: 'terminal-' + name,
        pos: makePosition(room, 20, 22),
        capacity: options.terminalCapacity === undefined ? 10000 : options.terminalCapacity,
        contents: options.terminalContents || {},
        attach: options.terminal !== false,
    });
    const mineral = {
        id: 'mineral-' + name,
        room,
        pos: makePosition(room, 20, 20),
        mineralType: options.mineralType || RESOURCE_OXYGEN,
        mineralAmount: options.mineralAmount === undefined ? 500 : options.mineralAmount,
    };
    if (options.ticksToRegeneration !== undefined) mineral.ticksToRegeneration = options.ticksToRegeneration;
    const extractor = makeStructure(room, STRUCTURE_EXTRACTOR, {
        id: 'extractor-' + name,
        pos: options.extractorPos || mineral.pos,
        extra: {
            my: options.extractorMy === undefined ? true : options.extractorMy,
            cooldown: options.cooldown === undefined ? 0 : options.cooldown,
        },
    });
    registerObject(mineral, name);
    registerObject(extractor, name);
    setFind(room, FIND_MINERALS, [mineral]);
    setFind(room, FIND_MY_STRUCTURES, options.extractor === false ? [] : [extractor]);
    return { room, storage, terminal, mineral, extractor };
}

function mineralCreep(room, mineral, options = {}) {
    return makeCreep(room, {
        name: options.name || 'MineralMinerTest',
        memory: { role: 'MineralMiner', home: room.memory.base.name, source: mineral.id },
        body: options.body || [WORK, WORK, MOVE, CARRY],
        pos: options.pos || mineral.pos,
        store: options.store || makeStore(options.capacity || 100, options.contents || {}),
    });
}

describe('Mineral production regressions', function () {
    beforeEach(function () {
        resetScreeps();
    });

    it('requires an owned RCL6 room and a built owned extractor on the mineral', function () {
        const { room, mineral, extractor } = mineralRoom('A', { level: 5 });
        const role = new MineralMiner();
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), false);
        assert.equal(MineralManager.getDesiredMinerCount(room), 0);
        assert.equal(role.isNecessary(room), false);

        room.controller.level = 6;
        assert.equal(MineralManager.getDesiredMinerCount(room), 1);
        assert.equal(role.isNecessary(room), true);
        extractor.pos = makePosition(room, 21, 20);
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), false);
        extractor.pos = mineral.pos;
        extractor.my = false;
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), false);
        extractor.my = true;
        room.controller.my = false;
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), false);

        const missing = mineralRoom('B', { extractor: false });
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(missing.room)), false);
    });

    it('separates infrastructure from mineral, regeneration, cooldown, and capacity readiness', function () {
        const { room, storage, terminal, mineral, extractor } = mineralRoom();
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), true);

        mineral.mineralAmount = 0;
        let state = MineralManager.getMiningState(room);
        assert.equal(state.hasInfrastructure, true);
        assert.equal(MineralManager.canHarvest(state), false);
        mineral.mineralAmount = 500;
        mineral.ticksToRegeneration = 1;
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), false);
        mineral.ticksToRegeneration = 0;
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), true);
        extractor.cooldown = 1;
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), false);
        extractor.cooldown = 0;
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), true);

        storage.store._capacity = 0;
        terminal.store._capacity = 0;
        assert.equal(MineralManager.canHarvest(MineralManager.getMiningState(room)), false);
        assert.equal(MineralManager.getDesiredMinerCount(room), 0);
        terminal.store._capacity = 100;
        assert.deepEqual(MineralManager.getDeliveryTargets(room), [terminal]);
        assert.equal(MineralManager.getDesiredMinerCount(room), 1);
    });

    it('spawns the standard body capped at five WORK with mineral and spawn memory', function () {
        const { room, mineral } = mineralRoom();
        room.energyAvailable = 10000;
        const spawn = makeSpawn(room, { name: 'HomeSpawn', memory: { home: room.memory.base.name } });
        const role = new MineralMiner();
        const creep = role.spawnCreep(spawn);
        assert.ok(creep);
        assert.deepEqual(creep.body, [MOVE, CARRY, WORK, WORK, WORK, WORK, WORK]);
        assert.equal(creep.memory.role, 'MineralMiner');
        assert.equal(creep.memory.home, room.memory.base.name);
        assert.equal(creep.memory.source, mineral.id);
        assert.equal(creep.memory.homeSpawn, 'HomeSpawn');
        assert.equal(role.priority, -1);
        assert.equal(role._disableAutomaticLoot, true);
    });

    it('harvests the assigned mineral and delivers partial cargo while depleted and cooling down', function () {
        const { room, storage, mineral, extractor } = mineralRoom('A', { mineralAmount: 100 });
        const creep = mineralCreep(room, mineral);
        const role = new MineralMiner();
        role._work(creep);
        const harvested = creep.store.getUsedCapacity(RESOURCE_OXYGEN);
        assert.ok(harvested > 0);
        assert.equal(creep.store.getUsedCapacity(RESOURCE_ENERGY), 0);
        assert.ok(mineral.mineralAmount < 100);

        mineral.mineralAmount = 0;
        mineral.ticksToRegeneration = 50;
        extractor.cooldown = 5;
        role._work(creep);
        assert.equal(creep.store.getUsedCapacity(RESOURCE_OXYGEN), 0);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_OXYGEN), harvested);
        assert.equal(creep.memory.source, mineral.id);
    });

    it('keeps mining through extractor cooldowns and delivers only when full', function () {
        const { room, storage, mineral, extractor } = mineralRoom();
        const creep = mineralCreep(room, mineral);
        const role = new MineralMiner();
        role._work(creep);
        const firstLoad = creep.store.getUsedCapacity(RESOURCE_OXYGEN);
        assert.ok(firstLoad > 0);

        extractor.cooldown = 5;
        role._work(creep);
        assert.equal(creep.lastMoveTo, undefined);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_OXYGEN), 0);
        assert.equal(creep.store.getUsedCapacity(RESOURCE_OXYGEN), firstLoad);

        extractor.cooldown = 0;
        role._work(creep);
        assert.ok(creep.store.getUsedCapacity(RESOURCE_OXYGEN) > firstLoad);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_OXYGEN), 0);

        creep.store.set(RESOURCE_OXYGEN, 100);
        role._work(creep);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_OXYGEN), 100);
        assert.equal(creep.store.getUsedCapacity(RESOURCE_OXYGEN), 0);
    });

    it('falls back to a nonfull terminal and moves in range before delivery', function () {
        const { room, storage, terminal, mineral, extractor } = mineralRoom('A', {
            mineralAmount: 0,
            ticksToRegeneration: 50,
            cooldown: 5,
            storageCapacity: 10,
            storageContents: { [RESOURCE_ENERGY]: 10 },
        });
        const creep = mineralCreep(room, mineral, {
            contents: { [RESOURCE_OXYGEN]: 20 },
        });
        const role = new MineralMiner();
        role._work(creep);
        assert.equal(creep.lastMoveTo, terminal);
        assert.equal(creep.store.getUsedCapacity(RESOURCE_OXYGEN), 20);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_OXYGEN), 0);

        creep.pos = terminal.pos;
        role._work(creep);
        assert.equal(creep.store.getUsedCapacity(RESOURCE_OXYGEN), 0);
        assert.equal(terminal.store.getUsedCapacity(RESOURCE_OXYGEN), 20);
        assert.equal(storage.store.getUsedCapacity(RESOURCE_ENERGY), 10);
        assert.equal(extractor.cooldown, 5);
    });

    it('moves to a ready mineral on ERR_NOT_IN_RANGE', function () {
        const { room, mineral } = mineralRoom();
        const creep = mineralCreep(room, mineral, { pos: makePosition(room, 10, 10) });
        new MineralMiner()._work(creep);
        assert.equal(creep.lastMoveTo, mineral);
        assert.equal(creep.movedThisTick, true);
        assert.equal(creep.memory.source, mineral.id);
        assert.equal(mineral.mineralAmount, 500);
    });

    it('treats cooldown and depletion results as waiting without clearing the source or warning', function () {
        const { room, mineral } = mineralRoom();
        const creep = mineralCreep(room, mineral);
        const role = new MineralMiner();
        let warnings = 0;
        info.warning = () => warnings++;
        creep.harvest = () => ERR_TIRED;
        role._work(creep);
        creep.harvest = () => ERR_NOT_ENOUGH_RESOURCES;
        role._work(creep);
        assert.equal(creep.memory.source, mineral.id);
        assert.equal(warnings, 0);
    });
});
