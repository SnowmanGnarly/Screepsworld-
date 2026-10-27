const assert = require('node:assert/strict');
const {
    makeStore, makeRoom, makeStructure, makeTerminal, makePosition, setFind, resetScreeps, registerObject,
} = require('./helpers/screeps');
const IntelManager = require('../manager.intel');
const TerminalManager = require('../manager.terminal');
const MarketManager = require('../manager.market');
const LogisticsManager = require('../manager.logistics');

function ownedRoom(name, options = {}) {
    const memory = {
        base: { name, roleConfig: {} },
        logistics: options.logistics || { tasks: [] },
        terminal: options.terminalConfig || {
            enabled: true,
            emergencyReserve: options.emergencyReserve === undefined ? 1000 : options.emergencyReserve,
            batchSize: 500,
            cooldown: 0,
            hysteresis: 100,
            resources: {},
        },
    };
    if (options.marketConfig) memory.market = options.marketConfig;
    const room = makeRoom(name, { memory });
    room.controller = { my: true, level: 6, pos: makePosition(room, 30, 30), owner: { username: 'Me' } };
    const storage = makeStructure(room, STRUCTURE_STORAGE, {
        id: 'storage-' + name,
        pos: makePosition(room, 24, 25),
        store: makeStore(100000, options.storage || {}),
    });
    const terminal = makeTerminal(room, {
        pos: makePosition(room, 26, 25),
        store: makeStore(100000, options.terminal || {}),
        cooldown: options.cooldown || 0,
    });
    room.storage = storage;
    Game.rooms[name] = room;
    registerObject(storage, name);
    registerObject(terminal, name);
    setFind(room, FIND_STRUCTURES, [storage, terminal]);
    setFind(room, FIND_MY_STRUCTURES, [storage, terminal]);
    setFind(room, FIND_HOSTILE_CREEPS, []);
    return { room, storage, terminal };
}

function energyRules(overrides = {}) {
    return Object.assign({ min: 1000, target: 2000, max: 5000, reserve: 500 }, overrides);
}

function addOrder(id, type, resourceType, price, amount = 1000, roomName = 'X') {
    const order = { id, type, resourceType, price, amount, roomName, active: true };
    Game.market.orders[id] = order;
    return order;
}

