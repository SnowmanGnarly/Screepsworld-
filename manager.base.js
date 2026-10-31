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
var EconomyManager = require('./manager.economy');
var LabManager = require('./manager.lab');
var MainHeap = require('./main.heap');
var config = require('./main.config');

class BaseManager {
	
	/*
	 * Rooms take turns going first, so that if the CPU budget runs out it is never the same room's
	 * creeps that stand still every tick.
	 */

	static runAll(allRoles = BaseManager.fetchAllRoles()) {
		BaseManager._adoptOrphans();
		var rooms = MainUtil.findAllRooms();
		var first = rooms.length > 0 ? Game.time % rooms.length : 0;
		rooms.slice(first).concat(rooms.slice(0, first)).forEach(room => new BaseManager(room, allRoles).runBase());
	}

	/*
	 * Creeps only run through the base they belong to, so a creep whose base is gone would stand
	 * still until it dies. The nearest remaining base takes it in.
	 */

	static _adoptOrphans() {
		var rooms = MainUtil.findAllRooms();
		var bases = rooms.filter(room => room.memory.base && room.controller && room.controller.my);
		if (bases.length === 0) return;
		var names = new Set(rooms.filter(room => room.memory.base).map(room => room.memory.base.name));
		MainCache.getCreeps().forEach(creep => {
			if (names.has(creep.memory.home)) return;
			var distance = room => Game.map.getRoomLinearDistance(creep.room.name, room.name);
			var nearest = bases.slice().sort((a, b) => distance(a) - distance(b))[0];
			info.log(MainUtil.getDisplayName(creep) + ' lost its base and joins ' + nearest.memory.base.name, nearest);
			creep.memory.home = nearest.memory.base.name;
			MainCache.resetCreepsByHome();
		});
	}

	/*
	 * A tick that hits the CPU limit is thrown away whole, so the creeps that did not get a turn
	 * wait for the next tick instead.
	 */

	static _hasCpuLeft() {
		if (!Game.cpu.tickLimit) return true;
		return Game.cpu.getUsed() < Game.cpu.tickLimit * (1 - config.CPU.TICK_MARGIN);
	}

	static _guard(room, label, action) {
		try {
			action();
		} catch (error) {
			info.error('Could not ' + label + ' for ' + room.name + ': ' + error, room);
			info.notify(label + ':' + room.name, 'Could not ' + label + ' for ' + room.name + ': ' + error);
			console.log(error.stack);
		}
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
	    this._allRoles = allRoles;
	    this._rolesByName = new Map(allRoles.map(role => [role.roleName, role]));
	    this._defaultRole = this._rolesByName.get('Harvester') || new Harvester();
	}

