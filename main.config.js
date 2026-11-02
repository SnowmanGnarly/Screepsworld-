// @ts-check
/*
 * Tunable policy lives here, grouped by the subsystem it steers. Three things do not belong in
 * this file: game rules (use the engine constants), values that follow from game state (derive
 * them in manager.economy), and per-room overrides (room.memory).
 */

const SETTING_DEFAULTS = {
	visuals: true, // room overlays: role list, console and CPU panel
	pathVisuals: false, // draw every creep's path, which costs CPU on each move
	creepIcons: false, // draw a role icon on every creep
};

module.exports = {
	VERSION: '1.11.1', // keep in step with package.json; version() shows what the shard is running

	ROLE_PRIORITY: { // spawn order, the higher the sooner. Local roles all come before mission creeps
		Harvester: 100, Defender: 90, Miner: 85, Storekeeper: 75, Builder: 70, Upgrader: 50, Courier: 40,
		MineralMiner: -1, RemoteHauler: -5, RemoteMiner: -10, Reserver: -15, Scout: -20,
	},

	CPU: {
		CRITICAL_BUCKET: 200, // below this only defense, logistics, spawning and creeps run
		DEGRADED_BUCKET: 1000, // below this only that, intel, remote safety and boost upkeep run
		RECOVERED_BUCKET: 1500, // above this deferred work resumes
		STATS_INTERVAL: 10, // ticks averaged into one stats sample
		STATS_SAMPLES: 60, // samples kept in Memory.stats
		STATS_TOP_JOBS: 5, // jobs stored per sample, most expensive first
		ERROR_LOG_INTERVAL: 50, // ticks between repeated reports of one failing job
		NOTIFY_INTERVAL: 1000, // ticks between emails about one problem
		NOTIFY_GROUP_MINUTES: 60, // the game bundles emails that arrive within this time
		NOTIFY_PER_TICK: 20, // the game's limit on Game.notify calls in one tick; it drops the rest. No engine constant holds it
		NOTIFY_QUEUE_LIMIT: 100, // emails that may wait on the heap for a later tick
		TICK_MARGIN: 0.1, // share of the tick's CPU limit kept free, so the tick always finishes
	},

	SPAWN: {
		RECOVERY_ENERGY_RESERVE: 450, // spending floor while only one Harvester is active
		LAST_HARVESTER_TTL: 100, // replace the last Harvester once it is this close to death
		PRESPAWN_MARGIN: 50, // extra ticks added to spawn time when replacing a creep, covering travel
		MAX_WAIT_TICKS: 150, // how long a request may hold energy back for a full-size body
		MISSION_REQUEST_LIMIT: 100, // requests read from one provider per tick
		LOCAL_PRIORITY_OFFSET: 100, // lifts every local role above all mission requests
	},

	ECONOMY: {
		WORKERS_FALLBACK: 2, // Storekeepers wanted when there is no route to measure yet
		WORKERS_MAX: 6, // upper bound on derived Storekeepers per room
		PATH_FACTOR: 1.3, // straight-line range to estimated path length, when no path can be measured
		ROUTE_TTL: 5000, // ticks before a measured route length is measured again
		UPGRADER_MAX: 5, // upper bound on derived Upgraders per room
		ENERGY_RESERVE_MINIMUM: 50000, // storage plus terminal energy that workers, labs and factories never spend; room.memory.terminal.emergencyReserve overrides it
		ENERGY_RESERVE_BY_RCL: { 4: 5000, 5: 20000 }, // a lower line while a room is still growing: the full one would stop it building for thousands of ticks, its first tower included
		CONTROLLER_DOWNGRADE_GUARD: 5000, // ticks to downgrade below which an Upgrader may draw on the reserve
		UPGRADER_STORAGE_STEP: 100000, // stored energy above the reserve that pays for one more Upgrader
		UPGRADER_CONTAINER_FLOOR: 1000, // energy in containers before adding Upgraders, while there is no storage
		UPGRADE_INCOME_SHARE: 0.6, // share of mined income spent on the controller; the rest pays for creeps
		BUILDER_MAX: 3, // upper bound on derived Builders per room
		BUILDER_PROGRESS_STEP: 5000, // remaining build progress that justifies one more Builder
		HARVESTERS_PER_SOURCE_MAX: 3, // more than this crowd a source for little extra energy
		SOURCE_DROP_RANGE: 2, // range at which a container or link counts as serving a source
		WORKER_STORE_MIN: 1000, // energy elsewhere in the room before workers leave source containers to the haulers
		HUB_LINK_RANGE: 2, // range at which a receiving link counts as beside the storage
		MINER_WALK_RANGE: 7, // how far a Miner with no drop-off beside it walks to a store
		REPAIR_RATIO: 0.95, // a Handyman repairs roads and containers below this share of their hits
		REPAIR_DEMAND_RATIO: 0.5, // and a Handyman is only worth spawning once they fall below this
		LOOT_RANGE: 3, // how far a creep in a room with no haulers goes for loot
		SPENDING_SHARE: 0.5, // share of source income one Upgrader or Handyman may spend per tick
		HAULER_MIN_CARRY: 5, // CARRY parts on a Storekeeper before distance asks for more
	},

	BODY: {
		DEFAULT_UNITS: 5, // body repeats for roles whose useful size does not follow from game state
	},

	DEFENSE: {
		THREAT_WEIGHTS: { heal: 150, ranged: 120, attack: 100, work: 80 },
		DEFENDER_POWER: { heal: 100, ranged: 120, attack: 100 },
		BOOSTED_THREAT_MULTIPLIER: 2,
		INVADER_CORE_SCORE: 500,
		HOSTILE_STRUCTURE_SCORE: 200,
		PROXIMITY_RANGE: 20, // hostiles closer than this to the core add to the score
		PROXIMITY_WEIGHT: 10,
		LEVEL_2_SCORE: 200,
		LEVEL_3_CORE_RANGE: 4,
		SAFE_MODE_BREACH_RANGE: 3,
		SAFE_RAMPART_HITS: 20000, // a rampart this strong still protects what it covers
		EMERGENCY_RAMPART_HITS: 10000, // towers repair ramparts below this
		ALERT_INTERVAL: 100,
		MAX_LOCAL_DEFENDERS: 2,
		SECOND_DEFENDER_SCORE: 600,
		DEFENDER_THREAT_LEVEL: 2, // threat level at which Defenders are called for
		WALL_REPAIR_BASE_HITS: 10000, // a Handyman's wall target at RCL 1, doubling with each level
		WALL_REPAIR_MAX_HITS: 1000000,
		WALL_REPAIR_THREAT_MULTIPLIER: 5,
		TOWER_ENERGY_RESERVE: 200, // energy towers keep for attacking when they heal or repair
		TOWER_EMERGENCY_REPAIR_RATIO: 0.25,
	},

	LOGISTICS: {
		PRIORITY: {
			CORE: 100, TOWER_UNDER_ATTACK: 95, SALVAGE: 85, DROPPED: 80, LEGACY_ROUTE: 80, CONTAINER: 75,
			LAB_BOOST: 72, HUB_LINK: 70, LAB_OUTPUT: 65, LAB_ENERGY: 65, TOWER: 60, LAB_INPUT: 60, FACTORY: 60, STOCK_POLICY: 30,
		},
		TOWER_REFILL_FREE: 200, // tower capacity free before a refill is requested
		LAB_REFILL_FREE: 400,
		LAB_INPUT_DEFAULT: 1000,
		CONTAINER_COLLECT_MIN: 400,
		DROPPED_COLLECT_MIN: 100,
		RETRY_TICKS: 5,
		LINK_COLLECT_MIN: 200, // energy in the storage-side link worth a hauler's trip
		CLAIM_TIMEOUT: 150, // ticks a hauler may hold a task without moving any cargo
	},

	REMOTE: {
		DEFENDER_UNITS: 8, // body repeats on an outpost defender, within what the room can pay for
		HAULER_PAIRS_MAX: 16, // CARRY, CARRY, MOVE repeats on the largest hauler, the 50 part limit
		HAULER_TICKS_PER_TILE_LOADED: 2, // one MOVE per two CARRY moves every second tick when full
	},

	HEAP: {
		MAX_ENTRIES: 500, // bound on cached values across all rooms
	},

	LAB: {
		ACQUIRE_TIMEOUT: 1500, // ticks a goal may wait on imports without any arriving
		REACT_STALL: 600, // ticks a goal may hold stocked reagents without producing
		BLOCK_TICKS: 1000, // ticks a goal that could not proceed is skipped, so the next one can run
		MAX_PLANS_PER_SELECT: 4, // recipe trees walked in one selection
		PLAN_SCALE_PASSES: 3, // attempts to shrink a batch to the reagents that can be obtained
		MIN_BATCH: 100, // a smaller derived batch is not worth clearing the labs for
		DEMAND_TTL: 3000, // ticks a seen boost request keeps its stock topped up, about two creep lifetimes
		BOOST_SPAWNS_AHEAD: 2, // spawns of the largest seen body to keep stocked per compound
		PRICE_TTL: 5000, // ticks between reads of market history
		MIN_PROFIT_RATE: 1, // credits per reaction cooldown tick below which profit goals are ignored
		PRELOAD_TTL: 500, // ticks without a spawn attempt before a pre-loaded lab is released; a role may be saving energy
	},

	FACTORY: {
		IMPORT_TIMEOUT: 1500, // ticks a goal may wait on imports without any arriving
		PRODUCE_STALL: 600, // ticks a goal may wait without producing, longer than any recipe's cooldown
		BLOCK_TICKS: 1000, // ticks a goal that could not proceed is skipped, so the next one can run
	},

	DIRECTOR: {
		EVALUATE_INTERVAL: 50, // ticks between a room's looks at its economic goal; rooms take different ticks
		MISSION_INTERVAL: 10, // ticks between checks on whether a room's missions have finished
		DEFENSE_CLEAR_TICKS: 20, // ticks without a dangerous hostile before a room stands down
		STOCKPILE_ENTER: { 4: 20000, 5: 50000, 6: 100000, 7: 150000, 8: 200000 }, // stored energy below which a room saves up, by RCL
		STOCKPILE_EXIT_MARGIN: 50000, // saved above the entry level before a room spends again, so it does not flip-flop
		EXPAND_MIN_ENERGY: 300000, // stored energy a room must have to pay for a new one
		EXPAND_BUCKET: 9000, // a new room costs CPU for good, so only a full bucket may start one
		TOWER_PRIORITY: 120, // logistics priority for towers under GOAL_DEFENSE, above everything else
		LAB_BOOST_PRIORITY: 110, // logistics priority for loading labs during a MISSION_BOOST_QUEUE
		BOOST_LOAD_AMOUNT: 900, // compound loaded per lab: 30 boosted parts
		BOOST_LOAD_MIN: 30, // stock below this cannot boost one part, so a mission is not worth starting
		MISSION_RETRY: 1000, // ticks before a mission that timed out may start again
	},

	MEMORY: {
		MEASURE_INTERVAL: 100, // ticks between readings of the serialized memory size
		SIZE_WARNING_BYTES: 1500000, // serialized size that warns before the game's memory limit
		SIZE_WARNING_PAUSE: 500, // ticks between those warnings
		INTEL_CLEANUP_INTERVAL: 10, // ticks between cleanups of empire intel, missions and requests
		INTEL_CLEANUP_PHASE: 7,
		ROOM_PRUNE_INTERVAL: 1000, // ticks between cleanups of memory for rooms we no longer use
		ROOM_PRUNE_PHASE: 533, // keeps the cleanups off the ticks that other periodic work runs on
		STUCK_PRUNE_INTERVAL: 100, // ticks between cleanups of heap state for dead creeps
		STUCK_PRUNE_PHASE: 50,
	},

	MOVEMENT: {
		STUCK_TICKS: 2, // ticks without moving before a creep repaths around traffic
		STUCK_REPATH_PAUSE: 8, // further ticks before a creep that is still stuck may repath again
		LONG_REUSE_PATH: 20, // path reuse when walking to another room
		NEAR_RANGE: 3, // within this range of the target, other creeps count as obstacles
		PATH_TTL: 50, // ticks before a stored path is searched again, since the room may have changed
	},

	PLANNER: {
		MAX_RCL: 8,
		INTERVAL: 10, // ticks between a room's Mayor runs; rooms take different ticks
		MAX_OPEN_SITES: 2, // open non-road construction sites per room
		SOURCE_CONTAINER_RCL: 3, // the first level whose capacity pays for a full-size Miner
		RAMPART_RCL: 4, // the first level with a storage to pay for keeping a wall repaired
		RAMPART_MARGIN: 3, // free tiles between a building and the wall, the reach of a ranged attack
		RAMPART_PLAN_BUCKET: 5000, // bucket needed for the one expensive search behind a wall plan
	},

	/** @param {string} name */
	getSetting(name) {
		var settings = typeof Memory !== 'undefined' && /** @type {any} */ (Memory).settings;
		return settings && settings[name] !== undefined ? settings[name] : /** @type {any} */ (SETTING_DEFAULTS)[name];
	},

	/** @param {string} name */
	isSetting(name) {
		return Object.prototype.hasOwnProperty.call(SETTING_DEFAULTS, name);
	},
};
