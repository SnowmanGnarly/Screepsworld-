/*
 * A headless stand-in for the engine, so the real main.loop can run for thousands of ticks without a
 * server. screeps-server-mockup would be more faithful, but it needs isolated-vm, which does not
 * build on the Node version this repository runs on.
 *
 * Follows the engine: Memory is parsed lazily and written back from RawMemory._parsed (game.js and
 * runtime.js in @screeps/engine and @screeps/driver), game objects are rebuilt every tick, spawning
 * takes time, creeps walk one tile at a time under fatigue and die of age, sources regenerate,
 * dropped energy decays, sites turn into structures, and each action costs 0.2 CPU.
 *
 * Does not follow it: terrain is flat and open, creeps never block each other, actions apply at
 * once, structures do not decay, and there are no hostiles. getUsed() is the real time this machine
 * took plus the action costs, plus an estimate for path searches, since those are mocked here. That
 * shows how the CPU trend responds, not what a live shard will measure.
 */

const {
    constants, makeStore, makeRoom, makeStructure, makeTerminal, makeFactory, makeLab, makeCreep, makeSpawn, makePosition,
    resetScreeps, registerObject, rebuildGameObjects,
} = require('./screeps');
const main = require('../../main');
const MainCache = require('../../main.cache');
const MainHeap = require('../../main.heap');
const MainInfo = require('../../main.info');
const MainMemhack = require('../../main.memhack');
const CpuManager = require('../../manager.cpu');

const INTENT_CPU = 0.2; // intentCpu in the driver's runtime.js
const MOVE_TO_SEARCH_CPU = 0.5; // an estimate: moveTo searches or walks a cached path
const FIND_PATH_CPU = 1; // an estimate for one path across a room
const FIELD_CACHE_LIMIT = 200;
const SIZE = 50;

const METRICS = ['harvested', 'hauled', 'collected', 'upgraded', 'built', 'repaired', 'spawned', 'factory', 'tower', 'decayed', 'linkLoss', 'reacted', 'sitesPlaced'];
const SPENT = ['upgraded', 'built', 'repaired', 'spawned', 'factory', 'tower', 'decayed', 'linkLoss'];
const HAULERS = ['Storekeeper', 'Courier'];
const WALKABLE = new Set([STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_RAMPART]);
const NOT_OWNED = new Set([STRUCTURE_ROAD, STRUCTURE_CONTAINER, STRUCTURE_WALL]);

const tileIndex = (x, y) => x * SIZE + y;

class Simulator {
    constructor(options = {}) {
        delete global.Memory;
        delete global.RawMemory;
        resetScreeps({ commodities: constants.COMMODITIES });
        delete global.Memory;
        this.cpuLimit = options.cpuLimit || 20;
        this.pinnedBucket = null;
        this.storedMemory = '{}';
        this.parses = 0;
        this.errors = [];
        this.warnings = [];
        this.cpuPerTick = [];
        this.bucketPerTick = [];
        this.jobCpu = {};
        this.overLimit = 0;
        this.metrics = {};
        METRICS.forEach(metric => { this.metrics[metric] = []; });
        this._charged = 0;
        this._nextId = 1;
        this._fields = new Map();
        this._blocked = new Set();
        this._roads = new Set();
        this._installGame();
        this._installLogs();
        this._patchPositions();
        this._beginMemory();
    }

    // --- running ---------------------------------------------------------------------------------

    /*
     * Call once the world is set up. What setup wrote is stored, as if an earlier tick had done it.
     */

    start() {
        this._refreshObjects();
        this._endMemory();
        this.parses = 0;
        this.energyAtStart = this.energyInWorld();
    }

    tick() {
        this._beginMemory();
        this._startedAt = process.hrtime.bigint();
        this._charged = 0;
        main.loop();
        this._endMemory();
        this._recordCpu();
        this._resolveCreeps();
        this._advanceObjects();
        Game.time++;
        rebuildGameObjects();
        this._refreshObjects();
    }

    /*
     * What a code upload or a server restart does: the heap and its module state are gone.
     */

    globalReset() {
        MainHeap.reset();
        MainMemhack.reset();
        MainCache.initRound([]);
        CpuManager._degraded = undefined;
        CpuManager._measurements = [];
        CpuManager._resetStatsWindow();
    }

    dispose() {
        Object.assign(RoomPosition.prototype, this._originalPosition);
        Object.keys(this._originalPosition).forEach(key => {
            if (this._originalPosition[key] === undefined) delete RoomPosition.prototype[key];
        });
        console.log = this._originalConsoleLog;
        delete global.RawMemory;
        delete global.Memory;
        global.Memory = {};
    }

    // --- reading the results ---------------------------------------------------------------------

    total(metric, from = 1, to = Infinity) {
        let sum = 0;
        this.metrics[metric].forEach((amount, time) => {
            if (time >= from && time <= to) sum += amount;
        });
        return sum;
    }

