var MainCache = require('./main.cache');
var MainUtil = require('./main.util');
var IntelManager = require('./manager.intel');
var RoadManager = require('./manager.road');
var info = require('./main.info');
var config = require('./main.config');
var EconomyManager = require('./manager.economy');

class RemoteManager {

    static runAll(allowExpensive = true) {
        IntelManager.ensureMemory();
        this._importExplicitConfigurations();
        this.getRemoteMissions().forEach(mission => {
            try {
                this._normalizeMission(mission);
                this._refreshMission(mission);
                this._updateROI(mission);
                if (allowExpensive) this._planConstruction(mission);
            } catch (error) {
                info.error('Could not run remote mission ' + mission.id + ': ' + error);
            }
        });
    }

    static configure(home, targetRoom, options = {}) {
        if (!home || !targetRoom || typeof home !== 'string' || typeof targetRoom !== 'string') return false;
        var empire = IntelManager.ensureMemory();
        var id = options.id || 'remote:' + home + ':' + targetRoom;
        if (!empire.missions[id] && Object.keys(empire.missions).length >= IntelManager.MAX_MISSIONS) return false;
        var defaults = {
            id: id,
            type: 'remote',
            home: home,
            targetRoom: targetRoom,
            enabled: true,
            status: 'active',
            created: Game.time,
            maxDistance: RemoteManager.DEFAULT_MAX_DISTANCE,
            maxHaulers: RemoteManager.DEFAULT_MAX_HAULERS,
            maxSites: RemoteManager.DEFAULT_MAX_SITES,
            reserve: true,
        };
        var mission = Object.assign(defaults, empire.missions[id] || {}, options, {
            id: id,
            type: 'remote',
            home: home,
            targetRoom: targetRoom,
        });
        mission.maxDistance = MainUtil.clamp(mission.maxDistance, 1, 10, RemoteManager.DEFAULT_MAX_DISTANCE);
        mission.maxHaulers = MainUtil.clamp(mission.maxHaulers, 0, RemoteManager.MAX_HAULERS_PER_OUTPOST, RemoteManager.DEFAULT_MAX_HAULERS);
        mission.maxSites = MainUtil.clamp(mission.maxSites, 0, RemoteManager.MAX_SITES_PER_OUTPOST, RemoteManager.DEFAULT_MAX_SITES);
        empire.missions[id] = mission;
        this._normalizeMission(mission);
        return mission;
    }

    static _importExplicitConfigurations() {
        MainUtil.findAllRooms().forEach(room => {
            if (!room.memory.base || !room.memory.base.name) return;
            var base = room.memory.base;
            var remoteConfig = base.remote && typeof base.remote === 'object' ? base.remote : {};
            var entries = [];
            if (Array.isArray(base.remoteRooms)) entries = entries.concat(base.remoteRooms);
            else if (base.remoteRooms && typeof base.remoteRooms === 'object') {
                Object.keys(base.remoteRooms).forEach(targetRoom => {
                    entries.push(Object.assign({ targetRoom: targetRoom }, base.remoteRooms[targetRoom]));
                });
            }
            if (Array.isArray(remoteConfig.rooms)) entries = entries.concat(remoteConfig.rooms);
            entries.forEach(entry => {
                var targetRoom = typeof entry === 'string' ? entry : entry && (entry.targetRoom || entry.room || entry.name);
                if (!targetRoom) return;
                var options = typeof entry === 'object' ? Object.assign({}, remoteConfig, entry) : Object.assign({}, remoteConfig);
                delete options.rooms;
                options.homeRoom = room.name;
                this.configure(base.name, targetRoom, options);
            });
        });
        this._importFlags();
    }

