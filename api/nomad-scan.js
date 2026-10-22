'use strict';
// Secure, dedicated Vercel Cron entrypoint. It delegates to NOMAD's existing
// scanner; it does not change or invoke either investment brain.
const crypto = require('node:crypto');
const handler = require('./nomad');
module.exports = async (request, response) => {
  const secret = String(process.env.CRON_SECRET || '').trim();
  const received = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const a = Buffer.from(secret);
  const b = Buffer.from(received);
  if (request.method !== 'GET' || !secret || !received ||
      a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    response.statusCode = 401;
    return response.end('Unauthorized');
  }
  request.url = '/api/nomad?action=intelligence-scan';
  return handler(request, response);
};
