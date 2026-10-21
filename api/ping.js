// PestPass anonymous usage counter — receive endpoint.
// Receives one ping per app open: { id: <random on-device install ID>, v: <app version> }.
// Stores ONLY: daily + total open counts, the set of SHA-256-hashed IDs (for unique
// counts), and per-version open counts. No IP addresses, no personal data, no study data.
// Backing store: Upstash Redis via its REST API (env: UPSTASH_REDIS_REST_URL/TOKEN,
// or the Vercel KV aliases KV_REST_API_URL/TOKEN).
//
// NOTE: this handler never async-iterates the request stream — on this Vercel runtime
// that hangs POST requests. It uses the runtime-parsed body (the client sends JSON),
// with a short bounded event-based fallback so a request can never hang here.
const crypto = require('crypto');

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

function parseBodyValue(b) {
  if (b == null) return null;
  if (typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
  try { return JSON.parse(s); } catch (e) { return null; }
}

function readBody(req) {
  const parsed = parseBodyValue(req.body);
  if (parsed) return Promise.resolve(parsed);
  if (req.body != null) return Promise.resolve(null); // body present but unparseable
  // Fallback: collect the raw stream via events, bounded to 2.5s so we never hang.
  return new Promise(resolve => {
    const chunks = [];
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), 2500);
    try {
      req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => { clearTimeout(timer); finish(parseBodyValue(Buffer.concat(chunks))); });
      req.on('error', () => { clearTimeout(timer); finish(null); });
    } catch (e) { clearTimeout(timer); finish(null); }
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const cfg = redisConfig();
  if (!cfg) { res.status(503).json({ error: 'counter store not configured' }); return; }

  const body = await readBody(req);
  const id = body && typeof body.id === 'string' ? body.id : '';
  const v = body && typeof body.v === 'string' ? body.v : '?';
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id) || v.length > 12 || /[^\w.+-]/.test(v)) {
    res.status(400).json({ error: 'bad ping' }); return;
  }

  const day = new Date().toISOString().slice(0, 10); // UTC day
  const hash = crypto.createHash('sha256').update(id).digest('hex');
  const pipeline = [
    ['INCR', 'pp:opens:total'],
    ['INCR', 'pp:opens:day:' + day],
    ['SADD', 'pp:users:all', hash],
    ['SADD', 'pp:users:day:' + day, hash],
    ['HINCRBY', 'pp:versions', v, 1]
  ];

  try {
    const r = await fetch(cfg.url + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });
    if (!r.ok) { res.status(502).json({ error: 'store error' }); return; }
  } catch (e) {
    res.status(502).json({ error: 'store unreachable' }); return;
  }
  res.status(204).end();
};
