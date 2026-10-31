const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeLab, makeStructure, makeTerminal, makeCreep, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const LogisticsManager = require('../manager.logistics');
const LogisticsRunner = require('../logistics.runner');
const EconomyManager = require('../manager.economy');
const Upgrader = require('../role.upgrader');
const Builder = require('../role.builder');
const economy = require('../main.config').ECONOMY;

const EXTENSION_ENERGY = 50;

function pipelineRoom(options = {}) {
    const room = makeRoom('A', {
        memory: {
            base: { name: 'A', roleConfig: {} },
            logistics: { tasks: [] },
            terminal: { enabled: true, emergencyReserve: options.emergencyReserve || 0, batchSize: 1000, cooldown: 0, resources: {} },
        },
    });
    room.controller = { id: 'controller', my: true, level: 6, pos: makePosition(room, 40, 40), owner: { username: 'Me' } };
    registerObject(room.controller, 'A');
    Game.rooms.A = room;
    const structures = [];
    const add = (type, id, x, y, store) => {
        const structure = makeStructure(room, type, { id, pos: makePosition(room, x, y), store, extra: { my: true } });
        registerObject(structure, 'A');
        structures.push(structure);
        return structure;
    };
    const storage = options.noStorage ? null : add(STRUCTURE_STORAGE, 'storage', 28, 25, makeStore(1000000, { [RESOURCE_ENERGY]: options.stored === undefined ? 10000 : options.stored }));
    if (storage) room.storage = storage;
    const source = { id: 'source', room, pos: makePosition(room, 10, 10), energy: 3000, energyCapacity: 3000 };
    registerObject(source, 'A');
    const sourceContainer = add(STRUCTURE_CONTAINER, 'sourceContainer', 11, 11, makeStore(2000, { [RESOURCE_ENERGY]: options.inContainer === undefined ? 300 : options.inContainer }));
    const extensions = (options.extensions === undefined ? [[25, 22], [26, 22], [27, 22], [28, 22], [29, 22], [30, 22]] : options.extensions).map((position, index) => {
        return add(STRUCTURE_EXTENSION, 'ext' + index, position[0], position[1], makeStore(EXTENSION_ENERGY, {}));
    });
    setFind(room, FIND_STRUCTURES, structures);
    setFind(room, FIND_MY_STRUCTURES, structures.filter(structure => structure.structureType !== STRUCTURE_CONTAINER));
    setFind(room, FIND_SOURCES, [source]);
    setFind(room, FIND_SOURCES_ACTIVE, [source]);
    return { room, storage, sourceContainer, extensions, structures, source, add };
}

function hauler(room, at, capacity = 300, cargo = 0) {
    const creep = makeCreep(room, {
        name: 'hauler', capacity, pos: at.pos, memory: { role: 'Storekeeper', home: 'A' },
        store: makeStore(capacity, cargo ? { [RESOURCE_ENERGY]: cargo } : {}),
    });
    creep.spawning = false;
    Game.creeps.hauler = creep;
    return creep;
}

const walking = { _moveToLocation: (creep, target) => { creep.pos = target.pos || target; } };
const standing = { _moveToLocation: () => {} };
const energy = object => object.store.getUsedCapacity(RESOURCE_ENERGY);

function step(room, creep, role = walking) {
    Game.time++;
    new LogisticsManager(room).run();
    LogisticsRunner.run(creep, role, { resourceType: RESOURCE_ENERGY });
}

