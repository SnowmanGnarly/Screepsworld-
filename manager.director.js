/*
 * The strategic layer: Goal -> Mission -> Plan.
 *
 * GOAL     What a room is for right now. Exactly one, and the only thing kept in Memory.
 * MISSION  An objective a goal starts, with an end condition and a time limit. Heap only.
 * PLAN     Goal and missions merged into one frozen object of overrides that managers read every
 *          tick. Heap only, and rebuilt only when the goal or a mission changes.
 *
 * The Director moves no creeps and calls no manager; managers call it. Nothing here imports a
 * manager that reads the plan, so there is no cycle. The default plan means "do what the room would
 * do anyway", so if this module fails, or a room has no plan yet, the bot behaves as it did before.
 *
 * Plans never write to main.config.js or to a manager's room.memory: the config is shared by every
 * room and lasts until a reset, and a written flag would overwrite the operator's own setting with
 * nothing to restore it from.
 */

var MainCache = require('./main.cache');
var MainHeap = require('./main.heap');
var MainUtil = require('./main.util');
var info = require('./main.info');
var allConfig = require('./main.config');
var CpuManager = require('./manager.cpu');

const config = allConfig.DIRECTOR;

const GOAL_UPGRADE = 'upgrade';
const GOAL_STOCKPILE = 'stockpile';
const GOAL_DEFENSE = 'defense';
const GOAL_EXPAND = 'expand';
const GOALS = [GOAL_UPGRADE, GOAL_STOCKPILE, GOAL_DEFENSE, GOAL_EXPAND];

const MISSION_BOOST_QUEUE = 'boostQueue';
const MISSION_MARKET_DUMP = 'marketDump';
const MISSION_REBUILD_WALLS = 'rebuildWalls';
const MISSION_CLAIM_ROOM = 'claimRoom';

const FACTORY_NORMAL = 'normal'; // whatever room.memory.factory asks for
const FACTORY_DECOMPRESS = 'decompress'; // batteries back into energy
const FACTORY_PAUSE = 'pause';

const DEFAULT_PLAN = Object.freeze({
    priorities: Object.freeze({}), // logistics priority name -> value, read by LogisticsManager
    spawnCaps: Object.freeze({}), // role -> most creeps the room may derive. Manual quotas still win
    haltSpending: false, // Upgraders and Builders stop drawing energy
    factory: FACTORY_NORMAL,
    labReactions: true,
    preload: Object.freeze([]), // { resourceType, amount } to hold in labs, read by LabManager
    upgraderBoosts: true,
    factoryToTerminal: false,
    marketDump: false,
    wallsFirst: false,
    expand: false,
});

/*
 * What each goal asks of the room. Stockpiling decompresses rather than compresses: 600 energy makes
 * 50 batteries, which give back only 500, so compressing while short of energy would lower the very
 * stock the room is waiting on and it could never leave this goal.
 */

const GOAL_PLANS = {
    [GOAL_UPGRADE]: { factory: FACTORY_DECOMPRESS },
    [GOAL_STOCKPILE]: { factory: FACTORY_DECOMPRESS, spawnCaps: { Upgrader: 1, Builder: 1 }, upgraderBoosts: false },
    [GOAL_DEFENSE]: {
        factory: FACTORY_PAUSE,
        labReactions: false,
        upgraderBoosts: false,
        haltSpending: true,
        spawnCaps: { Upgrader: 1, Builder: 0 },
        priorities: { TOWER: config.TOWER_PRIORITY, TOWER_UNDER_ATTACK: config.TOWER_PRIORITY },
    },
    [GOAL_EXPAND]: { expand: true },
};

const GOAL_MISSIONS = {
    [GOAL_UPGRADE]: [MISSION_BOOST_QUEUE],
    [GOAL_STOCKPILE]: [MISSION_MARKET_DUMP],
    [GOAL_DEFENSE]: [MISSION_BOOST_QUEUE],
    [GOAL_EXPAND]: [MISSION_CLAIM_ROOM],
};

/*
 * canStart: is this worth starting in this room? isDone: has it reached its end condition?
 * maxAge: when to give up, so that no mission can hold a plan in place for ever.
 * plan: the overrides it adds while it runs.
 */

