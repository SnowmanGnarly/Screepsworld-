const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeCreep, makeSpawn, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const EconomyManager = require('../manager.economy');
const LinkManager = require('../manager.link');
const LogisticsManager = require('../manager.logistics');
const MainCache = require('../main.cache');
const MayorManager = require('../manager.mayor');
const constants = require('../main.constants');
const config = require('../main.config');
const Harvester = require('../role.harvester');

function homeRoom(options = {}) {
    const room = makeRoom('A', {
        memory: { base: { name: 'A', roleConfig: {} } },
        energyAvailable: options.energy === undefined ? 300 : options.energy,
        energyCapacityAvailable: options.capacity || 300,
    });
    room.controller = { my: true, level: options.level || 6, pos: makePosition(room, 30, 30), id: 'controller' };
    const spawn = makeSpawn(room, { name: 'Spawn1', pos: makePosition(room, 25, 25), memory: { home: 'A' } });
    Game.rooms.A = room;
    Game.spawns.Spawn1 = spawn;
    setFind(room, FIND_MY_SPAWNS, [spawn]);
    return { room, spawn };
}

function addSource(room, id, x, y) {
    const source = { id, room, pos: makePosition(room, x, y), energy: 3000, energyCapacity: 3000 };
    registerObject(source, room.name);
    setFind(room, FIND_SOURCES, (room._find[FIND_SOURCES] || []).concat(source));
    setFind(room, FIND_SOURCES_ACTIVE, (room._find[FIND_SOURCES_ACTIVE] || []).concat(source));
    return source;
}

function addStructure(room, type, x, y, options = {}) {
    const structure = makeStructure(room, type, Object.assign({ pos: makePosition(room, x, y), extra: { my: true } }, options));
    registerObject(structure, room.name);
    setFind(room, FIND_STRUCTURES, (room._find[FIND_STRUCTURES] || []).concat(structure));
    setFind(room, FIND_MY_STRUCTURES, (room._find[FIND_MY_STRUCTURES] || []).concat(structure));
    return structure;
}

function addLink(room, type, x, y, contents = {}) {
    return addStructure(room, STRUCTURE_LINK, x, y, { memory: { type }, store: makeStore(800, contents) });
}

function addStorage(room, x, y, energy) {
    room.storage = addStructure(room, STRUCTURE_STORAGE, x, y, { store: makeStore(1000000, { [RESOURCE_ENERGY]: energy }) });
    return room.storage;
}

function addCreep(room, name, role, extra = {}) {
    const { memory, ...options } = extra;
    Game.creeps[name] = makeCreep(room, Object.assign({ name, memory: Object.assign({ role, home: 'A' }, memory) }, options));
    return Game.creeps[name];
}