    static _importFlags() {
        var baseRooms = MainUtil.findAllRooms().filter(room => room.memory.base && room.memory.base.name);
        MainUtil.findAllFlags().forEach(flag => {
            if (!MainUtil.isRemoteFlag(flag)) return;
            var parts = flag.name.split(':');
            var home = null;
            var targetRoom = flag.pos.roomName;
            var options = flag.memory && typeof flag.memory === 'object' ? Object.assign({}, flag.memory) : {};
            if (parts.length >= 3) {
                home = parts[1];
                targetRoom = parts[2];
            } else if (parts.length === 2) {
                var matchingBase = baseRooms.find(room => room.memory.base.name === parts[1]);
                if (matchingBase) home = parts[1];
                else targetRoom = parts[1];
            }
            if (options.targetRoom) targetRoom = options.targetRoom;
            if (options.home) home = options.home;
            if (!home) {
                var candidates = baseRooms.map(room => ({
                    room: room,
                    distance: this._getDistance(room.name, targetRoom),
                })).filter(entry => entry.distance !== null && entry.distance <= (options.maxDistance || RemoteManager.DEFAULT_MAX_DISTANCE));
                candidates.sort((a, b) => a.distance - b.distance || a.room.name.localeCompare(b.room.name));
                if (candidates.length > 0) home = candidates[0].room.memory.base.name;
            }
            if (!home || !targetRoom) return;
            var homeRoom = baseRooms.find(room => room.memory.base.name === home);
            options.homeRoom = homeRoom ? homeRoom.name : options.homeRoom;
            this.configure(home, targetRoom, options);
        });
    }

    static getRemoteMissions() {
        var empire = IntelManager.ensureMemory();
        return Object.keys(empire.missions).map(id => empire.missions[id]).filter(mission => {
            return mission && mission.type === 'remote' && mission.home && mission.targetRoom;
        }).sort((a, b) => a.id.localeCompare(b.id));
    }

    static getMission(missionId) {
        if (!missionId) return null;
        return IntelManager.ensureMemory().missions[missionId] || null;
    }

    static getConfiguredOutposts() {
        return this.getRemoteMissions().filter(mission => mission.enabled !== false);
    }

    static _normalizeMission(mission) {
        mission.enabled = mission.enabled !== false;
        mission.status = mission.status || 'active';
        mission.maxDistance = MainUtil.clamp(mission.maxDistance, 1, 10, RemoteManager.DEFAULT_MAX_DISTANCE);
        // missions saved before the cap became a safety ceiling hold the old default
        if (mission.haulerCapVersion !== RemoteManager.HAULER_CAP_VERSION) {
            if (mission.maxHaulers === RemoteManager.LEGACY_DEFAULT_MAX_HAULERS) mission.maxHaulers = RemoteManager.DEFAULT_MAX_HAULERS;
            mission.haulerCapVersion = RemoteManager.HAULER_CAP_VERSION;
        }
        mission.maxHaulers = MainUtil.clamp(mission.maxHaulers, 0, RemoteManager.MAX_HAULERS_PER_OUTPOST, RemoteManager.DEFAULT_MAX_HAULERS);
        mission.maxSites = MainUtil.clamp(mission.maxSites, 0, RemoteManager.MAX_SITES_PER_OUTPOST, RemoteManager.DEFAULT_MAX_SITES);
        mission.sources = Array.isArray(mission.sources) ? mission.sources.slice(0, 8) : [];
        mission.defense = Object.assign({ threatLevel: 0, desiredDefenders: 0 }, mission.defense || {});
        mission.stats = Object.assign({
            energyHarvested: 0,
            energyDelivered: 0,
            energySpent: 0,
            repairCost: 0,
            defenseCost: 0,
            windowStarted: mission.created || Game.time,
            lastROIUpdate: 0,
            roi: 0,
            negativeEvaluations: 0,
        }, mission.stats || {});
        Object.keys(mission.stats).forEach(key => {
            if (typeof mission.stats[key] === 'number') {
                mission.stats[key] = MainUtil.clamp(mission.stats[key], -RemoteManager.MAX_METRIC, RemoteManager.MAX_METRIC, 0);
            }
        });
        if (!mission.homeRoom) {
            var homeRoom = MainUtil.findAllRooms().find(room => room.memory.base && room.memory.base.name === mission.home);
            mission.homeRoom = homeRoom ? homeRoom.name : null;
        }
        return mission;
    }

