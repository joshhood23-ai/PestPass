// PestPass anonymous usage counter — receive endpoint (Cloudflare Pages Function port).
// Ported 2026-11-19 from review/fixed/api/ping.js (Vercel Node handler) for the
// hosting move off Vercel. Counting semantics are IDENTICAL to the Vercel version:
// same Redis keys, same bot rule (bot IDs never enter user sets), same session
// counting at visit start, same Eastern-day boundaries, same allowlists.
// Differences are runtime shape only: Pages Function signature, env bindings,
// Web Crypto SHA-256, and Fetch-style Request/Response. The body is read via
// request.text() + JSON.parse — Workers has no Vercel-style parsed body, and the
// client already sends JSON (sendBeacon with a JSON-typed Blob).
// Backing store: Upstash Redis via its REST API (env: UPSTASH_REDIS_REST_URL/TOKEN).

function redisConfig(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

// Counter days run midnight to midnight Eastern (the owner's timezone), not UTC
// (directive 2026-10-24).
function easternDay(date) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date || new Date()).forEach(x => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day;
}

// Coarse device class from the user-agent header. Only the bucket label is
// stored — never the user-agent string itself. Bot/automation first, because
// those agents often also carry platform tokens.
function deviceBucket(ua) {
  const s = String(ua || '');
  if (/bot|crawler|spider|crawling|headless|phantom|selenium|puppeteer|playwright|lighthouse|slurp|scraper|curl\/|wget|python-requests|python-urllib|axios|okhttp|go-http-client|java\/|libwww|httpclient/i.test(s)) return 'Bot / automated';
  if (/android/i.test(s)) return 'Android';
  if (/iphone|ipad|ipod/i.test(s)) return 'iPhone / iPad';
  if (/windows|macintosh|mac os x|linux|cros/i.test(s)) return 'Desktop';
  return 'Other';
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost({ request, env }) {
  const cfg = redisConfig(env);
  if (!cfg) return jsonError(503, 'counter store not configured');

  let body = null;
  try { body = JSON.parse(await request.text()); } catch (e) { body = null; }
  const id = body && typeof body.id === 'string' ? body.id : '';
  const v = body && typeof body.v === 'string' ? body.v : '?';
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id) || v.length > 12 || /[^\w.+-]/.test(v)) {
    return jsonError(400, 'bad ping');
  }

  const FEATURES = ['quiz', 'flashcards', 'spaced-review', 'study-guides', 'bookmarks',
    'visual-id', 'insect-id', 'photo-frenzy', 'bug-blitz', 'survival', 'beat-the-clock',
    'math-drill', 'boss-battle', 'mock-exam'];

  const day = easternDay();
  const hash = await sha256Hex(id);
  const ua = request.headers.get('user-agent');
  let pipeline;
  if (body.t === 'end' || body.t === 'tick') {
    // Time ping: foreground seconds accumulated since the last flush. Adds
    // time only — the session itself was already counted at visit start.
    // Bot/automated agents never add time (they are not users).
    const secs = Math.floor(Number(body.secs));
    if (!Number.isFinite(secs) || secs < 1 || secs > 43200) {
      return jsonError(400, 'bad secs');
    }
    if (deviceBucket(ua) === 'Bot / automated') {
      return new Response(null, { status: 204 });
    }
    pipeline = [
      ['INCRBY', 'pp:time:total', secs],
      ['INCRBY', 'pp:time:day:' + day, secs]
    ];
  } else if (body.t === 'ev') {
    // Feature-open ping: aggregate counts per feature name (allowlisted).
    const e = typeof body.e === 'string' ? body.e : '';
    if (FEATURES.indexOf(e) < 0) {
      return jsonError(400, 'bad feature');
    }
    const evBucket = deviceBucket(ua);
    pipeline = [
      ['INCR', 'pp:feat:' + e + ':total'],
      ['INCR', 'pp:feat:' + e + ':day:' + day],
      ...(evBucket === 'Bot / automated' ? [] : [['SADD', 'pp:feat:' + e + ':users', hash]])
    ];
  } else {
    // Open ping (no t) and resume ping (t: 'resume') both count as one visit.
    // Bots still count as visits (opens + device bucket) but their IDs are kept
    // out of the user sets, so they never appear as users — new or returning.
    const bucket = deviceBucket(ua);
    // Exam state picked on the device (allowlisted; older app versions send
    // none). State user sets follow the same bot rule as every user set;
    // state visit counts include bots, like the device buckets do.
    const STATES = ['ga', 'fl', 'tx'];
    const st = STATES.indexOf(body.st) >= 0 ? body.st : null;
    const userAdds = bucket === 'Bot / automated' ? [] : [
      ['SADD', 'pp:users:all', hash],
      ['SADD', 'pp:users:day:' + day, hash],
      // A session is one visit; it is counted here, at visit start, so a
      // session is never lost when the browser drops the closing events.
      ['INCR', 'pp:sessions:total'],
      ['INCR', 'pp:sessions:day:' + day],
      ...(st ? [
        ['SADD', 'pp:state:' + st + ':users', hash],
        ['SADD', 'pp:state:' + st + ':day:' + day, hash]
      ] : [])
    ];
    pipeline = [
      ['INCR', 'pp:opens:total'],
      ['INCR', 'pp:opens:day:' + day],
      ...userAdds,
      ['HINCRBY', 'pp:versions', v, 1],
      ['HINCRBY', 'pp:devices:all', bucket, 1],
      ['HINCRBY', 'pp:devices:day:' + day, bucket, 1],
      ...(st ? [
        ['HINCRBY', 'pp:states:visits', st, 1],
        ['HINCRBY', 'pp:states:visits:day:' + day, st, 1]
      ] : [])
    ];
  }

  try {
    const r = await fetch(cfg.url + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });
    if (!r.ok) return jsonError(502, 'store error');
  } catch (e) {
    return jsonError(502, 'store unreachable');
  }
  return new Response(null, { status: 204 });
}
