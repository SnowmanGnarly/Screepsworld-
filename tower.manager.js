module.exports = {
    run() {
        for (const room of Object.values(Game.rooms)) {
            this.runRoom(room);
        }
    },

    runRoom(room) {
        const towers = require('utils')
            .getCachedStructures(room, STRUCTURE_TOWER, 'towers', 10)
            .filter(t => t.store.energy > 0);

        if (!towers.length) return;

        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        const hasHostiles = hostiles.length > 0;

        for (const tower of towers) {
            if (this.tryAttack(tower)) continue;
            if (this.tryHealCritical(tower)) continue;

            // Save CPU unless combat
            if (!hasHostiles && Game.time % 5 !== 0) continue;

            if (this.tryRepairStructures(tower)) continue;
            if (this.tryRepairWalls(tower)) continue;
            this.tryHealMinor(tower);
        }
    },

    tryAttack(tower) {
        const hostile = tower.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (!hostile) return false;
        tower.attack(hostile);
        return true;
    },

    tryHealCritical(tower) {
        const creep = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: c => c.hits < c.hitsMax * 0.5
        });
        if (!creep) return false;
        tower.heal(creep);
        return true;
    },

    tryRepairStructures(tower) {
        const target = tower.pos.findClosestByRange(FIND_STRUCTURES, {
            filter: s =>
                s.structureType === STRUCTURE_ROAD
                    ? s.hits < s.hitsMax * 0.8
                    : s.hits < s.hitsMax * 0.8 &&
                    ![STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType)
        });
        if (!target) return false;
        tower.repair(target);
        return true;
    },

    tryRepairWalls(tower) {
        if (tower.store.energy < 500) return false;

        const walls = tower.room.find(FIND_STRUCTURES, {
            filter: s =>
                [STRUCTURE_WALL, STRUCTURE_RAMPART].includes(s.structureType) &&
                s.hits < require('constants').TOWER_REPAIR_THRESHOLD
        });

        if (!walls.length) return false;

        walls.sort((a, b) => a.hits - b.hits);
        tower.repair(walls[0]);
        return true;
    },

    tryHealMinor(tower) {
        const creep = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: c => c.hits < c.hitsMax
        });
        if (creep) tower.heal(creep);
    }
};