    static _refreshMission(mission) {
        var intel = IntelManager.getIntel(mission.targetRoom);
        if (intel) {
            mission.sources = intel.sources.map(source => {
                var previous = mission.sources.find(candidate => candidate.id === source.id) || {};
                return {
                    id: source.id,
                    x: source.x,
                    y: source.y,
                    energyCapacity: source.energyCapacity || previous.energyCapacity || 0,
                    output: previous.output || 0,
                };
            });
            mission.controller = intel.controller;
            mission.lastIntel = intel.lastSeen;
        }
        var homeRoom = mission.homeRoom && Game.rooms[mission.homeRoom];
        mission.distance = homeRoom ? this._getDistance(homeRoom.name, mission.targetRoom) : null;
        mission.distanceValid = mission.distance !== null && mission.distance <= mission.maxDistance;
    }

    static _isOperational(mission) {
        if (!mission || mission.enabled === false || !mission.distanceValid) return false;
        if (mission.status === 'blacklisted') {
            if (mission.blacklistedUntil && mission.blacklistedUntil <= Game.time) {
                mission.status = 'suspended';
                mission.suspendedUntil = Math.max(mission.suspendedUntil || 0, Game.time + RemoteManager.SUSPENSION_TICKS);
            }
            return false;
        }
        if (mission.status === 'suspended') {
            if (!mission.suspendedUntil || mission.suspendedUntil > Game.time) return false;
            mission.status = 'active';
            mission.suspensionReason = null;
        }
        return mission.status === 'active';
    }

    static getSpawnRequests(home, baseRoom) {
        var requests = [];
        this.getRemoteMissions().forEach(mission => {
            if (mission.home !== home) return;
            this._normalizeMission(mission);
            this._refreshMission(mission);
            if (!this._isOperational(mission)) return;
            this._addDefenseRequest(mission, requests, baseRoom);
            if (mission.defense.threatLevel >= config.DEFENSE.DEFENDER_THREAT_LEVEL) return;
            this._addScoutRequest(mission, requests);
            this._addReserverRequest(mission, requests, baseRoom);
            this._addEconomyRequests(mission, baseRoom, requests);
        });
        return requests.slice(0, RemoteManager.MAX_SPAWN_REQUESTS_PER_HOME);
    }

    /*
     * A defender only helps if it can win. One small invader has 1000 hits and out-damages a single
     * part many times over, so this sends the largest body the room can pay for.
     */

    static getDefenderBody(style, baseRoom) {
        var unit = style === 'ranged' ? [RANGED_ATTACK, MOVE] : style === 'support' ? [HEAL, MOVE] : [ATTACK, MOVE];
        var capacity = baseRoom && baseRoom.energyCapacityAvailable || 0;
        var units = Math.max(1, Math.min(config.REMOTE.DEFENDER_UNITS, Math.floor(capacity / this._bodyCost(unit))));
        var body = [];
        for (var index = 0; index < units; index++) body.push(unit[0], unit[1]);
        return body;
    }

    static _addDefenseRequest(mission, requests, baseRoom) {
        var defense = mission.defense || {};
        var current = this._getMissionCreeps(mission, 'Defender').filter(creep => !creep.memory.retiring).length;
        var desired = MainUtil.clamp(defense.desiredDefenders, 0, RemoteManager.MAX_DEFENDERS_PER_OUTPOST, 0);
        if (current >= desired) return;
        var body = this.getDefenderBody(defense.preferredStyle, baseRoom);
        requests.push(this._makeRequest(mission, 'Defender', 95, body, {
            targetPos: this._getControllerPos(mission),
        }, 'defense'));
    }

    static _addScoutRequest(mission, requests) {
        if (mission.sources.length > 0 && mission.lastIntel && Game.time - mission.lastIntel < RemoteManager.SCOUT_INTERVAL) return;
        var current = this._getMissionCreeps(mission, 'Scout').filter(creep => creep.memory.phase !== 'return').length;
        if (current > 0) return;
        requests.push(this._makeRequest(mission, 'Scout', 30, [MOVE], {
            targetPos: { roomName: mission.targetRoom, x: 25, y: 25 },
        }, 'scout'));
    }

