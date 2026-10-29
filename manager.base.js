/*
 * A base is a 'virtual' construct. It most closely resembles a 'room'.
 * BaseManager manages role instantiation, repopulation, emergency recovery,
 * and creep execution.
 */
 
var MainUtil = require('./main.util');
var info = require('./main.info');

var Harvester = require('./role.harvester');
var Builder = require('./role.builder');
var Courier = require('./role.courier');
var Upgrader = require('./role.upgrader');
var Handman = require('./role.handyman');
var Explorer = require('./role.explorer');
var Miner = require('./role.miner');
var MineralMiner = require('./role.miner.mineral');
var StoreKeeper = require('./role.storekeeper');
var Defender = require('./role.defender');
var Scout = require('./role.scout');
var Reserver = require('./role.reserver');
var RemoteMiner = require('./role.remoteMiner');
var RemoteHauler = require('./role.remoteHauler');

var MemoryManager = require('./manager.memory');
var MainCache = require('./main.cache');
var LogisticsManager = require('./manager.logistics');
var MineralManager = require('./manager.mineral');
var LabManager = require('./manager.lab');

class BaseManager {
	
	static runAll(allRoles = BaseManager.fetchAllRoles()) {
	    MainUtil.findAllRooms().forEach(room => new BaseManager(room, allRoles).runBase());
	}
    
	static fetchAllRoles() {
		return [
	    	new Harvester(), 
	    	new Defender(),
	    	new Builder(), 
	    	new Upgrader(), 
	    	new Handman(), 
	    	new Explorer(), 
	    	new Miner(),
		    new MineralMiner(),
	    	new StoreKeeper(),
	    	new Courier(),
		    new Scout(),
		    new Reserver(),
		    new RemoteMiner(),
		    new RemoteHauler(),
	    ].sort((a, b) => b.priority - a.priority);
	}
	
	static registerMissionSpawnProvider(name, provider) {
		if (!name || !provider) return false;
		this._missionSpawnProviders.set(name, provider);
		return true;
	}

	static unregisterMissionSpawnProvider(name) {
		this._missionSpawnProviders.delete(name);
	}

	constructor(room, allRoles = BaseManager.fetchAllRoles()) {
	    this._room = room;
	    this._defaultRole = new Harvester();
	    this._allRoles = allRoles;
	    this._rolesByName = new Map(allRoles.map(role => [role.roleName, role]));
	}

    runBase() {  
    	if (this._room.memory.base) {
	        this._repopulateCreeps();
	        this._showSpawningAnimation();
	        this._moveCreeps();
    	}
    }

    _repopulateCreeps() {    
    	var baseName = this._room.memory.base.name;
    	var homeCreeps = MainCache.getCreepsByHome(baseName);
    	if (homeCreeps.length == 0) {
    		var emergencyCreep = this._spawnCreepForRole(this._defaultRole, { emergency: true });
    		if (!emergencyCreep) {
    			this._warnAboutRecovery();
    		}
    		return;
    	}

    	var harvester = this._rolesByName.get('Harvester') || this._defaultRole;
    	var upgrader = this._rolesByName.get('Upgrader');
    	var bootstrapRole = null;
    	if (!homeCreeps.some(creep => creep.memory.role == 'Harvester')) {
    		bootstrapRole = harvester;
    	} else if (upgrader && !homeCreeps.some(creep => creep.memory.role == 'Upgrader')) {
    		bootstrapRole = upgrader;
    	}
    	if (bootstrapRole) {
    		this._spawnCreepForRole(bootstrapRole);
    		return;
    	}
    	if (this._processMinerReplacements(baseName)) {
    		return;
    	}

    	var activeHarvesters = homeCreeps.filter(creep => creep.memory.role == 'Harvester' && !creep.spawning);
    	if (activeHarvesters.length === 1 && activeHarvesters[0].ticksToLive < 100) {
    		this._spawnCreepForRole(harvester);
    		return;
    	}
    	var preserveRecoveryReserve = activeHarvesters.length === 1;

    if (this._processMissionSpawnRequests(baseName, preserveRecoveryReserve)) {
			return;
		}

	    var alreadySpawned = false;
        this._allRoles.forEach(role => {
        	if (alreadySpawned) return;
            var foundNumber = MainCache.getCreepCount(baseName, role.roleName);
            var requiredNumber = MemoryManager.getRequiredNumberForRoomAndRole(this._room, role.roleName);
            if (role.roleName == 'Storekeeper' || role.roleName == 'Courier') {
                var roleConfig = this._room.memory.base.roleConfig[role.roleName] || {};
                var maxNumber = roleConfig.maxNumber === undefined ? (role.roleName == 'Storekeeper' ? 2 : 1) : roleConfig.maxNumber;
                var desiredNumber = LogisticsManager.getDesiredWorkerCount(this._room, role.roleName);
                requiredNumber = Math.max(requiredNumber, Math.min(desiredNumber, maxNumber));
            }
            if (role.roleName == 'MineralMiner') {
                var mineralConfig = this._room.memory.base.roleConfig.MineralMiner || {};
                var maxMiners = mineralConfig.maxNumber === undefined ? 1 : mineralConfig.maxNumber;
                var desiredMiners = MineralManager.getDesiredMinerCount(this._room);
                requiredNumber = Math.max(requiredNumber, Math.min(desiredMiners, maxMiners));
            }
            if (role.roleName == 'Defender') {
                foundNumber = MainCache.getCreepsByHome(baseName).filter(creep => {
                    return creep.memory.role === 'Defender' && !creep.memory.missionId;
                }).length;
                var defenderConfig = this._room.memory.base.roleConfig.Defender || {};
                var maxDefenders = defenderConfig.maxNumber === undefined ? 2 : defenderConfig.maxNumber;
                var desiredDefenders = this._room.memory.defense ? this._room.memory.defense.desiredDefenders || 0 : 0;
                requiredNumber = Math.max(requiredNumber, Math.min(desiredDefenders, maxDefenders));
            }
            if (foundNumber < requiredNumber && role.isNecessary(this._room)) {
            	if (preserveRecoveryReserve && role.roleName != 'Harvester' && this._room.energyAvailable < 450) {
            		return;
            	}
                if (this._spawnCreepForRole(role)) {
                	alreadySpawned = true;
                }
            }
        });
    }