    /*
     * Everything spent, plus everything that exists now. It must equal what there was at the start
     * plus everything mined: the books cannot balance if the bot or this simulator conjures or loses energy.
     */

    energyBalance() {
        const spent = SPENT.reduce((sum, metric) => sum + this.total(metric), 0);
        return { expected: this.energyAtStart + this.total('harvested'), actual: this.energyInWorld() + spent };
    }

    energyInWorld() {
        let total = 0;
        const add = object => { if (object.store) total += object.store.getUsedCapacity(RESOURCE_ENERGY); };
        Object.values(Game.rooms).forEach(room => {
            [FIND_STRUCTURES, FIND_TOMBSTONES].forEach(type => (room._find[type] || []).forEach(add));
            (room._find[FIND_DROPPED_RESOURCES] || []).forEach(drop => {
                if (drop.resourceType === RESOURCE_ENERGY) total += drop.amount;
            });
        });
        Object.values(Game.creeps).forEach(add);
        return total;
    }

    averageCpu(from = 1, to = Infinity) {
        const samples = this.cpuPerTick.filter((cpu, time) => time >= from && time <= to);
        return samples.reduce((sum, cpu) => sum + cpu, 0) / samples.length;
    }

    creepsWithRole(role) {
        return Object.values(Game.creeps).filter(creep => creep.memory.role === role && !creep.spawning);
    }

    /*
     * Values that would change meaning on the way through JSON. The heap copy of Memory keeps them
     * until a reset, after which the bot would suddenly see something else.
     */

