var MainCache = require('./main.cache');
var MainHeap = require('./main.heap');
var MainUtil = require('./main.util');
var TerminalManager = require('./manager.terminal');
var LogisticsManager = require('./manager.logistics');
var MarketManager = require('./manager.market');
var CpuManager = require('./manager.cpu');
var LabMatrix = require('./lab.matrix');
var info = require('./main.info');
var config = require('./main.config').LAB;

const PHASE = { IDLE: 'idle', SELECT: 'select', ACQUIRE: 'acquire', REACT: 'react' };
const TIER = LabMatrix.TIER;

class LabManager {

    static runAll() {
        MainUtil.findAllRooms().forEach(room => {
            if (!room.memory.base) return;
            try {
                new LabManager(room).run();
            } catch (error) {
                info.error('Could not run labs for ' + room.name + ': ' + error, room);
            }
        });
    }

    constructor(room) {
        this._room = room;
        this._memory = LabManager.getConfig(room);
        this._goals = LabManager._normalizeGoals(this._memory.goals);
        this._recipes = MainHeap.cached('labRecipes', undefined, () => LabManager.buildRecipeIndex());
        this._labs = MainCache.find(room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_LAB,
        }).slice().sort((a, b) => a.id.localeCompare(b.id));
        this._reactionLabs = LabManager._filterReactionLabs(this._labs);
        this._labsById = new Map(this._reactionLabs.map(lab => [lab.id, lab]));
        this._topology = null;
    }

    static getConfig(room) {
        var defaults = {
            enabled: true,
            goals: {},
            reserves: {},
            batchSize: 1000,
            maxDepth: 6,
            planningInterval: 10,
            requestExpiry: 1000,
            priority: 60,
            assignments: { inputA: null, inputB: null, outputs: [] },
            activeGoal: null,
            boostRequests: {},
            boosts: {},
            preloads: {},
            nextPlanningAt: 0,
            produceRetryAfter: 0,
        };
        var memory = Object.assign(defaults, room.memory.lab || {});
        delete memory.nextTopologyAt; // replaced by the heap's record of the last search
        memory.enabled = memory.enabled !== false;
        memory.batchSize = MainUtil.clamp(memory.batchSize, 5, 100000, 1000);
        memory.maxDepth = MainUtil.clamp(memory.maxDepth, 0, 10, 6);
        memory.planningInterval = MainUtil.clamp(memory.planningInterval, 1, 1000, 10);
        memory.requestExpiry = MainUtil.clamp(memory.requestExpiry, 1, 10000, 1000);
        memory.priority = MainUtil.clamp(memory.priority, 0, 1000, 60);
        memory.goals = memory.goals || {};
        memory.reserves = memory.reserves && typeof memory.reserves === 'object' ? memory.reserves : {};
        Object.keys(memory.reserves).slice(0, LabManager.MAX_CONFIGURED_GOALS).forEach(resourceType => {
            memory.reserves[resourceType] = MainUtil.clamp(memory.reserves[resourceType], 0, 1000000, 0);
        });
        memory.assignments = memory.assignments && typeof memory.assignments === 'object' ? memory.assignments : {};
        memory.assignments.outputs = Array.isArray(memory.assignments.outputs) ? memory.assignments.outputs : [];
        memory.boostRequests = memory.boostRequests && typeof memory.boostRequests === 'object' ? memory.boostRequests : {};
        memory.boosts = memory.boosts && typeof memory.boosts === 'object' ? memory.boosts : {};
        memory.preloads = memory.preloads && typeof memory.preloads === 'object' ? memory.preloads : {};
        room.memory.lab = memory;
        return memory;
    }

    static _normalizeGoals(configured) {
        var goals = {};
        if (Array.isArray(configured)) {
            configured.slice(0, LabManager.MAX_CONFIGURED_GOALS).forEach(entry => {
                if (!entry) return;
                var resourceType = entry.resourceType || entry.resource;
                var target = entry.target === undefined ? entry.amount : entry.target;
                if (resourceType) goals[resourceType] = MainUtil.clamp(target, 0, 1000000, 0);
            });
        } else if (configured && typeof configured === 'object') {
            Object.keys(configured).slice(0, LabManager.MAX_CONFIGURED_GOALS).forEach(resourceType => {
                var value = configured[resourceType];
                var target = value && typeof value === 'object' ? (value.target === undefined ? value.amount : value.target) : value;
                goals[resourceType] = MainUtil.clamp(target, 0, 1000000, 0);
            });
        }
        Object.keys(goals).forEach(resourceType => {
            if (goals[resourceType] <= 0) delete goals[resourceType];
        });
        return goals;
    }

    run() {
        this._cleanBoostRequests();
        if (!this._memory.enabled) {
            this._cancelGoal('lab manager disabled');
            this._cancelAllBoosts();
            this._clearManagedMetadata();
            return;
        }

        this._cleanPreloads();
        this._topology = this._getTopology();
        var goal = this._advance();

        this._alignTopologyToStep(goal ? goal.steps[goal.stepIndex] : null);
        if (goal) this._produceActive(goal);
        goal = this._memory.activeGoal;
        this._alignTopologyToStep(goal ? goal.steps[goal.stepIndex] : null);
        // after production, because this is what logistics reads later in the same tick
        this._projectLabMetadata(goal ? goal.steps[goal.stepIndex] : null);
    }

    /*
     * Labs do not move, so the search only runs again when the labs available to reactions change:
     * one is built or destroyed, or a player stocks one by hand. A global reset costs one search.
     */

    _getTopology() {
        var signature = this._reactionLabs.map(lab => lab.id).join();
        var searched = MainHeap.namespace('labTopology');
        var known = searched[this._room.name];
        if (known && known.signature === signature) {
            var saved = this._readTopology(false);
            if (!!saved === known.found) return saved;
        }

        var current = this._readTopology(true);
        var best = null;
        var labs = this._reactionLabs;
        for (var first = 0; first < labs.length; first++) {
            for (var second = first + 1; second < labs.length; second++) {
                var inputA = labs[first];
                var inputB = labs[second];
                var outputs = labs.filter(lab => {
                    return lab.id !== inputA.id && lab.id !== inputB.id &&
                        lab.pos.inRangeTo(inputA.pos, 2) && lab.pos.inRangeTo(inputB.pos, 2);
                });
                if (outputs.length === 0) continue;
                var candidate = { inputA, inputB, outputs };
                if (!best || outputs.length > best.outputs.length) best = candidate;
            }
        }
        if (current && best) {
            var currentScore = current.outputs.length;
            if (currentScore >= best.outputs.length) best = current;
        }
        searched[this._room.name] = { signature, found: !!best };
        this._memory.assignments = best ? {
            inputA: best.inputA.id,
            inputB: best.inputB.id,
            outputs: best.outputs.map(lab => lab.id),
        } : { inputA: null, inputB: null, outputs: [] };
        return best;
    }

    _readTopology(checkRange) {
        var assignments = this._memory.assignments;
        var inputA = this._labsById.get(assignments.inputA);
        var inputB = this._labsById.get(assignments.inputB);
        if (!inputA || !inputB || inputA.id === inputB.id) return null;
        var outputs = assignments.outputs.map(id => this._labsById.get(id)).filter(lab => {
            if (!lab || lab.id === inputA.id || lab.id === inputB.id) return false;
            return !checkRange || (lab.pos.inRangeTo(inputA.pos, 2) && lab.pos.inRangeTo(inputB.pos, 2));
        });
        return outputs.length > 0 ? { inputA, inputB, outputs } : null;
    }

    _alignTopologyToStep(step) {
        if (!this._topology || !step) return;
        var inputA = this._topology.inputA;
        var inputB = this._topology.inputB;
        if (inputA.mineralType !== step.reagents[1] || inputB.mineralType !== step.reagents[0]) return;
        this._topology.inputA = inputB;
        this._topology.inputB = inputA;
        this._memory.assignments.inputA = inputB.id;
        this._memory.assignments.inputB = inputA.id;
    }

    /*
     * idle -> select -> acquire <-> react -> idle. Draining is not a room phase: each lab already
     * drains itself when its contents do not match the current step.
     */

    _advance() {
        var fsm = this._getFsm();
        for (var hop = 0; hop < LabManager.MAX_PHASE_HOPS; hop++) {
            var next = this._runPhase(fsm);
            if (next === fsm.phase) break;
            fsm.phase = next;
        }
        return this._memory.activeGoal;
    }

    _getFsm() {
        if (!this._memory.fsm) {
            // a goal already in memory carries on, and counts as stalled only from now
            this._memory.fsm = { phase: this._memory.activeGoal ? PHASE.REACT : PHASE.IDLE, progress: null, progressAt: Game.time, blocked: {} };
        }
        return this._memory.fsm;
    }

    _runPhase(fsm) {
        switch (fsm.phase) {
            case PHASE.SELECT: return this._onSelect(fsm);
            case PHASE.ACQUIRE:
            case PHASE.REACT: return this._onGoal(fsm);
            default: return this._onIdle();
        }
    }

    _onIdle() {
        if (this._memory.activeGoal) return PHASE.REACT;
        var woken = LabMatrix.takeWake(this._room.name);
        return woken || Game.time >= (this._memory.nextPlanningAt || 0) ? PHASE.SELECT : PHASE.IDLE;
    }

    _onSelect(fsm) {
        var goal = this._topology ? this._selectGoal(fsm) : null;
        if (goal) return Object.keys(goal.pendingComponents).length > 0 ? PHASE.ACQUIRE : PHASE.REACT;
        this._memory.nextPlanningAt = Game.time + this._memory.planningInterval;
        return PHASE.IDLE;
    }

    _onGoal(fsm) {
        var goal = this._memory.activeGoal;
        if (!goal) return PHASE.IDLE;
        // a goal without a tier predates the matrix and belongs to the player
        var manual = goal.tier === undefined || goal.tier === TIER.MANUAL;
        if (manual && this._goals[goal.resourceType] === undefined) {
            this._cancelGoal('goal removed');
            return PHASE.IDLE;
        }
        if (this._getRoomStock(goal.resourceType) >= goal.configuredTarget) {
            this._completeGoal();
            return PHASE.IDLE;
        }
        if (Game.time >= (this._memory.nextPlanningAt || 0)) {
            this._updateRequests(goal);
            this._memory.nextPlanningAt = Game.time + this._memory.planningInterval;
        }
        var waiting = Object.keys(goal.pendingComponents).length > 0;
        if (this._isStalled(goal, fsm, waiting)) {
            fsm.blocked[goal.resourceType] = Game.time + config.BLOCK_TICKS;
            this._cancelGoal(waiting ? 'imports did not arrive' : 'reagents did not react');
            return PHASE.IDLE;
        }
        return waiting ? PHASE.ACQUIRE : PHASE.REACT;
    }

    // Keeps a high-water mark, so an amount that rises and falls back does not reset the clock.
    _isStalled(goal, fsm, waiting) {
        var progress = goal.steps.reduce((sum, step) => sum + step.produced, 0);
        Object.keys(goal.pendingComponents).forEach(resourceType => progress -= goal.pendingComponents[resourceType]);
        if (fsm.progress === null || progress > fsm.progress) {
            fsm.progress = progress;
            fsm.progressAt = Game.time;
            return false;
        }
        return Game.time - fsm.progressAt > (waiting ? config.ACQUIRE_TIMEOUT : config.REACT_STALL);
    }

    _selectGoal(fsm) {
        Object.keys(fsm.blocked).forEach(resourceType => {
            if (fsm.blocked[resourceType] <= Game.time) delete fsm.blocked[resourceType];
        });
        var stockOf = resourceType => this._getRoomStock(resourceType);
        var candidates = LabMatrix.rankCandidates(this._room.name, this._goals, stockOf, this._getProfitGoals()).filter(candidate => {
            return !!this._recipes[candidate.resourceType] && !fsm.blocked[candidate.resourceType];
        }).slice(0, config.MAX_PLANS_PER_SELECT);
        for (var candidate of candidates) {
            var plan = this._planFeasible(candidate);
            if (plan) {
                fsm.progress = null;
                fsm.progressAt = Game.time;
                return this._startGoal(candidate, plan);
            }
            fsm.blocked[candidate.resourceType] = Game.time + config.BLOCK_TICKS;
        }
        return null;
    }

    _getProfitGoals() {
        if (this._memory.autoProfit !== true || CpuManager.getTier() < CpuManager.TIER_NORMAL) return [];
        return LabMatrix.rankProfit(MarketManager.getConfig(this._room), this._recipes);
    }

    /*
     * Shrinks a derived batch to what can actually be obtained. Every step consumes one reagent per
     * product, so removing the worst shortfall from the batch is always enough. A manual goal keeps
     * its full size and its import requests, since the player may be about to supply it.
     */

    _planFeasible(candidate) {
        var amount = Math.min(this._memory.batchSize, candidate.target - this._getRoomStock(candidate.resourceType));
        for (var pass = 0; pass < config.PLAN_SCALE_PASSES; pass++) {
            var plan = this._planRecipe(candidate.resourceType, amount);
            if (plan.invalid.length > 0 || plan.steps.length === 0) {
                this._memory.planningError = plan.invalid[0] || 'no recipe';
                return null;
            }
            if (candidate.tier === TIER.MANUAL) return plan;
            var shortfall = Object.keys(plan.imports).reduce((worst, resourceType) => {
                return Math.max(worst, plan.imports[resourceType] - this._getImportSupply(resourceType));
            }, 0);
            if (shortfall <= 0) return plan;
            amount = Math.floor((amount - shortfall) / LabManager.REACTION_AMOUNT) * LabManager.REACTION_AMOUNT;
            if (amount < config.MIN_BATCH) return null;
        }
        return null;
    }

    _getImportSupply(resourceType) {
        var elsewhere = MainUtil.findAllRooms().reduce((sum, room) => {
            if (room === this._room || !room.terminal || !room.memory.base) return sum;
            return sum + TerminalManager.getAvailable(room, resourceType);
        }, 0);
        var market = MarketManager.getConfig(this._room);
        var rule = market.enabled && market.buy ? market.resources[resourceType] : null;
        if (!rule || !rule.buy || !(rule.maxBuyPrice > 0)) return elsewhere;
        return elsewhere + Math.max(0, rule.target - TerminalManager.getTotalStock(this._room, resourceType));
    }

    _startGoal(candidate, plan) {
        var rootStep = plan.steps[plan.steps.length - 1];
        var goal = {
            resourceType: candidate.resourceType,
            tier: candidate.tier,
            target: rootStep.amount,
            configuredTarget: candidate.target,
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
        this._memory.activeGoal = goal;
        this._memory.planningError = null;
        this._memory.nextPlanningAt = 0;
        this._updateRequests(goal);
        this._memory.nextPlanningAt = Game.time + this._memory.planningInterval;
        return goal;
    }

    static planRecipe(room, resourceType, amount, options = {}) {
        var manager = Object.create(LabManager.prototype);
        manager._room = room;
        manager._memory = LabManager.getConfig(room);
        manager._recipes = LabManager.buildRecipeIndex();
        manager._labs = MainCache.find(room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_LAB,
        });
        manager._reactionLabs = LabManager._filterReactionLabs(manager._labs);
        return manager._planRecipe(resourceType, amount, options);
    }

    _planRecipe(resourceType, amount, options = {}) {
        var plan = { resourceType, requestedAmount: amount, steps: [], imports: {}, invalid: [] };
        var available = this._getAvailableStockMap();
        var maxDepth = MainUtil.clamp(options.maxDepth, 0, 10, this._memory.maxDepth);
        var visit = (resource, requiredAmount, depth, path) => {
            var recipe = this._recipes[resource];
            if (!recipe) {
                plan.invalid.push('missing recipe:' + resource);
                return;
            }
            if (path.has(resource)) {
                plan.invalid.push('cycle:' + resource);
                return;
            }
            if (plan.steps.length >= LabManager.MAX_DEPENDENCY_STEPS) {
                plan.invalid.push('goal limit:' + resource);
                return;
            }
            var cycles = Math.ceil(requiredAmount / LabManager.REACTION_AMOUNT);
            if (cycles <= 0) return;
            var nextPath = new Set(path);
            nextPath.add(resource);
            recipe.reagents.forEach(component => {
                var required = cycles * LabManager.REACTION_AMOUNT;
                var used = Math.min(required, available[component] || 0);
                available[component] = (available[component] || 0) - used;
                var needed = required - used;
                if (needed <= 0) return;
                if (nextPath.has(component)) {
                    plan.invalid.push('cycle:' + component);
                    return;
                }
                if (this._recipes[component] && depth < maxDepth) {
                    visit(component, needed, depth + 1, nextPath);
                } else {
                    plan.imports[component] = (plan.imports[component] || 0) + needed;
                }
            });
            plan.steps.push({
                resourceType: resource,
                reagents: recipe.reagents.slice(),
                amount: cycles * LabManager.REACTION_AMOUNT,
                produced: 0,
                cooldown: recipe.cooldown,
            });
        };
        visit(resourceType, amount, 0, new Set());
        return plan;
    }

    static buildRecipeIndex() {
        var recipes = {};
        if (typeof REACTIONS === 'undefined' || !REACTIONS) return recipes;
        Object.keys(REACTIONS).sort().forEach(first => {
            var secondResources = REACTIONS[first] || {};
            Object.keys(secondResources).sort().forEach(second => {
                var product = secondResources[second];
                if (!product || recipes[product]) return;
                recipes[product] = {
                    reagents: [first, second],
                    cooldown: typeof REACTION_TIME !== 'undefined' && REACTION_TIME[product] || 0,
                };
            });
        });
        return recipes;
    }

    _updateRequests(goal) {
        goal.pendingComponents = {};
        Object.keys(goal.imports).sort().forEach(resourceType => {
            if (goal.completedImports[resourceType]) return;
            var required = goal.imports[resourceType];
            var id = 'lab:' + this._room.name + ':' + resourceType;
            var ownOpen = TerminalManager.getResourceRequests({ targetRoom: this._room.name, resourceType, status: 'open' })
                .find(request => request.id === id);
            if (this._getAvailableStock(resourceType) >= required) {
                goal.completedImports[resourceType] = true;
                if (ownOpen) TerminalManager.cancelResourceRequest(id, 'lab:local stock restored');
                return;
            }
            var requests = TerminalManager.getResourceRequests({ targetRoom: this._room.name, resourceType })
                .filter(request => request.id.indexOf('lab:') === 0)
                .sort((a, b) => a.id.localeCompare(b.id));
            var open = requests.find(request => request.status === 'open');
            if (open) {
                goal.pendingComponents[resourceType] = open.remaining;
                if (open.id === id && !goal.requestIds.includes(id)) goal.requestIds.push(id);
                if (open.id !== id && !goal.sharedRequestIds.includes(open.id)) goal.sharedRequestIds.push(open.id);
                if (open.id === id && open.expiresAt - Game.time < 100) {
                    TerminalManager.requestResource(this._room, resourceType, open.remaining, {
                        id,
                        priority: this._memory.priority,
                        reason: 'lab:' + goal.resourceType,
                        expiry: this._memory.requestExpiry,
                    });
                }
                return;
            }
            var completed = requests.find(request => request.id === id && request.status === 'complete');
            if (completed) {
                goal.completedImports[resourceType] = true;
                return;
            }
            var created = TerminalManager.requestResource(this._room, resourceType, required, {
                id,
                priority: this._memory.priority,
                reason: 'lab:' + goal.resourceType,
                expiry: this._memory.requestExpiry,
            });
            if (created) {
                if (!goal.requestIds.includes(id)) goal.requestIds.push(id);
                goal.pendingComponents[resourceType] = created.remaining;
            }
        });
        goal.updated = Game.time;
        this._memory.activeGoal = goal;
    }

    _projectLabMetadata(step) {
        var reservations = this._collectBoostReservations();
        var topology = this._topology;
        var preloadedLabs = this._getPreloadedLabs();
        this._labs.forEach(lab => {
            var memory = MainUtil.fetchMemoryOfStructure(lab);
            var reserved = reservations[lab.id] || { amount: 0, energy: 0, resources: {} };
            var preload = preloadedLabs[lab.id];
            var held = preload && lab.mineralType === preload.resourceType ? preload.amount : 0;
            memory.reservedBoostAmount = lab.mineralType ? (reserved.resources[lab.mineralType] || 0) + held : 0;
            memory.reservedBoostEnergy = reserved.energy || 0;
            var inTopology = topology && (topology.inputA.id === lab.id || topology.inputB.id === lab.id ||
                topology.outputs.some(output => output.id === lab.id));
            if (preload) {
                // logistics loads this like any lab input, once a lab holding something else has drained
                var foreign = lab.mineralType && lab.mineralType !== preload.resourceType;
                memory.labManaged = true;
                memory.labRole = 'boost';
                memory.inputResourceType = preload.resourceType;
                memory.targetAmount = Math.min(LabManager.MINERAL_CAPACITY, preload.amount + (reserved.resources[preload.resourceType] || 0));
                memory.outputResourceType = foreign ? lab.mineralType : null;
                memory.activeReaction = null;
                return;
            }
            if (reserved.amount > 0) {
                memory.labRole = 'boost';
                // Manual stock settings belong to the player and must survive the boost.
                if (!memory.labManaged) return;
                memory.inputResourceType = null;
                memory.targetAmount = 0;
                memory.outputResourceType = lab.mineralType;
                memory.activeReaction = null;
                return;
            }
            if (!memory.labManaged && (!step || !inTopology)) {
                LabManager._releaseBoostRole(memory);
                return;
            }
            if (!step || !inTopology) {
                memory.labRole = lab.mineralType ? 'drain' : 'idle';
                memory.inputResourceType = null;
                memory.targetAmount = 0;
                memory.outputResourceType = lab.mineralType;
                memory.activeReaction = null;
                // a delivery still on its way must find a lab that will drain it, not one left to the player
                if (!lab.mineralType && !LogisticsManager.isDeliveryClaimed(this._room, lab.id)) memory.labManaged = false;
                return;
            }

            memory.labManaged = true;
            var desired = null;
            var role = null;
            if (topology.inputA.id === lab.id) {
                desired = step.reagents[0];
                role = 'inputA';
            } else if (topology.inputB.id === lab.id) {
                desired = step.reagents[1];
                role = 'inputB';
            } else {
                desired = step.resourceType;
                role = 'output';
            }
            if (lab.mineralType && lab.mineralType !== desired) {
                memory.labRole = 'drain';
                memory.inputResourceType = null;
                memory.targetAmount = 0;
                memory.outputResourceType = lab.mineralType;
                memory.activeReaction = null;
                return;
            }
            memory.labRole = role;
            memory.activeReaction = role === 'output' ? step.resourceType : null;
            memory.outputResourceType = role === 'output' ? step.resourceType : null;
            memory.inputResourceType = role === 'output' ? null : desired;
            memory.targetAmount = role === 'output' ? 0 : Math.min(LabManager.MINERAL_CAPACITY, Math.max(0, step.amount - step.produced));
        });
    }

    _produceActive(goal) {
        if (Game.time < (this._memory.produceRetryAfter || 0) || !this._topology) return;
        var step = goal.steps[goal.stepIndex];
        if (!step) {
            this._completeGoal();
            return;
        }
        var inputA = this._topology.inputA;
        var inputB = this._topology.inputB;
        if (inputA.mineralType !== step.reagents[0] || inputB.mineralType !== step.reagents[1] ||
            this._isLabReserved(inputA.id) || this._isLabReserved(inputB.id)) return;
        if (inputA.store.getUsedCapacity(step.reagents[0]) < LabManager.REACTION_AMOUNT ||
            inputB.store.getUsedCapacity(step.reagents[1]) < LabManager.REACTION_AMOUNT) return;

        for (var output of this._topology.outputs) {
            if (step.produced >= step.amount) break;
            if (output.cooldown > 0 || this._isLabReserved(output.id)) continue;
            if (output.mineralType && output.mineralType !== step.resourceType) continue;
            if (output.store.getFreeCapacity(step.resourceType) < LabManager.REACTION_AMOUNT) continue;
            if (inputA.store.getUsedCapacity(step.reagents[0]) < LabManager.REACTION_AMOUNT ||
                inputB.store.getUsedCapacity(step.reagents[1]) < LabManager.REACTION_AMOUNT) break;
            var result = output.runReaction(inputA, inputB);
            if (result === OK) {
                step.produced += LabManager.REACTION_AMOUNT;
                this._memory.lastProducedAt = Game.time;
                this._memory.lastProduceError = null;
                continue;
            }
            if (result !== ERR_TIRED && result !== ERR_NOT_ENOUGH_RESOURCES && result !== ERR_FULL) {
                this._memory.produceRetryAfter = Game.time + Math.max(5, step.cooldown || 5);
                this._memory.lastProduceError = result;
                if (Game.time - (this._memory.lastProduceNotice || 0) >= 500) {
                    this._memory.lastProduceNotice = Game.time;
                    info.warning('Lab ' + output.id + ' could not produce ' + step.resourceType + ': ' + result, this._room);
                }
                break;
            }
        }
        var rootStep = goal.steps[goal.steps.length - 1];
        goal.produced = rootStep.produced;
        goal.pending = Math.max(0, goal.target - rootStep.produced);
        goal.updated = Game.time;
        if (step.produced >= step.amount) {
            if (goal.stepIndex >= goal.steps.length - 1) {
                this._completeGoal();
                return;
            }
            goal.stepIndex++;
        }
        this._memory.activeGoal = goal;
    }

    _completeGoal() {
        var goal = this._memory.activeGoal;
        if (!goal) return;
        this._cancelRequests(goal);
        this._memory.lastCompletedGoal = {
            resourceType: goal.resourceType,
            target: goal.target,
            produced: goal.steps[goal.steps.length - 1].produced,
            completedAt: Game.time,
        };
        this._memory.activeGoal = null;
        this._memory.nextPlanningAt = Game.time + this._memory.planningInterval;
    }

    _cancelGoal(reason) {
        var goal = this._memory.activeGoal;
        if (!goal) return;
        this._cancelRequests(goal);
        this._memory.lastCancelledGoal = {
            resourceType: goal.resourceType,
            reason: String(reason || 'cancelled').substring(0, 80),
            cancelledAt: Game.time,
        };
        this._memory.activeGoal = null;
        this._memory.nextPlanningAt = Game.time + this._memory.planningInterval;
    }

    _cancelRequests(goal) {
        goal.requestIds.forEach(id => {
            var request = TerminalManager.getResourceRequests().find(candidate => candidate.id === id && candidate.status === 'open');
            if (request) TerminalManager.cancelResourceRequest(id, 'lab:' + goal.resourceType);
        });
        goal.pendingComponents = {};
    }

    _clearManagedMetadata() {
        this._labs.forEach(lab => {
            var memory = MainUtil.fetchMemoryOfStructure(lab);
            memory.reservedBoostAmount = 0;
            memory.reservedBoostEnergy = 0;
            if (!memory.labManaged) {
                LabManager._releaseBoostRole(memory);
                return;
            }
            memory.labManaged = false;
            memory.labRole = lab.mineralType ? 'drain' : 'idle';
            memory.inputResourceType = null;
            memory.targetAmount = 0;
            memory.activeReaction = null;
            memory.outputResourceType = lab.mineralType;
        });
    }

    static _isStockLab(memory) {
        return !memory.labManaged && !!(memory.inputResourceType || memory.resourceType);
    }

    // Labs the player stocks manually (usually boost compounds) stay out of reactions.
    static _filterReactionLabs(labs) {
        return labs.filter(lab => !LabManager._isStockLab(MainUtil.fetchMemoryOfStructure(lab)));
    }

    static _releaseBoostRole(memory) {
        if (memory.labRole === 'boost') memory.labRole = LabManager._isStockLab(memory) ? 'stock' : 'idle';
    }

    _getRoomStock(resourceType) {
        var stock = TerminalManager.getTotalStock(this._room, resourceType);
        this._reactionLabs.forEach(lab => stock += lab.store.getUsedCapacity(resourceType));
        return stock;
    }

    _getAvailableStock(resourceType) {
        return Math.max(0, this._getRoomStock(resourceType) - (this._memory.reserves[resourceType] || 0));
    }

    _getAvailableStockMap() {
        var stocks = {};
        [this._room.storage, this._room.terminal].filter(hub => !!hub).forEach(hub => {
            Object.keys(hub.store).forEach(resourceType => {
                if (typeof hub.store[resourceType] === 'number') stocks[resourceType] = (stocks[resourceType] || 0) + hub.store[resourceType];
            });
        });
        this._reactionLabs.forEach(lab => {
            Object.keys(lab.store).forEach(resourceType => {
                if (typeof lab.store[resourceType] === 'number') stocks[resourceType] = (stocks[resourceType] || 0) + lab.store[resourceType];
            });
        });
        Object.keys(stocks).forEach(resourceType => {
            stocks[resourceType] = Math.max(0, stocks[resourceType] - (this._memory.reserves[resourceType] || 0));
        });
        return stocks;
    }

    static planSpawnBoost(spawn, body, roleName, memory = {}, options = {}) {
        if (options.emergency || !spawn || !spawn.room || !Array.isArray(body)) return { allow: true, plan: null };
        var room = spawn.room;
        var config = LabManager.getConfig(room);
        var policy = config.boosts[roleName];
        if (!config.enabled || !policy || typeof policy !== 'object') return { allow: true, plan: null };
        var required = policy.required === true;
        if (typeof BOOSTS === 'undefined') return { allow: !required, plan: null };
        var counts = {};
        Object.keys(policy).sort().forEach(partType => {
            if (partType === 'required') return;
            var resourceType = policy[partType];
            if (!BOOSTS[partType] || !BOOSTS[partType][resourceType]) return;
            var count = body.filter(part => {
                var type = typeof part === 'string' ? part : part.type;
                return type === partType && (typeof part === 'string' || !part.boost);
            }).length;
            if (count > 0) counts[resourceType] = (counts[resourceType] || 0) + count;
        });
        if (Object.keys(counts).length === 0) return { allow: !required, plan: null };

        var labs = MainCache.find(room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_LAB,
        }).slice().sort((a, b) => a.id.localeCompare(b.id));
        var reservations = LabManager._collectBoostReservations(room);
        var usedEnergy = {};
        var steps = [];
        var missing = {};
        Object.keys(counts).sort().forEach(resourceType => {
            var remaining = counts[resourceType];
            labs.forEach(lab => {
                if (remaining <= 0 || lab.mineralType !== resourceType) return;
                var reserved = reservations[lab.id] || { resources: {}, energy: 0 };
                var mineral = lab.store.getUsedCapacity(resourceType) - (reserved.resources[resourceType] || 0);
                var energy = lab.store.getUsedCapacity(RESOURCE_ENERGY) - (reserved.energy || 0) - (usedEnergy[lab.id] || 0);
                var count = Math.min(remaining, Math.floor(mineral / LabManager.BOOST_MINERAL), Math.floor(energy / LabManager.BOOST_ENERGY));
                if (count <= 0) return;
                steps.push({ labId: lab.id, resourceType, count, done: false });
                usedEnergy[lab.id] = (usedEnergy[lab.id] || 0) + count * LabManager.BOOST_ENERGY;
                remaining -= count;
            });
            if (remaining > 0) missing[resourceType] = true;
        });
        var complete = Object.keys(missing).length === 0;
        if (required) LabManager._queuePreloads(room, config, labs, reservations, counts, missing);
        Object.keys(counts).forEach(resourceType => {
            // what is already being loaded has no need to wake reaction planning
            LabMatrix.noteBoostDemand(room.name, resourceType, counts[resourceType], !complete && !config.preloads[resourceType]);
        });
        if (!complete) return { allow: !required, plan: null };
        return {
            allow: true,
            plan: { roomName: room.name, roleName, steps, created: Game.time },
        };
    }

    /*
     * The spawn attempt that finds a required compound in the hub rather than in a lab is what
     * starts it moving. The spawn stays blocked until the lab is stocked, so a late hauler costs
     * a short wait and not a creep's lifetime. A body is queued whole or not at all, because
     * parking one compound in a lab does nothing while another cannot be supplied.
     *
     * Entries belong to the compound and not to the role, since another role may be relying on the
     * same one. So a body that cannot be queued leaves them be: they go when the stock can no
     * longer cover what they hold out for, or when nobody that can be served is refreshing them.
     */

    static _queuePreloads(room, config, labs, reservations, counts, missing) {
        var entries = {};
        var taken = {};
        Object.keys(config.preloads).forEach(resourceType => {
            taken[config.preloads[resourceType].labId] = true;
        });
        var coverable = true;
        Object.keys(counts).sort().forEach(resourceType => {
            var current = config.preloads[resourceType];
            if (!current && !missing[resourceType]) return;
            var amount = counts[resourceType] * LabManager.BOOST_MINERAL;
            var lab = current ? labs.find(candidate => candidate.id === current.labId) :
                LabManager._designatePreloadLab(room, config, labs, reservations, resourceType, amount, taken);
            var supply = lab ? LabManager._getPreloadSupply(room, lab, reservations, resourceType) : 0;
            if (current && supply < current.amount) {
                delete config.preloads[resourceType];
                current = null;
            }
            if (!lab || supply < amount) {
                coverable = false;
                return;
            }
            taken[lab.id] = true;
            entries[resourceType] = { labId: lab.id, amount: current ? Math.max(current.amount, amount) : amount, askedAt: Game.time };
        });
        if (coverable) Object.assign(config.preloads, entries);
    }

    // What a lab can end up holding for a new spawn. Cargo in a hauler is in neither store, but it is still coming.
    static _getPreloadSupply(room, lab, reservations, resourceType) {
        var held = lab.mineralType === resourceType ? lab.store.getUsedCapacity(resourceType) : 0;
        var reserved = reservations[lab.id] ? reservations[lab.id].resources[resourceType] || 0 : 0;
        return held - reserved + LogisticsManager.getInboundAmount(room, lab.id, resourceType) + TerminalManager.getAvailable(room, resourceType);
    }

    // Input labs stay out because a reaction cannot run without them. Output labs just wait their turn.
    static _designatePreloadLab(room, config, labs, reservations, resourceType, amount, taken) {
        var hub = room.storage || room.terminal;
        var rank = lab => lab.mineralType === resourceType ? 0 : lab.mineralType ? 2 : 1;
        return labs.filter(lab => {
            if (taken[lab.id] || lab.id === config.assignments.inputA || lab.id === config.assignments.inputB) return false;
            if (LabManager._isStockLab(MainUtil.fetchMemoryOfStructure(lab))) return false;
            var reserved = reservations[lab.id] ? reservations[lab.id].resources : {};
            if (Object.keys(reserved).some(other => other !== resourceType)) return false;
            return LabManager.MINERAL_CAPACITY - (reserved[resourceType] || 0) >= amount;
        }).sort((a, b) => {
            return rank(a) - rank(b) || (hub ? a.pos.getRangeTo(hub) - b.pos.getRangeTo(hub) : 0) || a.id.localeCompare(b.id);
        })[0] || null;
    }

    _getPreloadedLabs() {
        var byLab = {};
        Object.keys(this._memory.preloads).forEach(resourceType => {
            var entry = this._memory.preloads[resourceType];
            byLab[entry.labId] = { resourceType, amount: entry.amount };
        });
        return byLab;
    }

    // Every spawn attempt refreshes its entries, so one that has gone quiet no longer needs the lab.
    _cleanPreloads() {
        Object.keys(this._memory.preloads).forEach(resourceType => {
            var entry = this._memory.preloads[resourceType];
            var exists = this._labs.some(lab => lab.id === entry.labId);
            if (!exists || Game.time - entry.askedAt > config.PRELOAD_TTL) delete this._memory.preloads[resourceType];
        });
    }

    static registerSpawnBoost(creep, plan) {
        if (!creep || !plan || !plan.steps || plan.steps.length === 0) return;
        var room = Game.rooms[plan.roomName] || creep.room;
        var config = LabManager.getConfig(room);
        plan.steps.forEach(step => delete config.preloads[step.resourceType]);
        config.boostRequests[creep.name] = {
            creepName: creep.name,
            roleName: plan.roleName,
            steps: plan.steps.map(step => Object.assign({}, step, { done: false })),
            created: Game.time,
            status: 'pending',
        };
        creep.memory.labBoost = { room: room.name };
    }

    static runCreep(creep, role) {
        if (!creep.memory.labBoost) return false;
        var room = Game.rooms[creep.memory.labBoost.room] || creep.room;
        var config = LabManager.getConfig(room);
        var request = config.boostRequests[creep.name];
        if (!config.enabled || !request || creep.memory.selfdestruct) {
            LabManager._deleteBoostRequest(room, creep);
            return false;
        }
        var step = request.steps.find(candidate => !candidate.done);
        if (!step) {
            LabManager._deleteBoostRequest(room, creep);
            return false;
        }
        var lab = Game.getObjectById(step.labId);
        if (!lab || lab.room.name !== creep.room.name || lab.mineralType !== step.resourceType ||
            lab.store.getUsedCapacity(step.resourceType) < step.count * LabManager.BOOST_MINERAL ||
            lab.store.getUsedCapacity(RESOURCE_ENERGY) < step.count * LabManager.BOOST_ENERGY) {
            LabManager._deleteBoostRequest(room, creep);
            return false;
        }
        if (!creep.pos.isNearTo(lab.pos)) {
            if (role && role._moveToLocation) role._moveToLocation(creep, lab);
            else creep.moveTo(lab.pos);
            return true;
        }
        var result = lab.boostCreep(creep, step.count);
        if (result === OK) {
            step.done = true;
            if (request.steps.every(candidate => candidate.done)) LabManager._deleteBoostRequest(room, creep);
            return true;
        }
        if (result === ERR_NOT_IN_RANGE) {
            if (role && role._moveToLocation) role._moveToLocation(creep, lab);
            else creep.moveTo(lab.pos);
            return true;
        }
        if (result === ERR_TIRED) return true;
        LabManager._deleteBoostRequest(room, creep);
        return false;
    }

    static _deleteBoostRequest(room, creep) {
        if (room.memory.lab && room.memory.lab.boostRequests) delete room.memory.lab.boostRequests[creep.name];
        delete creep.memory.labBoost;
    }

    _cleanBoostRequests() {
        Object.keys(this._memory.boostRequests).forEach(creepName => {
            var creep = Game.creeps[creepName];
            if (!creep || !creep.memory.labBoost) delete this._memory.boostRequests[creepName];
        });
    }

    _cancelAllBoosts() {
        Object.keys(this._memory.boostRequests).forEach(creepName => {
            var creep = Game.creeps[creepName];
            if (creep) delete creep.memory.labBoost;
        });
        this._memory.boostRequests = {};
        this._memory.preloads = {};
    }

    _isLabReserved(labId) {
        var reservations = this._collectBoostReservations();
        if (reservations[labId] && reservations[labId].amount > 0) return true;
        return Object.keys(this._memory.preloads).some(resourceType => this._memory.preloads[resourceType].labId === labId);
    }

    _collectBoostReservations() {
        return LabManager._collectBoostReservations(this._room);
    }

    static _collectBoostReservations(room) {
        var reservations = {};
        var requests = room.memory.lab && room.memory.lab.boostRequests || {};
        Object.keys(requests).forEach(creepName => {
            var request = requests[creepName];
            (request.steps || []).forEach(step => {
                if (step.done) return;
                if (!reservations[step.labId]) reservations[step.labId] = { amount: 0, energy: 0, resources: {} };
                var reserved = reservations[step.labId];
                reserved.amount += step.count * LabManager.BOOST_MINERAL;
                reserved.energy += step.count * LabManager.BOOST_ENERGY;
                reserved.resources[step.resourceType] = (reserved.resources[step.resourceType] || 0) + step.count * LabManager.BOOST_MINERAL;
            });
        });
        return reservations;
    }

}

LabManager.MAX_PHASE_HOPS = 5;
LabManager.MAX_DEPENDENCY_STEPS = 32;
LabManager.MAX_CONFIGURED_GOALS = 16;
LabManager.REACTION_AMOUNT = typeof LAB_REACTION_AMOUNT === 'undefined' ? 5 : LAB_REACTION_AMOUNT;
LabManager.BOOST_MINERAL = typeof LAB_BOOST_MINERAL === 'undefined' ? 30 : LAB_BOOST_MINERAL;
LabManager.BOOST_ENERGY = typeof LAB_BOOST_ENERGY === 'undefined' ? 20 : LAB_BOOST_ENERGY;
LabManager.MINERAL_CAPACITY = typeof LAB_MINERAL_CAPACITY === 'undefined' ? 3000 : LAB_MINERAL_CAPACITY;

module.exports = LabManager;
