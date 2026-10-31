var MainUtil = require('./main.util');
var MainCache = require('./main.cache');
var info = require('./main.info');
var TerminalManager = require('./manager.terminal');
var config = require('./main.config').LOGISTICS;
var economy = require('./main.config').ECONOMY;
var constants = require('./main.constants');
var EconomyManager = require('./manager.economy');

const PRIORITY = config.PRIORITY;
const TASK_CAP = 100;
const KIND_SUPPLY = 'supply';
const KIND_COLLECT = 'collect';
const KIND_ROUTE = 'route';

class LogisticsManager {

    static runAll() {
        MainUtil.findAllRooms().forEach(room => {
            if (!room.memory.base) return;
            try {
                new LogisticsManager(room).run();
            } catch (error) {
                info.error('Could not run logistics for ' + room.name + ': ' + error, room);
                console.log(error.stack);
            }
        });
    }

    constructor(room) {
        this._room = room;
        this._memory = this._fetchMemory();
    }

    _fetchMemory() {
        if (!this._room.memory.logistics) {
            this._room.memory.logistics = { tasks: [], overflow: 0 };
        }
        var memory = this._room.memory.logistics;
        if (!Array.isArray(memory.tasks)) memory.tasks = [];
        memory.version = 2;
        memory.overflow = memory.overflow || 0;
        return memory;
    }

    run() {
        this._normalizeTasks();
        this._reconcileClaims();
        this._cleanupAndRefreshTasks();
        this._generateRequests();
    }

    _normalizeTasks() {
        var tasksById = new Map();
        this._memory.tasks.forEach(task => {
            task.kind = task.kind || (task.standing ? KIND_ROUTE : KIND_SUPPLY);
            task.resourceType = task.resourceType || RESOURCE_ENERGY;
            task.amount = Math.max(0, Number(task.amount) || 0);
            task.remaining = Math.max(0, Number(task.remaining === undefined ? task.amount : task.remaining) || 0);
            task.priority = Number(task.priority) || 0;
            task.created = task.created === undefined ? Game.time : task.created;
            task.updated = task.updated || task.created;
            task.lastProgress = task.lastProgress || task.created;
            task.retryAfter = task.retryAfter || 0;
            task.state = task.state || 'open';
            task.assignedCreep = task.assignedCreep || null;
            task.sourceRoomName = task.sourceRoomName || this._room.name;
            task.targetRoomName = task.targetRoomName || this._room.name;
            task.standing = !!task.standing;

            var oldId = task.id;
            task.id = this._getTaskId(task);
            if (task.assignedCreep && Game.creeps[task.assignedCreep] && oldId !== task.id) {
                Game.creeps[task.assignedCreep].memory.taskId = task.id;
            }
            if (!tasksById.has(task.id)) {
                tasksById.set(task.id, task);
                return;
            }

            var existing = tasksById.get(task.id);
            existing.remaining = Math.max(existing.remaining, task.remaining);
            existing.amount = Math.max(existing.amount, task.amount);
            existing.priority = Math.max(existing.priority, task.priority);
            existing.created = Math.min(existing.created, task.created);
            if (!existing.assignedCreep && task.assignedCreep) {
                existing.assignedCreep = task.assignedCreep;
                if (Game.creeps[task.assignedCreep]) Game.creeps[task.assignedCreep].memory.taskId = existing.id;
            }
        });
        this._memory.tasks = Array.from(tasksById.values());
    }

    _getTaskId(task) {
        return [this._room.name, task.sourceId, task.targetId, task.resourceType].join(':');
    }

    _updateTaskId(task) {
        task.id = this._getTaskId(task);
        var creep = task.assignedCreep && Game.creeps[task.assignedCreep];
        if (creep) creep.memory.taskId = task.id;
    }

