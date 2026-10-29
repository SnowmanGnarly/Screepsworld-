const MainCache = require('../../main.cache');
const MainInfo = require('../../main.info');
MainInfo.__originalLog = MainInfo.log;

const constants = {
    RESOURCE_ENERGY: 'energy', RESOURCE_OXYGEN: 'oxygen', RESOURCE_ZYNTHIUM: 'zynthium',
    RESOURCE_HYDROGEN: 'hydrogen', RESOURCE_UTRIUM: 'utrium', RESOURCE_LEMERGIUM: 'lemergium',
    RESOURCE_KEANIUM: 'keanium', RESOURCE_CATALYST: 'catalyst', RESOURCE_GHODIUM: 'ghodium',
    RESOURCE_HYDROXIDE: 'hydroxide', RESOURCE_ZYNTHIUM_KEANITE: 'zynthium_keanite',
    RESOURCE_UTRIUM_LEMERGITE: 'utrium_lemergite', RESOURCE_UTRIUM_HYDRIDE: 'utrium_hydride',
    RESOURCE_UTRIUM_OXIDE: 'utrium_oxide', RESOURCE_UTRIUM_ACID: 'utrium_acid',
    RESOURCE_UTRIUM_ALKALIDE: 'utrium_alkalide', RESOURCE_ZYNTHIUM_HYDRIDE: 'zynthium_hydride',
    RESOURCE_ZYNTHIUM_OXIDE: 'zynthium_oxide', RESOURCE_ZYNTHIUM_ALKALIDE: 'zynthium_alkalide',
    RESOURCE_GHODIUM_HYDRIDE: 'ghodium_hydride', RESOURCE_GHODIUM_ACID: 'ghodium_acid',
    RESOURCE_GHODIUM_ALKALIDE: 'ghodium_alkalide', RESOURCE_CATALYZED_UTRIUM_ACID: 'catalyzed_utrium_acid',
    RESOURCE_CATALYZED_UTRIUM_ALKALIDE: 'catalyzed_utrium_alkalide',
    RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE: 'catalyzed_zynthium_alkalide',
    RESOURCE_CATALYZED_GHODIUM_ACID: 'catalyzed_ghodium_acid',
    RESOURCE_CATALYZED_GHODIUM_ALKALIDE: 'catalyzed_ghodium_alkalide',
    RESOURCE_BATTERY: 'battery', RESOURCE_COMPOSITE: 'composite', RESOURCE_OXIDANT: 'oxidant',
    FIND_MY_STRUCTURES: 'myStructures', FIND_STRUCTURES: 'structures', FIND_SOURCES: 'sources',
    FIND_SOURCES_ACTIVE: 'activeSources', FIND_MY_SPAWNS: 'mySpawns', FIND_HOSTILE_CREEPS: 'hostiles',
    FIND_HOSTILE_STRUCTURES: 'hostileStructures',
    FIND_MY_CREEPS: 'myCreeps', FIND_DROPPED_RESOURCES: 'dropped', FIND_TOMBSTONES: 'tombstones',
    FIND_RUINS: 'ruins', FIND_MINERALS: 'minerals', FIND_CONSTRUCTION_SITES: 'sites',
    FIND_MY_CONSTRUCTION_SITES: 'mySites', LOOK_STRUCTURES: 'structure', LOOK_CONSTRUCTION_SITES: 'site',
    LOOK_SOURCES: 'source', LOOK_MINERALS: 'mineral', LOOK_TERRAIN: 'terrain',
    STRUCTURE_SPAWN: 'spawn', STRUCTURE_EXTENSION: 'extension', STRUCTURE_STORAGE: 'storage',
    STRUCTURE_CONTAINER: 'container', STRUCTURE_LINK: 'link', STRUCTURE_TOWER: 'tower',
    STRUCTURE_CONTROLLER: 'controller', STRUCTURE_LAB: 'lab', STRUCTURE_TERMINAL: 'terminal',
    STRUCTURE_FACTORY: 'factory', STRUCTURE_EXTRACTOR: 'extractor', STRUCTURE_OBSERVER: 'observer',
    STRUCTURE_POWER_SPAWN: 'powerSpawn', STRUCTURE_NUKER: 'nuker', STRUCTURE_RAMPART: 'rampart',
    STRUCTURE_WALL: 'wall', STRUCTURE_ROAD: 'road', STRUCTURE_INVADER_CORE: 'invaderCore',
    WORK: 'work', MOVE: 'move', CARRY: 'carry', TOUGH: 'tough', ATTACK: 'attack',
    RANGED_ATTACK: 'ranged_attack', HEAL: 'heal', CLAIM: 'claim',
    BODYPART_COST: { work: 100, move: 50, carry: 50, tough: 10, attack: 80, ranged_attack: 150, heal: 250, claim: 600 },
    OK: 0, ERR_NOT_OWNER: -1, ERR_NO_PATH: -2, ERR_NAME_EXISTS: -3, ERR_BUSY: -4,
    ERR_NOT_FOUND: -5, ERR_NOT_ENOUGH_ENERGY: -6, ERR_NOT_ENOUGH_RESOURCES: -6,
    ERR_INVALID_TARGET: -7, ERR_FULL: -8, ERR_NOT_IN_RANGE: -9, ERR_NO_BODYPART: -12,
    ERR_RCL_NOT_ENOUGH: -14, ERR_TIRED: -11, ERR_INVALID_ARGS: -10,
    ORDER_BUY: 'buy', ORDER_SELL: 'sell', TERMINAL_COOLDOWN: 10,
    LAB_REACTION_AMOUNT: 5, LAB_BOOST_ENERGY: 20, LAB_BOOST_MINERAL: 30,
    LAB_ENERGY_CAPACITY: 2000, LAB_MINERAL_CAPACITY: 3000,
    HARVEST_MINERAL_POWER: 1, EXTRACTOR_COOLDOWN: 5,
    TOWER_ENERGY_COST: 10, TERRAIN_MASK_WALL: 1,
    REACTIONS: {
        hydrogen: { oxygen: 'hydroxide' },
        oxygen: { hydrogen: 'hydroxide', utrium: 'utrium_oxide', zynthium: 'zynthium_oxide', ghodium: 'ghodium_oxide' },
        utrium: { hydrogen: 'utrium_hydride', oxygen: 'utrium_oxide', lemergium: 'utrium_lemergite' },
        lemergium: { utrium: 'utrium_lemergite' },
        zynthium: { keanium: 'zynthium_keanite', oxygen: 'zynthium_oxide' },
        keanium: { zynthium: 'zynthium_keanite' },
        utrium_lemergite: { zynthium_keanite: 'ghodium' }, zynthium_keanite: { utrium_lemergite: 'ghodium' },
        ghodium: { hydrogen: 'ghodium_hydride', oxygen: 'ghodium_oxide' },
        utrium_hydride: { hydroxide: 'utrium_acid' }, utrium_oxide: { hydroxide: 'utrium_alkalide' },
        zynthium_oxide: { hydroxide: 'zynthium_alkalide' },
        ghodium_hydride: { hydroxide: 'ghodium_acid' }, ghodium_oxide: { hydroxide: 'ghodium_alkalide' },
        hydroxide: {
            utrium_hydride: 'utrium_acid', utrium_oxide: 'utrium_alkalide',
            zynthium_oxide: 'zynthium_alkalide', ghodium_hydride: 'ghodium_acid', ghodium_oxide: 'ghodium_alkalide',
        },
        catalyst: {
            utrium_acid: 'catalyzed_utrium_acid', utrium_alkalide: 'catalyzed_utrium_alkalide',
            zynthium_alkalide: 'catalyzed_zynthium_alkalide', ghodium_acid: 'catalyzed_ghodium_acid',
            ghodium_alkalide: 'catalyzed_ghodium_alkalide',
        },
        utrium_acid: { catalyst: 'catalyzed_utrium_acid' },
        utrium_alkalide: { catalyst: 'catalyzed_utrium_alkalide' },
        zynthium_alkalide: { catalyst: 'catalyzed_zynthium_alkalide' },
        ghodium_acid: { catalyst: 'catalyzed_ghodium_acid' },
        ghodium_alkalide: { catalyst: 'catalyzed_ghodium_alkalide' },
    },
    REACTION_TIME: {
        hydroxide: 20, zynthium_keanite: 5, utrium_lemergite: 5, ghodium: 5,
        utrium_hydride: 10, utrium_oxide: 10, zynthium_oxide: 10, ghodium_hydride: 10, ghodium_oxide: 10,
        utrium_acid: 5, utrium_alkalide: 5, zynthium_alkalide: 5, ghodium_acid: 5, ghodium_alkalide: 5,
        catalyzed_utrium_acid: 60, catalyzed_utrium_alkalide: 60, catalyzed_zynthium_alkalide: 60,
        catalyzed_ghodium_acid: 60, catalyzed_ghodium_alkalide: 60,
    },
    BOOSTS: {
        utrium_hydride: { attack: {} }, utrium_acid: { attack: {} }, catalyzed_utrium_acid: { attack: {} },
        utrium_oxide: { work: { harvest: 2 } }, utrium_alkalide: { work: { harvest: 4 } },
        catalyzed_utrium_alkalide: { work: { harvest: 6 } },
        zynthium_oxide: { work: { dismantle: 2 } }, zynthium_alkalide: { work: { dismantle: 4 } },
        catalyzed_zynthium_alkalide: { work: { dismantle: 6 } },
        ghodium_hydride: { work: { upgradeController: 1.5 } }, ghodium_acid: { work: { upgradeController: 1.8 } },
        catalyzed_ghodium_acid: { work: { upgradeController: 2 } },
        ghodium_oxide: { tough: {} }, ghodium_alkalide: { tough: {} }, catalyzed_ghodium_alkalide: { tough: {} },
    },
};

