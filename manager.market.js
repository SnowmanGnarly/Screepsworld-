var MainUtil = require('./main.util');
var TerminalManager = require('./manager.terminal');
var info = require('./main.info');

class MarketManager {

    static runAll(allowExpensive = true) {
        if (!Game.market) return;
        var context = { orders: null, scanned: 0, deals: 0 };
        MainUtil.findAllRooms().filter(room => TerminalManager._isOwnedTerminalRoom(room))
            .sort((a, b) => a.name.localeCompare(b.name)).forEach(room => {
                try {
                    new MarketManager(room).run(allowExpensive, context);
                } catch (error) {
                    info.error('Could not run market for ' + room.name + ': ' + error, room);
                }
            });
    }

    constructor(room) {
        this._room = room;
        this._memory = MarketManager.getConfig(room);
        this._deals = 0;
        this._creditsSpent = 0;
    }

    static getConfig(room) {
        var defaults = {
            enabled: false,
            buy: false,
            sell: false,
            createOrders: false,
            batchSize: 1000,
            scanCooldown: 25,
            failureCooldown: 100,
            maxDealsPerTick: 1,
            maxScannedOrders: 100,
            maxCreditsPerTick: 10000,
            maxCreditsPerDeal: 5000,
            minCreditBalance: 0,
            energyPrice: 0,
            historyLimit: 50,
            nextScanAt: 0,
            failures: 0,
            history: [],
            pending: null,
            resources: {},
        };
        var memory = Object.assign(defaults, room.memory.market || {});
        memory.enabled = memory.enabled === true;
        memory.buy = memory.buy === true;
        memory.sell = memory.sell === true;
        memory.createOrders = false;
        memory.batchSize = MainUtil.clamp(memory.batchSize, 1, 100000, 1000);
        memory.scanCooldown = MainUtil.clamp(memory.scanCooldown, 1, 1000, 25);
        memory.failureCooldown = MainUtil.clamp(memory.failureCooldown, 10, 5000, 100);
        memory.maxDealsPerTick = MainUtil.clamp(memory.maxDealsPerTick, 1, 5, 1);
        memory.maxScannedOrders = MainUtil.clamp(memory.maxScannedOrders, 1, 1000, 100);
        memory.maxCreditsPerTick = MainUtil.clamp(memory.maxCreditsPerTick, 0, 1000000000, 10000);
        memory.maxCreditsPerDeal = MainUtil.clamp(memory.maxCreditsPerDeal, 0, 1000000000, 5000);
        memory.minCreditBalance = MainUtil.clamp(memory.minCreditBalance, 0, 1000000000, 0);
        memory.energyPrice = MainUtil.clamp(memory.energyPrice, 0, 1000000, 0);
        memory.historyLimit = MainUtil.clamp(memory.historyLimit, 1, 100, 50);
        memory.nextScanAt = MainUtil.clamp(memory.nextScanAt, 0, Number.MAX_SAFE_INTEGER, 0);
        memory.failures = MainUtil.clamp(memory.failures, 0, 20, 0);
        memory.history = Array.isArray(memory.history) ? memory.history.slice(-memory.historyLimit) : [];
        memory.resources = memory.resources && typeof memory.resources === 'object' ? memory.resources : {};
        var terminalRules = TerminalManager.getConfig(room).resources;
        Object.keys(memory.resources).slice(0, TerminalManager.MAX_RESOURCE_TYPES).forEach(resourceType => {
            var terminalRule = terminalRules[resourceType] || {};
            var rule = Object.assign({
                min: terminalRule.min || 0,
                target: terminalRule.target || 0,
                max: terminalRule.max || 0,
                reserve: terminalRule.reserve || 0,
            }, memory.resources[resourceType] || {});
            rule.buy = rule.buy === true;
            rule.sell = rule.sell === true;
            rule.min = MainUtil.clamp(rule.buyBelow === undefined ? rule.min : rule.buyBelow, 0, 10000000, 0);
            rule.target = MainUtil.clamp(rule.buyTo === undefined ? rule.target : rule.buyTo, rule.min, 10000000, rule.min);
            rule.max = MainUtil.clamp(rule.sellAbove === undefined ? rule.max : rule.sellAbove, 0, 10000000, 0);
            rule.sellTo = MainUtil.clamp(rule.sellTo, 0, rule.max, rule.max);
            rule.reserve = MainUtil.clamp(rule.reserve, 0, 10000000, 0);
            rule.maxBuyPrice = MainUtil.clamp(rule.maxBuyPrice === undefined ? rule.maxPrice : rule.maxBuyPrice,
                0, 1000000, 0);
            rule.minSellPrice = MainUtil.clamp(rule.minSellPrice === undefined ? rule.minPrice : rule.minSellPrice,
                0, 1000000, 0);
            rule.batchSize = MainUtil.clamp(rule.batchSize, 1, 100000, memory.batchSize);
            memory.resources[resourceType] = rule;
        });
        room.memory.market = memory;
        return memory;
    }

