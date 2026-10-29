var MainCache = require('./main.cache');

class MineralManager {

    static getMiningState(room) {
        var state = {
            mineral: null,
            extractor: null,
            deliveryTargets: [],
            hasInfrastructure: false,
        };
        if (!room || !room.controller || !room.controller.my || room.controller.level < 6) return state;

        var minerals = MainCache.find(room, FIND_MINERALS);
        if (minerals.length === 0) return state;
        state.mineral = minerals[0];
        state.extractor = MainCache.find(room, FIND_MY_STRUCTURES, {
            filter: structure => structure.structureType === STRUCTURE_EXTRACTOR &&
                structure.my !== false && structure.pos.isEqualTo(state.mineral.pos),
        })[0] || null;
        state.hasInfrastructure = !!state.extractor;
        state.deliveryTargets = this.getDeliveryTargets(room);
        return state;
    }

    // Everything except the extractor cooldown: worth waiting at the mineral for.
    static isMineralAvailable(state) {
        return !!(state && state.hasInfrastructure && state.mineral && state.extractor &&
            state.deliveryTargets.length > 0 && state.mineral.mineralAmount > 0 &&
            (state.mineral.ticksToRegeneration === undefined || state.mineral.ticksToRegeneration <= 0));
    }

    static canHarvest(state) {
        return this.isMineralAvailable(state) && state.extractor.cooldown <= 0;
    }

    static getDeliveryTargets(room) {
        if (!room) return [];
        return [room.storage, room.terminal].filter(target => {
            return target && target.store && target.store.getFreeCapacity() > 0;
        });
    }

    static getDesiredMinerCount(room) {
        return this.canHarvest(this.getMiningState(room)) ? 1 : 0;
    }
}

module.exports = MineralManager;
