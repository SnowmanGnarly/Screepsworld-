var MainHeap = require('./main.heap');
var config = require('./main.config').LAB;

/*
 * Decides what a room's labs should make next. It only reads and ranks; LabManager issues every
 * order. Demand lives on the heap because the next spawn attempt rebuilds it after a reset.
 */

const TIER = { BOOST: 0, MANUAL: 1, PROFIT: 2 };

class LabMatrix {

    /*
     * Called by the spawn preflight with the real body, so demand is measured rather than guessed.
     * An unmet request wakes the room's selection on its next run instead of waiting for the timer.
     */

    static noteBoostDemand(roomName, resourceType, parts, unmet) {
        var rooms = MainHeap.namespace('labDemand');
        var demand = rooms[roomName] || (rooms[roomName] = {});
        var entry = demand[resourceType];
        var fresh = entry && Game.time - entry.at <= config.DEMAND_TTL;
        demand[resourceType] = { parts: fresh ? Math.max(entry.parts, parts) : parts, at: Game.time };
        if (unmet) MainHeap.namespace('labWake')[roomName] = true;
    }

    static takeWake(roomName) {
        var wake = MainHeap.namespace('labWake');
        if (!wake[roomName]) return false;
        delete wake[roomName];
        return true;
    }

    /*
     * Everything worth making in this room, best first. A resource keeps its most urgent tier and
     * its largest target when more than one source asks for it.
     */

    static rankCandidates(roomName, manualGoals, stockOf, profitGoals) {
        var byResource = {};
        var add = (resourceType, target, tier, score) => {
            if (stockOf(resourceType) >= target) return;
            var current = byResource[resourceType];
            byResource[resourceType] = current ? {
                resourceType, target: Math.max(current.target, target), tier: Math.min(current.tier, tier),
                score: current.tier <= tier ? current.score : score,
            } : { resourceType, target, tier, score };
        };

        var demand = MainHeap.namespace('labDemand')[roomName] || {};
        Object.keys(demand).forEach(resourceType => {
            var entry = demand[resourceType];
            if (Game.time - entry.at > config.DEMAND_TTL) {
                delete demand[resourceType];
                return;
            }
            var target = entry.parts * LAB_BOOST_MINERAL * config.BOOST_SPAWNS_AHEAD;
            add(resourceType, target, TIER.BOOST, target - stockOf(resourceType));
        });
        Object.keys(manualGoals).forEach(resourceType => add(resourceType, manualGoals[resourceType], TIER.MANUAL, 0));
        (profitGoals || []).forEach(goal => add(goal.resourceType, goal.target, TIER.PROFIT, goal.rate));

        return Object.keys(byResource).map(resourceType => byResource[resourceType]).sort((a, b) => {
            return a.tier - b.tier || b.score - a.score || a.resourceType.localeCompare(b.resourceType);
        });
    }

    /*
     * Products the market manager is already allowed to sell, ranked by credits per lab cooldown.
     * Selling stays the market manager's decision: this only keeps its sell rules supplied.
     */

    static rankProfit(marketConfig, recipes) {
        if (!marketConfig.enabled || !marketConfig.sell) return [];
        var rules = marketConfig.resources;
        var prices = this._getPrices(recipes);
        var memo = {};
        return Object.keys(rules).reduce((goals, resourceType) => {
            var rule = rules[resourceType];
            var recipe = recipes[resourceType];
            var price = prices[resourceType];
            if (!rule.sell || !rule.max || !recipe || !price) return goals;
            var first = this._cheapestSupply(recipe.reagents[0], prices, recipes, memo);
            var second = this._cheapestSupply(recipe.reagents[1], prices, recipes, memo);
            var margin = price.sell - first.cost - second.cost;
            var ticks = recipe.cooldown + first.ticks + second.ticks;
            if (!Number.isFinite(margin) || margin <= 0 || ticks <= 0) return goals;
            var rate = margin * LAB_REACTION_AMOUNT / ticks;
            if (rate >= config.MIN_PROFIT_RATE) goals.push({ resourceType, target: rule.max + rule.batchSize, rate });
            return goals;
        }, []);
    }

    // One unit bought or made, whichever costs less. A reaction turns one of each reagent into one product.
    static _cheapestSupply(resourceType, prices, recipes, memo) {
        if (memo[resourceType]) return memo[resourceType];
        var buy = prices[resourceType] ? prices[resourceType].buy : Infinity;
        var recipe = recipes[resourceType];
        var best = { cost: buy, ticks: 0 };
        if (recipe) {
            var first = this._cheapestSupply(recipe.reagents[0], prices, recipes, memo);
            var second = this._cheapestSupply(recipe.reagents[1], prices, recipes, memo);
            if (first.cost + second.cost < buy) {
                best = { cost: first.cost + second.cost, ticks: recipe.cooldown + first.ticks + second.ticks };
            }
        }
        memo[resourceType] = best;
        return best;
    }

    // One standard deviation against us on both sides, so thin markets do not look profitable.
    static _getPrices(recipes) {
        return MainHeap.cached('labPrices', config.PRICE_TTL, () => {
            var resources = new Set(Object.keys(recipes));
            Object.keys(recipes).forEach(product => recipes[product].reagents.forEach(reagent => resources.add(reagent)));
            var table = {};
            resources.forEach(resourceType => {
                var history = Game.market.getHistory(resourceType);
                var last = history && history[history.length - 1];
                if (!last) return;
                table[resourceType] = { sell: last.avgPrice - last.stddevPrice, buy: last.avgPrice + last.stddevPrice };
            });
            return table;
        });
    }
}

LabMatrix.TIER = TIER;

module.exports = LabMatrix;