Object.assign(global, constants);

class MockRoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }

    getRangeTo(target, y) {
        if (typeof target === 'object' && target.pos) target = target.pos;
        const x = typeof target === 'object' ? target.x : target;
        const otherY = typeof target === 'object' ? target.y : y;
        if (typeof target === 'object' && target.roomName && target.roomName !== this.roomName) return Infinity;
        return Math.max(Math.abs(this.x - x), Math.abs(this.y - otherY));
    }

    inRangeTo(target, range) {
        return this.getRangeTo(target) <= range;
    }

    isNearTo(target) {
        return this.inRangeTo(target, 1);
    }

    isEqualTo(target) {
        if (target && target.pos) target = target.pos;
        return this.roomName === target.roomName && this.x === target.x && this.y === target.y;
    }

    findClosestByPath(type) {
        const room = Game.rooms[this.roomName];
        const values = type === FIND_MY_SPAWNS ? Object.values(Game.spawns).filter(spawn => spawn.room === room) : room.find(type);
        return values.sort((a, b) => this.getRangeTo(a) - this.getRangeTo(b))[0] || null;
    }

    createConstructionSite(structureType, name) {
        const room = Game.rooms[this.roomName];
        const site = {
            id: 'site-' + room.createdSites.length,
            room,
            pos: new MockRoomPosition(this.x, this.y, this.roomName),
            structureType,
            name,
            progress: 0,
            progressTotal: structureType === STRUCTURE_CONTAINER ? 5000 : structureType === STRUCTURE_ROAD ? 1000 : 1000,
        };
        room.createdSites.push(site);
        room._find[FIND_CONSTRUCTION_SITES] = room._find[FIND_CONSTRUCTION_SITES] || [];
        room._find[FIND_MY_CONSTRUCTION_SITES] = room._find[FIND_MY_CONSTRUCTION_SITES] || [];
        room._find[FIND_CONSTRUCTION_SITES].push(site);
        room._find[FIND_MY_CONSTRUCTION_SITES].push(site);
        registerObject(site, room.name);
        return OK;
    }

    lookFor() {
        return [];
    }

    look() {
        return [];
    }
}

