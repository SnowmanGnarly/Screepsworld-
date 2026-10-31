/*
 * Keeps the parsed Memory on the heap, so a tick does not pay to parse it again. The engine gives
 * every tick a Memory that parses RawMemory on its first read, and writes RawMemory._parsed back
 * at the end of the tick. Handing both our object skips the parse; the write still happens.
 *
 * Two things behave differently from plain Memory. Edits from the client's Memory panel and from
 * RawMemory.set() are lost, because our copy is written over them next tick; commands that change
 * Memory in the console run on our copy and are kept. And a value
 * JSON cannot hold, such as undefined or Infinity, stays as it is until the next global reset.
 */

class MainMemhack {

	static initRound() {
		if (typeof RawMemory === 'undefined') return;
		if (this._memory && this._completedTick === Game.time - 1) {
			RawMemory._parsed = this._memory;
			delete global.Memory;
			global.Memory = this._memory;
			return;
		}
		// After a reset there is no copy. After a tick that never finished, such as one that hit the
		// CPU limit, the copy holds writes the game threw away, so only the stored Memory will do.
		var parsed = Memory;
		this._memory = parsed && RawMemory._parsed === parsed ? parsed : null;
	}

	static endRound() {
		this._completedTick = Game.time;
	}

	static reset() {
		this._memory = null;
		this._completedTick = undefined;
	}
}

MainMemhack.reset();

module.exports = MainMemhack;