    run(allowExpensive, context) {
        this._positionPending();
        if (!this._memory.enabled || !allowExpensive || Game.time < this._memory.nextScanAt) return;
        if (this._deals >= this._memory.maxDealsPerTick || context.deals >= MarketManager.MAX_DEALS_PER_TICK) return;
        if (TerminalManager.isCooldownActive(this._room)) return;
        if (context.orders === null) {
            if (!Game.market.getAllOrders) return;
            try {
                context.orders = Game.market.getAllOrders() || [];
                if (!Array.isArray(context.orders)) context.orders = Object.keys(context.orders).map(id => context.orders[id]);
                context.orders = context.orders.slice();
            } catch (error) {
                this._memory.failures++;
                this._memory.nextScanAt = Game.time + Math.min(5000, this._memory.failureCooldown * this._memory.failures);
                info.warning('Market order scan failed for ' + this._room.name + ': ' + error);
                return;
            }
        }
        var scanBudget = MarketManager.MAX_SCANNED_ORDERS_PER_TICK - context.scanned;
        if (scanBudget <= 0) return;
        var orders = context.orders.slice(0, Math.min(this._memory.maxScannedOrders, scanBudget))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        context.scanned += orders.length;

        var resourceTypes = Object.keys(this._memory.resources).sort();
        for (var resourceType of resourceTypes) {
            for (var side of ['buy', 'sell']) {
                if (!this._canAttempt(side)) continue;
                var candidate = this._findBestOrder(resourceType, side, orders);
                if (!candidate) continue;
                if (!candidate.plan.ready) {
                    this._setPending(candidate);
                    return;
                }
                var completed = this._deal(candidate, context);
                if (!completed) return;
                if (this._deals >= this._memory.maxDealsPerTick || context.deals >= MarketManager.MAX_DEALS_PER_TICK ||
                    TerminalManager.isCooldownActive(this._room)) return;
            }
        }
        this._memory.pending = null;
        this._memory.nextScanAt = Game.time + this._memory.scanCooldown;
    }

    _canAttempt(side) {
        if (!this._memory.enabled || !this._memory[side]) return false;
        if (this._deals >= this._memory.maxDealsPerTick || TerminalManager.isCooldownActive(this._room)) return false;
        return true;
    }

