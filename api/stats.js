// PestPass anonymous usage counter — read endpoint (owner only).
// GET /api/stats?key=<STATS_KEY> returns totals, unique counts, per-version opens,
// and the last 30 days of opens + uniques as JSON.
// Add &format=html for a readable phone-friendly dashboard page.
// STATS_KEY is set as an env var on the Vercel project; without it this endpoint
// refuses to answer.
function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

module.exports = async (req, res) => {
  const key = (req.query && req.query.key) || req.headers['x-stats-key'] || '';
  if (!process.env.STATS_KEY) { res.status(503).json({ error: 'STATS_KEY not configured' }); return; }
  if (key !== process.env.STATS_KEY) { res.status(401).json({ error: 'bad key' }); return; }
  const cfg = redisConfig();
  if (!cfg) { res.status(503).json({ error: 'counter store not configured' }); return; }

  const days = [];
  for (let i = 0; i < 30; i++) {
    days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  const pipeline = [['GET', 'pp:opens:total'], ['SCARD', 'pp:users:all'], ['HGETALL', 'pp:versions']];
  days.forEach(d => { pipeline.push(['GET', 'pp:opens:day:' + d]); pipeline.push(['SCARD', 'pp:users:day:' + d]); });

  let out;
  try {
    const r = await fetch(cfg.url + '/pipeline', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(pipeline)
    });
    if (!r.ok) { res.status(502).json({ error: 'store error' }); return; }
    out = await r.json();
  } catch (e) {
    res.status(502).json({ error: 'store unreachable' }); return;
  }

  const val = i => (out[i] && out[i].result != null ? out[i].result : 0);
  const versions = {};
  const va = Array.isArray(val(2)) ? val(2) : [];
  for (let i = 0; i + 1 < va.length; i += 2) versions[va[i]] = parseInt(va[i + 1], 10) || 0;

  const byDay = days.map((d, i) => ({
    day: d,
    opens: parseInt(val(3 + i * 2), 10) || 0,
    uniques: parseInt(val(4 + i * 2), 10) || 0
  }));

  const data = {
    totalOpens: parseInt(val(0), 10) || 0,
    totalUniqueUsers: parseInt(val(1), 10) || 0,
    opensByVersion: versions,
    last30Days: byDay
  };

  if (req.query && req.query.format === 'html') {
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(renderHtml(data));
    return;
  }
  res.status(200).json(data);
};

function prettyDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function renderHtml(data) {
  const days = data.last30Days;
  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  const opens7 = sum(days.slice(0, 7), 'opens');
  const opens30 = sum(days, 'opens');
  const maxOpens = Math.max(1, ...days.map(r => r.opens));
  const avg = data.totalUniqueUsers ? (data.totalOpens / data.totalUniqueUsers).toFixed(1) : '0';

  const rows = days.map((r, i) => {
    const pct = Math.round((r.opens / maxOpens) * 100);
    return '<tr' + (i === 0 ? ' class="today"' : '') + '><td>' + (i === 0 ? 'Today' : prettyDay(r.day)) +
      '</td><td class="num">' + r.opens + '</td><td class="num">' + r.uniques + '</td>' +
      '<td class="barcell"><div class="bar" style="width:' + pct + '%"></div></td></tr>';
  }).join('\n');

  const versionRows = Object.keys(data.opensByVersion).sort().map(v =>
    '<div class="verrow"><span>Version ' + v + '</span><strong>' + data.opensByVersion[v] + ' opens</strong></div>'
  ).join('\n') || '<div class="verrow"><span>No version data yet</span></div>';

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>PestPass Usage</title><style>' +
    ':root{--bg:#0e1014;--card:#171b23;--line:rgba(255,255,255,.09);--tx:#e8eaf4;--tx2:#a3aac2;--ac:#4ec9e1;--gn:#4dd68c}' +
    '@media (prefers-color-scheme: light){:root{--bg:#f7f8fb;--card:#fff;--line:rgba(0,0,0,.09);--tx:#1a1d27;--tx2:#6b7180}}' +
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px 16px 40px}' +
    '.wrap{max-width:560px;margin:0 auto}h1{font-size:22px;margin:4px 0 2px}.sub{color:var(--tx2);font-size:13px;margin-bottom:20px}' +
    '.cards{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}' +
    '.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}' +
    '.card .n{font-size:30px;font-weight:800;line-height:1.1}.card .l{color:var(--tx2);font-size:12.5px;margin-top:2px}' +
    '.wide{grid-column:1/-1}.wide .n{font-size:22px}' +
    'h2{font-size:15px;margin:24px 0 10px}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}' +
    'th,td{padding:9px 12px;font-size:13.5px;text-align:left;border-bottom:1px solid var(--line)}' +
    'th{color:var(--tx2);font-weight:600;font-size:12px}tr:last-child td{border-bottom:none}' +
    'td.num{font-weight:700}.today td{background:rgba(78,201,225,.08)}.today td:first-child{color:var(--ac);font-weight:700}' +
    '.barcell{width:34%}.bar{height:8px;border-radius:4px;background:var(--ac);min-width:2px}' +
    '.verrow{display:flex;justify-content:space-between;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:13.5px;margin-bottom:8px}' +
    '.foot{color:var(--tx2);font-size:12px;margin-top:22px;line-height:1.5}' +
    '</style></head><body><div class="wrap">' +
    '<h1>🐞 PestPass Usage</h1><div class="sub">Anonymous counts only — app opens and distinct devices. No personal data.</div>' +
    '<div class="cards">' +
    '<div class="card"><div class="n">' + data.totalUniqueUsers + '</div><div class="l">total users (devices)</div></div>' +
    '<div class="card"><div class="n">' + data.totalOpens + '</div><div class="l">total app opens</div></div>' +
    '<div class="card"><div class="n">' + opens7 + '</div><div class="l">opens — last 7 days</div></div>' +
    '<div class="card"><div class="n">' + avg + '</div><div class="l">avg opens per user</div></div>' +
    '</div>' +
    '<h2>Last 30 days</h2><table><tr><th>Day</th><th>Opens</th><th>Users</th><th></th></tr>' + rows + '</table>' +
    '<h2>Opens by app version</h2>' + versionRows +
    '<div class="foot">Days are counted in UTC. A "user" is one random on-device ID — reinstalling or clearing the app counts as a new user. Total opens in the last 30 days: ' + opens30 + '.</div>' +
    '</div></body></html>';
}