    _processMinerReplacements(baseName) {
        if (!Memory.minerReplacements) return false;
        var requestNames = Object.keys(Memory.minerReplacements).filter(name => {
            return Memory.minerReplacements[name].home === baseName;
        }).sort((a, b) => {
            return Memory.minerReplacements[a].created - Memory.minerReplacements[b].created;
        });
        for (var requestName of requestNames) {
            var request = Memory.minerReplacements[requestName];
            var requester = Game.creeps[requestName];
            if (!requester || requester.memory.trainedReplacement || !request.sourceId) {
                delete Memory.minerReplacements[requestName];
                continue;
            }
            var miner = this._rolesByName.get('Miner');
            if (!miner) {
                delete Memory.minerReplacements[requestName];
                continue;
            }
            var spawn = this._fetchFreeSpawn(baseName);
            if (!spawn && this._room.memory.base.outsourceSpawn) {
                spawn = this._fetchFreeSpawn();
            }
            if (spawn) {
                var resultingCreep = miner._spawnCreepFromSpawn(spawn, request.sourceId);
                if (resultingCreep) {
                    resultingCreep.memory.home = baseName;
                    requester.memory.trainedReplacement = true;
                    delete Memory.minerReplacements[requestName];
                    if (spawn.memory.debug) {
                        info.log(miner.symbol + ' Spawning replacement Miner (' + resultingCreep.body.length + 'p)', this._room);
                    }
                }
            }
            return true;
        }
        return false;
    }

