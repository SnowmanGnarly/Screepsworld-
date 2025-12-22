module.exports = {
    log: function (room, message, type = 'info') {
        if (!room.memory.console) return;

        const msgObj = {
            text: message,
            type: type,
            time: Game.time
        };

        if (!room.memory.console.messages) {
            room.memory.console.messages = [];
        }

        room.memory.console.messages.push(msgObj);

        // Keep only last 50 messages to save memory
        if (room.memory.console.messages.length > 50) {
            room.memory.console.messages.shift();
        }
    },

    clear: function (room) {
        if (room.memory.console) {
            room.memory.console.messages = [];
        }
    }
};