    _reconcileClaims() {
        this._memory.tasks.slice().forEach(task => {
            if (!task.assignedCreep) return;
            var creep = Game.creeps[task.assignedCreep];
            if (creep && Game.time - task.lastProgress >= config.CLAIM_TIMEOUT) {
                // whatever kept this hauler from the task, another may be able to do it
                task.assignedCreep = null;
                task.claimedAmount = 0;
                task.retryAfter = Game.time + config.RETRY_TICKS;
                delete creep.memory.taskId;
                return;
            }
            if (!creep) {
                task.assignedCreep = null;
                task.claimedAmount = 0;
                return;
            }

            var state = creep.memory.logistics || {};
            var currentCargo = creep.store.getUsedCapacity(task.resourceType) || 0;
            var previousCargo = typeof state.lastCargo === 'number' ? state.lastCargo : currentCargo;

            if (currentCargo < previousCargo) {
                var delivered = previousCargo - currentCargo;
                task.remaining = Math.max(0, task.remaining - delivered);
                task.lastProgress = Game.time;
            } else if (currentCargo > previousCargo) {
                task.lastProgress = Game.time;
            }

            if (currentCargo > 0 && task.remaining <= 0) {
                task.assignedCreep = null;
                delete creep.memory.taskId;
            } else if (currentCargo === 0 && state.phase === 'deliver' && previousCargo > 0) {
                task.assignedCreep = null;
                delete creep.memory.taskId;
                if (task.remaining <= 0 && !task.standing) this._removeTask(task.id);
            }

            state.phase = currentCargo > 0 ? 'deliver' : 'pickup';
            state.lastCargo = currentCargo;
            creep.memory.logistics = state;
        });
    }

    _cleanupAndRefreshTasks() {
        this._memory.tasks.slice().forEach(task => {
            if (!task.assignedCreep && task.remaining <= 0 && !task.standing) {
                this._removeTask(task.id);
                return;
            }
            this._refreshEndpoint(task, 'source');
            if (!this._memory.tasks.includes(task)) return;
            this._refreshEndpoint(task, 'target');
            if (!this._memory.tasks.includes(task)) return;
            if (!task.assignedCreep) this._refreshRemaining(task);
        });
    }

    _refreshEndpoint(task, endpoint) {
        var idKey = endpoint + 'Id';
        var roomKey = endpoint + 'RoomName';
        var roomName = task[roomKey] || this._room.name;
        var object = Game.getObjectById(task[idKey]);
        if (object) return;
        if (!Game.rooms[roomName]) {
            task.state = 'unavailable';
            return;
        }

        if (endpoint === 'target' && task.kind === KIND_COLLECT) {
            var sourceObject = Game.getObjectById(task.sourceId) || { id: task.sourceId };
            var hub = this._findNearestRefillTarget(sourceObject, task.resourceType);
            if (hub) {
                task.targetId = hub.id;
                task.targetRoomName = hub.room ? hub.room.name : this._room.name;
                this._updateTaskId(task);
            } else {
                task.state = 'unavailable';
            }
            return;
        }

        if (endpoint === 'source' && task.kind === KIND_SUPPLY) {
            var target = Game.getObjectById(task.targetId);
            var source = this._findBestResourceSourceFor(target, task.resourceType);
            if (source) {
                task.sourceId = source.id;
                task.sourceRoomName = source.room ? source.room.name : this._room.name;
                this._updateTaskId(task);
            } else {
                task.state = 'unavailable';
            }
            return;
        }

        if (task.standing) {
            task.state = 'unavailable';
            return;
        }

        if (task.assignedCreep && Game.creeps[task.assignedCreep]) {
            delete Game.creeps[task.assignedCreep].memory.taskId;
            task.assignedCreep = null;
        }
        this._removeTask(task.id);
    }