describe('Energy pipeline', function () {
    beforeEach(function () {
        resetScreeps();
        Game.market.calcTransactionCost = () => 0;
    });

    describe('hauling trips', function () {
        it('loads for every extension waiting, not one per trip', function () {
            const { room, storage } = pipelineRoom();
            const creep = hauler(room, storage);

            step(room, creep, standing);

            assert.equal(energy(creep), 6 * EXTENSION_ENERGY);
        });

        it('takes no more than the waiting extensions can use', function () {
            const { room, storage } = pipelineRoom({ extensions: [[25, 22], [26, 22]] });
            const creep = hauler(room, storage);

            step(room, creep, standing);

            assert.equal(energy(creep), 2 * EXTENSION_ENERGY);
        });

        it('fills them all from one withdrawal', function () {
            const { room, storage, extensions } = pipelineRoom();
            const creep = hauler(room, storage);
            const withdraw = creep.withdraw;
            let withdrawals = 0;
            creep.withdraw = function (...args) { withdrawals++; return withdraw.apply(this, args); };

            for (let tick = 0; tick < 30; tick++) step(room, creep);

            assert.deepEqual(extensions.map(energy), extensions.map(() => EXTENSION_ENERGY));
            assert.equal(withdrawals, 1);
            assert.equal(energy(creep), 0);
        });

        it('goes on to the nearest extension when it is already carrying energy', function () {
            const { room, storage } = pipelineRoom({ extensions: [[45, 45], [29, 25]] });
            const creep = hauler(room, storage, 300, 50);
            creep.pos = makePosition(room, 28, 26);
            Game.time++;
            new LogisticsManager(room).run();

            const task = LogisticsManager.assignTask(creep, { resourceType: RESOURCE_ENERGY });

            assert.equal(task.targetId, 'ext1');
        });

        it('still goes to the nearest source when it is empty', function () {
            const { room, storage, add, structures } = pipelineRoom({ extensions: [] });
            const a = add(STRUCTURE_EXTENSION, 'near-store', 27, 25, makeStore(EXTENSION_ENERGY, {}));
            setFind(room, FIND_MY_STRUCTURES, structures.filter(structure => structure.structureType !== STRUCTURE_CONTAINER));
            setFind(room, FIND_STRUCTURES, structures);
            const creep = hauler(room, storage);
            Game.time++;
            new LogisticsManager(room).run();

            const task = LogisticsManager.assignTask(creep, { resourceType: RESOURCE_ENERGY });

            assert.equal(task.targetId, a.id);
            assert.equal(task.sourceId, 'storage');
        });

        it('returns what is left to the storage when the extensions were filled by someone else', function () {
            const { room, storage, extensions } = pipelineRoom();
            const creep = hauler(room, storage);
            step(room, creep, standing);
            assert.equal(energy(creep), 300);
            const stored = energy(storage);
            extensions.forEach(extension => extension.store.set(RESOURCE_ENERGY, EXTENSION_ENERGY));

            for (let tick = 0; tick < 5; tick++) step(room, creep);

            assert.equal(energy(creep), 0);
            assert.equal(energy(storage), stored + 300);
        });

        it('keeps lab energy to the exact amount, inside the emergency reserve', function () {
            const { room, storage, structures } = pipelineRoom({ extensions: [], stored: 1500, emergencyReserve: 1000 });
            const lab = makeLab(room, { id: 'lab', pos: makePosition(room, 26, 25), contents: {} });
            registerObject(lab, 'A');
            setFind(room, FIND_STRUCTURES, [...structures, lab]);
            setFind(room, FIND_MY_STRUCTURES, [storage, lab]);
            const creep = hauler(room, storage, 2000);

            step(room, creep, standing);

            assert.equal(energy(creep), 500);
        });

        it('does not let extension demand inflate a lab energy load', function () {
            const { room, storage, structures, extensions } = pipelineRoom({ stored: 1500, emergencyReserve: 1000 });
            const lab = makeLab(room, { id: 'lab', pos: makePosition(room, 28, 26), contents: {} });
            registerObject(lab, 'A');
            setFind(room, FIND_STRUCTURES, [...structures, lab]);
            setFind(room, FIND_MY_STRUCTURES, [storage, ...extensions, lab]);
            extensions.forEach(extension => extension.store.set(RESOURCE_ENERGY, EXTENSION_ENERGY));
            const creep = hauler(room, storage, 2000);

            step(room, creep, standing);
            assert.equal(energy(creep), 500);
        });

        it('does not load for deliveries another hauler is already carrying', function () {
            const { room, storage } = pipelineRoom({ extensions: [[25, 22], [26, 22], [27, 22]] });
            Game.time++;
            new LogisticsManager(room).run();
            const first = makeCreep(room, { name: 'first', capacity: 300, pos: storage.pos, store: makeStore(300, { [RESOURCE_ENERGY]: 150 }) });
            Game.creeps.first = first;
            room.memory.logistics.tasks[0].assignedCreep = 'first';
            const creep = hauler(room, storage);

            LogisticsRunner.run(creep, standing, { resourceType: RESOURCE_ENERGY });

            assert.equal(energy(creep), EXTENSION_ENERGY);
        });

        it('sees a load taken this same tick, before it shows in the other hauler\'s store', function () {
            const { room, storage } = pipelineRoom({ extensions: [[25, 22], [26, 22], [27, 22]] });
            Game.time++;
            new LogisticsManager(room).run();
            Game.creeps.first = makeCreep(room, { name: 'first', capacity: 300, pos: storage.pos });
            room.memory.logistics.tasks[0].assignedCreep = 'first';
            room.memory.logistics.tasks[0].claimedAmount = 150;
            const creep = hauler(room, storage);

            LogisticsRunner.run(creep, standing, { resourceType: RESOURCE_ENERGY });

            assert.equal(energy(creep), EXTENSION_ENERGY);
        });

        it('still loads for what the other hauler cannot cover', function () {
            const { room, storage } = pipelineRoom({ extensions: [[25, 22], [26, 22], [27, 22], [28, 22]] });
            Game.time++;
            new LogisticsManager(room).run();
            const first = makeCreep(room, { name: 'first', capacity: 300, pos: storage.pos, store: makeStore(300, { [RESOURCE_ENERGY]: 100 }) });
            Game.creeps.first = first;
            room.memory.logistics.tasks[0].assignedCreep = 'first';
            const creep = hauler(room, storage);

            LogisticsRunner.run(creep, standing, { resourceType: RESOURCE_ENERGY });

            assert.equal(energy(creep), 2 * EXTENSION_ENERGY);
        });

        it('keeps the surplus small when two haulers refill together', function () {
            const { room, storage, extensions } = pipelineRoom();
            const one = hauler(room, storage);
            const two = makeCreep(room, { name: 'two', capacity: 300, pos: storage.pos, memory: { role: 'Storekeeper', home: 'A' } });
            two.spawning = false;
            Game.creeps.two = two;
            let returned = 0;
            [one, two].forEach(creep => {
                const transfer = creep.transfer;
                creep.transfer = function (target, ...rest) {
                    const before = energy(this);
                    const result = transfer.call(this, target, ...rest);
                    if (target === storage) returned += before - energy(this);
                    return result;
                };
            });

            for (let tick = 0; tick < 30; tick++) {
                Game.time++;
                new LogisticsManager(room).run();
                LogisticsRunner.run(one, walking, { resourceType: RESOURCE_ENERGY });
                LogisticsRunner.run(two, walking, { resourceType: RESOURCE_ENERGY });
            }

            assert.deepEqual(extensions.map(energy), extensions.map(() => EXTENSION_ENERGY));
            // a hauler still loads for its own task even when another has enough spare, so some overlap
            // remains. Without the spare check this walks back 250
            assert.ok(returned <= 2 * EXTENSION_ENERGY, 'walked back ' + returned);
        });

        it('does not count tasks another hauler has claimed', function () {
            const { room, storage } = pipelineRoom({ extensions: [[25, 22], [26, 22], [27, 22]] });
            Game.time++;
            new LogisticsManager(room).run();
            room.memory.logistics.tasks[0].assignedCreep = 'other';
            room.memory.logistics.tasks[1].assignedCreep = 'other2';
            Game.creeps.other = makeCreep(room, { name: 'other', capacity: 50, pos: storage.pos });
            Game.creeps.other2 = makeCreep(room, { name: 'other2', capacity: 50, pos: storage.pos });
            const creep = hauler(room, storage);

            LogisticsRunner.run(creep, standing, { resourceType: RESOURCE_ENERGY });

            assert.equal(energy(creep), EXTENSION_ENERGY);
        });
    });

    describe('source containers', function () {
        const stores = (role, room) => {
            role._useStorageAsSource = true; // set from the room's source policy when a creep runs
            role._useSourceAsSource = false;
            return role._findSources(room).map(store => store.id);
        };

        [['Upgrader', () => new Upgrader()], ['Builder', () => new Builder()]].forEach(([name, make]) => {
            it(name + ' leaves a source container to the haulers while the storage has energy', function () {
                const { room } = pipelineRoom();
                assert.deepEqual(stores(make(), room), ['storage']);
            });

            it(name + ' falls back on a source container when the storage is nearly empty', function () {
                const { room } = pipelineRoom({ stored: economy.WORKER_STORE_MIN - 1 });
                assert.ok(stores(make(), room).includes('sourceContainer'));
            });

            it(name + ' uses a source container when the room has no storage', function () {
                const { room } = pipelineRoom({ noStorage: true });
                assert.ok(stores(make(), room).includes('sourceContainer'));
            });

            it(name + ' still uses a container away from any source', function () {
                const { room, add, structures } = pipelineRoom();
                add(STRUCTURE_CONTAINER, 'controllerContainer', 39, 39, makeStore(2000, { [RESOURCE_ENERGY]: 500 }));
                setFind(room, FIND_STRUCTURES, structures);
                const found = stores(make(), room);
                assert.ok(found.includes('controllerContainer'));
                assert.ok(!found.includes('sourceContainer'));
            });
        });

        it('moves a worker off a source container it remembers from before', function () {
            const { room, sourceContainer } = pipelineRoom();
            const role = new Upgrader();
            role._baseRoom = room;
            role._useStorageAsSource = true;
            role._useSourceAsSource = false;
            const creep = makeCreep(room, { name: 'worker', capacity: 100, pos: sourceContainer.pos, memory: { role: 'Upgrader', home: 'A', source: sourceContainer.id } });

            const chosen = role._findClosestSource(creep);

            assert.equal(chosen.id, 'storage');
            assert.equal(creep.memory.source, 'storage');
        });

        it('lets a worker keep a remembered source container when the storage is nearly empty', function () {
            const { room, sourceContainer } = pipelineRoom({ stored: economy.WORKER_STORE_MIN - 1 });
            const role = new Upgrader();
            role._baseRoom = room;
            role._useStorageAsSource = true;
            role._useSourceAsSource = false;
            const creep = makeCreep(room, { name: 'worker', capacity: 100, pos: sourceContainer.pos, memory: { role: 'Upgrader', home: 'A', source: sourceContainer.id } });

            assert.equal(role._findClosestSource(creep).id, sourceContainer.id);
        });

        it('leaves a worker on any other remembered source', function () {
            const { room, add, structures } = pipelineRoom();
            const away = add(STRUCTURE_CONTAINER, 'away', 39, 39, makeStore(2000, { [RESOURCE_ENERGY]: 500 }));
            setFind(room, FIND_STRUCTURES, structures);
            const role = new Upgrader();
            role._baseRoom = room;
            role._useStorageAsSource = true;
            role._useSourceAsSource = false;
            const creep = makeCreep(room, { name: 'worker', capacity: 100, pos: away.pos, memory: { role: 'Upgrader', home: 'A', source: away.id } });

            assert.equal(role._findClosestSource(creep).id, away.id);
        });

        it('tells a source container from any other', function () {
            const { room, sourceContainer, add, structures } = pipelineRoom();
            const away = add(STRUCTURE_CONTAINER, 'away', 39, 39, makeStore(2000, {}));
            setFind(room, FIND_STRUCTURES, structures);

            assert.equal(EconomyManager.isSourceContainer(room, sourceContainer), true);
            assert.equal(EconomyManager.isSourceContainer(room, away), false);
            assert.equal(EconomyManager.isSourceContainer(room, room.storage), false);
        });

        it('collects a source container to the storage once nothing skims it', function () {
            const { room, sourceContainer, storage } = pipelineRoom({ extensions: [], inContainer: 500 });
            const creep = hauler(room, sourceContainer);
            const stored = energy(storage);

            for (let tick = 0; tick < 6; tick++) step(room, creep);

            assert.ok(energy(storage) > stored, 'energy reached the storage');
        });
    });
});