describe('Energy that reaches the room', function () {
    beforeEach(function () {
        resetScreeps();
    });

    describe('links as drop-offs', function () {
        it('does not count a source link with no receiver at the storage', function () {
            const { room } = homeRoom();
            const source = addSource(room, 's1', 10, 10);
            addLink(room, constants.LINK_TYPE_SOURCE, 11, 11);
            assert.equal(EconomyManager.hasDropoff(room, source), false);
            assert.equal(EconomyManager.getDesiredMiners(room), 0);
        });

        it('does not count a controller link as a way into the room, because only Upgraders use it', function () {
            const { room } = homeRoom();
            const source = addSource(room, 's1', 10, 10);
            addStorage(room, 20, 40, 1000);
            addLink(room, constants.LINK_TYPE_SOURCE, 11, 11);
            addLink(room, constants.LINK_TYPE_TARGET, 31, 31);
            assert.equal(EconomyManager.getHubLink(room), null);
            assert.equal(EconomyManager.hasDropoff(room, source), false);
        });

        it('counts a source link once a receiver beside the storage exists', function () {
            const { room } = homeRoom();
            const source = addSource(room, 's1', 10, 10);
            addStorage(room, 20, 40, 1000);
            addLink(room, constants.LINK_TYPE_SOURCE, 11, 11);
            const hub = addLink(room, constants.LINK_TYPE_TARGET, 21, 41);
            assert.equal(EconomyManager.getHubLink(room), hub);
            assert.equal(EconomyManager.hasDropoff(room, source), true);
            assert.equal(EconomyManager.getDesiredMiners(room), 1);
        });

        it('still hauls from a linked source until that receiver exists', function () {
            const { room } = homeRoom();
            addSource(room, 's1', 10, 10);
            addStorage(room, 20, 40, 1000);
            addStructure(room, STRUCTURE_CONTAINER, 9, 9);
            addLink(room, constants.LINK_TYPE_SOURCE, 8, 8);
            assert.ok(EconomyManager.getHaulingCarryParts(room) > 0);
            addLink(room, constants.LINK_TYPE_TARGET, 21, 41);
            MainCache.initRound([]);
            assert.equal(EconomyManager.getHaulingCarryParts(room), 0);
        });

        it('keeps Harvesters on a source that only has a link with no receiver', function () {
            const { room } = homeRoom();
            addSource(room, 's1', 10, 10);
            addLink(room, constants.LINK_TYPE_SOURCE, 11, 11);
            addCreep(room, 'sk', 'Storekeeper');
            MainCache.initRound([]);
            assert.equal(EconomyManager.isSelfSustaining(room), false);
            assert.ok(EconomyManager.getDesiredHarvesters(room) >= 1);
        });

        it('does not call a room self-sustaining because of a Miner on an undeliverable source', function () {
            const { room } = homeRoom();
            addSource(room, 's1', 10, 10);
            addLink(room, constants.LINK_TYPE_SOURCE, 11, 11);
            addCreep(room, 'sk', 'Storekeeper');
            addCreep(room, 'm', 'Miner', { memory: { source: 's1' } });
            MainCache.initRound([]);
            assert.equal(EconomyManager.isSelfSustaining(room), false);
        });
    });

    describe('emptying the storage-side link', function () {
        it('asks a hauler to carry it into the storage', function () {
            const { room } = homeRoom();
            const storage = addStorage(room, 20, 40, 1000);
            const hub = addLink(room, constants.LINK_TYPE_TARGET, 21, 41, { [RESOURCE_ENERGY]: 400 });
            new LogisticsManager(room).run();
            const task = room.memory.logistics.tasks.find(entry => entry.sourceId === hub.id);
            assert.ok(task, 'a collect task exists');
            assert.equal(task.targetId, storage.id);
            assert.equal(task.kind, LogisticsManager.KIND_COLLECT);
        });

        it('leaves a nearly empty link alone', function () {
            const { room } = homeRoom();
            addStorage(room, 20, 40, 1000);
            const hub = addLink(room, constants.LINK_TYPE_TARGET, 21, 41, { [RESOURCE_ENERGY]: config.LOGISTICS.LINK_COLLECT_MIN - 1 });
            new LogisticsManager(room).run();
            assert.ok(!room.memory.logistics.tasks.some(entry => entry.sourceId === hub.id));
        });

        it('leaves the controller link to the Upgraders', function () {
            const { room } = homeRoom();
            addStorage(room, 20, 40, 1000);
            const controllerLink = addLink(room, constants.LINK_TYPE_TARGET, 31, 31, { [RESOURCE_ENERGY]: 800 });
            new LogisticsManager(room).run();
            assert.ok(!room.memory.logistics.tasks.some(entry => entry.sourceId === controllerLink.id));
        });
    });

    describe('sending between links', function () {
        it('sends to the receiver with the most room, so one full link does not block the other', function () {
            const { room } = homeRoom();
            addStorage(room, 20, 40, 1000);
            const sent = [];
            const sender = addLink(room, constants.LINK_TYPE_SOURCE, 11, 11, { [RESOURCE_ENERGY]: 400 });
            sender.cooldown = 0;
            sender.transferEnergy = target => {
                sent.push(target.id);
                return OK;
            };
            addLink(room, constants.LINK_TYPE_TARGET, 31, 31, { [RESOURCE_ENERGY]: 700 });
            const emptier = addLink(room, constants.LINK_TYPE_TARGET, 21, 41, { [RESOURCE_ENERGY]: 100 });
            new LinkManager(room).runLinks();
            assert.deepEqual(sent, [emptier.id]);
        });
    });

    describe('Mayor link order', function () {
        function linkLimits() {
            global.CONTROLLER_STRUCTURES = Object.assign({}, CONTROLLER_STRUCTURES, { [STRUCTURE_LINK]: { 5: 2, 6: 3, 7: 4, 8: 6 } });
        }

        it('builds the storage receiver first, or the source links would carry nothing', function () {
            linkLimits();
            const { room } = homeRoom({ level: 5 });
            addSource(room, 's1', 10, 10);
            const storage = addStorage(room, 25, 40, 1000);
            const position = new MayorManager(room)._findSmartPlacementPosition(STRUCTURE_LINK);
            assert.ok(position.inRangeTo(storage.pos, 2));
            assert.equal(room.memory.roomManager.linkRoles[position.x + ',' + position.y], constants.LINK_TYPE_TARGET);
        });

        it('then links a source, next to the container its Miner stands on', function () {
            linkLimits();
            const { room } = homeRoom({ level: 5 });
            const source = addSource(room, 's1', 10, 10);
            const storage = addStorage(room, 25, 40, 1000);
            const container = addStructure(room, STRUCTURE_CONTAINER, 11, 10);
            addLink(room, constants.LINK_TYPE_TARGET, storage.pos.x + 1, storage.pos.y + 1);
            MainCache.initRound([]);
            const position = new MayorManager(room)._findSmartPlacementPosition(STRUCTURE_LINK);
            assert.ok(position.inRangeTo(source.pos, 2));
            assert.ok(position.isNearTo(container.pos), position.x + ',' + position.y);
            assert.equal(room.memory.roomManager.linkRoles[position.x + ',' + position.y], constants.LINK_TYPE_SOURCE);
        });

        it('adds the controller link only after the sources', function () {
            linkLimits();
            const { room } = homeRoom({ level: 7 });
            addSource(room, 's1', 10, 10);
            const storage = addStorage(room, 25, 40, 1000);
            addLink(room, constants.LINK_TYPE_TARGET, storage.pos.x + 1, storage.pos.y + 1);
            addLink(room, constants.LINK_TYPE_SOURCE, 11, 11);
            MainCache.initRound([]);
            const position = new MayorManager(room)._findSmartPlacementPosition(STRUCTURE_LINK);
            assert.ok(position.inRangeTo(room.controller.pos, 2));
        });
    });

    describe('spending what is mined', function () {
        function sustainingRoom(options = {}) {
            const setup = homeRoom(options);
            addSource(setup.room, 's1', 10, 10);
            addSource(setup.room, 's2', 40, 40);
            addStructure(setup.room, STRUCTURE_CONTAINER, 11, 11);
            addStructure(setup.room, STRUCTURE_CONTAINER, 39, 39);
            addCreep(setup.room, 'm1', 'Miner', { memory: { source: 's1' } });
            addCreep(setup.room, 'm2', 'Miner', { memory: { source: 's2' } });
            addCreep(setup.room, 'sk', 'Storekeeper');
            MainCache.initRound([]);
            return setup;
        }

        it('keeps one Upgrader before static mining works', function () {
            const { room } = homeRoom({ capacity: 800, level: 3 });
            addSource(room, 's1', 10, 10);
            assert.equal(EconomyManager.getDesiredUpgraders(room), 1);
        });

        it('sizes upgrading from income once Miners run, without waiting for savings', function () {
            const { room } = sustainingRoom({ capacity: 800, level: 3 });
            room._find[FIND_STRUCTURES][0].store.set(RESOURCE_ENERGY, config.ECONOMY.UPGRADER_CONTAINER_FLOOR);
            // 20 energy per tick x 0.6 = 12 WORK, and 800 capacity pays for 3 per creep
            assert.equal(EconomyManager.getDesiredUpgraders(room), 4);
        });

        it('needs fewer Upgraders as each one grows', function () {
            const { room } = sustainingRoom({ capacity: 2300, level: 6 });
            addStorage(room, 25, 40, config.ECONOMY.UPGRADER_STORAGE_FLOOR);
            MainCache.initRound([]);
            // 12 WORK wanted and 9 per creep
            assert.equal(EconomyManager.getDesiredUpgraders(room), 2);
        });

        it('holds Upgraders back until the containers have something to spare, before there is a storage', function () {
            const { room } = sustainingRoom({ capacity: 800, level: 3 });
            const containers = room._find[FIND_STRUCTURES].filter(structure => structure.structureType === STRUCTURE_CONTAINER);
            containers.forEach(container => container.store.set(RESOURCE_ENERGY, 0));
            MainCache.initRound([]);
            assert.equal(EconomyManager.getDesiredUpgraders(room), 1);
            containers[0].store.set(RESOURCE_ENERGY, config.ECONOMY.UPGRADER_CONTAINER_FLOOR);
            MainCache.initRound([]);
            assert.equal(EconomyManager.getDesiredUpgraders(room), 4);
        });

        it('drops to one while the storage rebuilds its reserve', function () {
            const { room } = sustainingRoom({ capacity: 2300, level: 6 });
            addStorage(room, 25, 40, config.ECONOMY.UPGRADER_STORAGE_FLOOR - 1);
            MainCache.initRound([]);
            assert.equal(EconomyManager.getDesiredUpgraders(room), 1);
        });

        it('adds Upgraders from savings above the reserve, up to the limit', function () {
            const { room } = sustainingRoom({ capacity: 2300, level: 6 });
            addStorage(room, 25, 40, config.ECONOMY.UPGRADER_STORAGE_FLOOR + config.ECONOMY.UPGRADER_STORAGE_STEP);
            MainCache.initRound([]);
            assert.equal(EconomyManager.getDesiredUpgraders(room), 3);
            room.storage.store.set(RESOURCE_ENERGY, 900000);
            MainCache.initRound([]);
            assert.equal(EconomyManager.getDesiredUpgraders(room), config.ECONOMY.UPGRADER_MAX);
        });

        it('stops at what RCL 8 can use', function () {
            const { room } = sustainingRoom({ capacity: 12900, level: 8 });
            addStorage(room, 25, 40, 900000);
            MainCache.initRound([]);
            const work = EconomyManager.getSpendingWorkParts(room);
            assert.equal(EconomyManager.getDesiredUpgraders(room), Math.ceil(CONTROLLER_MAX_UPGRADE_PER_TICK / work));
        });

        it('counts only sources that Miners are working', function () {
            const { room } = sustainingRoom({ capacity: 800, level: 3 });
            room._find[FIND_STRUCTURES][0].store.set(RESOURCE_ENERGY, config.ECONOMY.UPGRADER_CONTAINER_FLOOR);
            delete Game.creeps.m2;
            MainCache.initRound([]);
            assert.equal(EconomyManager.getDesiredUpgraders(room), 2);
        });

        it('starts a room with enough Harvesters to use its sources', function () {
            const { room } = homeRoom({ capacity: 300, level: 1 });
            addSource(room, 's1', 10, 10);
            addSource(room, 's2', 40, 40);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 2 * config.ECONOMY.HARVESTERS_PER_SOURCE_MAX);
        });

        it('needs fewer as bodies grow', function () {
            const { room } = homeRoom({ capacity: 1300, level: 4 });
            addSource(room, 's1', 10, 10);
            addSource(room, 's2', 40, 40);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 2);
        });

        it('does not send more Harvesters to a source than can stand beside it', function () {
            const { room } = homeRoom({ capacity: 300, level: 1 });
            const source = addSource(room, 's1', 10, 10);
            room.getTerrain = () => ({ get: (x, y) => (x === 9 && y === 9 ? 0 : TERRAIN_MASK_WALL) });
            assert.ok(source);
            assert.equal(EconomyManager.getDesiredHarvesters(room), 1);
        });

        it('adds Builders quickly when there is much to build', function () {
            const { room } = homeRoom({ capacity: 550, level: 2 });
            const sites = [0, 1, 2].map(index => ({ id: 'site' + index, progress: 0, progressTotal: 3000 }));
            setFind(room, FIND_MY_CONSTRUCTION_SITES, sites);
            assert.equal(EconomyManager.getDesiredBuilders(room), 2);
        });

        it('sends an Upgrader to the store nearest the controller, even when another is nearer the creep', function () {
            const Upgrader = require('../role.upgrader');
            const { room } = homeRoom();
            const near = addLink(room, constants.LINK_TYPE_TARGET, 31, 31, { [RESOURCE_ENERGY]: 500 });
            addStorage(room, 20, 20, 5000);
            const creep = addCreep(room, 'up', 'Upgrader', { pos: makePosition(room, 21, 21) });
            const role = new Upgrader();
            role._baseRoom = room;
            role._useStorageAsSource = true;
            assert.equal(role._findClosestSource(creep), near);
        });
    });

    describe('Miners at their post', function () {
        const Miner = require('../role.miner');

        function minerRoom(options = {}) {
            const setup = homeRoom(options);
            const source = addSource(setup.room, 's1', 10, 10);
            return Object.assign(setup, { source });
        }

        function runMiner(room, creep) {
            MainCache.initRound([]);
            new Miner().run(creep, room);
        }

        it('walks onto the container that touches the source', function () {
            const { room } = minerRoom();
            const container = addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(2000) });
            const creep = addCreep(room, 'm', 'Miner', { pos: makePosition(room, 20, 20), memory: { source: 's1' }, body: [WORK, MOVE, CARRY] });
            runMiner(room, creep);
            assert.equal(creep.lastMoveTo.x, container.pos.x);
            assert.equal(creep.lastMoveTo.y, container.pos.y);
        });

        it('keeps walking when it stands on the same coordinates in another room', function () {
            const { room } = minerRoom();
            addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(2000) });
            const creep = addCreep(room, 'm', 'Miner', { pos: new RoomPosition(11, 10, 'B'), memory: { source: 's1' }, body: [WORK, MOVE, CARRY] });
            runMiner(room, creep);
            assert.equal(creep.lastMoveTo.roomName, 'A');
        });

        it('harvests and transfers in the same tick, and loses nothing', function () {
            const { room, source } = minerRoom();
            const container = addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(2000) });
            const creep = addCreep(room, 'm', 'Miner', {
                pos: makePosition(room, 11, 10), memory: { source: 's1' }, capacity: 50,
                body: [WORK, WORK, WORK, WORK, WORK, MOVE, CARRY], store: makeStore(50, { [RESOURCE_ENERGY]: 40 }),
            });
            const before = source.energy;
            let transferred = 0;
            const transfer = creep.transfer;
            creep.transfer = function (target, type) {
                transferred = this.store.getUsedCapacity(type);
                return transfer.call(this, target, type);
            };
            runMiner(room, creep);
            assert.equal(source.energy, before - 10, 'it harvested this tick');
            assert.equal(transferred > 0, true, 'and transferred this tick');
            assert.equal(container.store.getUsedCapacity(RESOURCE_ENERGY) > 0, true);
        });

        it('keeps harvesting without a pause over a whole source cycle', function () {
            const { room, source } = minerRoom();
            addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(100000) });
            const creep = addCreep(room, 'm', 'Miner', {
                pos: makePosition(room, 11, 10), memory: { source: 's1' }, capacity: 50, body: [WORK, WORK, WORK, WORK, WORK, MOVE, CARRY],
            });
            for (let tick = 0; tick < 300; tick++) {
                Game.time++;
                runMiner(room, creep);
            }
            assert.equal(source.energy, 0, 'the whole 3000 in 300 ticks');
        });

        it('does not unload a small amount, which would waste an intent', function () {
            const { room } = minerRoom();
            const container = addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(2000) });
            const creep = addCreep(room, 'm', 'Miner', {
                pos: makePosition(room, 11, 10), memory: { source: 's1' }, capacity: 50, body: [WORK, MOVE, CARRY], store: makeStore(50, { [RESOURCE_ENERGY]: 4 }),
            });
            runMiner(room, creep);
            assert.equal(container.store.getUsedCapacity(RESOURCE_ENERGY), 0);
        });

        it('prefers a link that can deliver over the container', function () {
            const { room } = minerRoom();
            addStorage(room, 25, 40, 1000);
            addLink(room, constants.LINK_TYPE_TARGET, 26, 41);
            const container = addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(2000) });
            const link = addLink(room, constants.LINK_TYPE_SOURCE, 12, 11);
            const creep = addCreep(room, 'm', 'Miner', {
                pos: makePosition(room, 11, 10), memory: { source: 's1' }, capacity: 50, body: [WORK, MOVE, CARRY], store: makeStore(50, { [RESOURCE_ENERGY]: 49 }),
            });
            runMiner(room, creep);
            assert.ok(link.store.getUsedCapacity(RESOURCE_ENERGY) > 0);
            assert.equal(container.store.getUsedCapacity(RESOURCE_ENERGY), 0);
        });

        it('fills the container, not a link that has no way into the room', function () {
            const { room } = minerRoom();
            const container = addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(2000) });
            const link = addLink(room, constants.LINK_TYPE_SOURCE, 12, 11);
            const creep = addCreep(room, 'm', 'Miner', {
                pos: makePosition(room, 11, 10), memory: { source: 's1' }, capacity: 50, body: [WORK, MOVE, CARRY], store: makeStore(50, { [RESOURCE_ENERGY]: 49 }),
            });
            runMiner(room, creep);
            assert.equal(link.store.getUsedCapacity(RESOURCE_ENERGY), 0);
            assert.ok(container.store.getUsedCapacity(RESOURCE_ENERGY) > 0);
        });

        it('counts a link out of reach of the post as needing haulers', function () {
            const { room, source } = minerRoom();
            addStorage(room, 25, 40, 1000);
            addLink(room, constants.LINK_TYPE_TARGET, 26, 41);
            addStructure(room, STRUCTURE_CONTAINER, 11, 10);
            addLink(room, constants.LINK_TYPE_SOURCE, 8, 8);
            assert.equal(EconomyManager.hasDeliveringLink(room, source), false);
            assert.ok(EconomyManager.getHaulingCarryParts(room) > 0);
        });

        it('stands between the source and a link when there is no container', function () {
            const { room, source } = minerRoom();
            addStorage(room, 25, 40, 1000);
            addLink(room, constants.LINK_TYPE_TARGET, 26, 41);
            const link = addLink(room, constants.LINK_TYPE_SOURCE, 12, 12);
            const post = EconomyManager.getMinerPost(room, source);
            assert.deepEqual(post, { x: 11, y: 11 });
            assert.ok(link.pos.inRangeTo(post.x, post.y, 1));
        });

        it('works beside the post while the Miner it replaces is still on it', function () {
            const { room, source } = minerRoom();
            addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(2000) });
            addCreep(room, 'old', 'Miner', { pos: makePosition(room, 11, 10), memory: { source: 's1' }, ticksToLive: 5 });
            const creep = addCreep(room, 'new', 'Miner', { pos: makePosition(room, 11, 11), memory: { source: 's1' }, capacity: 50, body: [WORK, MOVE, CARRY] });
            const before = source.energy;
            runMiner(room, creep);
            assert.equal(creep.lastMoveTo, undefined, 'it does not push against the old Miner');
            assert.equal(source.energy, before - 2);
        });

        it('still feeds a link with no way into the room, rather than spilling on the ground', function () {
            const { room } = minerRoom();
            const link = addLink(room, constants.LINK_TYPE_SOURCE, 12, 12);
            const creep = addCreep(room, 'm', 'Miner', {
                pos: makePosition(room, 11, 11), memory: { source: 's1', working: true, ticksToSource: 1400, initialTicksToLive: 1500 },
                capacity: 50, body: [WORK, MOVE, CARRY], store: makeStore(50, { [RESOURCE_ENERGY]: 50 }),
            });
            runMiner(room, creep);
            assert.equal(link.store.getUsedCapacity(RESOURCE_ENERGY), 50);
        });

        it('takes over a post that a passing creep is standing on', function () {
            const { room } = minerRoom();
            const container = addStructure(room, STRUCTURE_CONTAINER, 11, 10, { store: makeStore(2000) });
            addCreep(room, 'passing', 'Storekeeper', { pos: makePosition(room, 11, 10) });
            const creep = addCreep(room, 'm', 'Miner', { pos: makePosition(room, 11, 11), memory: { source: 's1' }, capacity: 50, body: [WORK, MOVE, CARRY] });
            runMiner(room, creep);
            assert.equal(creep.lastMoveTo.x, container.pos.x);
            assert.equal(creep.lastMoveTo.y, container.pos.y);
        });

        it('still walks to a store when nothing stands beside the source', function () {
            const { room } = minerRoom();
            const storage = addStorage(room, 14, 10, 0);
            const creep = addCreep(room, 'm', 'Miner', {
                pos: makePosition(room, 11, 10), memory: { source: 's1', working: true, ticksToSource: 1400, initialTicksToLive: 1500 },
                capacity: 50, body: [WORK, MOVE, CARRY], store: makeStore(50, { [RESOURCE_ENERGY]: 50 }),
            });
            runMiner(room, creep);
            assert.equal(creep.lastMoveTo, storage);
        });
    });

    describe('Harvesters with no free source', function () {
        function minedRoom(options = {}) {
            const setup = homeRoom(options);
            addSource(setup.room, 's1', 10, 10);
            addStructure(setup.room, STRUCTURE_CONTAINER, 11, 11, { store: makeStore(2000) });
            addCreep(setup.room, 'm1', 'Miner', { memory: { source: 's1' } });
            MainCache.initRound([]);
            return setup;
        }

        function run(room, creep) {
            const role = new Harvester();
            role.run(creep, room);
            return role;
        }

        it('takes from the storage rather than standing idle', function () {
            const { room } = minedRoom();
            const storage = addStorage(room, 26, 25, 5000);
            const harvester = addCreep(room, 'h', 'Harvester', { pos: makePosition(room, 26, 26), capacity: 100 });
            MainCache.initRound([]);
            run(room, harvester);
            assert.equal(harvester.store.getUsedCapacity(RESOURCE_ENERGY), 100);
            assert.equal(storage.store.getUsedCapacity(RESOURCE_ENERGY), 4900);
        });

        it('prefers a source when one is free', function () {
            const { room } = homeRoom();
            const source = addSource(room, 's1', 26, 26);
            addStorage(room, 24, 24, 5000);
            const harvester = addCreep(room, 'h', 'Harvester', { pos: makePosition(room, 25, 25), capacity: 100 });
            MainCache.initRound([]);
            run(room, harvester);
            assert.equal(harvester.memory.source, source.id);
        });

        it('brings storage energy to the spawn and never back to the storage', function () {
            const { room } = minedRoom();
            const storage = addStorage(room, 26, 25, 5000);
            const extension = addStructure(room, STRUCTURE_EXTENSION, 27, 26, { store: makeStore(50) });
            const harvester = addCreep(room, 'h', 'Harvester', {
                pos: makePosition(room, 26, 26), store: makeStore(100, { [RESOURCE_ENERGY]: 100 }), memory: { working: true },
            });
            MainCache.initRound([]);
            run(room, harvester);
            assert.equal(extension.store.getUsedCapacity(RESOURCE_ENERGY), 50);

            extension.store.set(RESOURCE_ENERGY, 50);
            MainCache.initRound([]);
            const before = storage.store.getUsedCapacity(RESOURCE_ENERGY);
            run(room, harvester);
            assert.equal(storage.store.getUsedCapacity(RESOURCE_ENERGY), before, 'nothing is carried back');
        });

        it('still delivers to the storage when it mined the energy itself', function () {
            const { room } = homeRoom();
            addSource(room, 's1', 40, 40);
            const storage = addStorage(room, 26, 25, 0);
            const harvester = addCreep(room, 'h', 'Harvester', {
                pos: makePosition(room, 26, 26), store: makeStore(100, { [RESOURCE_ENERGY]: 100 }), memory: { working: true },
            });
            MainCache.initRound([]);
            run(room, harvester);
            assert.equal(storage.store.getUsedCapacity(RESOURCE_ENERGY), 100);
        });
    });
});
