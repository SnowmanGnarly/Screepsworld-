/*
 * This module is used to display some information to the screen, so debugging is easier.
 */
 
var MainHeap = require('./main.heap');
var MainUtil = require('./main.util');
var config = require('./main.config');

class MainInfo {

    /*
	 * Displays the collected information on the screen.
	 */
    
	static visualize() {   
		MainUtil.findAllRooms().forEach(room => {
            this._visualizeRoleInfos(room);
            this._visualizeConsole(room);
        });
    }

    /*
	 * Displays the role infos for a specific room on the screen.
	 * 
	 * @param {Room} room
	 */
    
	static _visualizeRoleInfos(room) {   
        var roleInfo = MainHeap.namespace('roleInfo')[room.name];
        if (!roleInfo)
            return;

    	var console = MainInfo._fetchMemoryOfRoomConsole(room);
        var x = console.roleInfoX;
        var y = console.roleInfoY;
        
        var roomName = (room.memory.base && room.memory.base.name) || room.name;
        room.visual.text(roomName + '    ' + room.energyAvailable + '/' + room.energyCapacityAvailable + '🟡', x, y++, {align: 'left', opacity: console.opacity});
        
        var unusedRoles = '';
        
        for (const role in roleInfo) {
            var count = roleInfo[role];
            if (count.currentNumber || (count.requiredNumber > 0)) {
            	var ofRequired = count.requiredNumber >= 0 ? '/' + count.requiredNumber : '';
                room.visual.text(count.symbol + ' ' + role + ' ' + count.currentNumber + ofRequired, x, y++, {align: 'left', opacity: console.opacity});
            } else {
                unusedRoles += count.symbol;
            }
        }
        
        if (unusedRoles) {
        	var ofRequired = room.memory.base ? '/0' : '';
        	room.visual.text(unusedRoles + ' 0' + ofRequired, x, y++, {align: 'left', opacity: console.opacity});
        }
    }

	/*
	 * Fetches the memory of the room's console.
	 * 
	 * @param {Room} room
	 */
	
	static _fetchMemoryOfRoomConsole(room) {
		var defaultArray = {
			x: 30,
			y: 0,
			height: 49,
			roleInfoX: 0,
			roleInfoY: 0,
			opacity: 0.8,
		};
		if (room.memory.console) {
			room.memory.console = Object.assign(defaultArray, room.memory.console);
		} else {
			room.memory.console = defaultArray;
		}
		return room.memory.console;
	}

    /*
	 * Displays the console for a specific room on the screen.
	 * 
	 * @param {Room} room
	 */
    
	static _visualizeConsole(room) {   
    	var console = this._fetchMemoryOfRoomConsole(room);
        var x = console.x;
        var xLine = x + 5;
        var yMin = console.y;
        var height = console.height;
        var y = yMin + height;

        var wasDrawn = false;
        
        for (const lineIndex in this._lines) {
        	var lineRoom = this._lineRooms[lineIndex];
        	if (lineRoom && lineRoom != room.name) {
        		continue;
        	}
        	
            var time = this._lineTimes[lineIndex];
            room.visual.text(time.toISOString().substring(2, 16).replace('T', ' '), x, y, {align: 'left'});
            
            room.visual.text(this._lines[lineIndex], xLine, y, {align: 'left'});
            
            wasDrawn = true;
            y--;
            if (y <= yMin) {
                break;
            }
        }
        
        if (!wasDrawn) {
            room.visual.text('<no console entries>', xLine, y, {align: 'left', opacity: console.opacity});
        } 
    }

    /*
	 * Clears the UI console.
	 */
    
	static clearLines() {   
        this._lineTimes = [];
        this._lines = [];
        this._lineRooms = [];
    }
    
    /*
	 * Sends an email for a problem that needs the owner, since nobody reads the console while away.
	 * One problem sends at most one email per interval, and the game bundles what arrives in between.
	 *
	 * @param key names the problem
	 * @param message
	 */

	static notify(key, message) {
		var last = MainHeap.namespace('notified')[key];
		if (last !== undefined && Game.time - last < config.CPU.NOTIFY_INTERVAL) return;
		MainHeap.namespace('notified')[key] = Game.time;
		var shard = Game.shard ? '[' + Game.shard.name + '] ' : '';
		this.sendEmail(shard + message, config.CPU.NOTIFY_GROUP_MINUTES);
	}

