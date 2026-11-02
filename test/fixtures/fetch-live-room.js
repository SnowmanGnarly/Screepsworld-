/*
 * Saves a snapshot of a live room as a test fixture: terrain, every object in it, the room's
 * Memory and the Memory of the creeps standing there. test/liveroom.regression.test.js runs the
 * real managers against it, so a planner or economy change is checked on real terrain.
 *
 * Usage: SCREEPS_TOKEN=<token> node test/fixtures/fetch-live-room.js [shard] [room]
 * The token needs read access to Memory. It is only sent to screeps.com and never written out.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TOKEN = process.env.SCREEPS_TOKEN;
const SHARD = process.argv[2] || 'shard3';
const ROOM = process.argv[3] || 'W13S14';
const API = 'https://screeps.com/api/';

async function get(endpoint, params) {
    const url = new URL(API + endpoint);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url, { headers: { 'X-Token': TOKEN, 'X-Username': TOKEN } });
    if (!response.ok) throw new Error(endpoint + ' returned HTTP ' + response.status);
    return response.json();
}

// Memory comes back as "gz:" followed by base64 of gzipped JSON
async function readMemory(memoryPath) {
    const { data } = await get('user/memory', { path: memoryPath, shard: SHARD });
    if (typeof data !== 'string' || !data.startsWith('gz:')) return data;
    const json = zlib.gunzipSync(Buffer.from(data.slice(3), 'base64')).toString('utf8');
    return json === 'undefined' ? undefined : JSON.parse(json);
}

async function main() {
    if (!TOKEN) throw new Error('Set SCREEPS_TOKEN first.');
    const { time } = await get('game/time', { shard: SHARD });
    const { objects, users } = await get('game/room-objects', { room: ROOM, shard: SHARD });
    const { terrain } = await get('game/room-terrain', { room: ROOM, shard: SHARD, encoded: 1 });
    const roomMemory = await readMemory('rooms.' + ROOM);
    const creepMemory = await readMemory('creeps');
    const creepsHere = new Set(objects.filter(object => object.type === 'creep').map(object => object.name));
    const fixture = {
        shard: SHARD,
        room: ROOM,
        time,
        terrain: terrain[0].terrain,
        users: Object.fromEntries(Object.entries(users || {}).map(([id, user]) => [id, { username: user.username }])),
        objects: objects.map(object => {
            const copy = { ...object };
            delete copy.actionLog;
            delete copy.meta;
            return copy;
        }),
        memory: {
            room: roomMemory,
            creeps: Object.fromEntries(Object.entries(creepMemory || {}).filter(([name]) => creepsHere.has(name))),
        },
    };
    const file = path.join(__dirname, ROOM + '.json');
    fs.writeFileSync(file, JSON.stringify(fixture, null, 1) + '\n');
    console.log('Saved ' + objects.length + ' objects from ' + SHARD + '/' + ROOM + ' at tick ' + time + ' to ' + file);
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