const MISSIONS = {
    [MISSION_BOOST_QUEUE]: {
        maxAge: 1500,
        canStart: (room, goal) => DirectorManager._getBoostCompounds(room, goal).length > 0,
        // defense holds its compounds until the goal ends; upgrading stops once they are loaded
        isDone: (room, mission) => mission.goal !== GOAL_DEFENSE && mission.compounds.every(entry => DirectorManager._isLoaded(room, entry)),
        build: (room, goal) => ({ compounds: DirectorManager._getBoostCompounds(room, goal) }),
        plan: mission => ({
            priorities: { LAB_BOOST: config.LAB_BOOST_PRIORITY },
            preload: mission.compounds,
            // only defense may stop reactions: upgrading would never make the compound it is waiting for
            labReactions: mission.goal !== GOAL_DEFENSE,
        }),
    },
    [MISSION_MARKET_DUMP]: {
        maxAge: 1000,
        // selling is opt-in everywhere else, and a plan must not be how it gets switched on
        canStart: room => !!(room.terminal && room.memory.market && room.memory.market.enabled === true),
        isDone: () => false,
        build: () => ({}),
        plan: () => ({ factoryToTerminal: true, marketDump: true }),
    },
    [MISSION_REBUILD_WALLS]: {
        maxAge: 3000,
        canStart: room => !!(room.memory.mayor && room.memory.mayor.enableFortification) && DirectorManager._hasWeakWalls(room),
        isDone: room => !DirectorManager._hasWeakWalls(room),
        build: () => ({}),
        plan: () => ({ wallsFirst: true }),
    },
    [MISSION_CLAIM_ROOM]: {
        maxAge: 3000,
        canStart: () => DirectorManager._findExpansionFlag() !== null,
        isDone: () => DirectorManager._findExpansionFlag() === null,
        build: () => ({}),
        plan: () => ({ expand: true }),
    },
};

class DirectorManager {

    /*
     * The hostile check runs every tick in every CPU tier, because a defense must not wait for the
     * bucket. Anything economic waits for the room's turn and a normal tier.
     */

    static runAll() {
        var tier = CpuManager.getTier();
        MainUtil.findAllRooms().forEach(room => {
            if (!room.memory.base || !room.controller || !room.controller.my) return;
            try {
                this._runRoom(room, tier);
            } catch (error) {
                info.failure('director:' + room.name, 'Could not run the Director for ' + room.name, error, room);
            }
        });
    }

    // --- what managers read. These never allocate, so they are safe on hot paths ---------------

    static getGoal(room) {
        var state = this._states()[room.name];
        return state ? state.goal : GOAL_UPGRADE;
    }

    static getPlan(room) {
        var state = this._states()[room.name];
        return state ? state.plan : DEFAULT_PLAN;
    }

    static hasMission(room, type) {
        var state = this._states()[room.name];
        return !!state && state.missions.some(mission => mission.type === type);
    }

    static getLogisticsPriority(room, name, fallback) {
        var override = this.getPlan(room).priorities[name];
        return override === undefined ? fallback : override;
    }

    static getSpawnCap(room, roleName, derived) {
        var cap = this.getPlan(room).spawnCaps[roleName];
        return cap === undefined ? derived : Math.min(derived, cap);
    }

    // --- goals -----------------------------------------------------------------------------------

    static _runRoom(room, tier) {
        var state = this._getState(room);
        if (this._isUnderAttack(room)) {
            state.lastHostileAt = Game.time;
            if (state.goal !== GOAL_DEFENSE) this._setGoal(room, state, GOAL_DEFENSE);
        } else if (state.goal === GOAL_DEFENSE) {
            if (Game.time - state.lastHostileAt >= config.DEFENSE_CLEAR_TICKS) this._standDown(room, state);
        } else if (tier === CpuManager.TIER_NORMAL && MainUtil.isRoomsTurn(room.name, config.EVALUATE_INTERVAL)) {
            var next = this._chooseEconomicGoal(room, state.goal);
            if (next !== state.goal) this._setGoal(room, state, next);
        }
        if (MainUtil.isRoomsTurn(room.name, config.MISSION_INTERVAL)) this._reviewMissions(room, state);
    }

    /*
     * A scout passing through must not stop the economy, so only a body that can do harm counts.
     * MainCache shares this find with DefenseManager, so with no hostiles it costs next to nothing.
     */

    static _isUnderAttack(room) {
        var hostiles = MainCache.find(room, FIND_HOSTILE_CREEPS);
        if (hostiles.length === 0) return false;
        var dangerous = [ATTACK, RANGED_ATTACK, HEAL, WORK, CLAIM];
        return hostiles.some(hostile => dangerous.some(part => hostile.getActiveBodyparts(part) > 0));
    }

