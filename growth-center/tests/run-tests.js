// Run: npm test
// Uses a throwaway data folder so it never touches data/raw.json or data/ops.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-test-'));
delete process.env.GEMINI_API_KEY; // tests exercise the deterministic layer + offline analyst

const store = require('../lib/store');
const engine = require('../lib/engine');
const actions = require('../lib/actions');
const copilot = require('../lib/copilot');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

(async () => {
  store.load();
  console.log('\nBaseline numbers (must match independent pandas analysis in README §3)');
  const s = engine.snapshot('2025-04-20');
  await test('import duplicates removed: 2 daily, 4 status, 20 check-in rows', () => {
    assert.deepStrictEqual([s.data_quality.duplicate_rows_removed.daily, s.data_quality.duplicate_rows_removed.regHistory, s.data_quality.duplicate_rows_removed.checkins], [2, 4, 20]);
  });
  await test('identified external people = 3,625 (3,500 campaign + 125 walk-ins)', () => {
    assert.strictEqual(s.totals.identified_people, 3625); assert.strictEqual(s.totals.identified_walkins, 125);
  });
  await test('external registrations = 2,800 (40 internal excluded)', () => {
    assert.strictEqual(s.totals.registrations, 2800); assert.strictEqual(s.data_quality.internal_registrations_excluded, 40);
  });
  await test('final status mix 2500 confirmed / 183 cancelled / 88 waitlisted / 29 interested', () => {
    assert.deepStrictEqual([s.totals.confirmed, s.totals.cancelled, s.totals.waitlisted, s.totals.interested], [2500, 183, 88, 29]);
  });
  await test('verified unique external visitors = 2,050 (1,925 registered + 125 walk-ins)', () => {
    assert.strictEqual(s.totals.visitors, 2050); assert.strictEqual(s.totals.visitors_registered, 1925);
  });
  await test('net spend = ₹2,74,000 including vendor credits', () => assert.strictEqual(s.totals.spend, 274000));
  await test('Paid Social: 680 regs, 340 visitors, ₹93,000 → ₹273.5/visitor', () => {
    const k = s.campaigns.find((c) => c.campaign_id === 'C02');
    assert.deepStrictEqual([k.registrations, k.visitors, k.spend, k.cost_per_visitor], [680, 340, 93000, 273.5]);
  });
  await test('gate failures = 60 confirmed people never verified; 88 waitlisted', () => {
    assert.strictEqual(s.totals.gate_failures, 60);
  });
  await test('query tool agrees: distinct external verified visitors = 2,050', () => {
    const q = engine.query({ table: 'checkins', filters: [{ field: 'person_type', op: 'eq', value: 'external' }, { field: 'is_verified_admission', op: 'eq', value: true }], measure: 'count_distinct', field: 'person_id', as_of: '2025-04-20' });
    assert.strictEqual(q.value, 2050);
  });

  await test('status transitions are queryable: 36 cancelled-then-reconfirmed registrations', () => {
    const q = engine.query({ table: 'registrations', filters: [{ field: 'person_type', op: 'eq', value: 'external' }, { field: 'was_reconfirmed', op: 'eq', value: true }], as_of: '2025-04-20' });
    assert.strictEqual(q.value, 36);
  });
  await test('offline analyst answers staff/test admissions from data (internal 20, staff 10, test 10)', async () => {
    const r = await copilot.chat({ messages: [{ role: 'user', content: 'Were any staff or test accounts admitted?' }], asOf: '2025-04-20' });
    assert.ok(/internal 20, staff 10, test 10/.test(r.reply), r.reply);
  });

  console.log('\nSnapshot rules (no later outcome in an earlier snapshot)');
  await test('before the event there are zero visitors and a projection instead', () => {
    const p = engine.snapshot('2025-04-11');
    assert.strictEqual(p.totals.visitors, 0); assert.strictEqual(p.projection.mode, 'projected');
  });
  await test('targets switch from launch to revised plan on 15 March', () => {
    assert.strictEqual(engine.snapshot('2025-03-14').target_version, 'Attendee launch plan');
    assert.strictEqual(engine.snapshot('2025-03-15').target_version, 'Attendee revised plan');
  });
  await test('R0001 is cancelled on 10 Mar but confirmed again by 20 Mar', () => {
    const at = (d) => engine.query({ table: 'registrations', filters: [{ field: 'registration_id', op: 'eq', value: 'R0001' }], group_by: 'current_status', as_of: d }).groups[0].group;
    assert.strictEqual(at('2025-03-10'), 'cancelled'); assert.strictEqual(at('2025-03-20'), 'confirmed');
  });
  await test('spend as of 14 March excludes later ledger rows', () => {
    assert.ok(engine.snapshot('2025-03-14').totals.spend < 274000);
  });

  console.log('\nData changes flow into analytics');
  await test('adding ₹10,000 Paid Social spend raises totals and cost per visitor', () => {
    actions.upsertDaily({ campaign_id: 'C02', activity_date: '2025-04-11', impressions: 3407, clicks: 40, reported_reach: 2000, landing_page_sessions: 30, registration_starts: 5, marketing_spend_inr: 10000 });
    const n = engine.snapshot('2025-04-20');
    assert.strictEqual(n.totals.spend, 284000);
    assert.strictEqual(n.campaigns.find((c) => c.campaign_id === 'C02').cost_per_visitor, 302.9); // 1,03,000 / 340
  });
  await test('editing a duplicated activity id leaves exactly one row', () => {
    const dupId = (() => { const seen = new Set(); for (const r of store.raw.daily) { if (seen.has(r.activity_id)) return r.activity_id; seen.add(r.activity_id); } })();
    const row = store.raw.daily.find((r) => r.activity_id === dupId);
    actions.upsertDaily({ ...row, activity_id: dupId, marketing_spend_inr: row.marketing_spend_inr });
    assert.strictEqual(store.raw.daily.filter((r) => r.activity_id === dupId).length, 1);
  });
  await test('a new target version is picked up by snapshots after its date', () => {
    actions.addTargets({ effective_date: '2025-04-01', target_version: 'Test plan', registration_goal: 2900 });
    assert.strictEqual(engine.snapshot('2025-04-20').kpis.registrations.goal, 2900);
    assert.strictEqual(engine.snapshot('2025-03-20').kpis.registrations.goal, 3200);
  });
  await test('changing a registration status changes confirmed count', () => {
    const before = engine.snapshot('2025-04-20').totals.confirmed;
    actions.setRegistrationStatus('R0002', 'cancelled', '2025-04-10T12:00:00');
    assert.strictEqual(engine.snapshot('2025-04-20').totals.confirmed, before - 1);
  });
  await test('reset restores the original numbers', () => {
    store.resetToSource();
    const r = engine.snapshot('2025-04-20');
    assert.strictEqual(r.totals.spend, 274000); assert.strictEqual(r.kpis.registrations.goal, 3200);
  });
  await test('importing the original workbook reproduces the baseline', () => {
    store.importWorkbook(fs.readFileSync(path.join(__dirname, '..', 'data', 'Attendee Dataset.xlsx')));
    assert.strictEqual(engine.snapshot('2025-04-20').totals.visitors, 2050);
  });

  console.log('\nExecution + copilot');
  await test('overdue task shows up in diagnosis', () => {
    actions.createTask({ title: 'Test overdue task', due: '2025-04-01', owner_id: 'T04' });
    const d = engine.snapshot('2025-04-20').diagnosis.find((f) => f.area === 'Execution');
    assert.ok(d && /past their deadline/.test(d.title));
  });
  await test('copilot proposal is NOT executed until confirmed', async () => {
    const before = store.ops.tasks.length;
    const r = await copilot.chat({ messages: [{ role: 'user', content: 'Tell me about Paid Social' }, { role: 'assistant', content: '...' }, { role: 'user', content: 'create a task for it' }], asOf: '2025-04-20' });
    assert.strictEqual(r.proposals.length, 1);
    assert.strictEqual(store.ops.tasks.length, before);
    actions.confirm(r.proposals[0].id);
    assert.strictEqual(store.ops.tasks.length, before + 1);
    assert.strictEqual(store.ops.tasks[store.ops.tasks.length - 1].campaign_id, 'C02');
    assert.throws(() => actions.confirm(r.proposals[0].id), /expired|handled/);
  });
  await test('copilot says when data cannot answer (demographics, revenue)', async () => {
    for (const q of ['What was the gender split of visitors?', 'What ROI did Paid Social generate?']) {
      const r = await copilot.chat({ messages: [{ role: 'user', content: q }], asOf: '2025-04-20' });
      assert.ok(/cannot answer/i.test(r.reply), q);
    }
  });
  await test('copilot answers follow-ups using the previous campaign', async () => {
    const r = await copilot.chat({ messages: [{ role: 'user', content: 'How is Creator Partners doing?' }, { role: 'assistant', content: '...' }, { role: 'user', content: 'show the weekly registrations trend for it' }], asOf: '2025-04-20' });
    assert.ok(r.trace.some((t) => t.tool === 'get_time_series' && t.args.campaign_id === 'C03'));
  });
  await test('offline fallback resolves "them" from the previous answer and keeps the stated task title', async () => {
    const r = await copilot.chat({ messages: [{ role: 'user', content: 'Which campaign has the most opt-outs?' }, { role: 'assistant', content: 'Paid Social (C02), owner Arjun Verma, 117 opt-outs.' }, { role: 'user', content: 'Create a task for them to reduce nurture frequency, due 2025-04-25' }], asOf: '2025-04-20' });
    const p = r.proposals[0].payload;
    assert.deepStrictEqual([p.title, p.campaign_id, p.owner_id, p.due], ['Reduce nurture frequency', 'C02', 'T04', '2025-04-25']);
  });
  await test('a status proposal without a real change is rejected (model must say paused/stopped)', () => {
    assert.throws(() => actions.propose('set_campaign_status', { campaign_id: 'C02' }, 'x'), /needs a change/);
    assert.throws(() => actions.propose('set_campaign_status', { campaign_id: 'C02', status: 'active' }, 'x'), /already active/);
    assert.ok(actions.propose('set_campaign_status', { campaign_id: 'C02', status: 'paused' }, 'x').id);
  });
  await test('copilot numbers follow changed data', async () => {
    actions.upsertDaily({ campaign_id: 'C03', activity_date: '2025-04-11', impressions: 100, clicks: 1, marketing_spend_inr: 41000 });
    const r = await copilot.chat({ messages: [{ role: 'user', content: 'How is Creator Partners doing?' }], asOf: '2025-04-20' });
    assert.ok(r.reply.includes('₹1,00,000'), 'expected new spend ₹1,00,000 in reply');
    store.resetToSource();
  });
  await test('calculator tool is exact and rejects code', () => {
    assert.strictEqual(copilot.runTool('calculate', { expression: '(2200-2050)/2200*100' }, {}).result, 6.818182);
    assert.ok(copilot.runTool('calculate', { expression: 'process.exit()' }, {}).error);
  });

  await test('Gemini loop: function call → tool runs on live data → functionResponse sent back', async () => {
    const realFetch = global.fetch; const bodies = [];
    const replies = [
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_campaign_performance', args: { campaign_id: 'C02' } } }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'propose_action', args: { type: 'set_campaign_status', campaign_id: 'C02', status: 'paused', rationale: 'test' } } }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Paid Social cost ₹273.5 per visitor. Proposed pausing it.' }] } }] },
    ];
    global.fetch = async (url, opt) => { bodies.push(JSON.parse(opt.body)); return { ok: true, json: async () => replies.shift() }; };
    process.env.GEMINI_API_KEY = 'test-key';
    try {
      const r = await copilot.chat({ messages: [{ role: 'user', content: 'How is paid social doing? pause it' }], asOf: '2025-04-20' });
      assert.strictEqual(r.mode, 'gemini');
      assert.deepStrictEqual(r.trace.map((t) => t.tool), ['get_campaign_performance', 'propose_action']);
      const fr = bodies[1].contents[bodies[1].contents.length - 1].parts[0].functionResponse;
      assert.strictEqual(fr.name, 'get_campaign_performance');
      assert.strictEqual(fr.response.result.campaigns[0].cost_per_visitor, 273.5);
      assert.strictEqual(r.proposals.length, 1);
      assert.strictEqual(store.ops.campaigns.C02.status, 'active', 'proposal must not execute by itself');
      assert.ok(bodies[0].tools[0].functionDeclarations.length >= 12);
    } finally { global.fetch = realFetch; delete process.env.GEMINI_API_KEY; }
  });
  await test('Gemini error falls back to the offline analyst instead of failing', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota exceeded' } }) });
    process.env.GEMINI_API_KEY = 'test-key';
    try {
      const r = await copilot.chat({ messages: [{ role: 'user', content: 'Are we on track?' }], asOf: '2025-04-20' });
      assert.strictEqual(r.mode, 'offline-fallback'); assert.ok(/quota exceeded/.test(r.reply)); assert.ok(/2,050/.test(r.reply));
    } finally { global.fetch = realFetch; delete process.env.GEMINI_API_KEY; }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