function makeStore(capacity, contents = {}, resourceCapacities = null) {
    const store = { ...contents };
    Object.defineProperties(store, {
        _capacity: { value: capacity, writable: true },
        _resourceCapacities: { value: resourceCapacities },
        getUsedCapacity: {
            value(resourceType) {
                if (resourceType) return store[resourceType] || 0;
                return Object.keys(store).reduce((sum, key) => sum + (typeof store[key] === 'number' ? store[key] : 0), 0);
            },
        },
        getFreeCapacity: {
            value(resourceType) {
                if (store._resourceCapacities && resourceType) {
                    const capacity = resourceType === RESOURCE_ENERGY ? store._resourceCapacities.energy : store._resourceCapacities.mineral;
                    return Math.max(0, capacity - store.getUsedCapacity(resourceType));
                }
                return Math.max(0, store._capacity - store.getUsedCapacity());
            },
        },
        set: {
            value(resourceType, amount) {
                if (amount > 0) store[resourceType] = amount;
                else delete store[resourceType];
            },
        },
    });
    return store;
}

function makeRoom(name, options = {}) {
    return {
        name,
        memory: options.memory || {},
        controller: Object.prototype.hasOwnProperty.call(options, 'controller') ? options.controller : { my: true, level: 1 },
        storage: options.storage,
        terminal: options.terminal,
        energyAvailable: options.energyAvailable === undefined ? 300 : options.energyAvailable,
        energyCapacityAvailable: options.energyCapacityAvailable || 300,
        visual: { text() {} },
        createdSites: [],
        _find: {},
        find(type, options) {
            const values = this._find[type] || [];
            return options && options.filter ? values.filter(options.filter) : values.slice();
        },
        getTerrain() {
            return { get: () => 0 };
        },
        lookAt() {
            return [];
        },
    };
}

