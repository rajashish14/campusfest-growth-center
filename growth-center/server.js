// CampusFest Attendee Growth Center - API + static frontend.
const fs = require('fs');
const path = require('path');

// tiny .env loader (no dependency): KEY=value lines
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const express = require('express');
const store = require('./lib/store');
const engine = require('./lib/engine');
const actions = require('./lib/actions');
const copilot = require('./lib/copilot');

store.load();
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/chart.umd.js', (req, res) => res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js')));

const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
    if (!e.status) console.error(e);
  }
};
const realDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
// invalid dates fall back to the latest date; valid dates are clamped to the range the data covers
const asOf = (req) => {
  if (!realDate(req.query.asOf)) return undefined;
  const { min, max } = engine.dataRange();
  return req.query.asOf < min ? min : req.query.asOf > max ? max : req.query.asOf;
};

// ---------------------------------------------------------------- read
app.get('/api/meta', wrap(() => ({
  range: engine.dataRange(), campaigns: store.raw.campaigns, owners: store.ops.owners, settings: store.ops.settings,
  ai: { provider: process.env.GEMINI_API_KEY ? 'gemini' : 'offline', model: process.env.GEMINI_API_KEY ? (process.env.GEMINI_MODEL || 'gemini-flash-latest') : null },
  version: store.version,
})));
app.get('/api/snapshot', wrap((req) => {
  const s = engine.snapshot(asOf(req));
  return { ...s, initiatives: engine.evaluateInitiatives(s) };
}));
app.get('/api/timeseries', wrap((req) => engine.timeSeries({ ...req.query, as_of: asOf(req) })));
app.get('/api/simulate', wrap((req) => engine.simulateShift(asOf(req), req.query.from, req.query.to, req.query.amount, Number(req.query.elasticity) || 0.8)));
app.get('/api/log', wrap(() => store.ops.log));
app.get('/api/daily', wrap((req) => {
  let rows = store.raw.daily;
  if (req.query.campaign) rows = rows.filter((r) => r.campaign_id === req.query.campaign);
  return rows.slice().sort((a, b) => (a.activity_date < b.activity_date ? 1 : -1)).slice(0, Number(req.query.limit) || 60);
}));
app.get('/api/targets', wrap(() => store.raw.targets));
app.get('/api/registrations/search', wrap((req) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return [];
  const c = engine.clean();
  return c.registrations.filter((r) => r.registration_id.toLowerCase() === q || r.person_id.toLowerCase() === q || String(r.person_name).toLowerCase().includes(q))
    .slice(0, 15).map((r) => ({ ...r, person_type: c.personType.get(r.person_id), history: (c.histByReg.get(r.registration_id) || []).map((h) => ({ status: h.status, effective_at: h.effective_at })) }));
}));

// ---------------------------------------------------------------- execution layer
app.get('/api/tasks', wrap(() => store.ops.tasks));
app.post('/api/tasks', wrap((req) => actions.createTask(req.body, 'user')));
app.patch('/api/tasks/:id', wrap((req) => actions.updateTask(req.params.id, req.body, 'user')));
app.delete('/api/tasks/:id', wrap((req) => actions.deleteTask(req.params.id, 'user')));
app.patch('/api/campaigns/:id', wrap((req) => actions.setCampaignStatus({ ...req.body, campaign_id: req.params.id }, 'user')));
app.patch('/api/initiatives/:id', wrap((req) => actions.updateInitiative(req.params.id, req.body, 'user')));
app.patch('/api/settings', wrap((req) => {
  const allowed = { assumed_show_rate: [0, 1], assumed_walkins: [0, 100000], venue_daily_capacity: [0, 1e6], scale_ratio: [0, 10], fix_ratio: [0, 10], stop_ratio: [0, 20], fatigue_drop: [0, 1] };
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!allowed[k]) continue;
    const n = Number(v);
    if (!(n >= allowed[k][0] && n <= allowed[k][1])) { const e = new Error(`${k} out of range`); e.status = 400; throw e; }
    store.ops.settings[k] = n;
  }
  store.log('settings', `Settings changed: ${Object.keys(req.body || {}).join(', ')}`);
  store.saveOps();
  return store.ops.settings;
}));

// ---------------------------------------------------------------- data edits
app.post('/api/daily', wrap((req) => actions.upsertDaily(req.body, 'user')));
app.delete('/api/daily/:id', wrap((req) => actions.deleteDaily(req.params.id, 'user')));
app.post('/api/targets', wrap((req) => actions.addTargets(req.body, 'user')));
app.post('/api/registrations/:id/status', wrap((req) => actions.setRegistrationStatus(req.params.id, req.body.status, req.body.effective_at, 'user')));
app.post('/api/import', express.raw({ type: () => true, limit: '25mb' }), wrap((req) => {
  if (!req.body || !req.body.length) { const e = new Error('Upload an .xlsx file'); e.status = 400; throw e; }
  store.importWorkbook(req.body);
  return { ok: true, people: store.raw.people.length, daily: store.raw.daily.length };
}));
app.post('/api/reset', wrap((req) => { store.resetToSource({ keepOps: !!(req.body && req.body.keepOps) }); return { ok: true }; }));

// ---------------------------------------------------------------- copilot
app.post('/api/chat', wrap(async (req) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages.filter((m) => m && typeof m.content === 'string') : [];
  if (!messages.length) { const e = new Error('messages required'); e.status = 400; throw e; }
  return copilot.chat({ messages, asOf: req.body.asOf, mode: req.body.mode });
}));
app.post('/api/actions/:id/confirm', wrap((req) => actions.confirm(req.params.id)));
app.post('/api/actions/:id/reject', wrap((req) => actions.reject(req.params.id)));

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Growth Center running at http://localhost:${PORT}`);
    console.log(process.env.GEMINI_API_KEY ? `Copilot: Gemini (${copilot.MODEL_CHAIN.join(' -> ')})` : 'Copilot: offline analyst (set GEMINI_API_KEY in .env for the full AI copilot)');
  });
}
module.exports = app;
