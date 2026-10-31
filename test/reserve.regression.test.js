const assert = require('node:assert/strict');
const {
    makeRoom, makeStore, makeStructure, makeCreep, makeTerminal, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const constants = require('../main.constants');
const config = require('../main.config');
const MainCache = require('../main.cache');
const EconomyManager = require('../manager.economy');
const TerminalManager = require('../manager.terminal');
const LogisticsManager = require('../manager.logistics');
const Director = require('../manager.director');
const Builder = require('../role.builder');
const Upgrader = require('../role.upgrader');
const Handyman = require('../role.handyman');
const Harvester = require('../role.harvester');

const RESERVE = config.ECONOMY.ENERGY_RESERVE_MINIMUM;

function makeBase(options = {}) {
    const room = makeRoom('W1N1', { memory: { base: { name: 'W1N1', roleConfig: {} } }, energyAvailable: 300, energyCapacityAvailable: 300 });
    room.controller = {
        id: 'controller', room, my: true, level: options.level || 6, pos: makePosition(room, 40, 40), structureType: STRUCTURE_CONTROLLER,
        ticksToDowngrade: options.ticksToDowngrade === undefined ? 50000 : options.ticksToDowngrade,
    };
    Game.rooms.W1N1 = room;
    const structures = [];
    const place = (type, id, x, y, energy, capacity = 2000, extra = {}) => {
        const structure = makeStructure(room, type, { id, pos: makePosition(room, x, y), store: makeStore(capacity, { [RESOURCE_ENERGY]: energy }), extra: Object.assign({ my: true }, extra) });
        registerObject(structure, room.name);
        structures.push(structure);
        return structure;
    };
    const source = { id: 'source', room, pos: makePosition(room, 5, 5), energy: 3000, energyCapacity: 3000 };
    registerObject(source, room.name);
    setFind(room, FIND_SOURCES, [source]);
    setFind(room, FIND_SOURCES_ACTIVE, []);
    registerObject(room.controller, room.name);
    if (options.stored !== undefined) {
        room.storage = place(STRUCTURE_STORAGE, 'storage', 20, 20, options.stored, 1000000);
    }
    if (options.terminalEnergy !== undefined) {
        const terminal = makeTerminal(room, { id: 'terminal', pos: makePosition(room, 22, 20), contents: { [RESOURCE_ENERGY]: options.terminalEnergy } });
        registerObject(terminal, room.name);
        structures.push(terminal);
    }
    const sync = () => {
        setFind(room, FIND_STRUCTURES, structures);
        setFind(room, FIND_MY_STRUCTURES, structures);
        MainCache.initRound([]);
    };
    sync();
    return { room, source, structures, place: (...args) => { const made = place(...args); sync(); return made; }, sync };
}

function worker(room, role, x = 20, y = 21, options = {}) {
    const creep = makeCreep(room, Object.assign({
        name: role + '-' + x + '-' + y, pos: makePosition(room, x, y), capacity: 300,
        body: [WORK, CARRY, MOVE], memory: { role, home: room.name },
    }, options));
    Game.creeps[creep.name] = creep;
    return creep;
}

const carried = creep => creep.store.getUsedCapacity(RESOURCE_ENERGY);
const ROLES = [['Builder', Builder], ['Upgrader', Upgrader], ['Handyman', Handyman]];

describe('Energy reserve', function () {
    beforeEach(function () {
        resetScreeps();
    });

    describe('getSpendableEnergy', function () {
        it('is storage plus terminal, less the reserve', function () {
            const { room } = makeBase({ stored: RESERVE, terminalEnergy: 7000 });
            assert.equal(EconomyManager.getStoredEnergy(room), RESERVE + 7000);
            assert.equal(EconomyManager.getSpendableEnergy(room), 7000);
        });

        it('is 0 at or below the reserve, never negative', function () {
            assert.equal(EconomyManager.getSpendableEnergy(makeBase({ stored: RESERVE }).room), 0);
            assert.equal(EconomyManager.getSpendableEnergy(makeBase({ stored: 10 }).room), 0);
        });

        it('is a lower line while a room is still growing, and the full one from RCL 6', function () {
            const line = level => EconomyManager.getEnergyReserve(makeBase({ level, stored: 0 }).room);
            Object.keys(config.ECONOMY.ENERGY_RESERVE_BY_RCL).forEach(level => {
                assert.ok(line(Number(level)) < RESERVE, 'RCL ' + level);
            });
            [6, 7, 8].forEach(level => assert.equal(line(level), RESERVE, 'RCL ' + level));
        });

        it('is 0 in a room with neither', function () {
            assert.equal(EconomyManager.getSpendableEnergy(makeBase().room), 0);
        });

        it('honors a per-room override', function () {
            const { room } = makeBase({ stored: 3000 });
            room.memory.terminal = { emergencyReserve: 1000 };
            assert.equal(EconomyManager.getSpendableEnergy(room), 2000);
        });

        it('counts what workers already took this tick, since the store only changes next tick', function () {
            const { room } = makeBase({ stored: RESERVE + 500 });
            EconomyManager.noteWorkerWithdrawal(room, 200);
            assert.equal(EconomyManager.getSpendableEnergy(room), 300);
            Game.time++;
            assert.equal(EconomyManager.getSpendableEnergy(room), 500, 'and starts over on the next one');
        });
    });

    describe('workers at the reserve', function () {
        ROLES.forEach(([name, Role]) => {
            it(name + ' takes nothing from storage at the line, and goes idle', function () {
                const { room } = makeBase({ stored: RESERVE });
                const creep = worker(room, name);
                new Role().run(creep, room);
                assert.equal(carried(creep), 0);
                assert.equal(room.storage.store.getUsedCapacity(RESOURCE_ENERGY), RESERVE);
                assert.equal(creep.lastMoveTo, undefined, 'it does not walk to a store it may not use');
            });

            it(name + ' cannot use a storage it remembers from before', function () {
                const { room } = makeBase({ stored: RESERVE });
                const creep = worker(room, name, 20, 21, { memory: { role: name, home: room.name, source: room.storage.id } });
                new Role().run(creep, room);
                assert.equal(carried(creep), 0);
                assert.equal(room.storage.store.getUsedCapacity(RESOURCE_ENERGY), RESERVE);
            });

            it(name + ' takes only down to the line when a little is spendable', function () {
                const { room } = makeBase({ stored: RESERVE + 100 });
                const creep = worker(room, name);
                new Role().run(creep, room);
                assert.equal(carried(creep), 100, 'not the 300 it could carry');
                assert.equal(room.storage.store.getUsedCapacity(RESOURCE_ENERGY), RESERVE);
            });

            it(name + ' fills up as usual well above the line', function () {
                const { room } = makeBase({ stored: RESERVE + 5000 });
                const creep = worker(room, name);
                new Role().run(creep, room);
                assert.equal(carried(creep), 300);
            });
        });

        it('stops several workers in one tick from taking the same spendable energy', function () {
            const { room } = makeBase({ stored: RESERVE + 400 });
            const taken = [];
            const creeps = [worker(room, 'Builder', 20, 21), worker(room, 'Builder', 21, 21), worker(room, 'Builder', 19, 21)];
            // as in the game, where the store does not change until the end of the tick
            creeps.forEach(creep => { creep.withdraw = (store, type, amount) => { taken.push(amount); return OK; }; });
            creeps.forEach(creep => new Builder().run(creep, room));
            assert.deepEqual(taken, [300, 100]);
        });

        it('leaves source containers and the hub link to the haulers, or the reserve could never refill', function () {
            const { room, source, place } = makeBase({ stored: RESERVE });
            place(STRUCTURE_CONTAINER, 'source-container', source.pos.x + 1, source.pos.y, 2000);
            const hub = place(STRUCTURE_LINK, 'hub-link', 21, 19, 800, 800);
            Memory.structures = { [hub.id]: { type: constants.LINK_TYPE_TARGET, _roomName: room.name } };
            const creep = worker(room, 'Builder', source.pos.x + 2, source.pos.y);
            new Builder().run(creep, room);
            assert.equal(carried(creep), 0);
            assert.equal(creep.lastMoveTo, undefined);
        });

        it('does not keep draining a hub link it remembers from before', function () {
            const { room, place } = makeBase({ stored: RESERVE });
            const hub = place(STRUCTURE_LINK, 'hub-link', 21, 19, 800, 800);
            Memory.structures = { [hub.id]: { type: constants.LINK_TYPE_TARGET, _roomName: room.name } };
            const creep = worker(room, 'Builder', 21, 20, { memory: { role: 'Builder', home: room.name, source: hub.id } });
            new Builder().run(creep, room);
            assert.equal(carried(creep), 0);
        });

        it('may still use a container that holds no mined income', function () {
            const { room, place } = makeBase({ stored: RESERVE });
            place(STRUCTURE_CONTAINER, 'spare', 30, 30, 500);
            const creep = worker(room, 'Builder', 30, 31);
            new Builder().run(creep, room);
            assert.equal(carried(creep), 300);
        });

        it('lets the Upgrader keep drawing from the link at the controller', function () {
            const { room, place } = makeBase({ stored: RESERVE });
            const link = place(STRUCTURE_LINK, 'controller-link', 38, 38, 500, 800);
            Memory.structures = { [link.id]: { type: constants.LINK_TYPE_TARGET, _roomName: room.name } };
            const creep = worker(room, 'Upgrader', 38, 39);
            new Upgrader().run(creep, room);
            assert.equal(carried(creep), 300);
        });

        it('lets a worker finish what it already carries', function () {
            const { room } = makeBase({ stored: RESERVE });
            const site = { id: 'site', room, pos: makePosition(room, 20, 22), structureType: STRUCTURE_EXTENSION, progress: 0, progressTotal: 3000, my: true };
            registerObject(site, room.name);
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [site]);
            const creep = worker(room, 'Builder', 20, 21, { store: makeStore(300, { [RESOURCE_ENERGY]: 100 }) });
            new Builder().run(creep, room);
            assert.ok(site.progress > 0);
        });
    });

    describe('rooms with nothing to protect', function () {
        it('keeps workers on source containers before there is a storage', function () {
            const { room, source, place } = makeBase();
            place(STRUCTURE_CONTAINER, 'source-container', source.pos.x + 1, source.pos.y, 1000);
            const creep = worker(room, 'Builder', source.pos.x + 2, source.pos.y);
            new Builder().run(creep, room);
            assert.equal(carried(creep), 300);
        });

        it('keeps workers on active sources before there is a storage', function () {
            const { room, source } = makeBase();
            setFind(room, FIND_SOURCES_ACTIVE, [source]);
            const creep = worker(room, 'Builder', source.pos.x + 1, source.pos.y);
            new Builder().run(creep, room);
            assert.ok(carried(creep) > 0);
        });
    });

    describe('what must not wait for the reserve', function () {
        it('lets an Upgrader save a controller close to downgrading', function () {
            const { room } = makeBase({ stored: 1000, ticksToDowngrade: config.ECONOMY.CONTROLLER_DOWNGRADE_GUARD - 1 });
            const creep = worker(room, 'Upgrader');
            new Upgrader().run(creep, room);
            assert.equal(carried(creep), 300);
        });

        it('keeps the Upgrader idle while the controller is safe', function () {
            const { room } = makeBase({ stored: 1000, ticksToDowngrade: config.ECONOMY.CONTROLLER_DOWNGRADE_GUARD });
            const creep = worker(room, 'Upgrader');
            new Upgrader().run(creep, room);
            assert.equal(carried(creep), 0);
        });

        it('lets a Builder rebuild a lost spawn', function () {
            const { room } = makeBase({ stored: 1000 });
            const site = { id: 'site', room, pos: makePosition(room, 20, 25), structureType: STRUCTURE_SPAWN, progress: 0, progressTotal: 15000, my: true };
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [site]);
            const creep = worker(room, 'Builder');
            new Builder().run(creep, room);
            assert.equal(carried(creep), 300);
        });

        it('does not let a second spawn into the reserve while the room still has one', function () {
            const { room } = makeBase({ stored: 1000 });
            setFind(room, FIND_MY_SPAWNS, [{ id: 'spawn', name: 'Spawn1', room }]);
            const site = { id: 'site', room, pos: makePosition(room, 20, 25), structureType: STRUCTURE_SPAWN, progress: 0, progressTotal: 15000, my: true };
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [site]);
            const creep = worker(room, 'Builder');
            new Builder().run(creep, room);
            assert.equal(carried(creep), 0);
            assert.equal(EconomyManager.getDesiredBuilders(room), 0);
        });

        it('does not stop a recovery Harvester feeding the spawn from storage', function () {
            const { room } = makeBase({ stored: 1000 });
            const creep = worker(room, 'Harvester');
            new Harvester().run(creep, room);
            assert.equal(carried(creep), 300);
        });

        it('does not let a recovery Harvester upgrade with the reserve once the spawn is full', function () {
            const { room } = makeBase({ stored: 1000 });
            room.controller.structureType = STRUCTURE_CONTROLLER;
            const targets = new Harvester()._findTargets(room);
            assert.ok(!targets.includes(room.controller));
        });

        it('lets a Harvester upgrade with what it mined, and with stored energy above the line', function () {
            const mined = makeBase({ stored: 1000 });
            mined.place(STRUCTURE_CONTAINER, 'container', 30, 30, 500);
            const harvester = new Harvester();
            harvester._useStorageAsSource = true;
            assert.ok(harvester._findTargets(mined.room).includes(mined.room.controller), 'mined');
            resetScreeps();
            const stocked = makeBase({ stored: RESERVE + 5000 });
            assert.ok(new Harvester()._findTargets(stocked.room).includes(stocked.room.controller), 'above the line');
        });

        it('still gives haulers storage energy for the spawn and extensions below the line', function () {
            const { room, place } = makeBase({ stored: 1000 });
            const extension = place(STRUCTURE_EXTENSION, 'extension', 25, 25, 0, 50);
            new LogisticsManager(room).run();
            const task = room.memory.logistics.tasks.find(candidate => candidate.targetId === extension.id);
            assert.ok(task, 'the extension gets a delivery');
            assert.equal(task.sourceId, room.storage.id);
        });
    });

    describe('creep demand', function () {
        function withSite(room) {
            const site = { id: 'site', room, pos: makePosition(room, 20, 25), structureType: STRUCTURE_EXTENSION, progress: 0, progressTotal: 3000, my: true };
            setFind(room, FIND_MY_CONSTRUCTION_SITES, [site]);
            return site;
        }

        it('spawns no Builder that could only stand idle', function () {
            const { room } = makeBase({ stored: RESERVE });
            withSite(room);
            assert.equal(EconomyManager.getDesiredBuilders(room), 0);
        });

        it('asks for Builders once there is energy to build with', function () {
            const { room } = makeBase({ stored: RESERVE + 5000 });
            withSite(room);
            assert.equal(EconomyManager.getDesiredBuilders(room), 1);
        });

        it('still asks for a Builder for a lost spawn', function () {
            const { room } = makeBase({ stored: 1000 });
            withSite(room).structureType = STRUCTURE_SPAWN;
            assert.equal(EconomyManager.getDesiredBuilders(room), 1);
        });

        it('asks for Builders in a room that has no storage yet', function () {
            const { room } = makeBase();
            withSite(room);
            assert.equal(EconomyManager.getDesiredBuilders(room), 1);
        });

        it('spawns no Handyman that could only stand idle', function () {
            const { room, place } = makeBase({ stored: RESERVE });
            place(STRUCTURE_ROAD, 'road', 10, 10, 0, 1, { hits: 1, hitsMax: 5000 });
            room.find(FIND_STRUCTURES).forEach(structure => { if (structure.id === 'road') Object.assign(structure, { hits: 1, hitsMax: 5000 }); });
            assert.equal(new Handyman().getDemand(room), 0);
        });

        it('keeps asking for one Upgrader, which keeps the controller safe', function () {
            const { room } = makeBase({ stored: 1 });
            assert.equal(EconomyManager.getDesiredUpgraders(room), 1);
        });
    });

    describe('one definition of the line', function () {
        it('is what the terminal holds back, so labs and factories share it', function () {
            const { room } = makeBase({ stored: RESERVE, terminalEnergy: 500 });
            assert.equal(TerminalManager.getReserve(room, RESOURCE_ENERGY), RESERVE);
            assert.equal(TerminalManager.getAvailable(room, RESOURCE_ENERGY), EconomyManager.getSpendableEnergy(room));
        });

        it('follows a change to the config, because rooms no longer keep their own copy', function () {
            const { room } = makeBase({ stored: RESERVE });
            TerminalManager.getConfig(room);
            assert.equal(room.memory.terminal.emergencyReserve, undefined);
            const original = config.ECONOMY.ENERGY_RESERVE_MINIMUM;
            config.ECONOMY.ENERGY_RESERVE_MINIMUM = original + 1000;
            try {
                assert.equal(TerminalManager.getReserve(room, RESOURCE_ENERGY), original + 1000);
            } finally {
                config.ECONOMY.ENERGY_RESERVE_MINIMUM = original;
            }
        });

        it('ignores the saved old default even before the terminal has tidied it, so growing rooms are not stalled', function () {
            const { room } = makeBase({ level: 4, stored: 0 });
            room.memory.terminal = { emergencyReserve: 50000 };
            assert.equal(EconomyManager.getEnergyReserve(room), config.ECONOMY.ENERGY_RESERVE_BY_RCL[4]);
        });

        it('forgets the copy of the old default that rooms have saved', function () {
            const { room } = makeBase({ stored: RESERVE });
            room.memory.terminal = { emergencyReserve: 50000 };
            TerminalManager.getConfig(room);
            assert.equal(room.memory.terminal.emergencyReserve, undefined);
        });

        it('keeps an override an operator chose', function () {
            const { room } = makeBase({ stored: RESERVE });
            room.memory.terminal = { emergencyReserve: 12345 };
            TerminalManager.getConfig(room);
            assert.equal(TerminalManager.getReserve(room, RESOURCE_ENERGY), 12345);
            assert.equal(EconomyManager.getEnergyReserve(room), 12345);
        });

        it('lets a higher per-resource rule on energy raise the terminal reserve only', function () {
            const { room } = makeBase({ stored: RESERVE });
            room.memory.terminal = { resources: { [RESOURCE_ENERGY]: { reserve: RESERVE + 1 } } };
            assert.equal(TerminalManager.getReserve(room, RESOURCE_ENERGY), RESERVE + 1);
        });

        it('is the most an Upgrader budget can fall to before asking for only one', function () {
            const { room } = makeBase({ stored: RESERVE - 1 });
            assert.equal(EconomyManager.getDesiredUpgraders(room), 1);
        });

        it('has the Director follow a room whose override is above its usual line', function () {
            const { room } = makeBase({ level: 8, stored: config.DIRECTOR.STOCKPILE_ENTER[8] + 1000 });
            assert.equal(Director._chooseEconomicGoal(room, Director.GOAL_UPGRADE), Director.GOAL_UPGRADE);
            room.memory.terminal = { emergencyReserve: config.DIRECTOR.STOCKPILE_ENTER[8] + 2000 };
            assert.equal(Director._chooseEconomicGoal(room, Director.GOAL_UPGRADE), Director.GOAL_STOCKPILE);
        });

        it('has the Director start saving before workers reach the line, at every RCL', function () {
            Object.keys(config.DIRECTOR.STOCKPILE_ENTER).forEach(level => {
                resetScreeps();
                const { room } = makeBase({ level: Number(level), stored: 0 });
                room.storage.store.set(RESOURCE_ENERGY, EconomyManager.getEnergyReserve(room) - 1);
                assert.equal(Director._chooseEconomicGoal(room, Director.GOAL_UPGRADE), Director.GOAL_STOCKPILE, 'RCL ' + level);
            });
        });
    });
});
