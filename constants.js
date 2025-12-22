module.exports = {
    // Role names
    ROLE_WORKER: 'worker',
    ROLE_HARVESTER: 'harvester',
    ROLE_UPGRADER: 'upgrader',
    ROLE_BUILDER: 'builder',
    ROLE_HAULER: 'hauler',
    ROLE_WARRIOR: 'warrior',

    ROLE_REMOTE_HARVESTER: 'remote_harvester',

   
    // Limits
    MAX_WORKERS: 0, // Phasing out the generalist
    MAX_HARVESTERS: 2,
    MAX_HAULERS: 2,
    MAX_UPGRADERS: 2,
    MAX_BUILDERS: 2,
    MAX_REMOTE_HARVESTERS: 0,

 
    // Remote Logistics
    REMOTE_CONFIG: {
        'E58N16': 'E58N15' // Home Room -> Remote Room
    },

    // Rooms where spawning is completely disabled
    SPAWN_RESTRICTED_ROOMS: [],

    // Spawn thresholds
    SPAWN_ENERGY_WAIT_THRESHOLD: 800,

    // Worker tier thresholds (percentage of container capacity)
    WORKER_TIER_1_THRESHOLD: 0.5,  // < 50%
    WORKER_TIER_2_THRESHOLD: 0.7,  // 50-70%
    // > 70% = Tier 3

    // Worker tier energy costs
    WORKER_TIER_1_ENERGY: 400,  // 2 segments
    WORKER_TIER_2_ENERGY: 800,  // 4 segments
    // Tier 3 uses full available energy

    // Repair thresholds
    RAMPART_REPAIR_THRESHOLD: 40000,
    WALL_REPAIR_THRESHOLD: 5000,
    TOWER_REPAIR_THRESHOLD: 102000, // Towers repair up to 10k HP
    STRUCTURE_REPAIR_THRESHOLD: 0.8,
    ROAD_REPAIR_THRESHOLD: 0.5,

    // Tower thresholds
    TOWER_ENERGY_RATIO_REPAIR: 0.5,
    TOWER_REFILL_THRESHOLD: 0.8, // Refill towers when energy is below 80%

    // Source capacities (max harvesters per source ID)
    SOURCE_CAPACITY: {
        '5bbcb08c9099fc012e63c56e': 1,
        '5bbcb08c9099fc012e63c570': 1
    },

    // Other
    CONSTRUCTION_CHECK_INTERVAL: 10,

    // Role symbols for GUI
    ROLE_SYMBOLS: {
        'worker': '🛠️',
        'harvester': '⛏️',
        'upgrader': '⚡',
        'builder': '🔨',
        'hauler': '📦',
        'warrior': '⚔️',
        'ranged': '🏹',
        'healer': '💚'
    },

    // GUI Color Schemes
    GUI_COLORS: {
        STATUS_GOOD: '#00ff88',
        STATUS_WARNING: '#ffaa00',
        STATUS_DANGER: '#ff4444',
        STATUS_INFO: '#00d4ff',
        BG_DARK: '#1a1a2e',
        BG_GRADIENT: '#0f3460',
        BG_BORDER: '#16213e'
    }
};