    static _addReserverRequest(mission, requests, baseRoom) {
        if (!mission.reserve || mission.sources.length === 0) return;
        var controller = mission.controller;
        if (controller && controller.owner && !controller.my) return;
        var username = this._getOwnUsername(mission);
        if (controller && controller.reservation && controller.reservation.username !== username) return;
        if (controller && controller.reservation && controller.reservation.username === username &&
            controller.reservation.ticksToEnd >= RemoteManager.RESERVATION_THRESHOLD) return;
        var body = this.getReserverBody(baseRoom);
        if (this._getMissionCreeps(mission, 'Reserver').some(creep => {
            return !creep.memory.retiring && !this._needsReplacement(creep, mission, body);
        })) return;
        requests.push(this._makeRequest(mission, 'Reserver', 75, body, {
            controllerPos: this._getControllerPos(mission),
        }, 'reserve'));
    }

    /*
     * A reservation decays by one per tick and each CLAIM part adds one, so a single
     * part only holds the reservation still. Two parts are what make it grow.
     */

    static getReserverBody(baseRoom) {
        var body = [CLAIM, CLAIM, MOVE, MOVE];
        var capacity = baseRoom && baseRoom.energyCapacityAvailable || 0;
        return capacity >= this._bodyCost(body) ? body : [CLAIM, MOVE];
    }

    static _addEconomyRequests(mission, baseRoom, requests) {
        if (mission.sources.length === 0) return;
        var activeMiners = this._getMissionCreeps(mission, 'RemoteMiner');
        mission.sources.forEach(source => {
            var body = this.getMinerBody(mission, source, baseRoom);
            var current = activeMiners.filter(creep => {
                return (creep.memory.sourceId || creep.memory.source) === source.id &&
                    !this._needsReplacement(creep, mission, body);
            }).length;
            if (current > 0) return;
            requests.push(this._makeRequest(mission, 'RemoteMiner', 65, body, {
                sourceId: source.id,
                source: source.id,
                sourcePos: { roomName: mission.targetRoom, x: source.x, y: source.y },
            }, 'mine:' + source.id));
        });

        if (activeMiners.length === 0) return;
        var demand = this.calculateRouteDemand(mission, { baseRoom: baseRoom });
        var currentHaulers = this._getMissionCreeps(mission, 'RemoteHauler').filter(creep => {
            return !this._needsReplacement(creep, mission, demand.body);
        }).length;
        if (demand.rawHaulers > demand.haulers && Game.time - (mission.haulerCapWarnedAt || 0) >= RemoteManager.HAULER_CAP_WARNING_INTERVAL) {
            mission.haulerCapWarnedAt = Game.time;
            info.warning('Remote ' + mission.targetRoom + ' needs ' + demand.rawHaulers + ' haulers but maxHaulers is ' + demand.haulers, baseRoom);
        }
        if (currentHaulers >= demand.haulers) return;
        var anchor = mission.sources[0];
        requests.push(this._makeRequest(mission, 'RemoteHauler', 60, demand.body, {
            sourcePos: { roomName: mission.targetRoom, x: anchor.x, y: anchor.y },
        }, 'haul'));
        mission.desired = Object.assign({}, mission.desired, demand);
    }

    static _makeRequest(mission, role, priority, body, memory, suffix) {
        var homePos = this._getHomePos(mission);
        return {
            id: mission.id + ':' + suffix,
            provider: 'remote',
            role: role,
            priority: priority,
            body: body.slice(),
            exactBody: body.slice(),
            home: mission.home,
            created: Game.time,
            memory: Object.assign({}, mission.creepMemory || {}, memory, {
                missionId: mission.id,
                targetRoom: mission.targetRoom,
                homeRoom: mission.homeRoom,
                homePos: homePos,
            }),
        };
    }

