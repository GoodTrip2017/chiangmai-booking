// Child process lets crash/restart tests exercise real process boundaries.
const { createApp } = require('../../src/app');
const { pool } = require('../../src/db');
const server = createApp().listen(0, '127.0.0.1', () => console.log('TEST_URL=http://127.0.0.1:' + server.address().port));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(async () => { await pool.end(); process.exit(0); }); });