    runBase() {  
    	if (this._room.memory.base) {
    		// a spawning problem must not stop the creeps we already have
	        BaseManager._guard(this._room, 'spawn creeps', () => this._repopulateCreeps());
	        BaseManager._guard(this._room, 'show spawning', () => this._showSpawningAnimation());
	        BaseManager._guard(this._room, 'run creeps', () => this._moveCreeps());
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
    	// these recovery rules ignore quotas, so they must not bring Harvesters back to a room that runs without them
    	var selfSustaining = EconomyManager.isSelfSustaining(this._room);
    	var bootstrapRole = null;
    	if (!selfSustaining && !homeCreeps.some(creep => creep.memory.role == 'Harvester')) {
    		bootstrapRole = harvester;
    	} else if (upgrader && !homeCreeps.some(creep => creep.memory.role == 'Upgrader')) {
    		bootstrapRole = upgrader;
    	}
    	if (bootstrapRole === harvester) {
    		this._spawnCreepForRole(harvester);
    		return;
    	}
    	var defender = this._rolesByName.get('Defender');
    	if (defender && this._needsLocalDefenders(baseName) && this._spawnCreepForRole(defender)) {
    		return;
    	}
    	if (bootstrapRole) {
    		this._spawnCreepForRole(bootstrapRole);
    		return;
    	}
    	var activeHarvesters = homeCreeps.filter(creep => creep.memory.role == 'Harvester' && !creep.spawning);
    	var isLastHarvester = !selfSustaining && activeHarvesters.length === 1;
    	if (isLastHarvester && activeHarvesters[0].ticksToLive < config.SPAWN.LAST_HARVESTER_TTL) {
    		this._spawnCreepForRole(harvester);
    		return;
    	}
    	this._runSpawnQueue(baseName, isLastHarvester);
    }

    /*
     * Everything that wants a creep goes through one queue with one priority scale: local roles
     * first, then missions. The first request we can serve wins, and a request saving up for a
     * full-size body holds the energy back from everything below it.
     */

    _runSpawnQueue(baseName, preserveRecoveryReserve) {
    	var waits = MainHeap.namespace('spawnWait');
    	var queue = this._buildSpawnQueue(baseName);
    	for (var request of queue) {
    		var isHarvester = !request.entry && request.role.roleName == 'Harvester';
    		if (preserveRecoveryReserve && !isHarvester && this._room.energyAvailable < this._getRecoveryReserve()) {
    			continue;
    		}
    		var role = request.role;
    		// the first creep of a role that moves energy is what refills the spawn, so it cannot wait.
    		// One that is only being replaced still can: its successor lives with this body for 1500 ticks
    		var options = {
    			baseName: baseName,
    			mayWait: !(role.movesEnergy && !request.entry && this._countLivingCreeps(baseName, role) === 0),
    		};
    		var spawned = request.entry ? this._spawnMissionRequest(request.entry, options) : this._spawnCreepForRole(role, options);
    		if (spawned) {
    			delete waits[baseName];
    			return true;
    		}
    		if (options.waitingForEnergy) {
    			return false;
    		}
    	}
    	// nothing is saving up any more, so the next request gets its full wait
    	delete waits[baseName];
    	return false;
    }

    _buildSpawnQueue(baseName) {
    	var queue = [];
    	this._allRoles.forEach(role => {
    		if (this._countActiveCreeps(baseName, role) >= this._getRequiredNumber(role)) return;
    		if (!role.isNecessary(this._room)) return;
    		queue.push({ role: role, priority: role.priority + config.SPAWN.LOCAL_PRIORITY_OFFSET });
    	});
    	this._collectMissionRequests(baseName).forEach(entry => {
    		queue.push({ role: this._rolesByName.get(entry.request.role), entry: entry, priority: entry.request.priority || 0 });
    	});
    	return queue.sort((a, b) => b.priority - a.priority);
    }

    /*
     * Manual quotas act as a floor over what the room derives for itself, so setCreepCount keeps
     * working. maxNumber only limits the derived part.
     */

    _getRequiredNumber(role) {
    	var manual = MemoryManager.getRequiredNumberForRoomAndRole(this._room, role.roleName);
    	if (!role.alwaysDerived && !EconomyManager.isAutomatic(this._room, role.roleName)) return manual;
    	var roleConfig = this._room.memory.base.roleConfig[role.roleName] || {};
    	var derived = role.getDemand(this._room);
    	var maxNumber = roleConfig.maxNumber === undefined ? role.defaultMaxNumber : roleConfig.maxNumber;
    	return Math.max(manual, maxNumber === undefined ? derived : Math.min(derived, maxNumber));
    }

    /*
     * A creep about to expire no longer counts, which is what makes its replacement spawn in
     * time. Mission creeps belong to their mission and never fill a local quota.
     */

    _countActiveCreeps(baseName, role) {
    	return MainCache.getCreepsByHome(baseName).filter(creep => {
    		return creep.memory.role === role.roleName && !creep.memory.missionId && !role.needsReplacement(creep);
    	}).length;
    }

    _countLivingCreeps(baseName, role) {
    	return MainCache.getCreepsByHome(baseName).filter(creep => {
    		return creep.memory.role === role.roleName && !creep.memory.missionId && !creep.spawning;
    	}).length;
    }

    /*
     * A room that cannot hold the full reserve may spend once it is full; otherwise
     * nothing but Harvesters could ever spawn there and extensions would never be built.
     */

    _getRecoveryReserve() {
        return Math.min(config.SPAWN.RECOVERY_ENERGY_RESERVE, this._room.energyCapacityAvailable);
    }

    _needsLocalDefenders(baseName) {
        var defense = this._room.memory.defense;
        if (!defense || !(defense.desiredDefenders > 0) || !(defense.threatLevel >= config.DEFENSE.DEFENDER_THREAT_LEVEL)) return false;
        var localDefenders = MainCache.getCreepsByHome(baseName).filter(creep => {
            return creep.memory.role === 'Defender' && !creep.memory.missionId;
        }).length;
        return localDefenders < defense.desiredDefenders;
    }

    _collectMissionRequests(baseName) {
        var requests = [];
        BaseManager._missionSpawnProviders.forEach((provider, providerName) => {
            try {
                var produced = typeof provider === 'function'
                    ? provider(baseName, this._room)
                    : provider.getSpawnRequests(baseName, this._room);
                (produced || []).slice(0, config.SPAWN.MISSION_REQUEST_LIMIT).forEach(request => {
                    if (request && request.home === baseName) requests.push({ request, provider, providerName });
                });
            } catch (error) {
                info.error('Mission spawn provider ' + providerName + ' failed: ' + error, this._room);
            }
        });
        requests.sort((a, b) => (b.request.priority || 0) - (a.request.priority || 0) ||
            (a.request.created || 0) - (b.request.created || 0) || String(a.request.id).localeCompare(String(b.request.id)));
        var seen = new Set();
        return requests.filter(entry => {
            var key = entry.request.id || entry.providerName + ':' + entry.request.role;
            if (seen.has(key) || !this._rolesByName.has(entry.request.role)) return false;
            seen.add(key);
            return true;
        });
    }

    _spawnMissionRequest(entry, options) {
        var request = entry.request;
        var role = this._rolesByName.get(request.role);
        var spawn = this._fetchFreeSpawn(this._room.memory.base.name);
        if (!spawn && this._room.memory.base.outsourceSpawn) spawn = this._fetchFreeSpawn();
        if (!spawn) return false;
        var resultingCreep = role.spawnMissionCreep(spawn, request, options);
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
    	var recoveryCost = BODYPART_COST[WORK] + BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
    	info.warning('Emergency Harvester recovery needs a free eligible spawn with ' + recoveryCost + ' available energy.', this._room);
    	info.notify('recovery:' + this._room.name, this._room.name + ' has no creeps and cannot spawn any.');
    }

    _spawnCreepForRole(role, options = {}) {    
        options.baseRoom = this._room;
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
            if (!BaseManager._hasCpuLeft()) return;
            try {
                var creepRole = this._findNecessaryMandatoryRole(creep.memory.role);
                if (LabManager.runCreep(creep, creepRole)) return;
                creepRole.run(creep, this._room);

                // Safe role counting with defensive checks against foreign or uninitialized rooms
                var roleInfo = MainHeap.namespace('roleInfo')[creep.room.name];
                if (roleInfo && roleInfo[creepRole.roleName]) {
                	roleInfo[creepRole.roleName].currentNumber++;
                }

                if (config.getSetting('creepIcons') && this._room.memory.base && this._room.memory.base.roleConfig && this._room.memory.base.roleConfig.showIcons && this._room == creep.room) {
                	this._room.visual.text(creepRole.symbol, creep.pos.x, creep.pos.y, {align: 'left', opacity: 0.8});
                }
            } catch (e) {
                console.log(e.stack);
                info.log(e);
                info.notify('creep:' + creep.memory.role + ':' + this._room.name, creep.memory.role + ' in ' + this._room.name + ' keeps failing: ' + e);
            }
        });
    }

    _findNecessaryMandatoryRole(roleName) {
        var result = this._findMandatoryRole(roleName);
        if (this._isRoleNecessary(result)) {
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
        return fallback && this._isRoleNecessary(fallback) ? fallback : result;
    }

    // each role scans the room for work, so ask once per tick rather than once per creep
    _isRoleNecessary(role) {
        if (!this._necessaryRoles) this._necessaryRoles = new Map();
        if (!this._necessaryRoles.has(role.roleName)) {
            this._necessaryRoles.set(role.roleName, role.isNecessary(this._room));
        }
        return this._necessaryRoles.get(role.roleName);
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
