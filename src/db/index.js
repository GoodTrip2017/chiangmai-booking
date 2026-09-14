const { Pool } = require('pg');
require('dotenv').config();

const { connectionConfig } = require('./config');
const pool = new Pool(connectionConfig());

pool.on('error', (err) => console.error('閒置資料庫連線中斷：', err.code || 'UNKNOWN'));

module.exports = { pool };