    _refreshRemaining(task) {
        var source = Game.getObjectById(task.sourceId);
        var target = Game.getObjectById(task.targetId);
        var sourceAmount = LogisticsManager.getResourceAmount(source, task.resourceType);
        var targetFree = LogisticsManager.getTargetFree(target, task.resourceType);

        if (task.kind === KIND_COLLECT) {
            if (source && sourceAmount <= 0) {
                this._removeTask(task.id);
                return;
            }
            task.remaining = Math.min(sourceAmount, targetFree);
            task.amount = task.remaining;
        } else if (task.kind === KIND_SUPPLY) {
            if (target && targetFree <= 0) {
                this._removeTask(task.id);
                return;
            }
            task.remaining = Math.min(task.remaining, targetFree);
            if (task.remaining <= 0) {
                this._removeTask(task.id);
                return;
            }
            var bestSource = this._findBestResourceSourceFor(target, task.resourceType);
            if (bestSource) {
                task.sourceId = bestSource.id;
                task.sourceRoomName = bestSource.room ? bestSource.room.name : this._room.name;
                task.id = this._getTaskId(task);
            }
        } else {
            if (task.remaining <= 0) {
                task.amount = Math.min(sourceAmount, targetFree);
                task.remaining = task.amount;
            } else if (sourceAmount > 0 && targetFree > 0) {
                task.remaining = Math.min(task.remaining, targetFree);
            }
        }

        if (task.labInput && target && task.resourceType !== RESOURCE_ENERGY) {
            var labMemory = MainUtil.fetchMemoryOfStructure(target);
            var expectedResource = labMemory.inputResourceType || labMemory.resourceType;
            if (expectedResource !== task.resourceType) {
                this._removeTask(task.id);
                return;
            }
            var targetAmount = labMemory.targetAmount === undefined ? config.LAB_INPUT_DEFAULT : Math.max(0, Number(labMemory.targetAmount) || 0);
            var deficit = Math.max(0, targetAmount - target.store.getUsedCapacity(task.resourceType));
            task.remaining = Math.min(task.remaining, deficit);
            if (task.remaining <= 0) {
                this._removeTask(task.id);
                return;
            }
        }
        if ((task.factoryInput || task.labInput) && task.resourceType === RESOURCE_ENERGY) {
            task.remaining = Math.min(task.remaining, TerminalManager.getAvailable(this._room, RESOURCE_ENERGY));
        }
        task.state = task.remaining > 0 && source && target && sourceAmount > 0 && targetFree > 0 ? 'open' : 'unavailable';
    }

