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
  const pipeline = [['GET', 'pp:opens:total'], ['SCARD', 'pp:users:all'], ['HGETALL', 'pp:versions'],
    ['GET', 'pp:time:total'], ['GET', 'pp:sessions:total']];
  days.forEach(d => { pipeline.push(['GET', 'pp:opens:day:' + d]); pipeline.push(['SCARD', 'pp:users:day:' + d]); });
  days.forEach(d => { pipeline.push(['SMEMBERS', 'pp:users:day:' + d]); });
  days.forEach(d => { pipeline.push(['GET', 'pp:time:day:' + d]); pipeline.push(['GET', 'pp:sessions:day:' + d]); });
  pipeline.push(['HGETALL', 'pp:devices:all']);
  days.forEach(d => { pipeline.push(['HGETALL', 'pp:devices:day:' + d]); });

  // Feature-use block (appended last): per feature, total opens, distinct
  // users, and today's opens.
  const FEATURES = ['quiz', 'flashcards', 'spaced-review', 'study-guides', 'bookmarks',
    'visual-id', 'insect-id', 'photo-frenzy', 'bug-blitz', 'survival', 'beat-the-clock',
    'math-drill', 'boss-battle', 'mock-exam'];
  FEATURES.forEach(f => {
    pipeline.push(['GET', 'pp:feat:' + f + ':total']);
    pipeline.push(['SCARD', 'pp:feat:' + f + ':users']);
    pipeline.push(['GET', 'pp:feat:' + f + ':day:' + days[0]]);
  });

  // Daily feature opens (appended last of all): per-feature day totals for
  // the last 7 days, so the dashboard can show what was used each day.
  const FEAT_DAYS = 7;
  for (let di = 0; di < FEAT_DAYS; di++) {
    FEATURES.forEach(f => { pipeline.push(['GET', 'pp:feat:' + f + ':day:' + days[di]]); });
  }

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

  // Pipeline layout: 0 opens total, 1 users total, 2 versions, 3 time total,
  // 4 sessions total, then per-day opens/uniques pairs, then per-day member sets,
  // then per-day time/sessions pairs.
  const dayBase = 5;
  const memberBase = dayBase + days.length * 2;
  const timeBase = memberBase + days.length;

  // New vs returning per day: walk the 30 days oldest -> newest, tracking every
  // hashed ID seen so far. A day's "new" users are its members never seen before.
  const seen = new Set();
  const splitByDay = {};
  [...days].reverse().forEach(d => {
    const idx = days.indexOf(d);
    const members = Array.isArray(val(memberBase + idx)) ? val(memberBase + idx) : [];
    let nw = 0;
    members.forEach(h => { if (!seen.has(h)) { seen.add(h); nw++; } });
    splitByDay[d] = { newUsers: nw, returningUsers: members.length - nw };
  });

  const byDay = days.map((d, i) => ({
    day: d,
    opens: parseInt(val(dayBase + i * 2), 10) || 0,
    uniques: parseInt(val(dayBase + i * 2 + 1), 10) || 0,
    newUsers: splitByDay[d].newUsers,
    returningUsers: splitByDay[d].returningUsers,
    timeSeconds: parseInt(val(timeBase + i * 2), 10) || 0,
    sessions: parseInt(val(timeBase + i * 2 + 1), 10) || 0
  }));

  // Device buckets: pp:devices:all HGETALL sits right after the time/sessions
  // block, then one HGETALL per day in the same order as `days`.
  const devBase = timeBase + days.length * 2;
  const hashOf = i => {
    const a = Array.isArray(val(i)) ? val(i) : [];
    const o = {};
    for (let j = 0; j + 1 < a.length; j += 2) o[a[j]] = parseInt(a[j + 1], 10) || 0;
    return o;
  };
  const devices = { totals: hashOf(devBase), today: hashOf(devBase + 1) };

  const featBase = devBase + 1 + days.length;
  const FEATURE_LABELS = { quiz: 'Quiz', flashcards: 'Flashcards', 'spaced-review': 'Spaced Review', 'study-guides': 'Study Guides', bookmarks: 'Bookmarks', 'visual-id': 'Visual ID drill', 'insect-id': 'Insect ID drill', 'photo-frenzy': 'Photo Frenzy', 'bug-blitz': 'True/False Blitz', survival: 'Survival', 'beat-the-clock': 'Beat the Clock', 'math-drill': 'Math Drill', 'boss-battle': 'Boss Battle', 'mock-exam': 'Mock Exam' };
  const features = FEATURES.map((f, i) => ({
    name: f,
    label: FEATURE_LABELS[f] || f,
    opens: parseInt(val(featBase + i * 3), 10) || 0,
    users: parseInt(val(featBase + i * 3 + 1), 10) || 0,
    today: parseInt(val(featBase + i * 3 + 2), 10) || 0
  })).sort((a, b) => b.opens - a.opens);

  // Daily detail augmentation: per-day device mix (the per-day HGETALLs are
  // already in the pipeline), per-day average session time, and the last
  // FEAT_DAYS days of feature opens (appended block at the very end).
  const featDayBase = featBase + FEATURES.length * 3;
  byDay.forEach((r, i) => {
    r.devices = hashOf(devBase + 1 + i);
    r.avgTimePerSession = r.sessions ? Math.round(r.timeSeconds / r.sessions) : 0;
    if (i < FEAT_DAYS) {
      const fd = [];
      FEATURES.forEach((f, fi) => {
        const n = parseInt(val(featDayBase + i * FEATURES.length + fi), 10) || 0;
        if (n > 0) fd.push({ name: f, label: FEATURE_LABELS[f] || f, opens: n });
      });
      fd.sort((a, b) => b.opens - a.opens);
      r.features = fd;
    }
  });

  const data = {
    totalOpens: parseInt(val(0), 10) || 0,
    totalUniqueUsers: parseInt(val(1), 10) || 0,
    opensByVersion: versions,
    totalTimeSeconds: parseInt(val(3), 10) || 0,
    totalSessions: parseInt(val(4), 10) || 0,
    devices: devices,
    features: features,
    last30Days: byDay
  };

  res.setHeader('Cache-Control', 'no-store');
  if (req.query && req.query.format === 'html') {
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(renderHtml(data));
    return;
  }
  res.status(200).json(data);
};