function setFind(room, type, values) {
    room._find[type] = values;
    return values;
}

function makePosition(room, x, y) {
    return new MockRoomPosition(x, y, room.name);
}

function makeStructure(room, structureType, options = {}) {
    return {
        id: options.id || structureType + '-' + Math.random().toString(36).slice(2),
        structureType,
        room,
        pos: options.pos || makePosition(room, 25, 25),
        store: options.store || makeStore(1000),
        memory: options.memory,
        hits: options.hits === undefined ? 1000 : options.hits,
        hitsMax: options.hitsMax || 1000,
        ...options.extra,
    };
}

function makeTerminal(room, options = {}) {
    const terminal = makeStructure(room, STRUCTURE_TERMINAL, {
        id: options.id || 'terminal-' + room.name,
        pos: options.pos,
        store: options.store || makeStore(options.capacity || 100000, options.contents || {}),
        extra: { my: true, cooldown: options.cooldown || 0, sent: [] },
    });
    terminal.send = function (resourceType, amount, targetRoomName, description) {
        if (this.cooldown > 0) return ERR_TIRED;
        if (!targetRoomName || amount <= 0) return ERR_INVALID_ARGS;
        const fee = Game.market.calcTransactionCost(amount, room.name, targetRoomName);
        const energyCost = fee + (resourceType === RESOURCE_ENERGY ? amount : 0);
        if (this.store.getUsedCapacity(resourceType) < amount || this.store.getUsedCapacity(RESOURCE_ENERGY) < energyCost) {
            return ERR_NOT_ENOUGH_RESOURCES;
        }
        const target = Game.rooms[targetRoomName] && Game.rooms[targetRoomName].terminal;
        if (target && target.store.getFreeCapacity(resourceType) < amount) return ERR_FULL;
        this.store.set(resourceType, this.store.getUsedCapacity(resourceType) - amount);
        this.store.set(RESOURCE_ENERGY, this.store.getUsedCapacity(RESOURCE_ENERGY) - fee);
        if (target) target.store.set(resourceType, target.store.getUsedCapacity(resourceType) + amount);
        this.sent.push({ resourceType, amount, targetRoomName, description, fee });
        this.cooldown = TERMINAL_COOLDOWN;
        return OK;
    };
    if (options.attach !== false) room.terminal = terminal;
    return terminal;
}

function makeFactory(room, options = {}) {
    const factory = makeStructure(room, STRUCTURE_FACTORY, {
        id: options.id || 'factory-' + room.name,
        pos: options.pos,
        store: options.store || makeStore(options.capacity || 100000, options.contents || {}),
        memory: options.memory,
        extra: {
            my: true,
            level: options.level || 0,
            cooldown: options.cooldown || 0,
            produced: [],
        },
    });
    factory.produce = function (resourceType) {
        const recipe = typeof COMMODITIES !== 'undefined' && COMMODITIES[resourceType];
        if (!recipe || !recipe.components || !Number.isFinite(recipe.amount)) return ERR_INVALID_TARGET;
        if ((this.level || 0) < (recipe.level || 0)) return ERR_RCL_NOT_ENOUGH;
        if (this.cooldown > 0) return ERR_TIRED;
        if (this.store.getFreeCapacity(resourceType) < recipe.amount) return ERR_FULL;
        for (const component of Object.keys(recipe.components)) {
            if (this.store.getUsedCapacity(component) < recipe.components[component]) return ERR_NOT_ENOUGH_RESOURCES;
        }
        for (const component of Object.keys(recipe.components)) {
            this.store.set(component, this.store.getUsedCapacity(component) - recipe.components[component]);
        }
        this.store.set(resourceType, this.store.getUsedCapacity(resourceType) + recipe.amount);
        this.cooldown = recipe.cooldown || 0;
        this.produced.push({ resourceType, amount: recipe.amount });
        return OK;
    };
    return factory;
}

