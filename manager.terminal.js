var MainUtil = require('./main.util');
var IntelManager = require('./manager.intel');
var info = require('./main.info');

class TerminalManager {

    static runAll() {
        IntelManager.cleanup();
        var managers = [];
        MainUtil.findAllRooms().filter(room => this._isOwnedTerminalRoom(room))
            .sort((a, b) => a.name.localeCompare(b.name)).forEach(room => {
                try {
                    managers.push(new TerminalManager(room));
                } catch (error) {
                    info.error('Could not initialize terminal for ' + room.name + ': ' + error, room);
                }
            });
        var roomsByName = new Map(managers.map(manager => [manager._room.name, manager]));

        try {
            this._generateBalancingRequests(managers);
        } catch (error) {
            info.error('Could not plan terminal balancing: ' + error);
        }

        var requests = this.getResourceRequests({ status: 'open' }).sort((a, b) => this._compareRequests(a, b));
        requests.forEach(request => {
            if (!this._isBalanceRequestValid(request, roomsByName)) {
                this._releaseReservation(request);
                request.status = 'cancelled';
                request.completedAt = Game.time;
                return;
            }
            if (request.retryAfter > Game.time || request.reservedBy) return;
            try {
                this._reserveRequest(request, roomsByName);
            } catch (error) {
                info.error('Could not reserve terminal request ' + request.id + ': ' + error);
            }
        });
        this._positionRequests(managers, requests);
        this._executeRequests(requests.slice().sort((a, b) => this._compareRequests(a, b)), roomsByName);
    }

    constructor(room) {
        this._room = room;
        this._memory = TerminalManager.getConfig(room);
    }

    static requestResource(homeRoomOrBase, resourceType, amount, options = {}) {
        var targetRoom = this._resolveTargetRoom(homeRoomOrBase, options);
        if (!targetRoom || !this._isOwnedTerminalRoom(targetRoom)) return false;
        amount = Math.floor(Number(amount));
        if (!Number.isFinite(amount) || amount <= 0 || typeof resourceType !== 'string' || !resourceType) return false;
        amount = Math.min(amount, TerminalManager.MAX_REQUEST_AMOUNT);
        var empire = IntelManager.ensureMemory();
        IntelManager.cleanup();
        var reason = this._safeId(options.reason || 'external');
        var id = options.id ? this._safeId(options.id) : 'request:' + targetRoom.name + ':' + resourceType + ':' + reason;
        var existing = empire.resourceRequests[id];
        if (existing && (existing.status === 'complete' || existing.status === 'cancelled' || existing.status === 'expired')) {
            delete empire.resourceRequests[id];
            existing = null;
        }
        var priority = this._clamp(options.priority, 0, 1000, options.defense ? 200 : 50);
        if (options.defense) priority = Math.max(200, priority);
        if (!existing && Object.keys(empire.resourceRequests).length >= IntelManager.MAX_RESOURCE_REQUESTS) {
            var candidate = Object.keys(empire.resourceRequests).map(key => empire.resourceRequests[key]).sort((a, b) => {
                return (a.priority || 0) - (b.priority || 0) || (a.created || 0) - (b.created || 0) || a.id.localeCompare(b.id);
            })[0];
            if (!candidate || (candidate.priority || 0) >= priority) return false;
            this._releaseReservation(candidate);
            delete empire.resourceRequests[candidate.id];
        }
        var expiresAt = this._getExpiry(options);
        if (existing) {
            existing.remaining = Math.max(existing.remaining || 0, amount);
            existing.amount = Math.max(existing.amount || 0, existing.remaining);
            existing.priority = Math.max(existing.priority || 0, priority);
            existing.expiresAt = Math.max(existing.expiresAt || 0, expiresAt);
            existing.updated = Game.time;
            if (options.donorRoom) existing.donorRoom = options.donorRoom;
            return existing;
        }
        var request = {
            id: id,
            targetRoom: targetRoom.name,
            homeBase: targetRoom.memory.base ? targetRoom.memory.base.name : targetRoom.name,
            resourceType: resourceType,
            amount: amount,
            remaining: amount,
            priority: priority,
            reason: String(options.reason || 'external').substring(0, 80),
            kind: options.kind === 'balance' ? 'balance' : 'external',
            status: 'open',
            created: Game.time,
            updated: Game.time,
            expiresAt: expiresAt,
            retryAfter: 0,
            donorRoom: options.donorRoom || null,
            reservedBy: null,
            reservedAmount: 0,
            reservedFee: 0,
            reservedAt: 0,
        };
        empire.resourceRequests[id] = request;
        return request;
    }

