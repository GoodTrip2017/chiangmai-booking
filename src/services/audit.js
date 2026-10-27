const { pool } = require('../db');

async function record(actor, action, target = '', details = {}) {
  await pool.query(
    'INSERT INTO system_events(actor_type,actor_id,action,target,details) VALUES($1,$2,$3,$4,$5)',
    [actor.type, actor.id, action, target, details]
  );
}

async function recent(limit = 100) {
  const { rows } = await pool.query('SELECT id,actor_type,actor_id,action,target,details,created_at FROM system_events ORDER BY id DESC LIMIT $1', [limit]);
  return rows;
}

module.exports = { record, recent };