    /*
     * UPGRADE -> STOCKPILE when the stock falls below the entry level for this RCL.
     * STOCKPILE -> UPGRADE only once it is back above that level plus the margin. Between the two the
     * room keeps the goal it has, and the goal is in Memory, so a global reset does not change it.
     * A room with no storage has nothing to stockpile in.
     */

    static _chooseEconomicGoal(room, current) {
        var stored = this._getStoredEnergy(room);
        var enter = config.STOCKPILE_ENTER[room.controller.level];
        if (room.storage && enter !== undefined) {
            var line = current === GOAL_STOCKPILE ? enter + config.STOCKPILE_EXIT_MARGIN : enter;
            if (stored < line) return GOAL_STOCKPILE;
        }
        return this._canExpand(room, stored) ? GOAL_EXPAND : GOAL_UPGRADE;
    }

    // storage and terminal together, because moving stock between the two is not a loss of energy
    static _getStoredEnergy(room) {
        var inStore = structure => (structure ? structure.store.getUsedCapacity(RESOURCE_ENERGY) : 0);
        return inStore(room.storage) + inStore(room.terminal);
    }

    /*
     * The operator chooses where to go by placing a flag, which is how an Explorer finds its target.
     * One room expands at a time, and the game only lets us claim what GCL pays for.
     */

    static _canExpand(room, stored) {
        if (room.controller.level < allConfig.PLANNER.MAX_RCL || stored < config.EXPAND_MIN_ENERGY) return false;
        if (Game.cpu.bucket < config.EXPAND_BUCKET || !Game.gcl) return false;
        if (this._findExpansionFlag() === null) return false;
        var owned = MainUtil.findAllRooms().filter(other => other.controller && other.controller.my).length;
        if (owned >= Game.gcl.level) return false;
        var states = this._states();
        return !Object.keys(states).some(name => name !== room.name && states[name].goal === GOAL_EXPAND);
    }

    static _findExpansionFlag() {
        return MainUtil.findAllFlags().find(flag => !MainUtil.isRemoteFlag(flag)) || null;
    }

    static _standDown(room, state) {
        this._setGoal(room, state, this._chooseEconomicGoal(room, GOAL_DEFENSE));
        this._startMission(room, state, MISSION_REBUILD_WALLS);
        state.plan = this._buildPlan(state);
    }

    static _setGoal(room, state, goal) {
        info.log('Director: ' + room.name + ' ' + state.goal + ' -> ' + goal, room);
        state.goal = goal;
        room.memory.director = { goal: goal };
        // missions belong to the goal that started them
        state.missions = [];
        this._startGoalMissions(room, state);
        state.plan = this._buildPlan(state);
    }

    // --- missions --------------------------------------------------------------------------------

    static _startGoalMissions(room, state) {
        GOAL_MISSIONS[state.goal].forEach(type => this._startMission(room, state, type));
    }

    static _startMission(room, state, type) {
        var spec = MISSIONS[type];
        if (state.missions.some(mission => mission.type === type)) return;
        if (state.retryAfter[type] > Game.time || !spec.canStart(room, state.goal)) return;
        state.missions.push(Object.assign({ type: type, goal: state.goal, startedAt: Game.time }, spec.build(room, state.goal)));
    }

    static _reviewMissions(room, state) {
        var before = state.missions.length;
        state.missions = state.missions.filter(mission => {
            var spec = MISSIONS[mission.type];
            if (Game.time - mission.startedAt >= spec.maxAge) {
                state.retryAfter[mission.type] = Game.time + config.MISSION_RETRY;
                return false;
            }
            return !spec.isDone(room, mission);
        });
        var finished = state.missions.length !== before;
        var running = state.missions.length;
        this._startGoalMissions(room, state);
        if (finished || state.missions.length !== running) state.plan = this._buildPlan(state);
    }

    /*
     * Boost compounds are opt-in: upgrading uses what room.memory.lab.boosts already asks for, and
     * defense loads only what the room holds, so a plan cannot start buying or making them.
     */

    static _getBoostCompounds(room, goal) {
        var wanted = [];
        if (goal === GOAL_DEFENSE) {
            wanted = [RESOURCE_CATALYZED_UTRIUM_ACID, RESOURCE_CATALYZED_KEANIUM_ALKALIDE, RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, RESOURCE_CATALYZED_GHODIUM_ALKALIDE];
        } else {
            var policy = room.memory.lab && room.memory.lab.boosts && room.memory.lab.boosts.Upgrader;
            if (policy && policy[WORK]) wanted = [policy[WORK]];
        }
        return wanted.map(resourceType => ({
            resourceType,
            amount: Math.min(config.BOOST_LOAD_AMOUNT, this._getStock(room, resourceType)),
        })).filter(entry => entry.amount >= config.BOOST_LOAD_MIN && !this._isLoaded(room, entry));
    }