    static requestTransfer(homeRoomOrBase, resourceType, amount, options = {}) {
        return this.requestResource(homeRoomOrBase, resourceType, amount, options);
    }

    static cancelResourceRequest(id, reason = 'cancelled') {
        var request = IntelManager.ensureMemory().resourceRequests[id];
        if (!request) return false;
        this._releaseReservation(request);
        request.status = 'cancelled';
        request.reason = String(reason).substring(0, 80);
        request.completedAt = Game.time;
        request.updated = Game.time;
        return true;
    }

    static getResourceRequests(filters = {}) {
        var requests = IntelManager.ensureMemory().resourceRequests;
        return Object.keys(requests).map(id => requests[id]).filter(request => {
            if (!request) return false;
            if (filters.status && request.status !== filters.status) return false;
            if (filters.targetRoom && request.targetRoom !== filters.targetRoom) return false;
            if (filters.reservedBy && request.reservedBy !== filters.reservedBy) return false;
            if (filters.resourceType && request.resourceType !== filters.resourceType) return false;
            return true;
        });
    }

    static _resolveTargetRoom(homeRoomOrBase, options) {
        if (options.targetRoom && Game.rooms[options.targetRoom]) return Game.rooms[options.targetRoom];
        if (homeRoomOrBase && typeof homeRoomOrBase === 'object' && homeRoomOrBase.name) return homeRoomOrBase;
        if (typeof homeRoomOrBase !== 'string') return null;
        if (Game.rooms[homeRoomOrBase]) return Game.rooms[homeRoomOrBase];
        return MainUtil.findAllRooms().find(room => room.memory.base && room.memory.base.name === homeRoomOrBase) || null;
    }

    static _getExpiry(options) {
        var maximum = Game.time + TerminalManager.MAX_REQUEST_TTL;
        if (Number.isFinite(options.expiresAt)) return this._clamp(Math.floor(options.expiresAt), Game.time + 1, maximum, maximum);
        var ttl = options.expiresIn === undefined ? options.expiry : options.expiresIn;
        ttl = this._clamp(ttl, 1, TerminalManager.MAX_REQUEST_TTL, TerminalManager.DEFAULT_REQUEST_TTL);
        return Game.time + ttl;
    }

    static _isOwnedTerminalRoom(room) {
        return !!(room && room.terminal && room.controller && room.controller.my && room.memory.base);
    }

    static getConfig(room) {
        var defaults = {
            enabled: true,
            emergencyReserve: 50000,
            batchSize: 5000,
            cooldown: 10,
            hysteresis: 500,
            maxTransfersPerTick: 1,
            historyLimit: 50,
            nextSendAt: 0,
            history: [],
            resources: {
                [RESOURCE_ENERGY]: { min: 10000, target: 20000, max: 50000, reserve: 0 },
            },
        };
        var existing = room.memory.terminal || {};
        var memory = Object.assign(defaults, existing);
        memory.enabled = memory.enabled !== false;
        memory.emergencyReserve = this._clamp(memory.emergencyReserve, 0, 10000000, 50000);
        memory.batchSize = this._clamp(memory.batchSize, 1, 100000, 5000);
        memory.cooldown = this._clamp(memory.cooldown, 0, 100, 10);
        memory.hysteresis = this._clamp(memory.hysteresis, 0, memory.batchSize, Math.min(500, memory.batchSize));
        memory.maxTransfersPerTick = this._clamp(memory.maxTransfersPerTick, 1, 5, 1);
        memory.historyLimit = this._clamp(memory.historyLimit, 1, 100, 50);
        memory.nextSendAt = this._clamp(memory.nextSendAt, 0, Number.MAX_SAFE_INTEGER, 0);
        memory.history = Array.isArray(memory.history) ? memory.history.slice(-memory.historyLimit) : [];
        memory.resources = memory.resources && typeof memory.resources === 'object' ? memory.resources : {};
        Object.keys(memory.resources).slice(0, TerminalManager.MAX_RESOURCE_TYPES).forEach(resourceType => {
            var rule = memory.resources[resourceType] || {};
            rule.min = this._clamp(rule.min, 0, 10000000, 0);
            rule.target = this._clamp(rule.target, rule.min, 10000000, rule.min);
            rule.max = this._clamp(rule.max, rule.target, 10000000, rule.target);
            rule.reserve = this._clamp(rule.reserve, 0, 10000000, 0);
            memory.resources[resourceType] = rule;
        });
        room.memory.terminal = memory;
        return memory;
    }