    findUnserializable(value = Memory, path = 'Memory') {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return [];
        if (typeof value === 'number') return Number.isFinite(value) ? [] : [path + ' = ' + value];
        if (typeof value !== 'object') return [path + ' is a ' + typeof value];
        if (Array.isArray(value)) return value.flatMap((item, index) => this.findUnserializable(item, path + '[' + index + ']'));
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== null && prototype !== Object.prototype) return [path + ' is a ' + prototype.constructor.name];
        return Object.keys(value).flatMap(key => {
            return value[key] === undefined ? [] : this.findUnserializable(value[key], path + '.' + key);
        });
    }

    // --- the world -------------------------------------------------------------------------------

    addRoom(name, options = {}) {
        const room = makeRoom(name, { energyAvailable: 0, energyCapacityAvailable: 0 });
        delete room.memory;
        this._installMemory(room, 'rooms', name);
        room.visual = new Proxy({}, { get: () => () => {} });
        room.findPath = (from, to) => {
            this.charge(FIND_PATH_CPU);
            return to.x + ',' + to.y;
        };
        Game.rooms[name] = room;
        room.controller = {
            id: 'controller-' + name, room, my: true, level: options.level || 1, owner: { username: 'Me' },
            pos: makePosition(room, options.controllerX || 40, options.controllerY || 10), structureType: STRUCTURE_CONTROLLER,
            progress: 0, progressTotal: CONTROLLER_LEVELS[options.level || 1], ticksToDowngrade: 100000, safeModeAvailable: 0,
        };
        registerObject(room.controller, name);
        room._find[FIND_STRUCTURES] = [];
        room._find[FIND_MY_STRUCTURES] = [];
        room._find[FIND_CONSTRUCTION_SITES] = [];
        room._find[FIND_MY_CONSTRUCTION_SITES] = [];
        room._find[FIND_DROPPED_RESOURCES] = [];
        room._find[FIND_TOMBSTONES] = [];
        room._find[FIND_SOURCES] = [];
        room._find[FIND_MY_SPAWNS] = [];
        return room;
    }

    addSource(room, id, x, y) {
        const source = { id, room, pos: makePosition(room, x, y), energy: SOURCE_ENERGY_CAPACITY, energyCapacity: SOURCE_ENERGY_CAPACITY };
        registerObject(source, room.name);
        room._find[FIND_SOURCES].push(source);
        return source;
    }

    addSpawn(room, name, x, y) {
        const spawn = makeSpawn(room, { name, pos: makePosition(room, x, y) });
        delete spawn.memory;
        this._installMemory(spawn, 'spawns', name);
        Object.assign(spawn, {
            id: 'spawn-' + name, structureType: STRUCTURE_SPAWN, my: true, owner: { username: 'Me' }, hits: 5000, hitsMax: 5000,
            store: makeStore(SPAWN_ENERGY_CAPACITY, { [RESOURCE_ENERGY]: SPAWN_ENERGY_CAPACITY }),
        });
        spawn.spawnCreep = this._spawnCreepAction();
        spawn.recycleCreep = this._recycleCreepAction();
        Game.spawns[name] = spawn;
        room._find[FIND_MY_SPAWNS].push(spawn);
        this._register(room, spawn);
        return spawn;
    }

    addStructure(room, structureType, x, y, options = {}) {
        const structure = this._makeStructure(room, structureType, makePosition(room, x, y), options);
        this._register(room, structure);
        if (structureType === STRUCTURE_STORAGE) room.storage = structure;
        return structure;
    }

    addCreep(room, name, role, parts, options = {}) {
        const creep = this._makeCreep(room, name, parts, makePosition(room, options.x, options.y));
        creep.spawning = false;
        creep.ticksToLive = options.ticksToLive || CREEP_LIFE_TIME;
        if (!Memory.creeps) Memory.creeps = {};
        Memory.creeps[name] = Object.assign({ role, home: room.name }, options.memory);
        Game.creeps[name] = creep;
        return creep;
    }

    charge(cpu) {
        this._charged += cpu;
    }

    _add(metric, amount) {
        const series = this.metrics[metric];
        series[Game.time] = (series[Game.time] || 0) + amount;
    }

    _makeStructure(room, structureType, pos, options) {
        const id = options.id || structureType + '-' + this._nextId++;
        const owned = NOT_OWNED.has(structureType) ? {} : { my: true, owner: { username: 'Me' } };
        const energy = options.energy === undefined ? {} : { [RESOURCE_ENERGY]: options.energy };
        const contents = Object.assign(energy, options.contents);
        switch (structureType) {
            case STRUCTURE_TERMINAL: return makeTerminal(room, { id, pos, contents, capacity: TERMINAL_CAPACITY });
            case STRUCTURE_FACTORY: return this._trackFactory(makeFactory(room, { id, pos, contents, capacity: FACTORY_CAPACITY }));
            case STRUCTURE_LAB: return this._trackLab(makeLab(room, { id, pos, contents }));
        }
        const stores = {
            [STRUCTURE_EXTENSION]: EXTENSION_ENERGY_CAPACITY[room.controller.level], [STRUCTURE_TOWER]: TOWER_CAPACITY,
            [STRUCTURE_CONTAINER]: CONTAINER_CAPACITY, [STRUCTURE_STORAGE]: STORAGE_CAPACITY, [STRUCTURE_LINK]: LINK_CAPACITY,
        };
        const structure = makeStructure(room, structureType, { id, pos, hits: 5000, hitsMax: 5000, extra: owned });
        structure.store = stores[structureType] ? makeStore(stores[structureType], contents) : undefined;
        if (structureType === STRUCTURE_TOWER) this._addTowerActions(structure);
        if (structureType === STRUCTURE_LINK) this._addLinkAction(structure);
        return structure;
    }

    _register(room, structure) {
        registerObject(structure, room.name);
        room._find[FIND_STRUCTURES].push(structure);
        if (structure.my) room._find[FIND_MY_STRUCTURES].push(structure);
        this._mapChanged();
    }

    _trackFactory(factory) {
        const current = this;
        const produce = factory.produce;
        factory.produce = function (resourceType) {
            const before = this.store.getUsedCapacity(RESOURCE_ENERGY);
            const result = produce.call(this, resourceType);
            if (result === OK) {
                current._add('factory', before - this.store.getUsedCapacity(RESOURCE_ENERGY));
                current.charge(INTENT_CPU);
            }
            return result;
        };
        return factory;
    }

    _trackLab(lab) {
        const current = this;
        const runReaction = lab.runReaction;
        lab.runReaction = function (inputA, inputB) {
            const result = runReaction.call(this, inputA, inputB);
            if (result === OK) {
                current._add('reacted', LAB_REACTION_AMOUNT);
                current.charge(INTENT_CPU);
            }
            return result;
        };
        return lab;
    }

    _addTowerActions(tower) {
        const current = this;
        ['attack', 'heal', 'repair'].forEach(action => {
            tower[action] = function () {
                if (this.store.getUsedCapacity(RESOURCE_ENERGY) < TOWER_ENERGY_COST) return ERR_NOT_ENOUGH_ENERGY;
                this.store.set(RESOURCE_ENERGY, this.store.getUsedCapacity(RESOURCE_ENERGY) - TOWER_ENERGY_COST);
                current._add('tower', TOWER_ENERGY_COST);
                current.charge(INTENT_CPU);
                return OK;
            };
        });
    }

    _addLinkAction(link) {
        const current = this;
        link.cooldown = 0;
        link.transferEnergy = function (target, amount) {
            if (this.cooldown > 0) return ERR_TIRED;
            const sending = Math.min(amount === undefined ? this.store.getUsedCapacity(RESOURCE_ENERGY) : amount, target.store.getFreeCapacity(RESOURCE_ENERGY));
            if (sending <= 0) return ERR_FULL;
            const lost = Math.ceil(sending * LINK_LOSS_RATIO);
            this.store.set(RESOURCE_ENERGY, this.store.getUsedCapacity(RESOURCE_ENERGY) - sending);
            target.store.set(RESOURCE_ENERGY, target.store.getUsedCapacity(RESOURCE_ENERGY) + sending - lost);
            this.cooldown = LINK_COOLDOWN * this.pos.getRangeTo(target);
            current._add('linkLoss', lost);
            current.charge(INTENT_CPU);
            return OK;
        };
    }

    // --- creeps ----------------------------------------------------------------------------------

    _makeCreep(room, name, parts, pos) {
        const carry = parts.filter(part => part === CARRY).length;
        const creep = makeCreep(room, {
            name, pos, body: parts.map(type => ({ type, hits: 100 })), hitsMax: parts.length * 100,
            store: makeStore(carry * CARRY_CAPACITY),
        });
        delete creep.memory;
        this._installMemory(creep, 'creeps', name);
        creep.fatigue = 0;
        creep.id = 'creep-' + name;
        this._addCreepActions(creep);
        registerObject(creep, room.name);
        return creep;
    }

    _addCreepActions(creep) {
        const current = this;
        const intent = (name, wrap) => {
            const original = creep[name];
            creep[name] = function (...args) {
                const result = wrap ? wrap.call(this, original, args) : original.apply(this, args);
                if (result === OK) current.charge(INTENT_CPU);
                return result;
            };
        };
        const energyDelta = (actor, action) => {
            const before = actor.store.getUsedCapacity(RESOURCE_ENERGY);
            const result = action();
            return { result, delta: actor.store.getUsedCapacity(RESOURCE_ENERGY) - before };
        };

        intent('harvest', function (original, args) {
            const { result, delta } = energyDelta(this, () => original.apply(this, args));
            if (result === OK && delta > 0) current._add('harvested', delta);
            return result;
        });
        intent('transfer', function (original, args) {
            const { result, delta } = energyDelta(this, () => original.apply(this, args));
            if (result === OK && HAULERS.includes(this.memory.role)) current._add('hauled', -delta);
            return result;
        });
        intent('withdraw', function (original, args) {
            const { result, delta } = energyDelta(this, () => original.apply(this, args));
            if (result === OK && args[0].structureType === STRUCTURE_CONTAINER && HAULERS.includes(this.memory.role)) current._add('collected', delta);
            return result;
        });
        intent('pickup');
        intent('build', function (original, args) {
            const { result, delta } = energyDelta(this, () => original.apply(this, args));
            if (result === OK) current._add('built', -delta);
            return result;
        });
        creep.upgradeController = function (controller) {
            if (this.pos.getRangeTo(controller) > 3) return ERR_NOT_IN_RANGE;
            const energy = Math.min(this.getActiveBodyparts(WORK) * UPGRADE_CONTROLLER_POWER, this.store.getUsedCapacity(RESOURCE_ENERGY));
            if (energy <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            this.store.set(RESOURCE_ENERGY, this.store.getUsedCapacity(RESOURCE_ENERGY) - energy);
            controller.progress += energy;
            current._add('upgraded', energy);
            current.charge(INTENT_CPU);
            return OK;
        };
        creep.repair = function (target) {
            if (this.pos.getRangeTo(target) > 3) return ERR_NOT_IN_RANGE;
            const carried = this.store.getUsedCapacity(RESOURCE_ENERGY);
            const hits = Math.min(this.getActiveBodyparts(WORK) * REPAIR_POWER, target.hitsMax - target.hits, carried * REPAIR_POWER);
            if (hits <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            const energy = Math.ceil(hits / REPAIR_POWER);
            this.store.set(RESOURCE_ENERGY, carried - energy);
            target.hits += hits;
            current._add('repaired', energy);
            current.charge(INTENT_CPU);
            return OK;
        };
        creep.drop = function (resourceType, amount) {
            const held = this.store.getUsedCapacity(resourceType);
            const dropping = amount === undefined ? held : Math.min(amount, held);
            if (dropping <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            this.store.set(resourceType, held - dropping);
            current._dropResource(this.room, this.pos, resourceType, dropping);
            current.charge(INTENT_CPU);
            return OK;
        };
        creep.moveTo = function (target, options = {}) {
            const result = current._moveIntent(this, target.pos || target, options.range);
            if (result === OK) current.charge(INTENT_CPU + MOVE_TO_SEARCH_CPU);
            return result;
        };
        creep.moveByPath = function (path) {
            const [x, y] = path.split(',').map(Number);
            const result = current._moveIntent(this, { x, y });
            if (result === OK) current.charge(INTENT_CPU);
            return result;
        };
    }

    _moveIntent(creep, target, range) {
        if (creep.fatigue > 0) return ERR_TIRED;
        if (creep.getActiveBodyparts(MOVE) === 0) return ERR_NO_BODYPART;
        creep.moveIntent = { x: target.x, y: target.y, range };
        return OK;
    }

    _spawnCreepAction() {
        const current = this;
        return function (body, name, options = {}) {
            if (this.spawning) return ERR_BUSY;
            if (Game.creeps[name]) return ERR_NAME_EXISTS;
            const cost = body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
            if (this.room.energyAvailable < cost) return ERR_NOT_ENOUGH_ENERGY;
            if (options.dryRun) return OK;
            current._payForSpawn(this.room, cost);
            if (!Memory.creeps) Memory.creeps = {};
            Memory.creeps[name] = options.memory || {};
            const creep = current._makeCreep(this.room, name, body, this.pos);
            creep.spawning = true;
            creep.ticksToLive = undefined;
            Game.creeps[name] = creep;
            this.spawning = { name, needTime: body.length * CREEP_SPAWN_TIME, remainingTime: body.length * CREEP_SPAWN_TIME };
            current.charge(INTENT_CPU);
            return OK;
        };
    }

    _recycleCreepAction() {
        const current = this;
        return function (creep) {
            if (this.pos.getRangeTo(creep) > 1) return ERR_NOT_IN_RANGE;
            current._kill(creep);
            return OK;
        };
    }

    _payForSpawn(room, cost) {
        let owed = cost;
        room._find[FIND_STRUCTURES].forEach(structure => {
            if (owed === 0 || (structure.structureType !== STRUCTURE_SPAWN && structure.structureType !== STRUCTURE_EXTENSION)) return;
            const paid = Math.min(owed, structure.store.getUsedCapacity(RESOURCE_ENERGY));
            structure.store.set(RESOURCE_ENERGY, structure.store.getUsedCapacity(RESOURCE_ENERGY) - paid);
            owed -= paid;
        });
        room.energyAvailable -= cost;
        this._add('spawned', cost);
    }

    _kill(creep) {
        const room = creep.room;
        const tombstone = {
            id: 'tombstone-' + this._nextId++, room, pos: creep.pos, deathTime: Game.time,
            ticksToDecay: creep.body.length * TOMBSTONE_DECAY_PER_PART,
            store: makeStore(creep.store._capacity, Object.fromEntries(Object.entries(creep.store))),
        };
        registerObject(tombstone, room.name);
        room._find[FIND_TOMBSTONES].push(tombstone);
        delete Game.creeps[creep.name];
        delete Game.objects[creep.id];
    }

    _dropResource(room, pos, resourceType, amount) {
        const drops = room._find[FIND_DROPPED_RESOURCES];
        const existing = drops.find(drop => drop.resourceType === resourceType && drop.pos.isEqualTo(pos));
        if (existing) {
            existing.amount += amount;
            return;
        }
        const drop = { id: 'drop-' + this._nextId++, room, pos, resourceType, amount };
        registerObject(drop, room.name);
        drops.push(drop);
    }

    // --- between ticks ---------------------------------------------------------------------------

    _resolveCreeps() {
        Object.values(Game.creeps).forEach(creep => {
            if (creep.spawning) return;
            if (creep.moveIntent) this._walk(creep);
            creep.moveIntent = null;
            creep.fatigue = Math.max(0, creep.fatigue - 2 * creep.getActiveBodyparts(MOVE));
            creep.ticksToLive--;
            if (creep.ticksToLive <= 0) this._kill(creep);
        });
        Object.values(Game.spawns).forEach(spawn => {
            if (!spawn.spawning) return;
            spawn.spawning.remainingTime--;
            if (spawn.spawning.remainingTime > 0) return;
            const creep = Game.creeps[spawn.spawning.name];
            if (creep) {
                creep.spawning = false;
                creep.ticksToLive = CREEP_LIFE_TIME;
                creep.pos = this._freeTileBeside(spawn);
            }
            spawn.spawning = null;
        });
    }

    _walk(creep) {
        const { x, y, range } = creep.moveIntent;
        const room = creep.pos.roomName;
        const wanted = range === undefined ? (this._blocked.has(tileIndex(x, y)) ? 1 : 0) : range;
        if (creep.pos.getRangeTo(x, y) <= wanted) return;
        const field = this._distanceField(x, y);
        let best = null;
        let bestDistance = field[tileIndex(creep.pos.x, creep.pos.y)];
        if (bestDistance < 0) bestDistance = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const nx = creep.pos.x + dx;
                const ny = creep.pos.y + dy;
                if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
                const distance = field[tileIndex(nx, ny)];
                if (distance >= 0 && distance < bestDistance && !this._blocked.has(tileIndex(nx, ny))) {
                    best = [nx, ny];
                    bestDistance = distance;
                }
            }
        }
        if (!best) return;
        creep.pos = new RoomPosition(best[0], best[1], room);
        const carryParts = creep.getActiveBodyparts(CARRY);
        const heavy = creep.body.length - creep.getActiveBodyparts(MOVE) - carryParts +
            Math.min(carryParts, Math.ceil(creep.store.getUsedCapacity() / CARRY_CAPACITY));
        creep.fatigue += heavy * (this._roads.has(tileIndex(best[0], best[1])) ? 1 : 2);
    }

    _distanceField(x, y) {
        const key = tileIndex(x, y);
        if (this._fields.has(key)) return this._fields.get(key);
        const field = new Int16Array(SIZE * SIZE).fill(-1);
        field[key] = 0;
        const queue = [key];
        for (let head = 0; head < queue.length; head++) {
            const tile = queue[head];
            const tileX = Math.floor(tile / SIZE);
            const tileY = tile % SIZE;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const nx = tileX + dx;
                    const ny = tileY + dy;
                    if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
                    const next = tileIndex(nx, ny);
                    if (field[next] >= 0 || this._blocked.has(next)) continue;
                    field[next] = field[tile] + 1;
                    queue.push(next);
                }
            }
        }
        if (this._fields.size >= FIELD_CACHE_LIMIT) this._fields.clear();
        this._fields.set(key, field);
        return field;
    }

    _freeTileBeside(object) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const x = object.pos.x + dx;
                const y = object.pos.y + dy;
                if ((dx !== 0 || dy !== 0) && !this._blocked.has(tileIndex(x, y))) return new RoomPosition(x, y, object.pos.roomName);
            }
        }
        return object.pos;
    }

    _advanceObjects() {
        Object.values(Game.rooms).forEach(room => {
            room._find[FIND_SOURCES].forEach(source => {
                if (source.energy < source.energyCapacity && source.ticksToRegeneration === undefined) source.ticksToRegeneration = ENERGY_REGEN_TIME;
                if (source.ticksToRegeneration === undefined) return;
                source.ticksToRegeneration--;
                if (source.ticksToRegeneration <= 0) {
                    source.energy = source.energyCapacity;
                    source.ticksToRegeneration = undefined;
                }
            });
            room._find[FIND_STRUCTURES].forEach(structure => {
                if (structure.cooldown > 0) structure.cooldown--;
            });
            this._decayDrops(room);
            this._decayTombstones(room);
            this._finishSites(room);
        });
    }

    _decayDrops(room) {
        room._find[FIND_DROPPED_RESOURCES] = room._find[FIND_DROPPED_RESOURCES].filter(drop => {
            if (drop.amount > 0) {
                const decay = Math.ceil(drop.amount / ENERGY_DECAY);
                drop.amount -= decay;
                if (drop.resourceType === RESOURCE_ENERGY) this._add('decayed', decay);
            }
            if (drop.amount > 0) return true;
            delete Game.objects[drop.id];
            return false;
        });
    }

    _decayTombstones(room) {
        room._find[FIND_TOMBSTONES] = room._find[FIND_TOMBSTONES].filter(tombstone => {
            tombstone.ticksToDecay--;
            if (tombstone.ticksToDecay > 0) return true;
            Object.keys(tombstone.store).forEach(resourceType => {
                if (tombstone.store[resourceType] > 0) this._dropResource(room, tombstone.pos, resourceType, tombstone.store[resourceType]);
            });
            delete Game.objects[tombstone.id];
            return false;
        });
    }

    _finishSites(room) {
        const finished = room._find[FIND_CONSTRUCTION_SITES].filter(site => site.progress >= site.progressTotal);
        finished.forEach(site => {
            [FIND_CONSTRUCTION_SITES, FIND_MY_CONSTRUCTION_SITES].forEach(type => {
                room._find[type] = room._find[type].filter(other => other !== site);
            });
            room.createdSites = room.createdSites.filter(other => other !== site);
            delete Game.objects[site.id];
            if (site.structureType === STRUCTURE_SPAWN) {
                this.addSpawn(room, site.name || 'Spawn' + this._nextId++, site.pos.x, site.pos.y).store = makeStore(SPAWN_ENERGY_CAPACITY);
                return;
            }
            this.addStructure(room, site.structureType, site.pos.x, site.pos.y, {});
        });
    }

    _refreshObjects() {
        Object.values(Game.rooms).forEach(room => {
            const inRoom = Object.values(Game.creeps).filter(creep => creep.room === room);
            room._find[FIND_MY_CREEPS] = inRoom;
            room._find[FIND_SOURCES_ACTIVE] = room._find[FIND_SOURCES].filter(source => source.energy > 0);
            let available = 0;
            let capacity = 0;
            room._find[FIND_STRUCTURES].forEach(structure => {
                if (structure.structureType !== STRUCTURE_SPAWN && structure.structureType !== STRUCTURE_EXTENSION) return;
                available += structure.store.getUsedCapacity(RESOURCE_ENERGY);
                capacity += structure.store._capacity;
            });
            room.energyAvailable = available;
            room.energyCapacityAvailable = capacity;
        });
    }

    _mapChanged() {
        this._blocked = new Set();
        this._roads = new Set();
        Object.values(Game.rooms).forEach(room => {
            (room._find[FIND_STRUCTURES] || []).forEach(structure => {
                const tile = tileIndex(structure.pos.x, structure.pos.y);
                if (structure.structureType === STRUCTURE_ROAD) this._roads.add(tile);
                if (!WALKABLE.has(structure.structureType)) this._blocked.add(tile);
            });
            (room._find[FIND_SOURCES] || []).forEach(source => this._blocked.add(tileIndex(source.pos.x, source.pos.y)));
            if (room.controller) this._blocked.add(tileIndex(room.controller.pos.x, room.controller.pos.y));
        });
        this._fields.clear();
    }

    // --- the engine's side of Memory, CPU and logs -------------------------------------------------

    _beginMemory() {
        const current = this;
        global.RawMemory = { get: () => current.storedMemory };
        delete global.Memory;
        Object.defineProperty(global, 'Memory', {
            configurable: true,
            enumerable: true,
            get() {
                current.parses++;
                const parsed = JSON.parse(current.storedMemory);
                Object.setPrototypeOf(parsed, null);
                RawMemory._parsed = parsed;
                Object.defineProperty(global, 'Memory', { configurable: true, enumerable: true, value: parsed });
                return parsed;
            },
        });
    }

    _endMemory() {
        if (RawMemory._parsed) this.storedMemory = JSON.stringify(RawMemory._parsed);
    }

    _installMemory(object, group, name) {
        Object.defineProperty(object, 'memory', {
            configurable: true,
            enumerable: true,
            get() {
                if (!Memory[group]) Memory[group] = {};
                if (!Memory[group][name]) Memory[group][name] = {};
                return Memory[group][name];
            },
            set(value) {
                if (!Memory[group]) Memory[group] = {};
                Memory[group][name] = value;
            },
        });
    }

    _installGame() {
        const current = this;
        Game.cpu = {
            limit: this.cpuLimit,
            tickLimit: 500,
            bucket: 10000,
            getUsed() {
                return Number(process.hrtime.bigint() - current._startedAt) / 1e6 + current._charged;
            },
        };
        this._startedAt = process.hrtime.bigint();
    }

    _recordCpu() {
        const used = Game.cpu.getUsed();
        this.cpuPerTick[Game.time] = used;
        if (used > Game.cpu.tickLimit) this.overLimit++;
        CpuManager._measurements.forEach(({ name, usedTicks }) => {
            this.jobCpu[name] = (this.jobCpu[name] || 0) + usedTicks;
        });
        const bucket = Math.max(0, Math.min(10000, Game.cpu.bucket + this.cpuLimit - used));
        Game.cpu.bucket = this.pinnedBucket === null ? bucket : this.pinnedBucket;
        Game.cpu.tickLimit = Math.min(500, Game.cpu.bucket);
        this.bucketPerTick[Game.time] = Game.cpu.bucket;
    }

    _installLogs() {
        MainInfo.error = message => this.errors.push({ time: Game.time, message: String(message) });
        MainInfo.warning = message => this.warnings.push({ time: Game.time, message: String(message) });
        MainInfo.log = () => {};
        this._originalConsoleLog = console.log;
        console.log = () => {};
    }

    // --- room positions ----------------------------------------------------------------------------

    _patchPositions() {
        const current = this;
        const prototype = RoomPosition.prototype;
        this._originalPosition = {
            createConstructionSite: prototype.createConstructionSite, look: prototype.look, lookFor: prototype.lookFor, findPathTo: prototype.findPathTo,
        };
        prototype.createConstructionSite = function (structureType, name) {
            return current._createSite(this, structureType, name);
        };
        prototype.look = function () {
            return current._objectsAt(this).map(object => object.structureType && object.progressTotal === undefined
                ? { type: 'structure', structure: object }
                : { type: 'constructionSite', constructionSite: object });
        };
        prototype.lookFor = function (type) {
            const objects = current._objectsAt(this);
            if (type === LOOK_STRUCTURES) return objects.filter(object => object.progressTotal === undefined);
            if (type === LOOK_CONSTRUCTION_SITES) return objects.filter(object => object.progressTotal !== undefined);
            return [];
        };
        prototype.findPathTo = function (target, options = {}) {
            current.charge(FIND_PATH_CPU);
            const to = target.pos || target;
            const distance = current._distanceField(to.x, to.y)[tileIndex(this.x, this.y)];
            return new Array(Math.max(0, distance - (options.range || 0))).fill(null);
        };
    }

    _objectsAt(pos) {
        const room = Game.rooms[pos.roomName];
        return room._find[FIND_STRUCTURES].concat(room._find[FIND_CONSTRUCTION_SITES]).filter(object => object.pos.x === pos.x && object.pos.y === pos.y);
    }

    _createSite(pos, structureType, name) {
        const room = Game.rooms[pos.roomName];
        if (this._objectsAt(pos).some(object => object.structureType !== STRUCTURE_RAMPART)) return ERR_INVALID_TARGET;
        if (this._blocked.has(tileIndex(pos.x, pos.y)) && structureType !== STRUCTURE_RAMPART) return ERR_INVALID_TARGET;
        const sites = room._find[FIND_CONSTRUCTION_SITES];
        if (sites.length >= MAX_CONSTRUCTION_SITES) return ERR_FULL;
        const count = room._find[FIND_STRUCTURES].concat(sites).filter(object => object.structureType === structureType).length;
        if (count >= CONTROLLER_STRUCTURES[structureType][room.controller.level]) return ERR_RCL_NOT_ENOUGH;
        const site = {
            id: 'site-' + this._nextId++, room, pos: new RoomPosition(pos.x, pos.y, pos.roomName), structureType, name,
            my: true, progress: 0, progressTotal: CONSTRUCTION_COST[structureType],
        };
        registerObject(site, room.name);
        sites.push(site);
        room._find[FIND_MY_CONSTRUCTION_SITES].push(site);
        room.createdSites.push(site);
        this._add('sitesPlaced', 1);
        this.charge(INTENT_CPU);
        return OK;
    }
}