    static onSpawn(request, creep) {
        var mission = this.getMission(request.memory && request.memory.missionId);
        if (!mission) return;
        this._normalizeMission(mission);
        mission.stats.energySpent = this._boundedAdd(mission.stats.energySpent, this._bodyCost(request.body));
        mission.stats.totalSpawned = (mission.stats.totalSpawned || 0) + 1;
        if (request.role === 'RemoteMiner') {
            this._getMissionCreeps(mission, 'RemoteMiner').forEach(existing => {
                if (existing !== creep && (existing.memory.sourceId || existing.memory.source) === request.memory.sourceId) {
                    existing.memory.trainedReplacement = true;
                }
            });
        }
    }

    static _getMissionCreeps(mission, roleName) {
        return MainUtil.findAllCreeps().filter(creep => {
            return creep.memory.missionId === mission.id && (!roleName || creep.memory.role === roleName);
        });
    }

    static _needsReplacement(creep, mission, body) {
        if (creep.spawning) return false;
        if (creep.memory.trainedReplacement) return true;
        var leadTime = (mission.travelTicks || RemoteManager.DEFAULT_TRAVEL_TICKS) + body.length * CREEP_SPAWN_TIME + RemoteManager.REPLACEMENT_BUFFER;
        return Number.isFinite(creep.ticksToLive) && creep.ticksToLive <= leadTime;
    }

    static _getSourceOutput(source, reserved) {
        if (source.output) return source.output;
        if (source.energyCapacity) return source.energyCapacity / ENERGY_REGEN_TIME;
        return (reserved ? SOURCE_ENERGY_CAPACITY : SOURCE_ENERGY_NEUTRAL_CAPACITY) / ENERGY_REGEN_TIME;
    }

    static getMinerBody(mission, source, baseRoom) {
        var reserved = mission.controller && mission.controller.reservation &&
            mission.controller.reservation.username === this._getOwnUsername(mission);
        var output = this._getSourceOutput(source, reserved);
        var workParts = MainUtil.clamp(Math.ceil(output / HARVEST_POWER), 3, EconomyManager.getHarvestWorkParts(), 3);
        if (baseRoom && baseRoom.energyCapacityAvailable) {
            var affordableWork = Math.floor((baseRoom.energyCapacityAvailable - BODYPART_COST[CARRY] - BODYPART_COST[MOVE]) / BODYPART_COST[WORK]);
            workParts = Math.max(1, Math.min(workParts, affordableWork));
        }
        var body = [];
        for (var index = 0; index < workParts; index++) body.push(WORK);
        body.push(CARRY, MOVE);
        return body;
    }

    /*
     * One hauler big enough for the route uses far less CPU than several small ones, and carrying
     * more than the route produces would waste energy. A chosen haulerPairs still wins.
     */

    static getHaulerBody(mission, baseRoom, carryNeeded) {
        var homeRoom = baseRoom || mission.homeRoom && Game.rooms[mission.homeRoom];
        var energyCapacity = homeRoom && homeRoom.energyCapacityAvailable || SPAWN_ENERGY_CAPACITY;
        var wantedPairs = carryNeeded ? Math.ceil(carryNeeded / 2) : RemoteManager.DEFAULT_HAULER_PAIRS;
        var pairLimit = config.REMOTE.HAULER_PAIRS_MAX;
        var configuredPairs = mission.haulerPairs ? MainUtil.clamp(mission.haulerPairs, 1, pairLimit, RemoteManager.DEFAULT_HAULER_PAIRS) : MainUtil.clamp(wantedPairs, 1, pairLimit, RemoteManager.DEFAULT_HAULER_PAIRS);
        var pairCost = this._bodyCost([CARRY, CARRY, MOVE]);
        var pairs = Math.max(1, Math.min(configuredPairs, Math.floor(energyCapacity / pairCost)));
        var body = [];
        for (var index = 0; index < pairs; index++) body.push(CARRY, CARRY, MOVE);
        return body;
    }