function fmtTime(secs) {
  secs = Math.round(secs || 0);
  if (secs < 60) return secs + 's';
  const m = Math.floor(secs / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? h + 'h ' + rm + 'm' : h + 'h';
}

function prettyDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function chartSegH(v, max) { return v <= 0 ? 0 : Math.max(4, Math.round((v / max) * 100)); }

function bar30Html(daysDesc, mode) {
  const rows = daysDesc.slice().reverse(); // oldest first, today last
  const max = Math.max(1, ...rows.map(r => (mode === 'u' ? r.uniques : r.opens)));
  const cols = rows.map((r, i) => {
    const isToday = i === rows.length - 1;
    const total = mode === 'u' ? r.uniques : r.opens;
    let segs;
    if (mode === 'u') {
      segs = '<div class="segR" style="height:' + chartSegH(r.returningUsers, max) + '%"></div>' +
             '<div class="segN" style="height:' + chartSegH(r.newUsers, max) + '%"></div>';
    } else {
      segs = '<div class="segO" style="height:' + chartSegH(r.opens, max) + '%"></div>';
    }
    const val = total > 0 && (isToday || total === max) ? '<div class="bval">' + total + '</div>' : '<div class="bval"></div>';
    const title = prettyDay(r.day) + ' — ' + (mode === 'u'
      ? r.uniques + ' users (' + r.newUsers + ' new, ' + r.returningUsers + ' returning)'
      : r.opens + ' opens');
    return '<div class="col" title="' + title + '">' + val + '<div class="colbar">' + segs + '</div></div>';
  }).join('');
  const step = rows.length <= 10 ? 1 : rows.length <= 20 ? 2 : 5;
  const labels = rows.map((r, i) =>
    '<span>' + ((i % step === 0 || i === rows.length - 1) ? String(parseInt(r.day.slice(8, 10), 10)) : '') + '</span>'
  ).join('');
  return '<div class="cols' + (mode === 'o' ? ' short' : '') + '">' + cols + '</div><div class="xrow">' + labels + '</div>';
}

const kvRow = (k, v) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';

function renderHtml(data) {
  const days = data.last30Days;
  const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
  const opens7 = sum(days.slice(0, 7), 'opens');
  const opens30 = sum(days, 'opens');
  const avg = data.totalUniqueUsers ? (data.totalOpens / data.totalUniqueUsers).toFixed(1) : '0';

  const new7 = sum(days.slice(0, 7), 'newUsers');
  const rows = days.map((r, i) => {
    return '<tr' + (i === 0 ? ' class="today"' : '') + '><td>' + (i === 0 ? 'Today' : prettyDay(r.day)) +
      '</td><td class="num">' + r.opens + '</td><td class="num">' + r.uniques + '</td>' +
      '<td class="num newn">' + r.newUsers + '</td><td class="num">' + fmtTime(r.timeSeconds) + '</td></tr>';
  }).join('\n');

  const devOrderD = ['Android', 'iPhone / iPad', 'Desktop', 'Bot / automated', 'Other'];
  const detailHtml = days.slice(0, 7).map((r, i) => {
    const devs = devOrderD.filter(k => (r.devices || {})[k]).map(k => k + ' ' + r.devices[k]).join(' · ');
    const feats = (r.features || []).slice(0, 5).map(f => f.label + ' ' + f.opens).join(' · ');
    return '<div class="dday"><div class="dhead">' + (i === 0 ? 'Today' : prettyDay(r.day)) + '</div>' +
      kvRow('Opens', r.opens) + kvRow('Users', r.uniques) +
      kvRow('New users', '<span class="newn">' + r.newUsers + '</span>') + kvRow('Returning users', r.returningUsers) +
      kvRow('Time in app', fmtTime(r.timeSeconds)) + kvRow('Avg per session', fmtTime(r.avgTimePerSession || 0)) +
      kvRow('Sessions reporting time', r.sessions) +
      '<div class="dline dim" style="margin-top:6px">Devices: ' + (devs || 'no visits recorded') + '</div>' +
      '<div class="dline dim">Top features: ' + (feats || 'none opened') + '</div></div>';
  }).join('\n');

  const versionRows = Object.keys(data.opensByVersion).sort().map(v =>
    '<div class="verrow"><span>Version ' + v + '</span><strong>' + data.opensByVersion[v] + ' opens</strong></div>'
  ).join('\n') || '<div class="verrow"><span>No version data yet</span></div>';

  const featsOn = data.features.filter(f => f.opens > 0);
  const maxFeat = Math.max(1, ...featsOn.map(f => f.opens));
  const featureRows = featsOn.map(f =>
    '<div class="frow"><div class="frow-top"><span>' + f.label + '</span><strong>' + f.opens + ' opens · ' + f.users + ' users (' + f.today + ' today)</strong></div>' +
    '<div class="ftrack"><div class="ffill" style="width:' + Math.max(2, Math.round((f.opens / maxFeat) * 100)) + '%"></div></div></div>'
  ).join('\n') || '<div class="verrow"><span>No feature data yet — counting starts with the current app version</span></div>';

  const devOrder = ['Android', 'iPhone / iPad', 'Desktop', 'Bot / automated', 'Other'];
  const devTotal = devOrder.reduce((a, k) => a + (data.devices.totals[k] || 0), 0);
  const deviceRows = devOrder.map(k => {
    const n = data.devices.totals[k] || 0;
    const t = data.devices.today[k] || 0;
    const pct = devTotal ? Math.round((n / devTotal) * 100) : 0;
    return '<div class="verrow"><span>' + k + ' — ' + pct + '%</span><strong>' + n + ' visits (' + t + ' today)</strong></div>';
  }).join('\n');

  const rangeBar = '<div class="rangebar">' +
    '<button class="rbtn" data-n="7" onclick="setRange(7)">7 days</button>' +
    '<button class="rbtn" data-n="15" onclick="setRange(15)">15 days</button>' +
    '<button class="rbtn on" data-n="30" onclick="setRange(30)">30 days</button></div>';
  const usersChart = bar30Html(days, 'u');
  const opensChart = bar30Html(days, 'o');
  const legend = '<div class="chead"><span class="lg"><i class="sw" style="background:var(--gn)"></i>New users</span>' +
    '<span class="lg"><i class="sw" style="background:var(--ac);opacity:.55"></i>Returning</span>' +
    '<span class="lgdim">oldest → today</span></div>';

  const t0 = days[0];
  const topToday = [...data.features].sort((a, b) => b.today - a.today).find(f => f.today > 0);
  const todayInner = '<div class="dhead">Today so far</div>' +
    kvRow('Opens', t0.opens) + kvRow('Users', t0.uniques) +
    kvRow('New users', '<span class="newn">' + t0.newUsers + '</span>') + kvRow('Returning users', t0.returningUsers) +
    kvRow('Time in app', fmtTime(t0.timeSeconds)) + kvRow('Avg per session', fmtTime(t0.avgTimePerSession || 0)) +
    kvRow('Top feature today', topToday ? topToday.label + ' (' + topToday.today + ' opens)' : 'none yet');
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
    'td.num{font-weight:700}td.newn{color:var(--gn)}.today td{background:rgba(78,201,225,.08)}.today td:first-child{color:var(--ac);font-weight:700}' +
    '.dday{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:10px}' +
    '.dday .dhead{font-weight:800;font-size:14.5px;margin-bottom:3px}' +
    '.dday .dline{font-size:13.5px;line-height:1.55}' +
    '.dday .dim{color:var(--tx2);font-size:12.5px}' +
    '.rangebar{display:flex;gap:8px;margin:0 0 10px}.rbtn{flex:1;padding:9px 0;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--tx2);font-size:13.5px;font-weight:700;font-family:inherit;cursor:pointer}.rbtn.on{background:var(--ac);color:#0b0e13;border-color:transparent}' +
    '.chart{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 8px 8px}' +
    '.chead{display:flex;gap:14px;align-items:center;margin-bottom:8px;font-size:12px;color:var(--tx2)}' +
    '.chead .lg{display:flex;align-items:center;gap:5px}.chead .sw{display:inline-block;width:10px;height:10px;border-radius:3px}' +
    '.chead .lgdim{margin-left:auto;font-size:11px}' +
    '.cols{display:flex;gap:1px;height:240px;border-bottom:1px solid var(--line)}' +
    '.cols.short{height:176px}' +
    '.col{flex:1;display:flex;flex-direction:column;min-width:4px}' +
    '.bval{height:20px;text-align:center;font-size:13px;font-weight:800;line-height:20px}' +
    '.colbar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;border-radius:3px 3px 0 0;overflow:hidden}' +
    '.segN{background:var(--gn)}.segR{background:var(--ac);opacity:.55}.segO{background:var(--ac)}' +
    '.xrow{display:flex;gap:1px;margin-top:4px}.xrow span{flex:1;text-align:center;font-size:11.5px;color:var(--tx2);min-width:3px}' +
    '.kv{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13.5px}.kv:last-child{border-bottom:none}.kv .k{color:var(--tx2)}.kv .v{font-weight:700;text-align:right}.kv .newn{color:var(--gn)}' +
    '.frow{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px 12px;margin-bottom:8px}' +
    '.frow-top{display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:7px}' +
    '.ftrack{height:8px;border-radius:4px;background:rgba(127,140,170,.18);overflow:hidden}' +
    '.ffill{height:100%;border-radius:4px;background:var(--ac);min-width:2px}.ffill.dev{background:var(--gn)}' +
    '.verrow{display:flex;justify-content:space-between;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:13.5px;margin-bottom:8px}' +
    '.foot{color:var(--tx2);font-size:12px;margin-top:22px;line-height:1.5}' +
    '@media (max-width:480px){th,td{padding:8px 7px;font-size:12.5px}h1{font-size:20px}.card .n{font-size:25px}.frow-top{font-size:12.5px}}' +
    '</style></head><body><div class="wrap">' +
    '<h1>🐞 PestPass Usage</h1><div class="sub">Anonymous counts only — app opens and distinct devices. No personal data.</div>' +
    '<div class="sub">Counts are live. Page updated <span id="upd-t">just now</span> — it updates itself every 20 seconds, no refresh needed.</div>' +
    '<h2 style="margin-top:6px">Today</h2><div class="dday" id="today-box">' + todayInner + '</div>' +
    '<div class="cards">' +
    '<div class="card"><div class="n" id="st-users">' + data.totalUniqueUsers + '</div><div class="l">total users (devices)</div></div>' +
    '<div class="card"><div class="n" id="st-opens">' + data.totalOpens + '</div><div class="l">total app opens</div></div>' +
    '<div class="card"><div class="n" id="st-time">' + fmtTime(data.totalTimeSeconds) + '</div><div class="l">total time in app</div></div>' +
    '<div class="card"><div class="n" id="st-avgvisit">' + fmtTime(data.totalSessions ? data.totalTimeSeconds / data.totalSessions : 0) + '</div><div class="l">avg time per session</div></div>' +
    '</div>' +
    '<div class="dday" style="margin-bottom:2px"><div class="dhead">More totals</div>' +
    kvRow('Sessions that reported time', '<span id="st-sessions">' + data.totalSessions + '</span>') +
    kvRow('Opens — last 7 days', '<span id="st-opens7">' + opens7 + '</span>') +
    kvRow('Brand-new users — last 7 days', '<span id="st-new7">' + new7 + '</span>') +
    kvRow('Avg opens per user', '<span id="st-avgopens">' + avg + '</span>') + '</div>' +
    '<h2>Users per day — new vs returning</h2>' + rangeBar + '<div class="chart" id="chart-users">' + legend + usersChart + '</div>' +
    '<h2>Opens per day</h2><div class="chart" id="chart-opens">' + opensChart + '</div>' +
    '<h2>Daily detail — last 7 days</h2><div id="daily-detail">' + detailHtml + '</div>' +
    '<h2>Feature use — what people open</h2><div id="feat-rows">' + featureRows + '</div>' +
    '<h2>Last 30 days</h2><table><tr><th>Day</th><th>Opens</th><th>Users</th><th>New</th><th>Time</th></tr><tbody id="days-body">' + rows + '</tbody></table>' +
    '<h2>Visits by device type</h2><div id="dev-rows">' + deviceRows + '</div>' +
    '<h2>Opens by app version</h2><div id="ver-rows">' + versionRows + '</div>' +
    '<div class="foot">Days are counted in UTC. The two charts show the same 30 days as the table — in the users chart, green is first-time users and blue is returning users, and the number on top of a bar is that day\'s total. A "user" is one random on-device ID — reinstalling or clearing the app counts as a new user. <strong>Users</strong> = different users who opened the app that day; <strong>New</strong> = how many of them were opening it for the very first time. The rest were returning users — for example, today\'s returning count is Users minus New. (New is figured from the last 30 days of records.) <strong>Bots are not counted as users</strong> — automated visits still show in Opens and in the device chart, but since Oct 24, 2026 their IDs are kept out of the user counts entirely; days before that can still include bot visits in their user numbers. <strong>Time</strong> = total time the app was open on screen that day, reported when the app is closed or switched away from — so today\'s time can lag behind today\'s opens. A <strong>visit</strong> (counted in Opens) is a fresh app open, or returning to the app after it spent 30+ minutes in the background. <strong>Device types</strong> are counted from the browser\'s standard user-agent on each visit (the user-agent itself is never stored) and are only counted since this feature was added on Oct 21, 2026, so their total runs behind total opens. <strong>Daily detail</strong> breaks the last 7 days down by timed sessions, device mix and top features; feature-by-day counting started Oct 22, 2026 and device-by-day on Oct 21, 2026, so earlier days show none. <strong>Avg time per session</strong> is reported time divided by the sessions that reported time — most visits never report time, so it is NOT an average over all visits. <strong>Feature use</strong> counts one ping each time a feature is opened — only the feature\'s name, never answers, scores or content — and is counted since Oct 22, 2026. Total opens in the last 30 days: ' + opens30 + '.</div>' +
    '</div>' +
    '<script>' +
    // The page refreshes its own numbers from the JSON endpoint. Every fetch
    // carries a unique cache-buster, so even a copy of this page served from
    // an old service-worker cache still displays live data.
    'var KEY = new URLSearchParams(location.search).get("key") || "";' +
    'function fd(sec) { sec = Math.round(sec || 0); if (sec < 60) return sec + "s"; var m = Math.floor(sec / 60); if (m < 60) return m + "m"; var h = Math.floor(m / 60); var rm = m % 60; return rm ? h + "h " + rm + "m" : h + "h"; }' +
    'function pd(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); }' +
    'function kv(k, v) { return "<div class=\\"kv\\"><span class=\\"k\\">" + k + "</span><span class=\\"v\\">" + v + "</span></div>"; }' +
    'function sh(v, mx) { return v <= 0 ? 0 : Math.max(4, Math.round(v / mx * 100)); }' +
    'function b30(days, mode) {' +
    ' var rows = days.slice().reverse(); var mx = 1; rows.forEach(function (r) { var v = mode === "u" ? r.uniques : r.opens; if (v > mx) mx = v; });' +
    ' var cols = rows.map(function (r, i) { var total = mode === "u" ? r.uniques : r.opens; var segs;' +
    '  if (mode === "u") { segs = "<div class=\\"segR\\" style=\\"height:" + sh(r.returningUsers, mx) + "%\\"></div><div class=\\"segN\\" style=\\"height:" + sh(r.newUsers, mx) + "%\\"></div>"; }' +
    '  else { segs = "<div class=\\"segO\\" style=\\"height:" + sh(r.opens, mx) + "%\\"></div>"; }' +
    '  var val = total > 0 && (i === rows.length - 1 || total === mx) ? "<div class=\\"bval\\">" + total + "</div>" : "<div class=\\"bval\\"></div>";' +
    '  var title = pd(r.day) + " — " + (mode === "u" ? r.uniques + " users (" + r.newUsers + " new, " + r.returningUsers + " returning)" : r.opens + " opens");' +
    '  return "<div class=\\"col\\" title=\\"" + title + "\\">" + val + "<div class=\\"colbar\\">" + segs + "</div></div>"; }).join("");' +
    ' var step = rows.length <= 10 ? 1 : rows.length <= 20 ? 2 : 5; var labels = rows.map(function (r, i) { return "<span>" + ((i % step === 0 || i === rows.length - 1) ? String(parseInt(r.day.slice(8, 10), 10)) : "") + "</span>"; }).join("");' +
    ' return "<div class=\\"cols" + (mode === "o" ? " short" : "") + "\\">" + cols + "</div><div class=\\"xrow\\">" + labels + "</div>"; }' +
    'var RANGE = 30;' +
    'function setRange(n) { RANGE = n; var bs = document.querySelectorAll(".rbtn"); for (var i = 0; i < bs.length; i++) { bs[i].className = "rbtn" + (parseInt(bs[i].getAttribute("data-n"), 10) === n ? " on" : ""); } poll(); }' +
    'var LEGEND = "<div class=\\"chead\\"><span class=\\"lg\\"><i class=\\"sw\\" style=\\"background:var(--gn)\\"></i>New users</span><span class=\\"lg\\"><i class=\\"sw\\" style=\\"background:var(--ac);opacity:.55\\"></i>Returning</span><span class=\\"lgdim\\">oldest → today</span></div>";' +
    'function poll() { fetch(location.pathname + "?key=" + encodeURIComponent(KEY) + "&cb=" + Date.now(), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {' +
    ' var days = d.last30Days; var sum = function (arr, k) { return arr.reduce(function (a, x) { return a + x[k]; }, 0); };' +
    ' document.getElementById("st-users").textContent = d.totalUniqueUsers;' +
    ' document.getElementById("st-opens").textContent = d.totalOpens;' +
    ' document.getElementById("st-opens7").textContent = sum(days.slice(0, 7), "opens");' +
    ' document.getElementById("st-avgopens").textContent = d.totalUniqueUsers ? (d.totalOpens / d.totalUniqueUsers).toFixed(1) : "0";' +
    ' document.getElementById("st-new7").textContent = sum(days.slice(0, 7), "newUsers");' +
    ' document.getElementById("st-time").textContent = fd(d.totalTimeSeconds);' +
    ' document.getElementById("st-avgvisit").textContent = fd(d.totalSessions ? d.totalTimeSeconds / d.totalSessions : 0);' +
    ' document.getElementById("st-sessions").textContent = d.totalSessions;' +
    ' document.getElementById("chart-users").innerHTML = LEGEND + b30(days.slice(0, RANGE), "u");' +
    ' document.getElementById("chart-opens").innerHTML = b30(days.slice(0, RANGE), "o");' +
    ' var tt = days[0]; var tf = (d.features || []).slice().sort(function (a, b) { return b.today - a.today; }).filter(function (f) { return f.today > 0; })[0]; document.getElementById("today-box").innerHTML = "<div class=\\"dhead\\">Today so far</div>" + kv("Opens", tt.opens) + kv("Users", tt.uniques) + kv("New users", "<span class=\\"newn\\">" + tt.newUsers + "</span>") + kv("Returning users", tt.returningUsers) + kv("Time in app", fd(tt.timeSeconds)) + kv("Avg per session", fd(tt.avgTimePerSession || 0)) + kv("Top feature today", tf ? tf.label + " (" + tf.today + " opens)" : "none yet");' +
    ' var order = ["Android", "iPhone / iPad", "Desktop", "Bot / automated", "Other"]; var dt = 0; order.forEach(function (k) { dt += (d.devices.totals[k] || 0); });' +
    ' document.getElementById("dev-rows").innerHTML = order.map(function (k) { var n = d.devices.totals[k] || 0; var t = d.devices.today[k] || 0; var pct = dt ? Math.round(n / dt * 100) : 0; return "<div class=\\"verrow\\"><span>" + k + " — " + pct + "%</span><strong>" + n + " visits (" + t + " today)</strong></div>"; }).join("");' +
    ' document.getElementById("days-body").innerHTML = days.map(function (x, i) { return "<tr" + (i === 0 ? " class=\\"today\\"" : "") + "><td>" + (i === 0 ? "Today" : pd(x.day)) + "</td><td class=\\"num\\">" + x.opens + "</td><td class=\\"num\\">" + x.uniques + "</td><td class=\\"num newn\\">" + x.newUsers + "</td><td class=\\"num\\">" + fd(x.timeSeconds) + "</td></tr>"; }).join("");' +
    ' var dord = ["Android", "iPhone / iPad", "Desktop", "Bot / automated", "Other"]; document.getElementById("daily-detail").innerHTML = days.slice(0, 7).map(function (x, i) { var devs = dord.filter(function (k) { return (x.devices || {})[k]; }).map(function (k) { return k + " " + x.devices[k]; }).join(" · "); var feats = (x.features || []).slice(0, 5).map(function (f) { return f.label + " " + f.opens; }).join(" · "); return "<div class=\\"dday\\"><div class=\\"dhead\\">" + (i === 0 ? "Today" : pd(x.day)) + "</div>" + kv("Opens", x.opens) + kv("Users", x.uniques) + kv("New users", "<span class=\\"newn\\">" + x.newUsers + "</span>") + kv("Returning users", x.returningUsers) + kv("Time in app", fd(x.timeSeconds)) + kv("Avg per session", fd(x.avgTimePerSession || 0)) + kv("Sessions reporting time", x.sessions) + "<div class=\\"dline dim\\" style=\\"margin-top:6px\\">Devices: " + (devs || "no visits recorded") + "</div><div class=\\"dline dim\\">Top features: " + (feats || "none opened") + "</div></div>"; }).join("");' +
    ' var fr = (d.features || []).filter(function (f) { return f.opens > 0; }); var mf = 1; fr.forEach(function (f) { if (f.opens > mf) mf = f.opens; }); document.getElementById("feat-rows").innerHTML = fr.length ? fr.map(function (f) { return "<div class=\\"frow\\"><div class=\\"frow-top\\"><span>" + f.label + "</span><strong>" + f.opens + " opens · " + f.users + " users (" + f.today + " today)</strong></div><div class=\\"ftrack\\"><div class=\\"ffill\\" style=\\"width:" + Math.max(2, Math.round(f.opens / mf * 100)) + "%\\"></div></div></div>"; }).join("") : "<div class=\\"verrow\\"><span>No feature data yet — counting starts with the current app version</span></div>";' +
    ' var vk = Object.keys(d.opensByVersion).sort(); document.getElementById("ver-rows").innerHTML = vk.length ? vk.map(function (v) { return "<div class=\\"verrow\\"><span>Version " + v + "</span><strong>" + d.opensByVersion[v] + " opens</strong></div>"; }).join("") : "<div class=\\"verrow\\"><span>No version data yet</span></div>";' +
    ' document.getElementById("upd-t").textContent = new Date().toLocaleTimeString();' +
    '}).catch(function () {}); }' +
    'document.getElementById("upd-t").textContent = new Date().toLocaleTimeString();' +
    'setInterval(poll, 20000);' +
    'window.addEventListener("pageshow", poll);' +
    'document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });' +
    '</script>' +
    '</body></html>';
}