/*
 * The standard W1N1: an RCL 7 base with storage, containers at both sources, a factory making
 * batteries, labs making hydroxide, and every creep near a different point of its life, so that
 * the whole workforce has to be replaced during a run.
 */

function buildStandardRoom(simulator) {
    const room = simulator.addRoom('W1N1', { level: 7 });
    simulator.addSource(room, 'source-north', 8, 8);
    simulator.addSource(room, 'source-south', 42, 42);
    const containers = [[9, 9], [41, 41]];
    containers.forEach(([x, y]) => simulator.addStructure(room, STRUCTURE_CONTAINER, x, y, { energy: 500 }));

    simulator.addSpawn(room, 'Spawn1', 25, 25);
    simulator.addStructure(room, STRUCTURE_STORAGE, 25, 28, {
        id: 'storage', energy: 200000, contents: { [RESOURCE_HYDROGEN]: 3000, [RESOURCE_OXYGEN]: 3000 },
    });
    simulator.addStructure(room, STRUCTURE_TERMINAL, 27, 28, { id: 'terminal', energy: 20000 });
    simulator.addStructure(room, STRUCTURE_FACTORY, 23, 28, { id: 'factory' });
    simulator.addStructure(room, STRUCTURE_TOWER, 25, 22, { id: 'tower', energy: 1000 });
    [[30, 30], [31, 30], [30, 31]].forEach(([x, y], index) => simulator.addStructure(room, STRUCTURE_LAB, x, y, { id: 'lab-' + index }));
    for (let index = 0; index < 20; index++) {
        simulator.addStructure(room, STRUCTURE_EXTENSION, 16 + index, 20, { energy: EXTENSION_ENERGY_CAPACITY[7] });
    }

    room.memory.factory = { enabled: true, batteryTarget: 2000, planningInterval: 5 };
    room.memory.lab = { goals: { [RESOURCE_HYDROXIDE]: 1000 }, planningInterval: 5 };

    const miner = [WORK, WORK, WORK, WORK, WORK, WORK, CARRY, MOVE, MOVE, MOVE];
    const hauler = [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE];
    const courier = [WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE];
    const upgrader = [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE];
    simulator.addCreep(room, 'miner-north', 'Miner', miner, { x: 9, y: 9, ticksToLive: 700, memory: { source: 'source-north' } });
    simulator.addCreep(room, 'miner-south', 'Miner', miner, { x: 41, y: 41, ticksToLive: 1100, memory: { source: 'source-south' } });
    simulator.addCreep(room, 'hauler-1', 'Storekeeper', hauler, { x: 24, y: 27, ticksToLive: 600 });
    simulator.addCreep(room, 'hauler-2', 'Storekeeper', hauler, { x: 26, y: 27, ticksToLive: 1000 });
    simulator.addCreep(room, 'hauler-3', 'Storekeeper', hauler, { x: 28, y: 27, ticksToLive: 1300 });
    simulator.addCreep(room, 'courier', 'Courier', courier, { x: 24, y: 29, ticksToLive: 800 });
    simulator.addCreep(room, 'upgrader-1', 'Upgrader', upgrader, { x: 39, y: 12, ticksToLive: 900 });
    simulator.addCreep(room, 'upgrader-2', 'Upgrader', upgrader, { x: 38, y: 12, ticksToLive: 1200 });
    simulator.start();
    return room;
}

module.exports = { Simulator, buildStandardRoom };