    static calculateRouteDemand(mission, context = {}) {
        this._normalizeMission(mission);
        var sources = context.sources || mission.sources;
        var reserved = mission.controller && mission.controller.reservation &&
            mission.controller.reservation.username === this._getOwnUsername(mission);
        var outputPerTick = sources.reduce((sum, source) => {
            return sum + MainUtil.clamp(this._getSourceOutput(source, reserved), 0, 20, 5);
        }, 0);
        var distance = mission.distance === null || mission.distance === undefined ? 1 : mission.distance;
        var travelTicks = MainUtil.clamp(context.travelTicks || mission.travelTicks || distance * 50,
            20, RemoteManager.MAX_TRAVEL_TICKS, RemoteManager.DEFAULT_TRAVEL_TICKS);
        // Miners walk far slower than haulers, so a route is timed by a hauler once one has walked it.
        // It walks out empty at one tick per tile, and back loaded at half that speed
        var emptyWalk = context.travelTicks || mission.haulerTravelTicks || 0;
        var roundTripTicks = emptyWalk > 0
            ? MainUtil.clamp(emptyWalk * (1 + config.REMOTE.HAULER_TICKS_PER_TILE_LOADED) + 20, 40, CREEP_LIFE_TIME, 120)
            : MainUtil.clamp(travelTicks * 2 + 20, 40, CREEP_LIFE_TIME, 120);
        var carryNeeded = Math.ceil(outputPerTick * roundTripTicks / CARRY_CAPACITY);
        var body = context.body || this.getHaulerBody(mission, context.baseRoom, carryNeeded);
        var carryParts = body.filter(part => part === CARRY).length;
        var capacity = Math.max(CARRY_CAPACITY, carryParts * CARRY_CAPACITY);
        var rawHaulers = outputPerTick > 0 ? Math.ceil(outputPerTick * roundTripTicks / capacity) : 0;
        var haulers = MainUtil.clamp(rawHaulers, 0, mission.maxHaulers, 0);
        return {
            miners: sources.length,
            haulers: haulers,
            rawHaulers: rawHaulers,
            outputPerTick: MainUtil.clamp(outputPerTick, 0, 100, 0),
            travelTicks: travelTicks,
            roundTripTicks: roundTripTicks,
            capacity: capacity,
            body: body,
        };
    }

    static calculateNetROI(mission) {
        var stats = mission.stats || {};
        var net = (stats.energyDelivered || 0) - (stats.energySpent || 0) -
            (stats.repairCost || 0) - (stats.defenseCost || 0);
        return MainUtil.clamp(net, -RemoteManager.MAX_METRIC, RemoteManager.MAX_METRIC, 0);
    }

    static calculateROI(mission) {
        var stats = mission.stats || {};
        var elapsed = MainUtil.clamp(Game.time - (stats.windowStarted || mission.created || 0), 1, 5000, 1);
        return MainUtil.clamp(this.calculateNetROI(mission) / elapsed, -1000, 1000, 0);
    }

    static _updateROI(mission, force = false) {
        if (!force && Game.time - (mission.stats.lastROIUpdate || 0) < RemoteManager.ROI_INTERVAL) return;
        mission.stats.lastROIUpdate = Game.time;
        mission.stats.roi = this.calculateROI(mission);
        var age = Game.time - (mission.stats.windowStarted || mission.created || Game.time);
        if (age >= RemoteManager.ROI_MINIMUM_AGE && mission.stats.roi < -1) mission.stats.negativeEvaluations++;
        else mission.stats.negativeEvaluations = 0;
        if (mission.stats.negativeEvaluations >= 2 && mission.status === 'active') {
            this.suspendMission(mission.id, 'negative ROI', RemoteManager.SUSPENSION_TICKS);
            mission.stats.negativeEvaluations = 0;
        }
    }

    static recordEnergyHarvested(missionId, amount) {
        this._recordMetric(missionId, 'energyHarvested', amount);
    }

    static recordEnergyDelivered(missionId, amount) {
        this._recordMetric(missionId, 'energyDelivered', amount);
    }

    static _recordMetric(missionId, key, amount) {
        var mission = this.getMission(missionId);
        if (!mission || !Number.isFinite(amount) || amount <= 0) return;
        this._normalizeMission(mission);
        mission.stats[key] = this._boundedAdd(mission.stats[key], amount);
    }