    static _generateBalancingRequests(managers) {
        var resourceTypes = new Set();
        managers.forEach(manager => Object.keys(manager._memory.resources).forEach(resourceType => resourceTypes.add(resourceType)));
        Array.from(resourceTypes).sort().forEach(resourceType => {
            var states = managers.map(manager => ({
                manager: manager,
                rule: manager._memory.resources[resourceType],
                stock: this.getTotalStock(manager._room, resourceType),
            })).filter(state => state.rule && state.manager._memory.enabled);
            states.filter(state => state.stock < state.rule.min).sort((a, b) => {
                return a.stock - b.stock || a.manager._room.name.localeCompare(b.manager._room.name);
            }).forEach(deficit => {
                var donors = states.filter(state => state.manager !== deficit.manager &&
                    state.stock > state.rule.max + state.manager._memory.hysteresis);
                if (donors.length === 0) return;
                var amount = Math.min(deficit.manager._memory.batchSize, deficit.rule.target - deficit.stock);
                if (amount <= 0) return;
                this.requestResource(deficit.manager._room, resourceType, amount, {
                    id: 'balance:' + deficit.manager._room.name + ':' + resourceType,
                    kind: 'balance',
                    reason: 'balance',
                    priority: 40,
                    expiry: 50,
                });
            });
        });
    }

    static _isBalanceRequestValid(request, roomsByName) {
        if (request.kind !== 'balance' || request.status !== 'open') return true;
        var target = roomsByName.get(request.targetRoom);
        if (!target) return false;
        var rule = target._memory.resources[request.resourceType];
        return !!rule && this.getTotalStock(target._room, request.resourceType) < rule.min;
    }

    static _reserveRequest(request, roomsByName) {
        var target = roomsByName.get(request.targetRoom);
        if (!target) return false;
        var candidates = [];
        roomsByName.forEach(manager => {
            if (!manager._memory.enabled || manager._room.name === request.targetRoom) return;
            if (request.donorRoom && manager._room.name !== request.donorRoom) return;
            if (request.kind === 'balance' && !this._isBalanceDonor(manager, request.resourceType)) return;
            var plan = this._buildReservationPlan(manager, request);
            if (plan.amount > 0) candidates.push({ manager: manager, plan: plan });
        });
        candidates.sort((a, b) => b.plan.amount - a.plan.amount || a.plan.fee - b.plan.fee ||
            a.manager._room.name.localeCompare(b.manager._room.name));
        if (candidates.length === 0) return false;
        var selected = candidates[0];
        request.reservedBy = selected.manager._room.name;
        request.reservedAmount = selected.plan.amount;
        request.reservedFee = selected.plan.fee;
        request.reservedAt = Game.time;
        request.updated = Game.time;
        return true;
    }

    static _isBalanceDonor(manager, resourceType) {
        var rule = manager._memory.resources[resourceType];
        return !!rule && this.getTotalStock(manager._room, resourceType) > rule.max + manager._memory.hysteresis;
    }

    static _buildReservationPlan(manager, request) {
        var maximum = Math.min(request.remaining, manager._memory.batchSize);
        if (request.kind === 'balance') {
            var rule = manager._memory.resources[request.resourceType];
            var reserved = request.resourceType === RESOURCE_ENERGY ? this.getReservedEnergy(manager._room.name, request.id) :
                this.getReservedAmount(manager._room.name, request.resourceType, request.id);
            var threshold = Math.max(rule.max, this.getReserve(manager._room, request.resourceType));
            maximum = Math.min(maximum, Math.max(0, this.getTotalStock(manager._room, request.resourceType) - threshold - reserved));
        }
        return this.createTransactionPlan(manager._room, request.resourceType, maximum, request.targetRoom, {
            sendResource: true,
            requestId: request.id,
        });
    }