    _findBestOrder(resourceType, side, orders) {
        var rule = this._memory.resources[resourceType];
        if (!rule || !rule[side]) return null;
        var stock = TerminalManager.getTotalStock(this._room, resourceType);
        var wanted = 0;
        if (side === 'buy' && stock < rule.min) wanted = rule.target - stock;
        if (side === 'sell' && stock > rule.max) wanted = stock - rule.sellTo;
        wanted = Math.min(wanted, rule.batchSize, this._memory.batchSize);
        if (wanted <= 0) return null;
        var orderType = side === 'buy' ? ORDER_SELL : ORDER_BUY;
        var candidates = [];
        orders.filter(order => order && order.type === orderType && order.resourceType === resourceType &&
            order.amount > 0 && order.roomName && Number.isFinite(order.price) && order.price > 0).forEach(order => {
            var amount = Math.min(wanted, Math.floor(order.amount));
            if (side === 'buy') {
                var credits = Number(Game.market.credits) || 0;
                var budget = Math.min(credits - this._memory.minCreditBalance,
                    this._memory.maxCreditsPerTick - this._creditsSpent, this._memory.maxCreditsPerDeal);
                amount = Math.min(amount, Math.floor(Math.max(0, budget) / order.price));
            }
            if (amount <= 0) return;
            var plan = TerminalManager.createTransactionPlan(this._room, resourceType, amount, order.roomName, {
                sendResource: side === 'sell',
            });
            if (plan.amount <= 0 || !plan.reserveOK) return;
            var energyPrice = rule.energyPrice === undefined ? this._memory.energyPrice : rule.energyPrice;
            var effectivePrice = order.price + (side === 'buy' ? 1 : -1) * plan.fee * energyPrice / plan.amount;
            if (side === 'buy' && effectivePrice > rule.maxBuyPrice) return;
            if (side === 'sell' && effectivePrice < rule.minSellPrice) return;
            candidates.push({ order: order, side: side, plan: plan, effectivePrice: effectivePrice });
        });
        candidates.sort((a, b) => {
            var priceDifference = side === 'buy' ? a.effectivePrice - b.effectivePrice : b.effectivePrice - a.effectivePrice;
            return priceDifference || b.plan.amount - a.plan.amount || a.plan.fee - b.plan.fee ||
                String(a.order.id).localeCompare(String(b.order.id));
        });
        return candidates[0] || null;
    }

    _setPending(candidate) {
        this._memory.pending = {
            orderId: candidate.order.id,
            side: candidate.side,
            resourceType: candidate.plan.resourceType,
            targetRoom: candidate.plan.targetRoom,
            sendResource: candidate.plan.sendResource,
            amount: candidate.plan.amount,
            fee: candidate.plan.fee,
            price: candidate.order.price,
            expiresAt: Game.time + 100,
        };
        this._memory.nextScanAt = Game.time + 5;
        TerminalManager.positionMarketTransaction(this._room, candidate.plan);
    }

    _positionPending() {
        var pending = this._memory.pending;
        if (!pending) return;
        if (pending.expiresAt <= Game.time || !this._memory.enabled) {
            this._memory.pending = null;
            return;
        }
        TerminalManager.positionMarketTransaction(this._room, pending);
    }

    _deal(candidate, context) {
        var order = candidate.order;
        var plan = candidate.plan;
        var side = candidate.side;
        var credits = plan.amount * order.price;
        var result = Game.market.deal(order.id, plan.amount, this._room.name);
        this._memory.history.push({
            tick: Game.time,
            side: side,
            resourceType: plan.resourceType,
            amount: plan.amount,
            orderId: order.id,
            price: order.price,
            fee: plan.fee,
            credits: credits,
            result: result,
        });
        this._memory.history = this._memory.history.slice(-this._memory.historyLimit);
        TerminalManager.recordTransaction(this._room, {
            kind: 'market', resourceType: plan.resourceType, amount: plan.amount,
            targetRoom: order.roomName, fee: plan.fee, result: result,
            orderId: order.id, price: order.price, credits: credits,
        });
        this._memory.pending = null;
        if (result !== OK) {
            this._memory.failures++;
            this._memory.nextScanAt = Game.time + Math.min(5000, this._memory.failureCooldown * this._memory.failures);
            return false;
        }
        this._memory.failures = 0;
        this._memory.nextScanAt = Game.time + this._memory.scanCooldown;
        this._deals++;
        context.deals++;
        if (side === 'buy') this._creditsSpent += credits;
        return true;
    }

}

MarketManager.MAX_DEALS_PER_TICK = 10;
MarketManager.MAX_SCANNED_ORDERS_PER_TICK = 1000;

module.exports = MarketManager;
