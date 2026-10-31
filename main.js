/*
 * The main loop of the game. 
 */

var MainUtil = require('./main.util');
var MainInfo = require('./main.info');
var MainCache = require('./main.cache');
var MainConfig = require('./main.config');
var MainScheduler = require('./main.scheduler');

var BaseManager = require('./manager.base');
var CpuManager = require('./manager.cpu');
var DefenseManager = require('./manager.defense');
var LinkManager = require('./manager.link');
var LogisticsManager = require('./manager.logistics');
var MayorManager = require('./manager.mayor');
var MemoryManager = require('./manager.memory');
var IntelManager = require('./manager.intel');
var RemoteManager = require('./manager.remote');
var FactoryManager = require('./manager.factory');
var LabManager = require('./manager.lab');
var TerminalManager = require('./manager.terminal');
var MarketManager = require('./manager.market');
var RoadManager = require('./manager.road');
var RoomManager = require('./manager.room');
var TowerManager = require('./manager.tower');

var Explorer = require('./role.explorer');
var Miner = require('./role.miner');

var TileArray = require('./tile.array');

const MAYOR_INTERVAL = 10;

// roles hold no state between ticks, so one set serves until the next global reset
var allRoles = null;

// The order is the tick order. Towers and links run ahead of spawning so that a problem in the
// economy can never cost us our defense.
const JOBS = [
    { name: 'initRound()', run: () => MemoryManager.initRound(allRoles) },
    { name: 'MainCache', run: () => MainCache.initRound(allRoles) },
    { name: 'IntelManager', tier: CpuManager.TIER_DEGRADED, run: () => IntelManager.runAll() },
    { name: 'RemoteManager', tier: CpuManager.TIER_DEGRADED, run: () => RemoteManager.runAll(CpuManager.shouldRunDeferred()) },
    { name: 'DefenseManager', run: () => DefenseManager.runAll() },
    { name: 'TowerManager', run: () => TowerManager.runAll() },
    { name: 'LinkManager', run: () => LinkManager.runAll() },
    { name: 'FactoryManager', tier: CpuManager.TIER_DEGRADED, run: () => FactoryManager.runAll() },
    { name: 'LabManager', tier: CpuManager.TIER_DEGRADED, run: () => LabManager.runAll() },
    { name: 'TerminalManager', tier: CpuManager.TIER_DEGRADED, run: () => TerminalManager.runAll() },
    { name: 'MarketManager', tier: CpuManager.TIER_DEGRADED, run: () => MarketManager.runAll(CpuManager.shouldRunDeferred()) },
    { name: 'LogisticsManager', run: () => LogisticsManager.runAll() },
    { name: 'BaseManager', run: () => BaseManager.runAll(allRoles) },
    { name: 'RoadManager', tier: CpuManager.TIER_NORMAL, run: () => RoadManager.watchAllRooms() },
    { name: 'MayorManager', tier: CpuManager.TIER_NORMAL, every: MAYOR_INTERVAL, run: () => MayorManager.runAll() },
    { name: 'Visuals', tier: CpuManager.TIER_NORMAL, enabled: () => MainConfig.getSetting('visuals'), run: () => {
        MainInfo.visualize();
        CpuManager.visualize();
    } },
    { name: 'Stats', run: () => CpuManager.collectStats() },
];

module.exports.loop = function () {
    if (!allRoles) {
        allRoles = BaseManager.fetchAllRoles();
        MainInfo.log('Screepsworld ' + MainConfig.VERSION + ' loaded');
    }
    CpuManager.initRound();
    MainScheduler.run(JOBS);
}

// A count above zero is a floor over what the room derives. Zero means the operator wants none.
function applyManualCount(roleConfig, count) {
    roleConfig.requiredNumber = count;
    if (count === 0) roleConfig.auto = false;
    else delete roleConfig.auto;
}

// some helper methods to make managing this thing more easily

/*
 * Changes a console setting, e.g. setSetting('visuals', false). See main.config.js for the list.
 *
 * @param name
 * @param value
 */

global.setSetting = function (name, value) {
    if (!MainConfig.isSetting(name)) {
        MainInfo.error('Unknown setting: ' + name);
        return false;
    }
    if (!Memory.settings) Memory.settings = {};
    Memory.settings[name] = value;
    return true;
};

/*
 * Prints average CPU, the bucket trend and the most expensive jobs from the stored history.
 */

global.cpuReport = function () {
    return CpuManager.getStatsReport();
};

/*
 * Shows which version of the code the shard is running.
 */

global.version = function () {
    return MainConfig.VERSION;
};

/*
 * Prints the oldest creep with its ticks to live to the console.
 * 
 * @param baseName
 */

global.fetchOldestCreep = function (baseName) {
    var oldestCreep = MainUtil.findAllCreeps().
        filter(creep => (!baseName || creep.memory.home == baseName)).
        sort((a, b) => { return a.ticksToLive - b.ticksToLive });

    if (oldestCreep.length > 0) {
        MainInfo.log('Oldest creep: ' + oldestCreep[0].name + ' (' + oldestCreep[0].ticksToLive + ' ttl)');
        return oldestCreep[0];
    }
    MainInfo.error('No creep found.');
    return null;
};