describe('Terminal and market economy regressions', function () {
    beforeEach(function () {
        resetScreeps();
        Game.market.calcTransactionCost = () => 0;
    });

    it('persists bounded primitive resource requests and expires them through intel cleanup', function () {
        ownedRoom('A');
        const first = TerminalManager.requestResource('A', RESOURCE_OXYGEN, 500, {
            priority: 80, reason: 'future components', expiry: 10,
        });
        assert.ok(first);
        const duplicate = TerminalManager.requestTransfer('A', RESOURCE_OXYGEN, 600, {
            priority: 90, reason: 'future components', expiry: 10,
        });
        assert.equal(duplicate, first);
        assert.equal(first.remaining, 600);
        assert.equal(first.priority, 90);
        assert.equal(JSON.parse(JSON.stringify(first)).targetRoom, 'A');
        for (let index = 0; index < 120; index++) {
            TerminalManager.requestResource('A', RESOURCE_OXYGEN, 1, { id: 'bounded-' + index, expiry: 100 });
        }
        assert.ok(Object.keys(Memory.empire.resourceRequests).length <= IntelManager.MAX_RESOURCE_REQUESTS);
        const sos = TerminalManager.requestResource('A', RESOURCE_ENERGY, 100, { id: 'sos', defense: true, expiry: 100 });
        assert.ok(sos);
        assert.ok(Object.keys(Memory.empire.resourceRequests).length <= IntelManager.MAX_RESOURCE_REQUESTS);
        Game.time = 11;
        IntelManager.cleanup();
        assert.equal(Memory.empire.resourceRequests[first.id], undefined);
        assert.ok(Object.keys(Memory.empire.resourceRequests).length <= IntelManager.MAX_RESOURCE_REQUESTS);
    });

    it('keeps market trading and public orders disabled by default and skips scans at low bucket', function () {
        const { room } = ownedRoom('A', {
            terminal: { [RESOURCE_OXYGEN]: 10000, [RESOURCE_ENERGY]: 10000 },
            marketConfig: {
                enabled: true,
                buy: true,
                resources: { [RESOURCE_OXYGEN]: { buy: true, min: 100, target: 500, maxBuyPrice: 2 } },
            },
        });
        MarketManager.runAll(false);
        assert.equal(Game.market.getAllOrdersCalls, 0);
        room.memory.market.enabled = false;
        MarketManager.runAll(true);
        assert.equal(Game.market.getAllOrdersCalls, 0);
        assert.equal(Game.market.deals.length, 0);
        assert.equal(Game.market.createOrderCalls, 0);
    });

    it('calculates exact fee and reserve budgets and reports missing terminal energy', function () {
        const { room, storage, terminal } = ownedRoom('A', {
            storage: { [RESOURCE_ENERGY]: 1000 },
            terminal: { [RESOURCE_ENERGY]: 600 },
        });
        Game.market.calcTransactionCost = () => 100;
        const plan = TerminalManager.createTransactionPlan(room, RESOURCE_ENERGY, 500, 'B', { sendResource: true });
        assert.equal(plan.amount, 500);
        assert.equal(plan.fee, 100);
        assert.equal(plan.availableEnergy, 600);
        assert.equal(plan.reserveOK, true);
        assert.equal(plan.terminalReady, true);
        storage.store.set(RESOURCE_ENERGY, 1100);
        terminal.store.set(RESOURCE_ENERGY, 500);
        const missing = TerminalManager.createTransactionPlan(room, RESOURCE_ENERGY, 500, 'B', { sendResource: true });
        assert.equal(missing.terminalReady, false);
        assert.equal(missing.missingResource, 100);
    });

    it('does not duplicate reservations, positions exact fees through logistics, and honors cooldowns', function () {
        const donor = ownedRoom('A', {
            storage: { [RESOURCE_ENERGY]: 1100 },
            terminal: { [RESOURCE_ENERGY]: 500 },
        });
        const recipient = ownedRoom('B');
        Game.market.calcTransactionCost = () => 100;
        const request = TerminalManager.requestResource('B', RESOURCE_ENERGY, 500, { priority: 80, expiry: 100 });

        TerminalManager.runAll();
        TerminalManager.runAll();
        assert.equal(request.reservedBy, 'A');
        assert.equal(request.reservedAmount, 500);
        assert.equal(request.reservedFee, 100);
        assert.equal(TerminalManager.getReservedEnergy('A'), 600);
        assert.equal(donor.terminal.sent.length, 0);
        assert.equal(donor.room.memory.logistics.terminalStockPolicy[RESOURCE_ENERGY].min, 600);

        new LogisticsManager(donor.room).run();
        const positioning = donor.room.memory.logistics.tasks.find(task => !task.standing);
        assert.equal(positioning.sourceId, donor.storage.id);
        assert.equal(positioning.targetId, donor.terminal.id);
        assert.equal(positioning.amount, 100);
        donor.storage.store.set(RESOURCE_ENERGY, 1000);
        donor.terminal.store.set(RESOURCE_ENERGY, 600);
        Game.time = 2;
        TerminalManager.runAll();
        assert.equal(donor.terminal.sent.length, 1);
        assert.equal(donor.terminal.sent[0].fee, 100);
        assert.equal(recipient.terminal.store.getUsedCapacity(RESOURCE_ENERGY), 500);
        assert.equal(TerminalManager.getTotalStock(donor.room, RESOURCE_ENERGY), 1000);
        assert.equal(request.status, 'complete');

        donor.storage.store.set(RESOURCE_ENERGY, 1000);
        donor.terminal.store.set(RESOURCE_ENERGY, 1000);
        TerminalManager.requestResource('B', RESOURCE_ENERGY, 100, { reason: 'cooldown', expiry: 100 });
        Game.time = 3;
        TerminalManager.runAll();
        assert.equal(donor.terminal.sent.length, 1);
        donor.terminal.cooldown = 0;
        Game.time = 20;
        TerminalManager.runAll();
        assert.equal(donor.terminal.sent.length, 2);
    });

    it('balances owned rooms in deterministic batches without donor-recipient oscillation', function () {
        const donor = ownedRoom('A', {
            storage: { [RESOURCE_ENERGY]: 2000 },
            terminal: { [RESOURCE_ENERGY]: 8000 },
            terminalConfig: {
                enabled: true, emergencyReserve: 500, batchSize: 1000, cooldown: 0, hysteresis: 100,
                resources: { [RESOURCE_ENERGY]: energyRules() },
            },
        });
        const recipient = ownedRoom('B', {
            terminal: { [RESOURCE_ENERGY]: 500 },
            terminalConfig: {
                enabled: true, emergencyReserve: 500, batchSize: 1000, cooldown: 0, hysteresis: 100,
                resources: { [RESOURCE_ENERGY]: energyRules() },
            },
        });
        TerminalManager.runAll();
        assert.equal(donor.terminal.sent.length, 1);
        assert.equal(donor.terminal.sent[0].amount, 1000);
        assert.equal(recipient.terminal.store.getUsedCapacity(RESOURCE_ENERGY), 1500);
        donor.terminal.cooldown = 0;
        Game.time = 20;
        TerminalManager.runAll();
        assert.equal(donor.terminal.sent.length, 1);
        assert.equal(TerminalManager.getTotalStock(recipient.room, RESOURCE_ENERGY), 1500);
    });

    it('preempts ordinary transfers with defense-priority requests', function () {
        const donor = ownedRoom('A', {
            emergencyReserve: 0,
            terminal: { [RESOURCE_ENERGY]: 600 },
            terminalConfig: { enabled: true, emergencyReserve: 0, batchSize: 500, cooldown: 0, resources: {} },
        });
        const ordinary = ownedRoom('B');
        const defense = ownedRoom('C');
        Game.market.calcTransactionCost = () => 100;
        const normalRequest = TerminalManager.requestResource(ordinary.room, RESOURCE_ENERGY, 500, { priority: 40, reason: 'ordinary' });
        const defenseRequest = TerminalManager.requestResource(defense.room, RESOURCE_ENERGY, 500, { defense: true, reason: 'SOS' });
        TerminalManager.runAll();
        assert.equal(defense.terminal.store.getUsedCapacity(RESOURCE_ENERGY), 500);
        assert.equal(ordinary.terminal.store.getUsedCapacity(RESOURCE_ENERGY), 0);
        assert.equal(defenseRequest.status, 'complete');
        assert.equal(normalRequest.status, 'open');
        assert.equal(donor.terminal.sent.length, 1);
        assert.equal(donor.terminal.sent[0].targetRoomName, 'C');
    });

    it('preserves manual stock rules and standing logistics tasks', function () {
        const donor = ownedRoom('A', {
            storage: { [RESOURCE_OXYGEN]: 1000 },
            logistics: {
                stockPolicy: { [RESOURCE_OXYGEN]: { min: 5, max: 10 } },
                tasks: [{
                    id: 'standing', sourceId: 'manual-source', targetId: 'manual-target',
                    sourceRoomName: 'Offscreen', targetRoomName: 'Offscreen', resourceType: RESOURCE_OXYGEN,
                    amount: 100, remaining: 100, priority: 80, standing: true, created: 1,
                }],
            },
        });
        ownedRoom('B');
        TerminalManager.requestResource('B', RESOURCE_OXYGEN, 100, { priority: 80 });
        TerminalManager.runAll();
        new LogisticsManager(donor.room).run();
        assert.deepEqual(donor.room.memory.logistics.stockPolicy[RESOURCE_OXYGEN], { min: 5, max: 10 });
        assert.ok(donor.room.memory.logistics.tasks.some(task => task.standing));
        const manual = donor.room.memory.logistics.tasks.find(task => !task.standing);
        assert.equal(manual.amount, 990);
        assert.equal(manual.priority, 30);
    });

    it('selects the best net eligible sell order and enforces deal caps', function () {
        const seller = ownedRoom('A', {
            emergencyReserve: 0,
            storage: { [RESOURCE_OXYGEN]: 2000 },
            terminal: { [RESOURCE_OXYGEN]: 1000, [RESOURCE_ENERGY]: 1000 },
            terminalConfig: { enabled: true, emergencyReserve: 0, batchSize: 400, cooldown: 0, resources: {} },
            marketConfig: {
                enabled: true, sell: true, batchSize: 400, energyPrice: 1, maxDealsPerTick: 1,
                resources: {
                    [RESOURCE_OXYGEN]: { sell: true, min: 0, target: 0, max: 1000, sellTo: 1000, minSellPrice: 2, batchSize: 400 },
                },
            },
        });
        addOrder('nominal', ORDER_BUY, RESOURCE_OXYGEN, 3, 400, 'Y');
        addOrder('net-best', ORDER_BUY, RESOURCE_OXYGEN, 2.9, 400, 'X');
        Game.market.credits = 1000;
        Game.market.calcTransactionCost = (amount, from, target) => target === 'Y' ? 100 : 0;
        MarketManager.runAll(true);
        assert.equal(Game.market.deals.length, 1);
        assert.equal(Game.market.deals[0].orderId, 'net-best');
        assert.equal(Game.market.deals[0].amount, 400);
        assert.equal(seller.terminal.store.getUsedCapacity(RESOURCE_OXYGEN), 600);
        assert.equal(Game.market.credits, 2160);
        assert.equal(Game.market.createOrderCalls, 0);
    });

    it('enforces buy price, credit, and per-deal limits', function () {
        const buyer = ownedRoom('A', {
            emergencyReserve: 0,
            terminal: { [RESOURCE_ENERGY]: 1000 },
            terminalConfig: { enabled: true, emergencyReserve: 0, batchSize: 500, cooldown: 0, resources: {} },
            marketConfig: {
                enabled: true, buy: true, batchSize: 500, maxCreditsPerTick: 300, maxCreditsPerDeal: 300,
                minCreditBalance: 100,
                resources: {
                    [RESOURCE_OXYGEN]: { buy: true, min: 100, target: 500, max: 1000, maxBuyPrice: 2, batchSize: 500 },
                },
            },
        });
        const eligible = addOrder('eligible', ORDER_SELL, RESOURCE_OXYGEN, 1.5, 500, 'X');
        const expensive = addOrder('expensive', ORDER_SELL, RESOURCE_OXYGEN, 3, 500, 'Y');
        Game.market.credits = 1000;
        Game.market.calcTransactionCost = () => 10;
        MarketManager.runAll(true);
        assert.equal(Game.market.deals.length, 1);
        assert.equal(Game.market.deals[0].amount, 200);
        assert.equal(Game.market.deals[0].credits, 300);
        assert.equal(Game.market.credits, 700);
        assert.equal(buyer.terminal.store.getUsedCapacity(RESOURCE_OXYGEN), 200);
        assert.equal(eligible.amount, 300);
        assert.equal(expensive.amount, 500);
    });

    it('caps scanned orders without falling back to public order creation', function () {
        ownedRoom('A', {
            emergencyReserve: 0,
            terminal: { [RESOURCE_OXYGEN]: 1000, [RESOURCE_ENERGY]: 1000 },
            terminalConfig: { enabled: true, emergencyReserve: 0, batchSize: 400, cooldown: 0, resources: {} },
            marketConfig: {
                enabled: true, sell: true, maxScannedOrders: 1,
                resources: {
                    [RESOURCE_OXYGEN]: { sell: true, min: 0, target: 0, max: 100, sellTo: 100, minSellPrice: 2 },
                },
            },
        });
        addOrder('a-ineligible', ORDER_BUY, RESOURCE_OXYGEN, 1, 400, 'X');
        addOrder('b-eligible', ORDER_BUY, RESOURCE_OXYGEN, 3, 400, 'Y');
        MarketManager.runAll(true);
        assert.equal(Game.market.deals.length, 0);
        assert.equal(Game.market.getAllOrdersCalls, 1);
        assert.equal(Game.market.createOrderCalls, 0);
    });

    it('rate-limits failed deals and bounds market history', function () {
        const seller = ownedRoom('A', {
            emergencyReserve: 0,
            terminal: { [RESOURCE_OXYGEN]: 1000, [RESOURCE_ENERGY]: 1000 },
            terminalConfig: { enabled: true, emergencyReserve: 0, batchSize: 400, cooldown: 0, resources: {} },
            marketConfig: {
                enabled: true, sell: true, batchSize: 400, failureCooldown: 50, historyLimit: 1,
                resources: {
                    [RESOURCE_OXYGEN]: { sell: true, min: 0, target: 0, max: 100, sellTo: 100, minSellPrice: 1, batchSize: 400 },
                },
            },
        });
        addOrder('order', ORDER_BUY, RESOURCE_OXYGEN, 2, 400, 'X');
        const originalDeal = Game.market.deal;
        let calls = 0;
        Game.market.deal = function (...args) {
            calls++;
            return calls === 1 ? ERR_INVALID_TARGET : originalDeal.apply(this, args);
        };
        MarketManager.runAll(true);
        assert.equal(calls, 1);
        assert.equal(seller.room.memory.market.nextScanAt, 51);
        MarketManager.runAll(true);
        assert.equal(calls, 1);
        assert.equal(Game.market.getAllOrdersCalls, 1);
        Game.time = 52;
        MarketManager.runAll(true);
        assert.equal(calls, 2);
        assert.equal(seller.room.memory.market.history.length, 1);
        assert.equal(seller.room.memory.market.history[0].result, OK);
    });

    it('applies terminal emergency reserves to market sales', function () {
        ownedRoom('A', {
            terminal: { [RESOURCE_ENERGY]: 1000 },
            marketConfig: {
                enabled: true, sell: true,
                resources: {
                    [RESOURCE_ENERGY]: { sell: true, min: 0, target: 0, max: 100, sellTo: 100, minSellPrice: 1 },
                },
            },
        });
        addOrder('energy-order', ORDER_BUY, RESOURCE_ENERGY, 2, 500, 'X');
        MarketManager.runAll(true);
        assert.equal(Game.market.deals.length, 0);
        assert.equal(Game.market.orders['energy-order'].amount, 500);
    });
});