    static _getStock(room, resourceType) {
        return [room.storage, room.terminal].reduce((sum, store) => sum + (store ? store.store.getUsedCapacity(resourceType) : 0), 0);
    }

    static _isLoaded(room, entry) {
        return MainCache.find(room, FIND_MY_STRUCTURES).some(structure => {
            return structure.structureType === STRUCTURE_LAB && structure.store.getUsedCapacity(entry.resourceType) >= entry.amount;
        });
    }

    static _hasWeakWalls(room) {
        return MainCache.find(room, FIND_STRUCTURES).some(structure => {
            return (structure.structureType === STRUCTURE_RAMPART || structure.structureType === STRUCTURE_WALL) &&
                structure.hits < allConfig.DEFENSE.SAFE_RAMPART_HITS;
        });
    }

    // --- plans -----------------------------------------------------------------------------------

    /*
     * Goal first, then each mission on top. Where two overlap the stricter one wins: the higher
     * priority, the lower spawn cap, and false over true for anything a goal has switched off.
     */

    static _buildPlan(state) {
        var plan = Object.assign({}, DEFAULT_PLAN, { priorities: {}, spawnCaps: {}, preload: [] });
        var overlays = [GOAL_PLANS[state.goal]].concat(state.missions.map(mission => MISSIONS[mission.type].plan(mission)));
        overlays.forEach(overlay => {
            Object.keys(overlay).forEach(key => {
                var value = overlay[key];
                if (key === 'priorities') {
                    Object.keys(value).forEach(name => { plan.priorities[name] = Math.max(plan.priorities[name] || 0, value[name]); });
                } else if (key === 'spawnCaps') {
                    Object.keys(value).forEach(role => {
                        plan.spawnCaps[role] = plan.spawnCaps[role] === undefined ? value[role] : Math.min(plan.spawnCaps[role], value[role]);
                    });
                } else if (key === 'preload') {
                    plan.preload = plan.preload.concat(value);
                } else if (key === 'labReactions' || key === 'upgraderBoosts') {
                    plan[key] = plan[key] && value;
                } else {
                    plan[key] = value;
                }
            });
        });
        return Object.freeze(plan);
    }

    // --- state -----------------------------------------------------------------------------------

    static _states() {
        return MainHeap.namespace('director');
    }

    /*
     * After a global reset only the goal survives, from Memory. Missions are started again from it.
     * A room that was defending stays so until it has been clear for the full time. A wall mission
     * lost to a reset is not restarted; the Handyman levels walls regardless, only not first.
     */

    static _getState(room) {
        var states = this._states();
        if (states[room.name]) return states[room.name];
        var saved = room.memory.director && room.memory.director.goal;
        var goal = GOALS.includes(saved) ? saved : GOAL_UPGRADE;
        var state = { goal: goal, missions: [], plan: DEFAULT_PLAN, retryAfter: {}, lastHostileAt: Game.time };
        this._startGoalMissions(room, state);
        state.plan = this._buildPlan(state);
        states[room.name] = state;
        return state;
    }
}

DirectorManager.GOAL_UPGRADE = GOAL_UPGRADE;
DirectorManager.GOAL_STOCKPILE = GOAL_STOCKPILE;
DirectorManager.GOAL_DEFENSE = GOAL_DEFENSE;
DirectorManager.GOAL_EXPAND = GOAL_EXPAND;
DirectorManager.MISSION_BOOST_QUEUE = MISSION_BOOST_QUEUE;
DirectorManager.MISSION_MARKET_DUMP = MISSION_MARKET_DUMP;
DirectorManager.MISSION_REBUILD_WALLS = MISSION_REBUILD_WALLS;
DirectorManager.MISSION_CLAIM_ROOM = MISSION_CLAIM_ROOM;
DirectorManager.FACTORY_NORMAL = FACTORY_NORMAL;
DirectorManager.FACTORY_DECOMPRESS = FACTORY_DECOMPRESS;
DirectorManager.FACTORY_PAUSE = FACTORY_PAUSE;

module.exports = DirectorManager;