    _processMissionSpawnRequests(baseName, preserveRecoveryReserve) {
        if (preserveRecoveryReserve && this._room.energyAvailable < 450) return false;
        var requests = [];
        BaseManager._missionSpawnProviders.forEach((provider, providerName) => {
            try {
                var produced = typeof provider === 'function'
                    ? provider(baseName, this._room)
                    : provider.getSpawnRequests(baseName, this._room);
                (produced || []).slice(0, 100).forEach(request => {
                    if (request && request.home === baseName) requests.push({ request, provider, providerName });
                });
            } catch (error) {
                info.error('Mission spawn provider ' + providerName + ' failed: ' + error, this._room);
            }
        });
        requests.sort((a, b) => (b.request.priority || 0) - (a.request.priority || 0) ||
            (a.request.created || 0) - (b.request.created || 0) || String(a.request.id).localeCompare(String(b.request.id)));
        var seen = new Set();
        for (var entry of requests) {
            var key = entry.request.id || entry.providerName + ':' + entry.request.role;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!this._rolesByName.has(entry.request.role)) continue;
            var resultingCreep = this._spawnMissionRequest(entry);
            if (resultingCreep) return true;
        }
        return false;
    }

    _spawnMissionRequest(entry) {
        var request = entry.request;
        var role = this._rolesByName.get(request.role);
        var spawn = this._fetchFreeSpawn(this._room.memory.base.name);
        if (!spawn && this._room.memory.base.outsourceSpawn) spawn = this._fetchFreeSpawn();
        if (!spawn) return false;
        var resultingCreep = role.spawnMissionCreep(spawn, request);
        if (!resultingCreep) return false;
        resultingCreep.memory.home = this._room.memory.base.name;
        if (entry.provider && typeof entry.provider.onSpawn === 'function') {
            entry.provider.onSpawn(request, resultingCreep);
        }
        if (spawn.memory.debug) {
            info.log(role.symbol + ' Spawning mission ' + role.roleName + ' (' + resultingCreep.body.length + 'p)', this._room);
        }
        return resultingCreep;
    }

    _warnAboutRecovery() {
    	var lastWarning = this._room.memory.base.recoveryWarningAt;
    	if (lastWarning && Game.time - lastWarning < 20) {
    		return;
    	}
    	this._room.memory.base.recoveryWarningAt = Game.time;
    	info.warning('Emergency Harvester recovery needs a free eligible spawn with 200 available energy.', this._room);
    }

    _spawnCreepForRole(role, options = {}) {    
        var freeSpawn = this._fetchFreeSpawn(this._room.memory.base.name);
        if (freeSpawn) {
            var resultingCreep = role.spawnCreep(freeSpawn, options);
            if (resultingCreep && freeSpawn.memory.debug) {
            	info.log(role.symbol + ' Spawning new ' + role.roleName + ' (' + resultingCreep.body.length + 'p)', this._room);
            }
            return resultingCreep;
        } else if (this._room.memory.base.outsourceSpawn) {
            var outsourceSpawn = this._fetchFreeSpawn();
            if (outsourceSpawn) {
                var resCreep = role.spawnCreep(outsourceSpawn, options);
                if (resCreep) {
                	resCreep.memory.home = this._room.memory.base.name;
                	if (outsourceSpawn.memory.debug) {
                		info.log(role.symbol + ' Spawning new ' + role.roleName + ' (' + resCreep.body.length + 'p)', this._room);
                	}
                }
                return resCreep;
            }
        }
        return false;
    }

    spawnCreepForRoleName(roleName) {
	    var roles = this._allRoles.filter(role => role.roleName == roleName);
	    if (roles.length > 0) {
	    	return this._spawnCreepForRole(roles[0]);
	    }
        info.error('Could not find role: ' + roleName);
        return false;
    }

    _fetchFreeSpawn(baseName) {  
        var freeSpawns = MainCache.getFreeSpawns(baseName);
        return freeSpawns.length > 0 ? freeSpawns[0] : null;
    }  

    _showSpawningAnimation() {  
    	MainUtil.findAllSpawns().filter(spawn => spawn.spawning && spawn.room == this._room).forEach(spawn => {
            spawn.room.visual.text('🔁', spawn.pos.x - 1, spawn.pos.y, {align: 'left', opacity: 0.8});
        });
    }

    _moveCreeps() {  
    	var baseName = this._room.memory.base.name;
        MainCache.getCreepsByHome(baseName)
	        	.filter(creep => !creep.spawning)
	        	.forEach(creep => {
            try {
                var creepRole = this._findNecessaryMandatoryRole(creep.memory.role);
                if (LabManager.runCreep(creep, creepRole)) return;
                creepRole.run(creep, this._room);

                // Safe role counting with defensive checks against foreign or uninitialized rooms
                if (creep.room.memory.roleInfo && creep.room.memory.roleInfo[creepRole.roleName]) {
                	var currentNumber = creep.room.memory.roleInfo[creepRole.roleName].currentNumber;
                	creep.room.memory.roleInfo[creepRole.roleName].currentNumber = currentNumber ? currentNumber + 1 : 1;
                }
                
                if (this._room.memory.base && this._room.memory.base.roleConfig && this._room.memory.base.roleConfig.showIcons && this._room == creep.room) {
                	this._room.visual.text(creepRole.symbol, creep.pos.x, creep.pos.y, {align: 'left', opacity: 0.8});
                }
            } catch (e) {
                console.log(e.stack);
                info.log(e);
            }
        });
    }

    _findNecessaryMandatoryRole(roleName) {
        var result = this._findMandatoryRole(roleName);
        if (result.isNecessary(this._room)) {
        	return result;
        }

        var fallbackName = null;
        if (result.roleName == 'Builder') {
        	fallbackName = 'Upgrader';
        } else if (result.roleName == 'Handyman') {
        	fallbackName = 'Builder';
        }
        if (!fallbackName) {
        	return result;
        }

        var fallback = this._rolesByName.get(fallbackName);
        return fallback && fallback.isNecessary(this._room) ? fallback : result;
    }

    _findMandatoryRole(roleName) {
        var result = this._rolesByName.get(roleName);
        if (result) {
            return result;
        }
        info.error('COULD NOT FIND ROLE: ' + roleName + ' 🛑');
        return this._defaultRole;
    }
}

BaseManager._missionSpawnProviders = new Map();
BaseManager.registerMissionSpawnProvider('remote', {
	getSpawnRequests: function (baseName, room) {
		return require('./manager.remote').getSpawnRequests(baseName, room);
	},
	onSpawn: function (request, creep) {
		require('./manager.remote').onSpawn(request, creep);
	},
});

module.exports = BaseManager;
