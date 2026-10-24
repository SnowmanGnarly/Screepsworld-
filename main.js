const roles = {
    harvester: require('role.harvester'),
    upgrader: require('role.upgrader'),
    builder: require('role.builder'),
    hauler: require('role.hauler'),
    warrior: require('role.warrior'),
    ranged: require('role.ranged'),
    healer: require('role.healer'),
    // remote_harvester: require('role.remote_harvester'),
    // claimer: require('role.claimer')
};

module.exports.loop = function () {
    cleanupMemory();

    // Init Room Context (Brain)
    const RoomContext = require('room.context');
    for (const room of Object.values(Game.rooms)) {
        RoomContext.init(room);
        require('task.manager').run(room);
    }

    require('tower.manager').run();
    require('spawn.manager').run();

    // Run GUI stats collection and renderer for each room
    const guiStats = require('gui.stats');
    const guiRenderer = require('gui.renderer');
    for (const room of Object.values(Game.rooms)) {
        guiStats.collect(room);
        guiRenderer.run(room);
    }

    for (const creep of Object.values(Game.creeps)) {
        const role = creep.memory.role;
        const handler = roles[role];
        if (handler) handler.run(creep);
    }

    runLinkManager();
};

function cleanupMemory() {
    for (const name in Memory.creeps) {
        if (!Game.creeps[name]) delete Memory.creeps[name];
    }
}

function runLinkManager() {
    try {
        const linkManager = require('link.manager');
        for (const room of Object.values(Game.rooms)) {
            linkManager.run(room);
        }
    } catch (_) { }
}