    static recordHaulerArrival(missionId, travelTicks) {
        var mission = this.getMission(missionId);
        if (!mission || !(travelTicks > 0)) return;
        var measured = MainUtil.clamp(travelTicks, 1, RemoteManager.MAX_TRAVEL_TICKS, RemoteManager.DEFAULT_TRAVEL_TICKS);
        // the fastest walk, because a hauler held up by traffic says nothing about the route
        mission.haulerTravelTicks = mission.haulerTravelTicks ? Math.min(mission.haulerTravelTicks, measured) : measured;
    }

    static recordMinerArrival(missionId, travelTicks, source) {
        var mission = this.getMission(missionId);
        if (!mission) return;
        mission.travelTicks = MainUtil.clamp(Math.max(mission.travelTicks || 0, travelTicks || 0),
            20, RemoteManager.MAX_TRAVEL_TICKS, RemoteManager.DEFAULT_TRAVEL_TICKS);
        var sourceMemory = mission.sources.find(candidate => candidate.id === source.id);
        if (sourceMemory && source.energyCapacity) sourceMemory.output = MainUtil.clamp(source.energyCapacity / ENERGY_REGEN_TIME, 0, 20, 5);
    }

    static suspendMission(missionId, reason, duration = RemoteManager.SUSPENSION_TICKS) {
        var mission = this.getMission(missionId);
        if (!mission) return false;
        duration = MainUtil.clamp(duration, 100, 10000, RemoteManager.SUSPENSION_TICKS);
        mission.status = 'suspended';
        mission.suspensionReason = reason || 'suspended';
        mission.suspendedUntil = Math.max(mission.suspendedUntil || 0, Game.time + duration);
        mission.updated = Game.time;
        return true;
    }

    static blacklistMission(missionId, reason, duration = RemoteManager.PLAYER_BLACKLIST_TICKS) {
        var mission = this.getMission(missionId);
        if (!mission) return false;
        duration = MainUtil.clamp(duration, 500, 20000, RemoteManager.PLAYER_BLACKLIST_TICKS);
        mission.status = 'blacklisted';
        mission.blacklistReason = reason || 'hostile outpost';
        mission.blacklistedAt = Game.time;
        mission.blacklistedUntil = Math.max(mission.blacklistedUntil || 0, Game.time + duration);
        mission.suspendedUntil = Math.max(mission.suspendedUntil || 0, mission.blacklistedUntil + RemoteManager.SUSPENSION_TICKS);
        mission.updated = Game.time;
        return true;
    }

    static _planConstruction(mission) {
        if (!this._isOperational(mission) || mission.maxSites === 0 || mission.defense.threatLevel >= config.DEFENSE.DEFENDER_THREAT_LEVEL) return;
        if (Game.time - (mission.lastConstructionPlan || 0) < RemoteManager.CONSTRUCTION_INTERVAL) return;
        var room = Game.rooms[mission.targetRoom];
        if (!room || mission.sources.length === 0) return;
        mission.lastConstructionPlan = Game.time;
        var sites = MainCache.find(room, FIND_CONSTRUCTION_SITES);
        if (sites.length >= mission.maxSites) return;
        var structures = MainCache.find(room, FIND_STRUCTURES);
        var occupied = new Set(structures.concat(sites).map(value => value.pos.x + ',' + value.pos.y));
        var created = 0;

        for (var source of mission.sources) {
            if (sites.length + created >= mission.maxSites) break;
            var hasContainer = structures.concat(sites).some(value => {
                return (value.structureType === STRUCTURE_CONTAINER || value.structureType === STRUCTURE_STORAGE) &&
                    value.pos.getRangeTo(source.x, source.y) <= 1;
            });
            if (hasContainer) continue;
            var position = this._findContainerPosition(room, source, occupied);
            if (position && this._createRemoteSite(room, position, STRUCTURE_CONTAINER)) {
                occupied.add(position.x + ',' + position.y);
                created++;
            }
        }

        if (sites.length + created >= mission.maxSites) return;
        var roadPositions = new RoadManager(room).fetchPositionsOverThreshold().slice(0, 10);
        for (var roadPosition of roadPositions) {
            var key = roadPosition.x + ',' + roadPosition.y;
            if (occupied.has(key)) continue;
            if (this._createRemoteSite(room, roadPosition, STRUCTURE_ROAD)) {
                occupied.add(key);
                created++;
                break;
            }
        }
    }