    static _positionRequests(managers, requests) {
        managers.forEach(manager => {
            try {
                var desired = new Map();
                Object.keys(manager._memory.resources).forEach(resourceType => desired.set(resourceType, { amount: 0, priority: 40 }));
                requests.filter(request => request.status === 'open' && request.reservedBy === manager._room.name).forEach(request => {
                    var resource = desired.get(request.resourceType) || { amount: 0, priority: 40 };
                    resource.amount += request.reservedAmount;
                    resource.priority = Math.max(resource.priority, request.priority);
                    desired.set(request.resourceType, resource);
                    var energy = desired.get(RESOURCE_ENERGY) || { amount: 0, priority: 40 };
                    energy.amount += request.reservedFee;
                    energy.priority = Math.max(energy.priority, request.priority);
                    desired.set(RESOURCE_ENERGY, energy);
                });
                desired.forEach((value, resourceType) => {
                    this.setPositioningRule(manager._room, resourceType, value.amount, value.amount, value.priority, true);
                });
            } catch (error) {
                info.error('Could not position terminal resources for ' + manager._room.name + ': ' + error, manager._room);
            }
        });
    }

    static setPositioningRule(room, resourceType, minimum, maximum, priority = 40, replace = false) {
        if (!room || !room.memory || !resourceType) return false;
        if (!room.memory.logistics) room.memory.logistics = { tasks: [], overflow: 0 };
        if (!room.memory.logistics.terminalStockPolicy) room.memory.logistics.terminalStockPolicy = {};
        var policy = room.memory.logistics.terminalStockPolicy;
        var existing = policy[resourceType];
        priority = this._clamp(priority, 0, 1000, 40);
        if (existing && !replace && existing.priority > priority) return existing;
        minimum = this._clamp(Math.floor(minimum), 0, 10000000, 0);
        maximum = this._clamp(Math.floor(maximum), minimum, 10000000, minimum);
        policy[resourceType] = { min: minimum, max: maximum, priority: priority };
        if (Object.keys(policy).length > TerminalManager.MAX_RESOURCE_TYPES) {
            var oldest = Object.keys(policy).sort()[0];
            if (oldest !== resourceType) delete policy[oldest];
        }
        return policy[resourceType];
    }

    static positionMarketTransaction(room, plan) {
        if (!plan || plan.amount <= 0) return;
        if (plan.sendResource) {
            var resourceAmount = plan.amount + (plan.resourceType === RESOURCE_ENERGY ? plan.fee : 0);
            this.setPositioningRule(room, plan.resourceType, resourceAmount, resourceAmount, 30, false);
        } else {
            this.setPositioningRule(room, plan.resourceType, 0, 0, 30, false);
        }
        if (plan.fee > 0 && plan.resourceType !== RESOURCE_ENERGY) {
            this.setPositioningRule(room, RESOURCE_ENERGY, plan.fee, plan.fee, 30, false);
        } else if (!plan.sendResource && plan.fee > 0) {
            this.setPositioningRule(room, RESOURCE_ENERGY, plan.fee, plan.fee, 30, false);
        }
    }

    static _executeRequests(requests, roomsByName) {
        var sendsByRoom = new Map();
        requests.filter(request => request.status === 'open' && request.reservedBy).forEach(request => {
            try {
                var donor = roomsByName.get(request.reservedBy);
            if (!donor) {
                this._releaseReservation(request);
                return;
            }
            var sent = sendsByRoom.get(donor._room.name) || 0;
            if (sent >= donor._memory.maxTransfersPerTick || this.isCooldownActive(donor._room)) return;
            var validation = this._validateReservedTransaction(donor._room, request);
            if (!validation.reserveOK) {
                this._releaseReservation(request);
                request.retryAfter = Game.time + donor._memory.cooldown;
                return;
            }
            if (!validation.terminalReady) return;
            var result = donor._room.terminal.send(request.resourceType, request.reservedAmount, request.targetRoom, request.id);
            if (result === OK) {
                var amount = request.reservedAmount;
                var fee = request.reservedFee;
                request.remaining = Math.max(0, request.remaining - amount);
                this._releaseReservation(request);
                request.updated = Game.time;
                if (request.remaining <= 0) {
                    request.status = 'complete';
                    request.completedAt = Game.time;
                }
                sendsByRoom.set(donor._room.name, sent + 1);
                this.recordTransaction(donor._room, {
                    kind: 'terminal', resourceType: request.resourceType, amount: amount,
                    targetRoom: request.targetRoom, fee: fee, result: result,
                });
            } else {
                request.lastError = result;
                request.retryAfter = Game.time + Math.max(10, donor._memory.cooldown);
                this.recordTransaction(donor._room, {
                    kind: 'terminal', resourceType: request.resourceType, amount: request.reservedAmount,
                    targetRoom: request.targetRoom, fee: request.reservedFee, result: result,
                });
                this._releaseReservation(request);
            }
            } catch (error) {
                info.error('Could not execute terminal request ' + request.id + ': ' + error);
            }
        });
    }

