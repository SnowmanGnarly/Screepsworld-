/*
 * The middle storage tier: facts that outlive a tick but not a global reset. Everything here can
 * be rebuilt, so a reset only costs a little CPU.
 *
 * Store plain data only, such as IDs, numbers and strings. Game objects are rebuilt every tick,
 * so one kept here would show stale hits and store. Keep an ID and use Game.getObjectById().
 */

var config = require('./main.config').HEAP;

class MainHeap {

	/*
	 * Returns a mutable bucket for short-lived state that its owner prunes itself.
	 */

	static namespace(name) {
		if (!this._namespaces[name]) this._namespaces[name] = {};
		return this._namespaces[name];
	}

	/*
	 * Computes a value once and keeps it for ttl ticks, or until the next reset without a ttl.
	 * The cache is bounded: the oldest entry makes room for a new one.
	 */

	static cached(key, ttl, compute) {
		var entry = this._cache.get(key);
		if (entry && (ttl === undefined || Game.time - entry.at < ttl)) return entry.value;
		var value = compute();
		this._cache.delete(key);
		this._cache.set(key, { value: value, at: Game.time });
		if (this._cache.size > config.MAX_ENTRIES) {
			this._cache.delete(this._cache.keys().next().value);
		}
		return value;
	}

	static reset() {
		this._namespaces = {};
		this._cache = new Map();
	}
}

MainHeap.reset();

module.exports = MainHeap;
