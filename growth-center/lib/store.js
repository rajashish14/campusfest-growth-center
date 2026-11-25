// File-backed persistence. Two files:
//   data/raw.json  - the source tables (editable: daily marketing, targets, status changes, imports)
//   data/ops.json  - the operating layer (campaign status, tasks, initiatives, decision log, settings)
// Writes go to a temp file and are renamed, so a crash never leaves half a file behind.
const fs = require('fs');
const path = require('path');
const { readWorkbook } = require('./loader');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SOURCE_XLSX = path.join(__dirname, '..', 'data', 'Attendee Dataset.xlsx');
const RAW_FILE = path.join(DATA_DIR, 'raw.json');
const OPS_FILE = path.join(DATA_DIR, 'ops.json');

let raw = null;
let ops = null;
let version = 0; // bumps on every change so cached analytics are recomputed

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

const OWNERS = {
  T01: 'Riya Kapoor', T02: 'Kabir Shah', T03: 'Meera Iyer',
  T04: 'Arjun Verma', T05: 'Nisha Rao', T06: 'Dev Malhotra',
};

function seedOps(rawTables) {
  const campaigns = {};
  for (const c of rawTables.campaigns) {
    campaigns[c.campaign_id] = { status: 'active', planned_budget_inr: null, notes: '' };
  }
  const now = new Date().toISOString();
  const t = (id, title, campaign_id, owner_id, due, status, priority, note) => ({
    id, title, campaign_id, owner_id, owner_name: OWNERS[owner_id], due, status, priority,
    notes: note || '', created_by: 'manual', created_at: now, updated_at: now,
  });
  return {
    campaigns,
    owners: OWNERS,
    settings: {
      assumed_show_rate: 0.75,          // used only for pre-event projections
      assumed_walkins: 100,             // used only for pre-event projections
      venue_daily_capacity: 2600,
      scale_ratio: 0.8,                 // cost per outcome <= 0.8x portfolio -> scale
      fix_ratio: 1.25,                  // > 1.25x -> fix
      stop_ratio: 2.0,                  // > 2.0x -> stop / cut
      fatigue_drop: 0.3,                // CTR down 30%+ vs prior 14 days -> creative fatigue
    },
    tasks: [
      t('TSK-001', 'Rotate Paid Social creatives (3 new Reels variants)', 'C02', 'T04', '2025-03-14', 'done', 'high', 'CTR fell below 1.5% in week of 10 Mar.'),
      t('TSK-002', 'Sign 6 more college clubs for group registrations', 'C04', 'T03', '2025-03-20', 'done', 'high'),
      t('TSK-003', 'Referral "bring your squad" unlock at 3 friends', 'C05', 'T06', '2025-03-18', 'done', 'medium'),
      t('TSK-004', 'WhatsApp reminder to confirmed registrants (T-2 days)', null, 'T05', '2025-04-10', 'done', 'high'),
      t('TSK-005', 'Release waitlist seats after cancellations', null, 'T03', '2025-04-09', 'todo', 'high', 'Waitlist release never happened in 2025.'),
      t('TSK-006', 'Add 2 scanners at main gate for 6-7 pm peak', null, 'T04', '2025-04-11', 'todo', 'medium'),
      t('TSK-007', 'Creator brief v2 with programme-specific hooks', 'C03', 'T05', '2025-03-25', 'doing', 'low'),
      t('TSK-008', 'Publish line-up page for organic search', 'C06', 'T04', '2025-03-05', 'done', 'medium'),
    ],
    initiatives: [
      // Ranked by confidence-weighted incremental visitors per ₹10k (see README §5 and model/bet_contribution.py)
      { id: 'I1', rank: 1, name: 'College Partnerships 2.0 (club captains + group passes)', owner_id: 'T03', budget_inr: 75000,
        hypothesis: 'Groups that register together show up together; 91.7% show-rate and ₹81/visitor in 2025.',
        metric: { key: 'cost_per_visitor', campaign_id: 'C04' }, direction: 'lower', scale_at: 100, stop_at: 160, status: 'active', notes: '' },
      { id: 'I2', rank: 2, name: 'Bring-your-squad referral loop', owner_id: 'T06', budget_inr: 35000,
        hypothesis: 'Registrants recruit friends cheaper than any paid channel (₹69/visitor in 2025).',
        metric: { key: 'cost_per_visitor', campaign_id: 'C05' }, direction: 'lower', scale_at: 90, stop_at: 150, status: 'active', notes: '' },
      { id: 'I3', rank: 3, name: 'Show-up engine (reminders, QR pass, waitlist release, gate fix)', owner_id: 'T05', budget_inr: 22000,
        hypothesis: '575 confirmed no-shows, 88 stuck waitlisted, 60 lost at the gate: the cheapest visitors are already registered.',
        metric: { key: 'show_rate', campaign_id: null }, direction: 'higher', scale_at: 0.82, stop_at: 0.75, status: 'active', notes: '' },
      { id: 'I4', rank: 4, name: 'Paid Social on a leash (retargeting + fatigue kill-rule)', owner_id: 'T04', budget_inr: 40000,
        hypothesis: 'Paid works only while creatives are fresh; cap it, cut it fast, and use the freed ₹1L to fund bets 1-3.',
        metric: { key: 'ctr_last14', campaign_id: 'C02' }, direction: 'higher', scale_at: 0.025, stop_at: 0.015, status: 'active', notes: '' },
      { id: 'I5', rank: 5, name: 'Abandoned-registration recovery', owner_id: 'T04', budget_inr: 10000,
        hypothesis: 'People who started the form but stopped need a nudge, not more ads.',
        metric: { key: 'abandoned_starts', campaign_id: null }, direction: 'lower', scale_at: 150, stop_at: 300, status: 'active', notes: '' },
    ],
    log: [],
  };
}

