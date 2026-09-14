const { isIP } = require('node:net');

function clientIp(req, env = process.env) {
  if (env.NODE_ENV === 'production' && env.RAILWAY_ENVIRONMENT_ID) {
    // Railway overwrites X-Real-IP at its public edge; X-Forwarded-For is client-controlled.
    // Do not fall back to a spoofable header when the trusted value is absent or malformed.
    const value = req.headers['x-real-ip'];
    return typeof value === 'string' && isIP(value) ? value : 'unknown';
  }
  return req.ip || 'unknown';
}

module.exports = { clientIp };