function makeLab(room, options = {}) {
    const store = options.store || makeStore(LAB_ENERGY_CAPACITY + LAB_MINERAL_CAPACITY, options.contents || {}, {
        energy: LAB_ENERGY_CAPACITY,
        mineral: LAB_MINERAL_CAPACITY,
    });
    const lab = makeStructure(room, STRUCTURE_LAB, {
        id: options.id || 'lab-' + Math.random().toString(36).slice(2),
        pos: options.pos,
        store,
        memory: options.memory,
        extra: { my: true, cooldown: options.cooldown || 0, reactions: [], boosts: [] },
    });
    Object.defineProperty(lab, 'mineralType', {
        get() {
            return Object.keys(lab.store).find(resourceType => resourceType !== RESOURCE_ENERGY && lab.store[resourceType] > 0) || null;
        },
    });
    lab.runReaction = function (inputA, inputB) {
        if (this.cooldown > 0) return ERR_TIRED;
        if (!inputA || !inputB || this.pos.getRangeTo(inputA) > 2 || this.pos.getRangeTo(inputB) > 2) return ERR_NOT_IN_RANGE;
        const reagentA = inputA.mineralType;
        const reagentB = inputB.mineralType;
        const product = reagentA && reagentB && REACTIONS[reagentA] && REACTIONS[reagentA][reagentB];
        if (!product) return ERR_INVALID_ARGS;
        if (inputA.store.getUsedCapacity(reagentA) < LAB_REACTION_AMOUNT ||
            inputB.store.getUsedCapacity(reagentB) < LAB_REACTION_AMOUNT) return ERR_NOT_ENOUGH_RESOURCES;
        if ((this.mineralType && this.mineralType !== product) || this.store.getFreeCapacity(product) < LAB_REACTION_AMOUNT) return ERR_FULL;
        inputA.store.set(reagentA, inputA.store.getUsedCapacity(reagentA) - LAB_REACTION_AMOUNT);
        inputB.store.set(reagentB, inputB.store.getUsedCapacity(reagentB) - LAB_REACTION_AMOUNT);
        this.store.set(product, this.store.getUsedCapacity(product) + LAB_REACTION_AMOUNT);
        this.cooldown = REACTION_TIME[product] || 0;
        this.reactions.push({ inputA: inputA.id, inputB: inputB.id, product, amount: LAB_REACTION_AMOUNT });
        return OK;
    };
    lab.boostCreep = function (creep, bodyPartsCount) {
        if (this.cooldown > 0) return ERR_TIRED;
        if (this.pos.getRangeTo(creep) > 1) return ERR_NOT_IN_RANGE;
        const resourceType = this.mineralType;
        const recipe = resourceType && BOOSTS[resourceType];
        if (!recipe) return ERR_NOT_ENOUGH_RESOURCES;
        const eligible = creep.body.filter(part => {
            const type = typeof part === 'string' ? part : part.type;
            return recipe[type] && (typeof part === 'string' || !part.boost);
        });
        const count = bodyPartsCount === undefined ? eligible.length : Math.min(bodyPartsCount, eligible.length);
        if (count <= 0) return ERR_NO_BODYPART;
        if (this.store.getUsedCapacity(resourceType) < count * LAB_BOOST_MINERAL ||
            this.store.getUsedCapacity(RESOURCE_ENERGY) < count * LAB_BOOST_ENERGY) return ERR_NOT_ENOUGH_RESOURCES;
        this.store.set(resourceType, this.store.getUsedCapacity(resourceType) - count * LAB_BOOST_MINERAL);
        this.store.set(RESOURCE_ENERGY, this.store.getUsedCapacity(RESOURCE_ENERGY) - count * LAB_BOOST_ENERGY);
        let remaining = count;
        creep.body = creep.body.map(part => {
            const type = typeof part === 'string' ? part : part.type;
            if (remaining > 0 && recipe[type] && (typeof part === 'string' || !part.boost)) {
                remaining--;
                return Object.assign({}, typeof part === 'object' ? part : {}, { type, boost: resourceType });
            }
            return part;
        });
        this.boosts.push({ creepName: creep.name, resourceType, count });
        return OK;
    };
    return lab;
}