function load() {
  if (fs.existsSync(RAW_FILE)) {
    raw = JSON.parse(fs.readFileSync(RAW_FILE, 'utf8'));
  } else {
    raw = readWorkbook(SOURCE_XLSX);
    atomicWrite(RAW_FILE, raw);
  }
  if (fs.existsSync(OPS_FILE)) {
    ops = JSON.parse(fs.readFileSync(OPS_FILE, 'utf8'));
  } else {
    ops = seedOps(raw);
    atomicWrite(OPS_FILE, ops);
  }
  // campaigns added through an import get an ops record automatically
  for (const c of raw.campaigns) {
    if (!ops.campaigns[c.campaign_id]) ops.campaigns[c.campaign_id] = { status: 'active', planned_budget_inr: null, notes: '' };
  }
  version++;
}

function saveRaw() { atomicWrite(RAW_FILE, raw); version++; }
function saveOps() { atomicWrite(OPS_FILE, ops); version++; }

function log(kind, message, by = 'user') {
  ops.log.unshift({ at: new Date().toISOString(), kind, message, by });
  ops.log = ops.log.slice(0, 300);
}

function resetToSource({ keepOps = false } = {}) {
  raw = readWorkbook(SOURCE_XLSX);
  atomicWrite(RAW_FILE, raw);
  if (!keepOps) ops = seedOps(raw);
  log('data', 'Data reset to the original Attendee Dataset.xlsx');
  atomicWrite(OPS_FILE, ops);
  version++;
}

function importWorkbook(buffer) {
  const next = readWorkbook(buffer);
  raw = next;
  for (const c of raw.campaigns) {
    if (!ops.campaigns[c.campaign_id]) ops.campaigns[c.campaign_id] = { status: 'active', planned_budget_inr: null, notes: '' };
  }
  atomicWrite(RAW_FILE, raw);
  log('data', `Imported a new workbook (${raw.people.length} people, ${raw.daily.length} daily rows)`);
  saveOps();
}

module.exports = {
  load, saveRaw, saveOps, log, resetToSource, importWorkbook,
  get raw() { return raw; },
  get ops() { return ops; },
  get version() { return version; },
};