    static _validateReservedTransaction(room, request) {
        var plan = this.createTransactionPlan(room, request.resourceType, request.reservedAmount, request.targetRoom, {
            sendResource: true,
            requestId: request.id,
            maxAmount: request.reservedAmount,
        });
        return {
            reserveOK: plan.amount === request.reservedAmount && plan.fee === request.reservedFee,
            terminalReady: plan.terminalReady,
        };
    }

    static createTransactionPlan(room, resourceType, requestedAmount, targetRoomName, options = {}) {
        var sendResource = options.sendResource !== false;
        var requested = this._clamp(Math.floor(requestedAmount), 0, TerminalManager.MAX_REQUEST_AMOUNT, 0);
        if (Number.isFinite(options.maxAmount)) requested = Math.min(requested, Math.max(0, Math.floor(options.maxAmount)));
        var availableResource = sendResource ? this.getAvailable(room, resourceType, options.requestId) : requested;
        var availableEnergy = this.getAvailable(room, RESOURCE_ENERGY, options.requestId);
        var amount = sendResource ? Math.min(requested, availableResource) : requested;
        if (resourceType === RESOURCE_ENERGY && sendResource) amount = Math.min(amount, availableEnergy);
        var fee = this.calculateTransactionCost(amount, room.name, targetRoomName);
        for (var iteration = 0; iteration < 8 && amount > 0; iteration++) {
            var energyCost = fee + (sendResource && resourceType === RESOURCE_ENERGY ? amount : 0);
            if (energyCost <= availableEnergy && (!sendResource || resourceType === RESOURCE_ENERGY || amount <= availableResource)) break;
            if (sendResource && resourceType === RESOURCE_ENERGY) {
                amount = Math.max(0, Math.min(amount - 1, availableEnergy - fee));
            } else if (fee > availableEnergy) {
                amount = Math.max(0, Math.min(amount - 1, Math.floor(amount * availableEnergy / Math.max(1, fee))));
            } else {
                amount = Math.max(0, Math.min(amount - 1, availableResource));
            }
            fee = this.calculateTransactionCost(amount, room.name, targetRoomName);
        }
        fee = this.calculateTransactionCost(amount, room.name, targetRoomName);
        var reserveOK = amount > 0 && fee <= availableEnergy &&
            (!sendResource || resourceType !== RESOURCE_ENERGY || amount + fee <= availableEnergy) &&
            (!sendResource || resourceType === RESOURCE_ENERGY || amount <= availableResource);
        var terminal = room.terminal;
        var terminalResource = terminal ? terminal.store.getUsedCapacity(resourceType) : 0;
        var terminalEnergy = terminal ? terminal.store.getUsedCapacity(RESOURCE_ENERGY) : 0;
        var requiredResource = sendResource ? amount + (resourceType === RESOURCE_ENERGY ? fee : 0) : 0;
        var requiredEnergy = resourceType === RESOURCE_ENERGY && sendResource ? 0 : fee;
        var capacityReady = sendResource || (terminal && terminal.store.getFreeCapacity(resourceType) >= amount);
        var terminalReady = reserveOK && !!terminal && terminalResource >= requiredResource && terminalEnergy >= requiredEnergy && capacityReady;
        return {
            resourceType: resourceType,
            targetRoom: targetRoomName,
            sendResource: sendResource,
            amount: amount,
            fee: fee,
            availableResource: availableResource,
            availableEnergy: availableEnergy,
            reserveOK: reserveOK,
            terminalReady: terminalReady,
            ready: terminalReady && !this.isCooldownActive(room),
            missingResource: Math.max(0, requiredResource - terminalResource),
            missingEnergy: Math.max(0, requiredEnergy - terminalEnergy),
        };
    }

