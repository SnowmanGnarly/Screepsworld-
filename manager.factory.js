var MainCache = require('./main.cache');
var MainUtil = require('./main.util');
var TerminalManager = require('./manager.terminal');
var info = require('./main.info');

class FactoryManager {

    static runAll() {
        MainUtil.findAllRooms().forEach(room => {
            if (!room.memory.base) return;
            try {
                new FactoryManager(room).run();
            } catch (error) {
                info.error('Could not run factory for ' + room.name + ': ' + error, room);
            }
        });
    }

    constructor(room) {
        this._room = room;
        this._config = FactoryManager.getConfig(room);
        this._goals = this._getConfiguredGoals();
        this._factories = MainCache.find(room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_FACTORY,
        }).slice().sort((a, b) => a.id.localeCompare(b.id));
    }

    static getConfig(room) {
        var defaults = {
            enabled: true,
            goals: {},
            batteryTarget: 0,
            batchSize: 1000,
            maxDepth: 4,
            maxGoals: 4,
            planningInterval: 10,
            requestExpiry: 1000,
            priority: 70,
        };
        var config = Object.assign(defaults, room.memory.factory || {});
        config.enabled = config.enabled !== false;
        config.batteryTarget = this._clamp(config.batteryTarget, 0, 1000000, 0);
        config.batchSize = this._clamp(config.batchSize, 1, 100000, 1000);
        config.maxDepth = this._clamp(config.maxDepth, 0, 8, 4);
        config.maxGoals = this._clamp(config.maxGoals, 1, 16, 4);
        config.planningInterval = this._clamp(config.planningInterval, 1, 1000, 10);
        config.requestExpiry = this._clamp(config.requestExpiry, 1, 10000, 1000);
        config.priority = this._clamp(config.priority, 0, 1000, 70);
        config.goals = config.goals || config.targetStock || {};
        room.memory.factory = config;
        return config;
    }

    _getConfiguredGoals() {
        var goals = {};
        var configured = this._config.goals;
        if (Array.isArray(configured)) {
            configured.slice(0, FactoryManager.MAX_CONFIGURED_GOALS).forEach(entry => {
                if (!entry) return;
                var resourceType = entry.resourceType || entry.commodity || entry.resource;
                var target = entry.target === undefined ? entry.amount : entry.target;
                if (resourceType) goals[resourceType] = FactoryManager._clamp(target, 0, 1000000, 0);
            });
        } else if (configured && typeof configured === 'object') {
            Object.keys(configured).slice(0, FactoryManager.MAX_CONFIGURED_GOALS).forEach(resourceType => {
                var value = configured[resourceType];
                var target = value && typeof value === 'object' ? (value.target === undefined ? value.amount : value.target) : value;
                goals[resourceType] = FactoryManager._clamp(target, 0, 1000000, 0);
            });
        }
        if (this._config.batteryTarget > 0 && goals[RESOURCE_BATTERY] === undefined) {
            goals[RESOURCE_BATTERY] = this._config.batteryTarget;
        }
        Object.keys(goals).forEach(resourceType => {
            if (goals[resourceType] <= 0) delete goals[resourceType];
        });
        return goals;
    }

    run() {
        var assigned = new Set();
        this._factories.forEach(factory => {
            var memory = MainUtil.fetchMemoryOfStructure(factory);
            if (memory.activeGoal && memory.managed) assigned.add(memory.activeGoal.resourceType);
        });
        this._factories.forEach(factory => {
            var memory = MainUtil.fetchMemoryOfStructure(factory);
            if (memory.cancelRequested) {
                FactoryManager.cancelGoal(factory, 'explicit cancellation');
                delete memory.cancelRequested;
            }
            if (!this._config.enabled) {
                if (memory.activeGoal && memory.managed) this._cancelGoal(factory, memory, 'factory disabled');
                return;
            }
            if (memory.activeGoal && memory.managed && this._goals[memory.activeGoal.resourceType] === undefined) {
                this._cancelGoal(factory, memory, 'goal removed');
            }
            if (memory.activeGoal && memory.managed && this._isConfiguredGoalSatisfied(memory.activeGoal.resourceType)) {
                this._completeGoal(factory, memory);
            }
            if (memory.activeGoal && memory.managed) {
                if (Game.time >= (memory.nextPlanningAt || 0)) this._updateRequests(factory, memory, memory.activeGoal);
                this._updateActiveMetadata(factory, memory, memory.activeGoal);
                this._produceActive(factory, memory);
                return;
            }
            if (assigned.size >= this._config.maxGoals || Game.time < (memory.nextPlanningAt || 0)) return;
            var resourceType = this._selectGoal(assigned);
            if (!resourceType) return;
            if (this._startGoal(factory, memory, resourceType)) {
                assigned.add(resourceType);
                this._produceActive(factory, memory);
            }
        });
    }

    _selectGoal(assigned) {
        return Object.keys(this._goals).sort().find(resourceType => {
            return !assigned.has(resourceType) && FactoryManager._getRoomStock(this._room, resourceType) < this._goals[resourceType] &&
                !!FactoryManager.getRecipe(resourceType);
        }) || null;
    }

    _isConfiguredGoalSatisfied(resourceType) {
        return this._goals[resourceType] !== undefined && FactoryManager._getRoomStock(this._room, resourceType) >= this._goals[resourceType];
    }

    _startGoal(factory, memory, resourceType) {
        var missing = Math.min(this._config.batchSize, this._goals[resourceType] - FactoryManager._getRoomStock(this._room, resourceType));
        if (missing <= 0) return false;
        var plan = FactoryManager.planRecipe(this._room, factory, resourceType, missing, {
            maxDepth: this._config.maxDepth,
        });
        if (plan.invalid.length > 0 || plan.steps.length === 0) {
            memory.planningError = plan.invalid[0] || 'no recipe';
            memory.nextPlanningAt = Game.time + this._config.planningInterval;
            return false;
        }
        var rootStep = plan.steps[plan.steps.length - 1];
        var goal = {
            resourceType: resourceType,
            target: rootStep.amount,
            produced: 0,
            pending: rootStep.amount,
            steps: plan.steps,
            stepIndex: 0,
            imports: plan.imports,
            requestIds: [],
            sharedRequestIds: [],
            completedImports: {},
            pendingComponents: {},
            startedAt: Game.time,
            updated: Game.time,
        };
        memory.activeGoal = goal;
        memory.activeRecipe = goal.steps[0].resourceType;
        memory.managed = true;
        memory.planningError = null;
        memory.nextPlanningAt = 0;
        memory.outputResources = memory.outputResources || {};
        if (memory.outputResourceType) memory.outputResources[memory.outputResourceType] = true;
        goal.steps.forEach(step => memory.outputResources[step.resourceType] = true);
        this._updateRequests(factory, memory, goal);
        this._updateActiveMetadata(factory, memory, goal);
        return true;
    }

    static planRecipe(room, factory, resourceType, amount, options = {}) {
        var plan = {
            resourceType: resourceType,
            requestedAmount: amount,
            steps: [],
            imports: {},
            invalid: [],
        };
        var available = this._getStockMap(room);
        var maxDepth = this._clamp(options.maxDepth, 0, 8, 4);
        var visit = (resource, requiredAmount, depth, path) => {
            var recipe = this.getRecipe(resource);
            if (!recipe) {
                plan.invalid.push('missing recipe:' + resource);
                return;
            }
            if (path.has(resource)) {
                plan.invalid.push('cycle:' + resource);
                return;
            }
            if (plan.steps.length >= FactoryManager.MAX_DEPENDENCY_STEPS) {
                plan.invalid.push('goal limit:' + resource);
                return;
            }
            var cycles = Math.ceil(requiredAmount / recipe.amount);
            if (cycles <= 0) return;
            var nextPath = new Set(path);
            nextPath.add(resource);
            Object.keys(recipe.components).sort().forEach(component => {
                var required = cycles * recipe.components[component];
                var used = Math.min(required, available[component] || 0);
                available[component] = (available[component] || 0) - used;
                var needed = required - used;
                if (needed <= 0) return;
                var componentRecipe = this.getRecipe(component);
                if (!componentRecipe) {
                    plan.imports[component] = (plan.imports[component] || 0) + needed;
                    return;
                }
                if (nextPath.has(component)) {
                    plan.invalid.push('cycle:' + component);
                    return;
                }
                var levelEligible = (factory.level || 0) >= (componentRecipe.level || 0);
                if (depth < maxDepth && levelEligible) visit(component, needed, depth + 1, nextPath);
                else plan.imports[component] = (plan.imports[component] || 0) + needed;
            });
            plan.steps.push({
                resourceType: resource,
                amount: cycles * recipe.amount,
                cycles: cycles,
                produced: 0,
                cooldown: recipe.cooldown || 0,
                level: recipe.level || 0,
            });
        };
        visit(resourceType, amount, 0, new Set());
        return plan;
    }

    static getRecipe(resourceType) {
        if (typeof COMMODITIES === 'undefined' || !COMMODITIES[resourceType]) return null;
        var recipe = COMMODITIES[resourceType];
        if (!recipe || !recipe.components || !Number.isFinite(recipe.amount) || recipe.amount <= 0) return null;
        return recipe;
    }

    _updateRequests(factory, memory, goal) {
        goal.pendingComponents = {};
        Object.keys(goal.imports).sort().forEach(resourceType => {
            if (goal.completedImports[resourceType]) return;
            var required = goal.imports[resourceType];
            var requestAmount = resourceType === RESOURCE_ENERGY ? this._getEnergyImportAmount(factory.room, required) : required;
            if (requestAmount <= 0 || (resourceType !== RESOURCE_ENERGY && FactoryManager._getRoomStock(this._room, resourceType) >= required)) {
                goal.completedImports[resourceType] = true;
                return;
            }
            var id = 'factory:' + factory.id + ':' + resourceType;
            var request = TerminalManager.getResourceRequests({ targetRoom: this._room.name, resourceType: resourceType })
                .filter(candidate => candidate.id.indexOf('factory:') === 0)
                .sort((a, b) => a.id.localeCompare(b.id));
            var open = request.find(candidate => candidate.status === 'open');
            if (open) {
                goal.pendingComponents[resourceType] = open.remaining;
                if (open.id === id && !goal.requestIds.includes(id)) goal.requestIds.push(id);
                else if (open.id !== id && !goal.sharedRequestIds.includes(open.id)) goal.sharedRequestIds.push(open.id);
                if (open.id === id && open.expiresAt - Game.time < 100) {
                    TerminalManager.requestResource(this._room, resourceType, open.remaining, {
                        id: id,
                        priority: this._config.priority,
                        reason: 'factory:' + goal.resourceType,
                        expiry: this._config.requestExpiry,
                    });
                }
                return;
            }
            var completed = request.find(candidate => candidate.id === id && candidate.status === 'complete');
            if (completed) {
                goal.completedImports[resourceType] = true;
                return;
            }
            var created = TerminalManager.requestResource(this._room, resourceType, requestAmount, {
                id: id,
                priority: this._config.priority,
                reason: 'factory:' + goal.resourceType,
                expiry: this._config.requestExpiry,
            });
            if (created) {
                if (!goal.requestIds.includes(id)) goal.requestIds.push(id);
                goal.pendingComponents[resourceType] = created.remaining;
            }
            memory.nextPlanningAt = Game.time + this._config.planningInterval;
        });
        goal.updated = Game.time;
        memory.activeGoal = goal;
    }

    _getEnergyImportAmount(room, required) {
        var available = TerminalManager.getAvailable(room, RESOURCE_ENERGY);
        var reserve = TerminalManager.getReserve(room, RESOURCE_ENERGY);
        var total = TerminalManager.getTotalStock(room, RESOURCE_ENERGY);
        return Math.max(0, required - available) + Math.max(0, reserve - total);
    }

    _updateActiveMetadata(factory, memory, goal) {
        var step = goal.steps[goal.stepIndex];
        if (!step) return;
        var recipe = FactoryManager.getRecipe(step.resourceType);
        if (!recipe) return;
        var remainingCycles = Math.max(0, Math.ceil((step.amount - step.produced) / recipe.amount));
        var inputs = {};
        Object.keys(recipe.components).sort().forEach(component => {
            inputs[component] = remainingCycles * recipe.components[component];
        });
        memory.activeRecipe = step.resourceType;
        memory.outputResourceType = step.resourceType;
        memory.inputResources = inputs;
        memory.inputResourceType = Object.keys(inputs)[0] || null;
        var rootStep = goal.steps[goal.steps.length - 1];
        goal.produced = rootStep.produced;
        goal.pending = Math.max(0, goal.target - rootStep.produced);
        goal.updated = Game.time;
        memory.activeGoal = goal;
    }

    _produceActive(factory, memory) {
        var goal = memory.activeGoal;
        if (!goal || !this._config.enabled || memory.produceRetryAfter > Game.time) return;
        var step = goal.steps[goal.stepIndex];
        var recipe = step && FactoryManager.getRecipe(step.resourceType);
        if (!recipe || (factory.level || 0) < (recipe.level || 0) || factory.cooldown > 0) return;
        if (factory.store.getFreeCapacity(step.resourceType) < recipe.amount) return;
        var sufficient = Object.keys(recipe.components).every(component => {
            return factory.store.getUsedCapacity(component) >= recipe.components[component];
        });
        if (!sufficient) return;
        if (recipe.components[RESOURCE_ENERGY] &&
            this._getEnergyBudget(factory.room, factory) < recipe.components[RESOURCE_ENERGY]) return;
        var result = factory.produce(step.resourceType);
        if (result !== OK) {
            memory.produceRetryAfter = Game.time + Math.max(5, recipe.cooldown || 5);
            memory.lastProduceError = result;
            if (Game.time - (memory.lastProduceNotice || 0) >= 500) {
                memory.lastProduceNotice = Game.time;
                info.warning('Factory ' + factory.id + ' could not produce ' + step.resourceType + ': ' + result);
            }
            return;
        }
        memory.lastProducedAt = Game.time;
        memory.lastProduceError = null;
        step.produced += recipe.amount;
        if (step.produced >= step.amount) {
            if (goal.stepIndex === goal.steps.length - 1) {
                this._completeGoal(factory, memory);
                return;
            }
            goal.stepIndex++;
        }
        this._updateActiveMetadata(factory, memory, goal);
    }

    _getEnergyBudget(room, factory) {
        return TerminalManager.getTotalStock(room, RESOURCE_ENERGY) - TerminalManager.getReserve(room, RESOURCE_ENERGY) -
            TerminalManager.getReservedEnergy(room.name) + factory.store.getUsedCapacity(RESOURCE_ENERGY);
    }

    _completeGoal(factory, memory) {
        var goal = memory.activeGoal;
        if (!goal) return;
        this._cancelRequests(goal);
        memory.lastCompletedGoal = {
            resourceType: goal.resourceType,
            target: goal.target,
            produced: goal.steps[goal.steps.length - 1].produced,
            completedAt: Game.time,
        };
        memory.outputResourceType = goal.resourceType;
        this._clearActiveGoal(memory);
    }

    _cancelGoal(factory, memory, reason) {
        var goal = memory.activeGoal;
        if (!goal) return;
        this._cancelRequests(goal);
        memory.lastCancelledGoal = {
            resourceType: goal.resourceType,
            reason: String(reason || 'cancelled').substring(0, 80),
            cancelledAt: Game.time,
        };
        memory.outputResourceType = memory.activeRecipe || memory.outputResourceType;
        this._clearActiveGoal(memory);
    }

    _clearActiveGoal(memory) {
        delete memory.activeGoal;
        memory.activeRecipe = null;
        memory.inputResources = {};
        memory.inputResourceType = null;
        memory.managed = false;
        memory.nextPlanningAt = Game.time + this._config.planningInterval;
    }

    _cancelRequests(goal) {
        goal.requestIds.forEach(id => {
            var request = TerminalManager.getResourceRequests().find(candidate => candidate.id === id && candidate.status === 'open');
            if (request) TerminalManager.cancelResourceRequest(id, 'factory:' + goal.resourceType);
        });
        goal.pendingComponents = {};
    }

    static cancelGoal(factory, reason = 'cancelled') {
        if (!factory) return false;
        var manager = new FactoryManager(factory.room);
        var memory = MainUtil.fetchMemoryOfStructure(factory);
        if (!memory.activeGoal) return false;
        manager._cancelGoal(factory, memory, reason);
        return true;
    }

    static getActiveGoal(factory) {
        if (!factory) return null;
        return MainUtil.fetchMemoryOfStructure(factory).activeGoal || null;
    }

    static _getRoomStock(room, resourceType) {
        var stock = TerminalManager.getTotalStock(room, resourceType);
        MainCache.find(room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_FACTORY,
        }).forEach(factory => stock += factory.store.getUsedCapacity(resourceType));
        return stock;
    }

    static _getStockMap(room) {
        var stocks = {};
        [room.storage, room.terminal].filter(hub => !!hub).forEach(hub => {
            Object.keys(hub.store).forEach(resourceType => {
                if (typeof hub.store[resourceType] === 'number') stocks[resourceType] = (stocks[resourceType] || 0) + hub.store[resourceType];
            });
        });
        MainCache.find(room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_FACTORY,
        }).forEach(factory => {
            Object.keys(factory.store).forEach(resourceType => {
                if (typeof factory.store[resourceType] === 'number') stocks[resourceType] = (stocks[resourceType] || 0) + factory.store[resourceType];
            });
        });
        if (stocks[RESOURCE_ENERGY]) {
            stocks[RESOURCE_ENERGY] = Math.max(0, stocks[RESOURCE_ENERGY] - TerminalManager.getReserve(room, RESOURCE_ENERGY));
        }
        return stocks;
    }

    static _clamp(value, minimum, maximum, fallback) {
        value = Number(value);
        if (value === Infinity) return maximum;
        if (value === -Infinity) return minimum;
        if (!Number.isFinite(value)) return fallback;
        return Math.max(minimum, Math.min(maximum, value));
    }
}

FactoryManager.MAX_DEPENDENCY_STEPS = 32;
FactoryManager.MAX_CONFIGURED_GOALS = 16;

module.exports = FactoryManager;
