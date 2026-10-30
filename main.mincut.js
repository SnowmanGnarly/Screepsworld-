/*
 * Finds the fewest tiles that close a protected area off from the room's exits, which is where
 * ramparts belong. Each open tile is a node a creep can pass through at a cost of one rampart, and
 * the smallest set of tiles that stops all 8-way movement is the minimum cut of that graph.
 *
 * It looks at terrain only and touches no game state. A single solve takes real CPU, so callers
 * should run it once and store the result.
 */

const SIZE = 50;
const TILE_COUNT = SIZE * SIZE;
const SOURCE = TILE_COUNT * 2;
const SINK = SOURCE + 1;
const NODE_COUNT = SINK + 1;
const UNLIMITED = 1000000;
const NEIGHBOURS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
// each tile has its pass-through edge, up to 8 neighbours, one source or sink edge, and all their reverses
const MAX_EDGES = TILE_COUNT * 10 * 2;

function tileIndex(x, y) {
	return x * SIZE + y;
}

class FlowGraph {

	constructor() {
		this.head = new Int32Array(NODE_COUNT).fill(-1);
		this.next = new Int32Array(MAX_EDGES);
		this.to = new Int32Array(MAX_EDGES);
		this.capacity = new Int32Array(MAX_EDGES);
		this.edgeCount = 0;
		this.level = new Int32Array(NODE_COUNT);
		this.current = new Int32Array(NODE_COUNT);
		this.queue = new Int32Array(NODE_COUNT);
	}

	addEdge(from, to, capacity) {
		this._addHalfEdge(from, to, capacity);
		this._addHalfEdge(to, from, 0);
	}

	_addHalfEdge(from, to, capacity) {
		var edge = this.edgeCount++;
		this.to[edge] = to;
		this.capacity[edge] = capacity;
		this.next[edge] = this.head[from];
		this.head[from] = edge;
	}

	/*
	 * Marks how far each node is from the source through edges with capacity left. Returns false
	 * once the sink cannot be reached, and the marks then show which side of the cut a node is on.
	 */

	buildLevels() {
		this.level.fill(-1);
		this.level[SOURCE] = 0;
		var read = 0;
		var write = 0;
		this.queue[write++] = SOURCE;
		while (read < write) {
			var node = this.queue[read++];
			for (var edge = this.head[node]; edge !== -1; edge = this.next[edge]) {
				var neighbour = this.to[edge];
				if (this.capacity[edge] > 0 && this.level[neighbour] === -1) {
					this.level[neighbour] = this.level[node] + 1;
					this.queue[write++] = neighbour;
				}
			}
		}
		return this.level[SINK] !== -1;
	}

	_push(node, limit) {
		if (node === SINK) return limit;
		for (; this.current[node] !== -1; this.current[node] = this.next[this.current[node]]) {
			var edge = this.current[node];
			var neighbour = this.to[edge];
			if (this.capacity[edge] <= 0 || this.level[neighbour] !== this.level[node] + 1) continue;
			var pushed = this._push(neighbour, Math.min(limit, this.capacity[edge]));
			if (pushed > 0) {
				this.capacity[edge] -= pushed;
				this.capacity[edge ^ 1] += pushed;
				return pushed;
			}
		}
		return 0;
	}

	/*
	 * Dinic's algorithm. Stops early once the flow reaches the limit, which means no cut exists.
	 */

	maxFlow(limit) {
		var flow = 0;
		while (flow < limit && this.buildLevels()) {
			this.current.set(this.head);
			var pushed;
			while (flow < limit && (pushed = this._push(SOURCE, UNLIMITED)) > 0) {
				flow += pushed;
			}
		}
		return flow;
	}
}

class MinCut {

	/*
	 * Tiles next to an exit cannot hold a rampart, so they count as outside. Terrain walls are
	 * never part of the graph.
	 *
	 * @param terrainIsWall (x, y) => true for terrain a creep can never enter
	 * @param protectedTiles [{x, y}] what has to end up inside
	 * @returns [{x, y}] the tiles to fortify, or null if the area cannot be closed off
	 */

	static solve(terrainIsWall, protectedTiles) {
		// the search asks about each tile many times, and asking the game is not free
		var walls = new Uint8Array(TILE_COUNT);
		for (var wallX = 0; wallX < SIZE; wallX++) {
			for (var wallY = 0; wallY < SIZE; wallY++) {
				if (terrainIsWall(wallX, wallY)) walls[tileIndex(wallX, wallY)] = 1;
			}
		}
		var isWall = (x, y) => walls[tileIndex(x, y)] === 1;
		var outside = this._findOutsideTiles(isWall);
		var isProtected = new Uint8Array(TILE_COUNT);
		var hasProtected = false;
		for (var i = 0; i < protectedTiles.length; i++) {
			var tile = protectedTiles[i];
			if (isWall(tile.x, tile.y)) continue;
			if (outside[tileIndex(tile.x, tile.y)]) return null;
			isProtected[tileIndex(tile.x, tile.y)] = 1;
			hasProtected = true;
		}
		if (!hasProtected) return [];

		var graph = this._buildGraph(isWall, outside, isProtected);
		if (graph.maxFlow(UNLIMITED) >= UNLIMITED) return null;
		graph.buildLevels();

		var cut = [];
		for (var x = 0; x < SIZE; x++) {
			for (var y = 0; y < SIZE; y++) {
				var entry = tileIndex(x, y) * 2;
				if (graph.level[entry] !== -1 && graph.level[entry + 1] === -1) cut.push({ x: x, y: y });
			}
		}
		return cut;
	}

	static _findOutsideTiles(isWall) {
		var outside = new Uint8Array(TILE_COUNT);
		var markExit = (x, y) => {
			if (isWall(x, y)) return;
			for (var dx = -1; dx <= 1; dx++) {
				for (var dy = -1; dy <= 1; dy++) {
					var nx = x + dx;
					var ny = y + dy;
					if (nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE) outside[tileIndex(nx, ny)] = 1;
				}
			}
		};
		for (var edge = 0; edge < SIZE; edge++) {
			markExit(edge, 0);
			markExit(edge, SIZE - 1);
			markExit(0, edge);
			markExit(SIZE - 1, edge);
		}
		return outside;
	}

	static _buildGraph(isWall, outside, isProtected) {
		var graph = new FlowGraph();
		for (var x = 0; x < SIZE; x++) {
			for (var y = 0; y < SIZE; y++) {
				if (isWall(x, y)) continue;
				var index = tileIndex(x, y);
				var entry = index * 2;
				var exit = entry + 1;
				var isFixed = outside[index] || isProtected[index];
				graph.addEdge(entry, exit, isFixed ? UNLIMITED : 1);
				if (isProtected[index]) graph.addEdge(SOURCE, entry, UNLIMITED);
				if (outside[index]) graph.addEdge(exit, SINK, UNLIMITED);
				NEIGHBOURS.forEach(offset => {
					var nx = x + offset[0];
					var ny = y + offset[1];
					if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE || isWall(nx, ny)) return;
					graph.addEdge(exit, tileIndex(nx, ny) * 2, UNLIMITED);
				});
			}
		}
		return graph;
	}
}

module.exports = MinCut;