    static _findContainerPosition(room, source, occupied) {
        var terrain = room.getTerrain();
        for (var dx = -1; dx <= 1; dx++) {
            for (var dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                var x = source.x + dx;
                var y = source.y + dy;
                if (x < 1 || x > 48 || y < 1 || y > 48 || occupied.has(x + ',' + y)) continue;
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                return new RoomPosition(x, y, room.name);
            }
        }
        return null;
    }

    static _createRemoteSite(room, position, structureType) {
        var result = position.createConstructionSite(structureType);
        if (result !== OK) return false;
        MainCache.invalidateRoom(room, FIND_CONSTRUCTION_SITES);
        MainCache.invalidateRoom(room, FIND_MY_CONSTRUCTION_SITES);
        return true;
    }

    static _getControllerPos(mission) {
        var controller = mission.controller;
        return controller && controller.x !== null && controller.x !== undefined ?
            { roomName: mission.targetRoom, x: controller.x, y: controller.y } :
            { roomName: mission.targetRoom, x: 25, y: 25 };
    }

    static _getHomePos(mission) {
        var room = mission.homeRoom && Game.rooms[mission.homeRoom];
        var anchor = room && (room.storage || MainCache.find(room, FIND_MY_SPAWNS)[0]);
        return anchor ? { roomName: room.name, x: anchor.pos.x, y: anchor.pos.y } :
            { roomName: mission.homeRoom, x: 25, y: 25 };
    }

    static _getOwnUsername(mission) {
        if (Game.player && Game.player.username) return Game.player.username;
        var room = mission.homeRoom && Game.rooms[mission.homeRoom];
        return room && room.controller && room.controller.owner && room.controller.owner.username || null;
    }

    static _getDistance(first, second) {
        if (!first || !second || !Game.map || !Game.map.getRoomLinearDistance) return null;
        var distance = Game.map.getRoomLinearDistance(first, second);
        return Number.isFinite(distance) ? distance : null;
    }

    static _bodyCost(body) {
        return (body || []).reduce((sum, part) => sum + (BODYPART_COST[part] || 0), 0);
    }

    static _boundedAdd(value, amount) {
        return MainUtil.clamp((Number.isFinite(value) ? value : 0) + amount, 0, RemoteManager.MAX_METRIC, 0);
    }

}

RemoteManager.DEFAULT_MAX_DISTANCE = 1;
RemoteManager.DEFAULT_MAX_HAULERS = 8;
RemoteManager.MAX_HAULERS_PER_OUTPOST = 12;
RemoteManager.LEGACY_DEFAULT_MAX_HAULERS = 3;
RemoteManager.HAULER_CAP_VERSION = 2;
RemoteManager.HAULER_CAP_WARNING_INTERVAL = 1000;
RemoteManager.DEFAULT_MAX_SITES = 2;
RemoteManager.MAX_SITES_PER_OUTPOST = 4;
RemoteManager.MAX_DEFENDERS_PER_OUTPOST = 2;
RemoteManager.MAX_SPAWN_REQUESTS_PER_HOME = 50;
RemoteManager.DEFAULT_TRAVEL_TICKS = 50;
RemoteManager.MAX_TRAVEL_TICKS = 600;
RemoteManager.REPLACEMENT_BUFFER = 20;
RemoteManager.DEFAULT_HAULER_PAIRS = 4;
RemoteManager.SCOUT_INTERVAL = 1000;
RemoteManager.RESERVATION_THRESHOLD = 1000;
RemoteManager.CONSTRUCTION_INTERVAL = 25;
RemoteManager.ROI_INTERVAL = 500;
RemoteManager.ROI_MINIMUM_AGE = 1500;
RemoteManager.SUSPENSION_TICKS = 1000;
RemoteManager.PLAYER_BLACKLIST_TICKS = 5000;
RemoteManager.MAX_METRIC = 1000000000;

module.exports = RemoteManager;