function makeCreep(room, options = {}) {
    const creep = {
        name: options.name || 'creep-' + Math.random().toString(36).slice(2),
        room,
        memory: options.memory || {},
        body: options.body || [WORK, CARRY, MOVE],
        store: options.store || makeStore(options.capacity || 300),
        pos: options.pos || makePosition(room, 25, 25),
        spawning: options.spawning || false,
        ticksToLive: options.ticksToLive || 1500,
        hits: options.hits === undefined ? (options.hitsMax || 1000) : options.hits,
        hitsMax: options.hitsMax || 1000,
        owner: options.owner || { username: 'Me' },
        getActiveBodyparts(type) {
            return creep.body.filter(part => (part === type || part.type === type) && (typeof part === 'string' || part.hits !== 0)).length;
        },
        moveTo(target, moveOptions) {
            creep.lastMoveTo = target;
            creep.moveOptions = moveOptions;
            creep.memory.moving = true;
            return OK;
        },
        withdraw(source, resourceType, amount) {
            if (creep.pos.getRangeTo(source) > 1) return ERR_NOT_IN_RANGE;
            const available = source.store ? source.store.getUsedCapacity(resourceType) : 0;
            const count = Math.min(amount === undefined ? available : amount, available, creep.store.getFreeCapacity(resourceType));
            if (count <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            source.store.set(resourceType, source.store[resourceType] - count);
            creep.store.set(resourceType, (creep.store[resourceType] || 0) + count);
            return OK;
        },
        transfer(target, resourceType, amount) {
            if (creep.pos.getRangeTo(target) > 1) return ERR_NOT_IN_RANGE;
            const available = creep.store.getUsedCapacity(resourceType);
            const free = target.store.getFreeCapacity(resourceType);
            if (free <= 0) return ERR_FULL;
            const count = Math.min(amount === undefined ? available : amount, available, free);
            if (count <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            creep.store.set(resourceType, available - count);
            target.store.set(resourceType, (target.store[resourceType] || 0) + count);
            return OK;
        },
        pickup(source) {
            if (creep.pos.getRangeTo(source) > 1) return ERR_NOT_IN_RANGE;
            const resourceType = source.resourceType;
            const count = Math.min(source.amount, creep.store.getFreeCapacity(resourceType));
            if (count <= 0) return ERR_FULL;
            source.amount -= count;
            creep.store.set(resourceType, (creep.store[resourceType] || 0) + count);
            return OK;
        },
        harvest(source) {
            if (creep.pos.getRangeTo(source) > 1) return ERR_NOT_IN_RANGE;
            const workParts = creep.getActiveBodyparts(WORK);
            if (workParts === 0) return ERR_NO_BODYPART;
            if (source.mineralType) {
                const mineralRoom = source.room || room;
                const extractor = mineralRoom.find(FIND_MY_STRUCTURES).find(structure => {
                    return structure.structureType === STRUCTURE_EXTRACTOR && structure.pos.isEqualTo(source.pos);
                });
                if (!extractor) return ERR_NOT_FOUND;
                if (extractor.cooldown > 0) return ERR_TIRED;
                const available = source.mineralAmount || 0;
                const count = Math.min(workParts * HARVEST_MINERAL_POWER, available, creep.store.getFreeCapacity(source.mineralType));
                if (count <= 0) return ERR_NOT_ENOUGH_RESOURCES;
                source.mineralAmount = available - count;
                if (source.mineralAmount === 0) source.ticksToRegeneration = 50;
                extractor.cooldown = EXTRACTOR_COOLDOWN;
                creep.store.set(source.mineralType, creep.store.getUsedCapacity(source.mineralType) + count);
                return OK;
            }
            const resourceType = source.resourceType || RESOURCE_ENERGY;
            const available = source.energy === undefined ? (source.amount === undefined ? 3000 : source.amount) : source.energy;
            const count = Math.min(workParts * 2, available, creep.store.getFreeCapacity(resourceType));
            if (count <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            if (source.energy !== undefined) source.energy = available - count;
            else source.amount = available - count;
            creep.store.set(resourceType, (creep.store[resourceType] || 0) + count);
            return OK;
        },
        drop(resourceType) {
            const amount = creep.store.getUsedCapacity(resourceType);
            if (amount <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            const drop = { id: 'drop-' + Math.random().toString(36).slice(2), room, pos: creep.pos, resourceType, amount };
            creep.store.set(resourceType, 0);
            room._find[FIND_DROPPED_RESOURCES] = room._find[FIND_DROPPED_RESOURCES] || [];
            room._find[FIND_DROPPED_RESOURCES].push(drop);
            registerObject(drop, room.name);
            return OK;
        },
        build(site) {
            if (creep.pos.getRangeTo(site) > 3) return ERR_NOT_IN_RANGE;
            const workParts = creep.getActiveBodyparts(WORK);
            if (workParts === 0) return ERR_NO_BODYPART;
            const progress = Math.min(workParts * 5, creep.store.getUsedCapacity(RESOURCE_ENERGY), site.progressTotal - site.progress);
            if (progress <= 0) return ERR_NOT_ENOUGH_RESOURCES;
            site.progress += progress;
            creep.store.set(RESOURCE_ENERGY, creep.store.getUsedCapacity(RESOURCE_ENERGY) - progress);
            return OK;
        },
        attack(target) {
            if (creep.pos.getRangeTo(target) > 1) return ERR_NOT_IN_RANGE;
            creep.attacked = target;
            return OK;
        },
        rangedAttack(target) {
            if (creep.pos.getRangeTo(target) > 3) return ERR_NOT_IN_RANGE;
            creep.rangedAttacked = target;
            return OK;
        },
        heal(target) {
            if (creep.pos.getRangeTo(target) > 1) return ERR_NOT_IN_RANGE;
            creep.healed = target;
            target.hits = Math.min(target.hitsMax, target.hits + creep.getActiveBodyparts(HEAL) * 12);
            return OK;
        },
        reserveController(controller) {
            if (creep.pos.getRangeTo(controller) > 1) return ERR_NOT_IN_RANGE;
            creep.reserved = controller;
            controller.reservation = { username: creep.owner.username, ticksToEnd: 1 };
            return OK;
        },
        claimController(controller) {
            if (creep.pos.getRangeTo(controller) > 1) return ERR_NOT_IN_RANGE;
            controller.my = true;
            return OK;
        },
        upgradeController(controller) {
            if (creep.pos.getRangeTo(controller) > 3) return ERR_NOT_IN_RANGE;
            creep.upgraded = controller;
            return OK;
        },
        say() {},
    };
    return creep;
}

function makeSpawn(room, options = {}) {
    return {
        name: options.name || 'Spawn1',
        room,
        memory: options.memory || { home: room.name },
        spawning: null,
        pos: options.pos || makePosition(room, 25, 25),
        spawnCreep(body, name, options) {
            const creep = makeCreep(room, { name, body, memory: options.memory, spawning: true });
            Game.creeps[name] = creep;
            this.spawning = creep;
            return OK;
        },
        recycleCreep(creep) {
            if (this.pos.getRangeTo(creep) > 1) return ERR_NOT_IN_RANGE;
            creep.recycled = true;
            delete Game.creeps[creep.name];
            return OK;
        },
    };
}

function makeMarket(options = {}) {
    return {
        credits: options.credits === undefined ? 100000 : options.credits,
        orders: options.orders || {},
        deals: [],
        getAllOrdersCalls: 0,
        createOrderCalls: 0,
        getAllOrders() {
            this.getAllOrdersCalls++;
            return Object.values(this.orders);
        },
        calcTransactionCost(amount, fromRoomName, toRoomName) {
            if (options.calcTransactionCost) return options.calcTransactionCost(amount, fromRoomName, toRoomName);
            const distance = Game.map.getRoomLinearDistance(fromRoomName, toRoomName);
            return Math.ceil(amount * (1 - Math.exp(-distance / 30)));
        },
        deal(orderId, amount, roomName) {
            const order = this.orders[orderId];
            const room = Game.rooms[roomName];
            const terminal = room && room.terminal;
            if (!order || order.amount < amount || amount <= 0 || !terminal) return ERR_INVALID_ARGS;
            if (terminal.cooldown > 0) return ERR_TIRED;
            const fee = this.calcTransactionCost(amount, roomName, order.roomName);
            const cost = order.price * amount;
            if (order.type === ORDER_SELL) {
                if (this.credits < cost) return ERR_NOT_ENOUGH_RESOURCES;
                if (terminal.store.getUsedCapacity(RESOURCE_ENERGY) < fee ||
                    terminal.store.getFreeCapacity(order.resourceType) < amount) return ERR_NOT_ENOUGH_RESOURCES;
                terminal.store.set(RESOURCE_ENERGY, terminal.store.getUsedCapacity(RESOURCE_ENERGY) - fee);
                terminal.store.set(order.resourceType, terminal.store.getUsedCapacity(order.resourceType) + amount);
                this.credits -= cost;
            } else if (order.type === ORDER_BUY) {
                const energyCost = fee + (order.resourceType === RESOURCE_ENERGY ? amount : 0);
                if (terminal.store.getUsedCapacity(order.resourceType) < amount ||
                    terminal.store.getUsedCapacity(RESOURCE_ENERGY) < energyCost) return ERR_NOT_ENOUGH_RESOURCES;
                terminal.store.set(order.resourceType, terminal.store.getUsedCapacity(order.resourceType) - amount);
                terminal.store.set(RESOURCE_ENERGY, terminal.store.getUsedCapacity(RESOURCE_ENERGY) - fee);
                this.credits += cost;
            } else {
                return ERR_INVALID_ARGS;
            }
            order.amount -= amount;
            terminal.cooldown = TERMINAL_COOLDOWN;
            this.deals.push({ orderId, amount, roomName, fee, credits: cost });
            return OK;
        },
        createOrder() {
            this.createOrderCalls++;
            return OK;
        },
    };
}

function resetScreeps(options = {}) {
    Object.assign(global, constants);
    global.Game = {
        time: options.time || 1,
        rooms: options.rooms || {},
        creeps: options.creeps || {},
        spawns: options.spawns || {},
        flags: options.flags || {},
        objects: {},
        notifications: [],
        player: options.player || { username: 'Me' },
        cpu: options.cpu || { bucket: 9000, getUsed: () => 0 },
        market: makeMarket(options.market || {}),
        map: options.map || {
            getRoomLinearDistance(first, second) {
                if (first === second) return 0;
                const parse = name => {
                    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
                    if (!match) return null;
                    return {
                        x: (match[1] === 'W' ? -1 : 1) * Number(match[2]),
                        y: (match[3] === 'S' ? -1 : 1) * Number(match[4]),
                    };
                };
                const a = parse(first);
                const b = parse(second);
                return a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) : 1;
            },
        },
        getObjectById(id) {
            const object = this.objects[id];
            if (!object || object.destroyed) return null;
            if (object.roomName && !this.rooms[object.roomName]) return null;
            return object;
        },
        notify(message) {
            this.notifications.push(message);
        },
    };
    global.Memory = {};
    global.RoomPosition = MockRoomPosition;
    global.COMMODITIES = options.commodities || {
        [RESOURCE_BATTERY]: { amount: 100, cooldown: 10, components: { [RESOURCE_ENERGY]: 500 } },
        [RESOURCE_COMPOSITE]: { amount: 20, cooldown: 20, components: { [RESOURCE_HYDROGEN]: 50, [RESOURCE_OXYGEN]: 50 } },
        [RESOURCE_OXIDANT]: { amount: 10, cooldown: 60, level: 2, components: { [RESOURCE_COMPOSITE]: 20, [RESOURCE_ENERGY]: 100 } },
    };
    MainCache.initRound([]);
    const info = require('../../main.info');
    info.log = () => {};
    info.warning = () => {};
    info.error = () => {};
    return Game;
}

function registerObject(object, roomName) {
    if (roomName) object.roomName = roomName;
    Game.objects[object.id] = object;
    return object;
}

module.exports = {
    constants,
    makeStore,
    makeRoom,
    makeStructure,
    makeTerminal,
    makeFactory,
    makeLab,
    makeMarket,
    makeCreep,
    makeSpawn,
    makePosition,
    setFind,
    resetScreeps,
    registerObject,
};