	/*
	 * The game takes at most NOTIFY_PER_TICK emails in one tick and silently drops the rest, so every
	 * email goes through here. What does not fit waits on the heap and goes out on the next ticks,
	 * oldest first. A global reset loses what is waiting, and the wait is bounded.
	 *
	 * @param message
	 * @param groupMinutes 0 sends at once; otherwise the game bundles emails within this time
	 */

	static sendEmail(message, groupMinutes = 0) {
		var outbox = this._getOutbox();
		if (outbox.sent < config.CPU.NOTIFY_PER_TICK) {
			outbox.sent++;
			Game.notify(message, groupMinutes);
		} else if (outbox.waiting.length < config.CPU.NOTIFY_QUEUE_LIMIT) {
			outbox.waiting.push({ message: message, groupMinutes: groupMinutes });
		}
	}

	static flushNotifications() {
		var outbox = this._getOutbox();
		while (outbox.waiting.length > 0 && outbox.sent < config.CPU.NOTIFY_PER_TICK) {
			var email = outbox.waiting.shift();
			outbox.sent++;
			Game.notify(email.message, email.groupMinutes);
		}
	}

	static _getOutbox() {
		var outbox = MainHeap.namespace('outbox');
		if (outbox.tick !== Game.time) {
			outbox.tick = Game.time;
			outbox.sent = 0;
		}
		if (!outbox.waiting) outbox.waiting = [];
		return outbox;
	}

	/*
	 * Reports an error that a boundary caught. A broken job or room fails every tick, so each key
	 * logs at most once per ERROR_LOG_INTERVAL and emails at most once per NOTIFY_INTERVAL. This runs
	 * inside a catch block, so it must never throw: that would take the rest of the tick with it.
	 *
	 * @param key names the problem
	 * @param message
	 * @param error
	 * @param {Room} room
	 */

	static failure(key, message, error, room) {
		try {
			var failures = MainHeap.namespace('failures');
			var last = failures[key];
			if (last !== undefined && Game.time - last < config.CPU.ERROR_LOG_INTERVAL) return;
			failures[key] = Game.time;
			var text = message + ': ' + error;
			this.error(text, room);
			this.notify(key, text);
			console.log(error && error.stack);
		} catch (reportError) {
			console.log('Could not report ' + key + ': ' + reportError);
		}
	}

	/*
	 * Logs the string to the UI console.
	 * 
	 * @param the new line
	 * @param {Room} room
	 */
    
	static log(newLine, room) {   
		var displayLine = newLine instanceof Error ? String(newLine) : typeof newLine === 'object' && newLine !== null ? JSON.stringify(newLine) : newLine;
		if (typeof displayLine !== 'string') {
			displayLine = String(displayLine);
		}
		console.log(displayLine);
        var height = this.getMaxHeight();
        
        this._lineTimes.splice(0, 0, new Date());
        this._lineTimes = this._lineTimes.slice(0, height);
        
        this._lines.splice(0, 0, displayLine);
        this._lines = this._lines.slice(0, height);
        
        var lineRoomName = room && room.name ? room.name : room;
        this._lineRooms.splice(0, 0, lineRoomName);
        this._lineRooms = this._lineRooms.slice(0, height);
    }

    /*
	 * Logs the error to the UI console.
	 * 
	 * @param the new line
	 * @param {Room} room
	 */
    
	static error(newLine, room) {   
        this.log('🛑 ' + newLine, room);
    }

    /*
	 * Logs the warning to the UI console.
	 * 
	 * @param the new line
	 * @param {Room} room
	 */

	static warning(newLine, room) {   
        this.log('⚠ ' + newLine, room);
    }

    /*
	 * Returns the max console height for all rooms.
	 * 
	 * @param the new line
	 */
    
	static getMaxHeight() {   
		var heights = MainUtil.findAllRooms()
			.map(room => room.memory.console && room.memory.console.height)
			.filter(height => Number.isFinite(height));
		return heights.length > 0 ? Math.max(...heights) : 10;
    }
};

MainInfo._lineTimes = [];
MainInfo._lines = [];
MainInfo._lineRooms = [];

module.exports = MainInfo;