    static calculateTransactionCost(amount, fromRoomName, targetRoomName) {
        if (amount <= 0 || !Game.market || !Game.market.calcTransactionCost) return 0;
        var fee = Game.market.calcTransactionCost(amount, fromRoomName, targetRoomName);
        return Number.isFinite(fee) ? Math.max(0, Math.ceil(fee)) : 0;
    }

    static getTotalStock(room, resourceType) {
        if (!room) return 0;
        var storage = room.storage ? room.storage.store.getUsedCapacity(resourceType) : 0;
        var terminal = room.terminal ? room.terminal.store.getUsedCapacity(resourceType) : 0;
        return storage + terminal;
    }

    static getReserve(room, resourceType) {
        var config = this.getConfig(room);
        var rule = config.resources[resourceType] || {};
        var reserve = this._clamp(rule.reserve, 0, 10000000, 0);
        return resourceType === RESOURCE_ENERGY ? Math.max(reserve, config.emergencyReserve) : reserve;
    }

    static getAvailable(room, resourceType, exceptRequestId) {
        var reserved = resourceType === RESOURCE_ENERGY ? this.getReservedEnergy(room.name, exceptRequestId) :
            this.getReservedAmount(room.name, resourceType, exceptRequestId);
        return Math.max(0, this.getTotalStock(room, resourceType) - this.getReserve(room, resourceType) - reserved);
    }

    static getReservedAmount(roomName, resourceType, exceptRequestId) {
        return this.getResourceRequests({ status: 'open', reservedBy: roomName, resourceType: resourceType })
            .filter(request => request.id !== exceptRequestId)
            .reduce((sum, request) => sum + Math.max(0, request.reservedAmount || 0), 0);
    }

    static getReservedEnergy(roomName, exceptRequestId) {
        return this.getResourceRequests({ status: 'open', reservedBy: roomName }).filter(request => request.id !== exceptRequestId)
            .reduce((sum, request) => sum + Math.max(0, request.reservedFee || 0) +
                (request.resourceType === RESOURCE_ENERGY ? Math.max(0, request.reservedAmount || 0) : 0), 0);
    }

    static isCooldownActive(room) {
        if (!room || !room.terminal) return true;
        var config = this.getConfig(room);
        return room.terminal.cooldown > 0 || config.nextSendAt > Game.time;
    }

    static recordTransaction(room, details) {
        var config = this.getConfig(room);
        config.nextSendAt = Math.max(config.nextSendAt, Game.time + config.cooldown);
        config.history.push({
            tick: Game.time,
            kind: details.kind || 'terminal',
            resourceType: details.resourceType,
            amount: details.amount || 0,
            targetRoom: details.targetRoom || null,
            fee: details.fee || 0,
            result: details.result,
            orderId: details.orderId || null,
            price: details.price || 0,
            credits: details.credits || 0,
        });
        config.history = config.history.slice(-config.historyLimit);
    }

    static _releaseReservation(request) {
        request.reservedBy = null;
        request.reservedAmount = 0;
        request.reservedFee = 0;
        request.reservedAt = 0;
    }

    static _compareRequests(a, b) {
        return (b.priority || 0) - (a.priority || 0) || (a.created || 0) - (b.created || 0) || a.id.localeCompare(b.id);
    }

    static _safeId(value) {
        return String(value).substring(0, 100).replace(/[^A-Za-z0-9_.:-]/g, '_');
    }

    static _clamp(value, minimum, maximum, fallback) {
        value = Number(value);
        if (value === Infinity) return maximum;
        if (value === -Infinity) return minimum;
        if (!Number.isFinite(value)) return fallback;
        return Math.max(minimum, Math.min(maximum, value));
    }
}

TerminalManager.DEFAULT_REQUEST_TTL = 1000;
TerminalManager.MAX_REQUEST_TTL = 10000;
TerminalManager.MAX_REQUEST_AMOUNT = 1000000;
TerminalManager.MAX_RESOURCE_TYPES = 50;

module.exports = TerminalManager;