/*
 * Spawns a miner for a specific source.
 * 
 * @param spawnId
 * @param sourceId
 */

global.spawnMiner = function (spawnId, sourceId) {
    return new Miner().spawnCreepFromSpawnName(spawnId, sourceId);
};

/*
 * Spawns a explorer for a specific flag.
 * 
 * @param spawnId
 * @param flagName
 */

global.spawnExplorer = function (spawnId, flagName) {
    return new Explorer().spawnCreepFromSpawnName(spawnId, flagName);
};

/*
 * Spawns a specific role for a room
 * 
 * @param roomName
 * @param roleName
 */

global.spawnCreepForRoom = function (roomName, roleName) {
    var room = Game.rooms[roomName];
    if (room) {
        return new BaseManager(room).spawnCreepForRoleName(roleName);
    }
    MainInfo.error('Could not find room: ' + roomName);
    return false;
};

/*
 * Adds the type 'target' to the game object with the specified ID.
 * 
 * @param linkId
 */

global.makeLinkTarget = function (linkId) {
    LinkManager.makeLinkTarget(linkId);
};

/*
 * Adds the type 'source' to the game object with the specified ID.
 * 
 * @param linkId
 */

global.makeLinkSource = function (linkId) {
    LinkManager.makeLinkSource(linkId);
};

/*
 * Moves the creep back to a spawn and self-destructs it.
 * 
 * @param creepName
 */

global.selfdestruct = function (creepName) {
    var creep = Game.creeps[creepName];
    if (!creep) {
        MainInfo.error('Could not find creep: ' + creepName);
        return;
    }
    creep.memory.selfdestruct = true;
};

/*
 * Moves the creep to a specific game object.
 * 
 * @param creepName
 * @param gameObjectId
 */

global.moveCreepTo = function (creepName, gameObjectId) {
    var creep = Game.creeps[creepName];
    if (!creep) {
        MainInfo.error('Could not find creep: ' + creepName);
        return;
    }
    if (!Game.getObjectById(gameObjectId)) {
        MainInfo.error('Could not find game object: ' + gameObjectId);
        return;
    }
    creep.memory.moveToGameObject = gameObjectId;
};

/*
 * Sets the required number of creeps for a specific role in a room.
 * 
 * @param roomName - the name of the room
 * @param roleName - the role name (e.g., 'Harvester', 'Upgrader', 'Builder')
 * @param count - the number of creeps required
 */

global.setCreepCount = function (roomName, roleName, count) {
    var room = Game.rooms[roomName];
    if (!room) {
        MainInfo.error('Could not find room: ' + roomName);
        return false;
    }
    if (!room.memory.base) {
        MainInfo.error('Room ' + roomName + ' does not have a base.');
        return false;
    }
    if (!room.memory.base.roleConfig[roleName]) {
        MainInfo.error('Could not find role: ' + roleName);
        return false;
    }
    applyManualCount(room.memory.base.roleConfig[roleName], count);
    MainInfo.log('Set ' + roleName + ' count to ' + count + ' in room ' + roomName);
    return true;
};

/*
 * Sets the required number of creeps for multiple roles in a room.
 * 
 * @param roomName - the name of the room
 * @param roleNames - array of role names (e.g., ['Harvester', 'Upgrader', 'Builder'])
 * @param count - the number of creeps required for each role
 */

global.setMultipleCreepCounts = function (roomName, roleNames, count) {
    var room = Game.rooms[roomName];
    if (!room) {
        MainInfo.error('Could not find room: ' + roomName);
        return false;
    }
    if (!room.memory.base) {
        MainInfo.error('Room ' + roomName + ' does not have a base.');
        return false;
    }

    var successCount = 0;
    roleNames.forEach(roleName => {
        if (room.memory.base.roleConfig[roleName]) {
            applyManualCount(room.memory.base.roleConfig[roleName], count);
            successCount++;
        } else {
            MainInfo.error('Could not find role: ' + roleName);
        }
    });

    MainInfo.log('Set ' + successCount + ' roles to ' + count + ' creeps each in room ' + roomName);
    return true;
};


/*
 * Clears the lines of the JavaScript and in-game consoles.
 */

global.clearConsole = function () {
    MainInfo.clearLines();
};

/*
 * Creates the editable layout in the memory of the room. Will override previous layouts.
 * 
 * @param roomName 
 * @param array {TileArray} (or nothing)
 */

global.generateLayoutForRoom = function (roomName, array = new TileArray(50, 50)) {
    var room = Game.rooms[roomName];
    if (room) {
        var layout = RoomManager.generateLayoutForRoom(room, array);
        var cellCount = array.width * array.height;
        var cellWidth = cellCount > 0 ? layout.length / cellCount : 0;
        if (!Number.isInteger(cellWidth) || cellWidth < 1) {
            MainInfo.error('Could not format layout for room: ' + roomName);
            return false;
        }
        var rowLength = array.width * cellWidth;
        var rows = [];
        for (var position = 0; position < layout.length; position += rowLength) {
            rows.push(layout.substring(position, position + rowLength));
        }
        return rows.join('\n');
    }
    MainInfo.error('Could not find room: ' + roomName);
    return false;
};