    _generateRequests() {
        if (this._room.memory.source && this._room.memory.target) {
            this._createTask(this._room.memory.source, this._room.memory.target, RESOURCE_OXYGEN, 0, PRIORITY.LEGACY_ROUTE, KIND_ROUTE, true);
        }

        var coreStructures = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => (structure.structureType == STRUCTURE_SPAWN || structure.structureType == STRUCTURE_EXTENSION) &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });
        coreStructures.forEach(target => this._createSupplyTask(target, RESOURCE_ENERGY, PRIORITY.CORE));

        var hostiles = MainCache.find(this._room, FIND_HOSTILE_CREEPS);
        var towerPriority = hostiles.length > 0 ? PRIORITY.TOWER_UNDER_ATTACK : PRIORITY.TOWER;
        var towers = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType == STRUCTURE_TOWER && structure.store.getFreeCapacity(RESOURCE_ENERGY) >= config.TOWER_REFILL_FREE
        });
        towers.forEach(target => this._createSupplyTask(target, RESOURCE_ENERGY, towerPriority));

        // links beside a source are filled by Miners; hauling stored energy to them would only loop it back
        var energySources = MainCache.find(this._room, FIND_SOURCES);
        var sourceLinks = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType == STRUCTURE_LINK && MainUtil.fetchMemoryOfStructure(structure).type == constants.LINK_TYPE_SOURCE &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0 &&
                !energySources.some(source => structure.pos.inRangeTo(source.pos, economy.SOURCE_DROP_RANGE))
        });
        sourceLinks.forEach(target => this._createSupplyTask(target, RESOURCE_ENERGY, PRIORITY.HUB_LINK));

        // what the sources send arrives here, and it only reaches the room if someone carries it on
        var hubLink = EconomyManager.getHubLink(this._room);
        if (hubLink && hubLink.store.getUsedCapacity(RESOURCE_ENERGY) >= config.LINK_COLLECT_MIN) {
            this._createCollectionTask(hubLink, RESOURCE_ENERGY, PRIORITY.HUB_LINK);
        }

        var labs = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType == STRUCTURE_LAB
        });
        labs.forEach(lab => {
            var memory = MainUtil.fetchMemoryOfStructure(lab);
            // a required spawn is waiting on this lab, for its compound and its energy alike
            var boosting = memory.labRole === 'boost';
            var energyFree = lab.store.getFreeCapacity(RESOURCE_ENERGY);
            if (energyFree >= config.LAB_REFILL_FREE) this._createLabSupplyTask(lab, RESOURCE_ENERGY, boosting ? PRIORITY.LAB_BOOST : PRIORITY.LAB_ENERGY, energyFree);
            var inputResource = memory.inputResourceType || memory.resourceType;
            var targetAmount = memory.targetAmount === undefined ? config.LAB_INPUT_DEFAULT : Math.max(0, Number(memory.targetAmount) || 0);
            var inputMissing = inputResource ? targetAmount - lab.store.getUsedCapacity(inputResource) : 0;
            if (inputResource && inputMissing > 0 && (!lab.mineralType || lab.mineralType === inputResource)) {
                this._createLabSupplyTask(lab, inputResource, boosting ? PRIORITY.LAB_BOOST : PRIORITY.LAB_INPUT, inputMissing);
            }
            if (memory.outputResourceType && LogisticsManager.getResourceAmount(lab, memory.outputResourceType) > 0) {
                this._createCollectionTask(lab, memory.outputResourceType, PRIORITY.LAB_OUTPUT);
            }
        });

        var containers = MainCache.find(this._room, FIND_STRUCTURES, {
            filter: structure => structure.structureType == STRUCTURE_CONTAINER && structure.store.getUsedCapacity() > 0
        });
        containers.forEach(container => {
            Object.keys(container.store).forEach(resourceType => {
                var amount = container.store.getUsedCapacity(resourceType);
                if (amount >= config.CONTAINER_COLLECT_MIN || container.store.getFreeCapacity(resourceType) === 0) {
                    this._createCollectionTask(container, resourceType, PRIORITY.CONTAINER);
                }
            });
        });

        var droppedResources = MainCache.find(this._room, FIND_DROPPED_RESOURCES, {
            filter: resource => resource.amount >= config.DROPPED_COLLECT_MIN
        });
        droppedResources.forEach(resource => this._createCollectionTask(resource, resource.resourceType, PRIORITY.DROPPED));

        var salvage = MainCache.find(this._room, FIND_TOMBSTONES).concat(MainCache.find(this._room, FIND_RUINS));
        salvage.forEach(object => {
            Object.keys(object.store).forEach(resourceType => {
                if (object.store.getUsedCapacity(resourceType) > 0) this._createCollectionTask(object, resourceType, PRIORITY.SALVAGE);
            });
        });

        var factories = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType == STRUCTURE_FACTORY
        });
        this._generateFactoryTasks(factories);

        this._generateStockBalancingTasks();
        this._generateTerminalPositioningTasks();
    }

    _generateFactoryTasks(factories) {
        factories.forEach(factory => {
            var memory = MainUtil.fetchMemoryOfStructure(factory);
            var inputs = Object.assign({}, memory.inputResources || {});
            if (memory.inputResourceType && inputs[memory.inputResourceType] === undefined) {
                inputs[memory.inputResourceType] = memory.targetAmount || config.LAB_INPUT_DEFAULT;
            }
            if (Array.isArray(memory.inputResourceTypes)) {
                memory.inputResourceTypes.forEach(resourceType => {
                    if (inputs[resourceType] === undefined) inputs[resourceType] = memory.targetAmount || config.LAB_INPUT_DEFAULT;
                });
            }
            Object.keys(inputs).sort().forEach(resourceType => {
                var required = Math.max(0, Number(inputs[resourceType]) || 0);
                var missing = required - factory.store.getUsedCapacity(resourceType);
                if (missing > 0) this._createFactorySupplyTask(factory, resourceType, missing);
            });

            var outputs = new Set();
            if (memory.outputResourceType) outputs.add(memory.outputResourceType);
            if (memory.activeRecipe) outputs.add(memory.activeRecipe);
            if (Array.isArray(memory.outputResources)) memory.outputResources.forEach(resourceType => outputs.add(resourceType));
            else if (memory.outputResources && typeof memory.outputResources === 'object') {
                Object.keys(memory.outputResources).forEach(resourceType => outputs.add(resourceType));
            }
            outputs.forEach(resourceType => {
                if (factory.store.getUsedCapacity(resourceType) > 0) this._createCollectionTask(factory, resourceType, PRIORITY.FACTORY);
            });
        });
    }

    _createFactorySupplyTask(factory, resourceType, amount) {
        var source = this._findBestResourceSourceFor(factory, resourceType);
        if (!source) return null;
        amount = Math.min(amount, factory.store.getFreeCapacity(resourceType));
        if (resourceType === RESOURCE_ENERGY) {
            amount = Math.min(amount, TerminalManager.getAvailable(this._room, RESOURCE_ENERGY));
        }
        if (amount <= 0) return null;
        var task = this._createTask(source.id, factory.id, resourceType, amount, PRIORITY.FACTORY, KIND_SUPPLY);
        if (task) task.factoryInput = true;
        return task;
    }

    _generateStockBalancingTasks() {
        var policy = this._memory.stockPolicy || {};
        Object.keys(policy).forEach(resourceType => {
            var rule = policy[resourceType];
            var hubs = [this._room.storage, this._room.terminal].filter(hub => !!hub);
            var source = hubs.find(hub => hub.store.getUsedCapacity(resourceType) > rule.max);
            var target = hubs.find(hub => source && hub.id !== source.id && hub.store.getUsedCapacity(resourceType) < rule.min);
            if (source && target) this._createTask(source.id, target.id, resourceType, source.store.getUsedCapacity(resourceType) - rule.max, PRIORITY.STOCK_POLICY, KIND_SUPPLY);
        });
    }

    _generateTerminalPositioningTasks() {
        var policy = this._memory.terminalStockPolicy || {};
        var manualPolicy = this._memory.stockPolicy || {};
        var storage = this._room.storage;
        var terminal = this._room.terminal;
        if (!storage || !terminal) return;
        Object.keys(policy).sort().forEach(resourceType => {
            if (Object.prototype.hasOwnProperty.call(manualPolicy, resourceType)) return;
            var rule = policy[resourceType] || {};
            var minimum = Math.max(0, Number(rule.min) || 0);
            var maximum = Math.max(minimum, Number(rule.max) || 0);
            var priority = Math.max(0, Number(rule.priority) || 40);
            var terminalAmount = terminal.store.getUsedCapacity(resourceType);
            var storageAmount = storage.store.getUsedCapacity(resourceType);
            if (terminalAmount < minimum && storageAmount > 0) {
                var inbound = Math.min(minimum - terminalAmount, storageAmount, terminal.store.getFreeCapacity(resourceType));
                if (inbound > 0) this._createTask(storage.id, terminal.id, resourceType, inbound, priority, KIND_SUPPLY);
            }
            if (terminalAmount > maximum && storage.store.getFreeCapacity(resourceType) > 0) {
                var outbound = Math.min(terminalAmount - maximum, storage.store.getFreeCapacity(resourceType));
                if (outbound > 0) this._createTask(terminal.id, storage.id, resourceType, outbound, priority, KIND_SUPPLY);
            }
        });
    }

    _createSupplyTask(target, resourceType, priority, amount) {
        if (amount === undefined) amount = target.store.getFreeCapacity(resourceType);
        amount = Math.min(Math.max(0, Number(amount) || 0), LogisticsManager.getTargetFree(target, resourceType));
        if (amount <= 0) return null;
        var source = this._findBestResourceSourceFor(target, resourceType);
        if (!source) return null;
        return this._createTask(source.id, target.id, resourceType, amount, priority, KIND_SUPPLY);
    }

    _createLabSupplyTask(lab, resourceType, priority, amount) {
        if (resourceType === RESOURCE_ENERGY) {
            amount = Math.min(amount, TerminalManager.getAvailable(this._room, RESOURCE_ENERGY));
        }
        var task = this._createSupplyTask(lab, resourceType, priority, amount);
        if (task) task.labInput = true;
        return task;
    }

    _createCollectionTask(source, resourceType, priority, amount) {
        var target = this._findNearestRefillTarget(source, resourceType);
        if (!target || target.id === source.id) return null;
        if (amount === undefined) amount = LogisticsManager.getResourceAmount(source, resourceType);
        amount = Math.max(0, Number(amount) || 0);
        if (amount <= 0) return null;
        return this._createTask(source.id, target.id, resourceType, amount, priority, KIND_COLLECT);
    }

    _createTask(sourceId, targetId, resourceType, amount, priority, kind = KIND_SUPPLY, standing = false) {
        if (!sourceId || !targetId || sourceId === targetId) return null;
        var draft = { sourceId, targetId, resourceType, kind };
        var id = this._getTaskId(draft);
        var existing = this._memory.tasks.find(task => task.id === id);
        if (existing) {
            existing.priority = Math.max(existing.priority, priority);
            if (!existing.assignedCreep && !existing.standing) {
                existing.amount = Math.max(existing.amount, amount);
                existing.remaining = Math.max(existing.remaining, amount);
                existing.updated = Game.time;
                existing.state = 'open';
            }
            return existing;
        }

        if (this._memory.tasks.length >= TASK_CAP) {
            var candidate = this._memory.tasks.filter(task => !task.assignedCreep)
                .sort((a, b) => a.priority - b.priority || a.created - b.created)[0];
            if (candidate && candidate.priority < priority) {
                this._removeTask(candidate.id);
            } else {
                this._memory.overflow++;
                return null;
            }
        }

        var task = {
            id,
            sourceId,
            targetId,
            sourceRoomName: this._room.name,
            targetRoomName: this._room.name,
            resourceType,
            kind,
            amount,
            remaining: amount,
            priority,
            assignedCreep: null,
            claimedAmount: 0,
            created: Game.time,
            updated: Game.time,
            lastProgress: Game.time,
            retryAfter: 0,
            state: 'open',
            standing,
        };
        this._memory.tasks.push(task);
        return task;
    }

    _findBestResourceSourceFor(target, resourceType) {
        var candidates = MainCache.find(this._room, FIND_STRUCTURES, {
            filter: structure => {
                if (structure.structureType != STRUCTURE_STORAGE && structure.structureType != STRUCTURE_CONTAINER && structure.structureType != STRUCTURE_TERMINAL) return false;
                if (target && structure.id === target.id) return false;
                return LogisticsManager.getResourceAmount(structure, resourceType) > 0;
            }
        });
        candidates.sort((a, b) => {
            if (!target || !target.pos) return 0;
            return target.pos.getRangeTo(a) - target.pos.getRangeTo(b);
        });
        return candidates[0] || null;
    }

    _findNearestRefillTarget(source, resourceType) {
        var hubs = [this._room.storage, this._room.terminal].filter(hub => {
            return hub && hub.id !== source.id && hub.store.getFreeCapacity(resourceType) > 0;
        });
        if (hubs.length > 0) return hubs[0];

        if (resourceType !== RESOURCE_ENERGY) return null;
        var targets = MainCache.find(this._room, FIND_MY_STRUCTURES, {
            filter: structure => (structure.structureType == STRUCTURE_SPAWN ||
                structure.structureType == STRUCTURE_EXTENSION || structure.structureType == STRUCTURE_TOWER) &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });
        if (source.pos && source.pos.getRangeTo) {
            targets.sort((a, b) => source.pos.getRangeTo(a) - source.pos.getRangeTo(b));
        }
        return targets[0] || null;
    }

    _removeTask(taskId) {
        this._memory.tasks = this._memory.tasks.filter(task => task.id !== taskId);
    }

    static getResourceAmount(object, resourceType) {
        if (!object) return 0;
        if (object.amount !== undefined) return object.resourceType === resourceType ? object.amount : 0;
        if (object.store) {
            var amount = object.store.getUsedCapacity(resourceType) || 0;
            if (object.structureType === STRUCTURE_LAB && object.mineralType === resourceType && object.memory) {
                amount = Math.max(0, amount - (object.memory.reservedBoostAmount || 0));
            }
            return amount;
        }
        if (object.energy !== undefined && resourceType === RESOURCE_ENERGY) return object.energy;
        if (object.mineralAmount !== undefined && object.mineralType === resourceType) return object.mineralAmount;
        return 0;
    }

    static getTargetFree(target, resourceType) {
        if (!target || !target.store) return 0;
        if (target.structureType === STRUCTURE_LAB && resourceType !== RESOURCE_ENERGY &&
            target.mineralType && target.mineralType !== resourceType) return 0;
        return target.store.getFreeCapacity(resourceType) || 0;
    }

    static hasEligibleWork(room, options = {}) {
        if (!room.memory.logistics || !Array.isArray(room.memory.logistics.tasks)) return false;
        return room.memory.logistics.tasks.some(task => {
            if (task.assignedCreep || task.remaining <= 0 || task.state !== 'open' || task.retryAfter > Game.time) return false;
            return !options.resourceType || task.resourceType === options.resourceType;
        });
    }

    /*
     * What the logistics queue has already promised this tick, so that creeps working on their
     * own do not walk to the same extension or pile as a hauler that is on its way.
     */

    static getClaims(room) {
        return MainCache.memo('claims:' + room.name, () => {
            var claims = { targets: new Set(), pickups: new Set() };
            var tasks = room.memory.logistics && Array.isArray(room.memory.logistics.tasks) ? room.memory.logistics.tasks : [];
            tasks.forEach(task => {
                if (!task.assignedCreep) return;
                if (task.kind === KIND_COLLECT) claims.pickups.add(task.sourceId);
                else claims.targets.add(task.targetId);
            });
            return claims;
        });
    }

    /*
     * Cargo on its way to a target, which is in neither the source's store nor the target's yet.
     */

    static getInboundAmount(room, targetId, resourceType) {
        var tasks = room.memory.logistics && Array.isArray(room.memory.logistics.tasks) ? room.memory.logistics.tasks : [];
        return tasks.reduce((amount, task) => {
            if (task.targetId !== targetId || task.resourceType !== resourceType || !task.assignedCreep) return amount;
            var creep = Game.creeps[task.assignedCreep];
            return amount + (creep ? creep.store.getUsedCapacity(resourceType) : 0);
        }, 0);
    }

    static isDeliveryClaimed(room, targetId) {
        var tasks = room.memory.logistics && Array.isArray(room.memory.logistics.tasks) ? room.memory.logistics.tasks : [];
        return tasks.some(task => task.targetId === targetId && !!task.assignedCreep && task.kind !== KIND_COLLECT);
    }

    /*
     * A hauler loading for one extension at a time walks back for every 50 energy, and a room that
     * spawns often never gets past refilling them to collect from its containers. So it loads for
     * all the energy deliveries waiting and hands it out target by target. Lab and factory energy
     * stay exact, because those amounts are what keeps them out of the emergency reserve.
     * What other haulers already carry beyond their own task is on its way to those same targets.
     */

    static getPickupAmount(room, task) {
        if (!this._canShareLoad(room, task)) return task.remaining;
        var waiting = task.remaining;
        var spareElsewhere = 0;
        room.memory.logistics.tasks.forEach(other => {
            if (other === task || !this._canShareLoad(room, other)) return;
            if (other.assignedCreep) spareElsewhere += this._getSpareLoad(other);
            else if (other.state === 'open' && other.retryAfter <= Game.time) waiting += other.remaining;
        });
        return Math.max(task.remaining, waiting - spareElsewhere);
    }

    // a withdrawal only shows in the creep's store next tick, so the claim covers the tick it happens
    static _getSpareLoad(task) {
        var creep = Game.creeps[task.assignedCreep];
        var cargo = creep ? creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0 : 0;
        return Math.max(0, Math.max(cargo, task.claimedAmount || 0) - task.remaining);
    }

    static _canShareLoad(room, task) {
        if (task.kind !== KIND_SUPPLY || task.resourceType !== RESOURCE_ENERGY || task.labInput || task.factoryInput) return false;
        return !(room.storage && task.targetId === room.storage.id) && !(room.terminal && task.targetId === room.terminal.id);
    }

    /*
     * Whether a hauler is here to serve the queue. Until there is one, creeps loot for themselves.
     */

    static hasWorkers(room) {
        return MainCache.memo('workers:' + room.name, () => MainCache.getCreeps().some(creep => {
            return !creep.spawning && creep.room.name === room.name &&
                (creep.memory.role === 'Storekeeper' || creep.memory.role === 'Courier');
        }));
    }

    static getDesiredWorkerCount(room, roleName) {
        if (!room.memory.logistics || !Array.isArray(room.memory.logistics.tasks)) return 0;
        var options = roleName === 'Storekeeper' ? { resourceType: RESOURCE_ENERGY } : {};
        var available = room.memory.logistics.tasks.filter(task => {
            if (task.assignedCreep || task.remaining <= 0 || task.state !== 'open' || task.retryAfter > Game.time) return false;
            return !options.resourceType || task.resourceType === options.resourceType;
        }).length;
        if (available <= 0) return 0;
        if (roleName !== 'Storekeeper') return 1;
        // measured hauling need sets the fleet size; without it, match the work that is open
        if (EconomyManager.getHaulingCarryParts(room) > 0) {
            return EconomyManager.getDesiredStorekeepers(room, this._getStorekeeperCarryParts(room));
        }
        return Math.min(available, economy.WORKERS_FALLBACK);
    }

    static _getStorekeeperCarryParts(room) {
        var roleConfig = room.memory.base && room.memory.base.roleConfig || {};
        var pairCost = BODYPART_COST[MOVE] + BODYPART_COST[CARRY];
        var wanted = roleConfig.partsMaxMultiplier || EconomyManager.getStorekeeperCarryParts(room);
        return Math.max(1, Math.min(wanted, Math.floor(room.energyCapacityAvailable / pairCost)));
    }

    static assignTask(creep, options = {}) {
        if (!creep.room.memory.logistics) new LogisticsManager(creep.room);
        var tasks = creep.room.memory.logistics.tasks;

        if (creep.memory.taskId) {
            var existing = tasks.find(task => task.id === creep.memory.taskId);
            if (existing && existing.assignedCreep === creep.name) return existing;
            delete creep.memory.taskId;
        }

        var availableTasks = tasks.filter(task => {
            if (task.assignedCreep || task.remaining <= 0 || task.state !== 'open' || task.retryAfter > Game.time) return false;
            return !options.resourceType || task.resourceType === options.resourceType;
        });
        // a hauler already carrying the resource goes straight to the target, so that is the walk that counts
        var getDistance = task => {
            var isCarrying = (creep.store.getUsedCapacity(task.resourceType) || 0) > 0;
            var object = Game.getObjectById(isCarrying ? task.targetId : task.sourceId);
            return object ? creep.pos.getRangeTo(object) : 50;
        };
        availableTasks.sort((a, b) => {
            var priorityDifference = b.priority - a.priority;
            if (priorityDifference) return priorityDifference;
            return getDistance(a) - getDistance(b) || a.created - b.created || a.id.localeCompare(b.id);
        });
        if (availableTasks.length === 0) return null;

        var selectedTask = availableTasks[0];
        selectedTask.assignedCreep = creep.name;
        selectedTask.claimedAmount = 0;
        selectedTask.lastProgress = Game.time;
        var currentCargo = creep.store.getUsedCapacity(selectedTask.resourceType) || 0;
        creep.memory.taskId = selectedTask.id;
        creep.memory.logistics = {
            phase: currentCargo > 0 ? 'deliver' : 'pickup',
            lastCargo: currentCargo,
        };
        return selectedTask;
    }

    static releaseTask(room, taskId) {
        if (!room.memory.logistics) return;
        var task = room.memory.logistics.tasks.find(task => task.id === taskId);
        if (task) {
            task.assignedCreep = null;
            task.claimedAmount = 0;
        }
    }
}

LogisticsManager.KIND_SUPPLY = KIND_SUPPLY;
LogisticsManager.KIND_COLLECT = KIND_COLLECT;
LogisticsManager.KIND_ROUTE = KIND_ROUTE;
LogisticsManager.TASK_CAP = TASK_CAP;

module.exports = LogisticsManager;
