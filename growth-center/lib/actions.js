// Write operations shared by the REST API and the copilot.
// The copilot never calls these directly: it creates a *proposal*, the user clicks Confirm,
// and only then does executeAction() run. That is the "with user confirmation" guarantee.
const crypto = require('crypto');
const store = require('./store');

const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'];
const PRIORITIES = ['high', 'medium', 'low'];
const CAMPAIGN_STATUSES = ['active', 'scaling', 'paused', 'stopped'];

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function nextTaskId() {
  const n = store.ops.tasks.reduce((m, t) => Math.max(m, Number(String(t.id).replace(/\D/g, '')) || 0), 0) + 1;
  return 'TSK-' + String(n).padStart(3, '0');
}

function validateCampaign(id) {
  if (id === null || id === undefined || id === '') return null;
  if (!store.raw.campaigns.find((c) => c.campaign_id === id)) throw bad(`Unknown campaign_id ${id}`);
  return id;
}
function validateOwner(id) {
  if (!id) return null;
  if (!store.ops.owners[id]) throw bad(`Unknown owner_id ${id}. Owners: ${Object.entries(store.ops.owners).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  return id;
}

function createTask(p, by = 'user') {
  if (!p.title || String(p.title).trim().length < 3) throw bad('Task title is required');
  if (p.due && !isDate(p.due)) throw bad('due must be YYYY-MM-DD');
  if (p.priority && !PRIORITIES.includes(p.priority)) throw bad('priority must be high, medium or low');
  if (p.status && !TASK_STATUSES.includes(p.status)) throw bad('invalid status');
  const owner_id = validateOwner(p.owner_id);
  const now = new Date().toISOString();
  const task = {
    id: nextTaskId(), title: String(p.title).trim().slice(0, 200), campaign_id: validateCampaign(p.campaign_id),
    owner_id, owner_name: owner_id ? store.ops.owners[owner_id] : null, due: p.due || null,
    status: p.status || 'todo', priority: p.priority || 'medium', notes: p.notes ? String(p.notes).slice(0, 1000) : '',
    created_by: by, created_at: now, updated_at: now,
  };
  store.ops.tasks.push(task);
  store.log('task', `${task.id} created: ${task.title}`, by);
  store.saveOps();
  return task;
}

function updateTask(id, p, by = 'user') {
  const t = store.ops.tasks.find((x) => x.id === id);
  if (!t) throw bad(`Task ${id} not found`);
  const before = { ...t };
  if (p.title !== undefined) t.title = String(p.title).slice(0, 200);
  if (p.status !== undefined) { if (!TASK_STATUSES.includes(p.status)) throw bad('invalid status'); t.status = p.status; }
  if (p.priority !== undefined) { if (!PRIORITIES.includes(p.priority)) throw bad('invalid priority'); t.priority = p.priority; }
  if (p.due !== undefined) { if (p.due && !isDate(p.due)) throw bad('due must be YYYY-MM-DD'); t.due = p.due || null; }
  if (p.owner_id !== undefined) { t.owner_id = validateOwner(p.owner_id); t.owner_name = t.owner_id ? store.ops.owners[t.owner_id] : null; }
  if (p.campaign_id !== undefined) t.campaign_id = validateCampaign(p.campaign_id);
  if (p.notes !== undefined) t.notes = String(p.notes).slice(0, 1000);
  t.updated_at = new Date().toISOString();
  const changes = Object.keys(p).filter((k) => before[k] !== t[k]).map((k) => `${k}: ${before[k] ?? '-'} → ${t[k] ?? '-'}`);
  store.log('task', `${id} updated (${changes.join(', ') || 'no change'})`, by);
  store.saveOps();
  return t;
}

function deleteTask(id, by = 'user') {
  const i = store.ops.tasks.findIndex((x) => x.id === id);
  if (i < 0) throw bad(`Task ${id} not found`);
  const [t] = store.ops.tasks.splice(i, 1);
  store.log('task', `${id} deleted: ${t.title}`, by);
  store.saveOps();
  return { deleted: id };
}

function setCampaignStatus(p, by = 'user') {
  const id = validateCampaign(p.campaign_id);
  if (!id) throw bad('campaign_id is required');
  const o = store.ops.campaigns[id] || (store.ops.campaigns[id] = { status: 'active', planned_budget_inr: null, notes: '' });
  const before = { ...o };
  if (p.status !== undefined) { if (!CAMPAIGN_STATUSES.includes(p.status)) throw bad(`status must be one of ${CAMPAIGN_STATUSES.join(', ')}`); o.status = p.status; }
  if (p.planned_budget_inr !== undefined) {
    const v = p.planned_budget_inr === null || p.planned_budget_inr === '' ? null : Number(p.planned_budget_inr);
    if (v !== null && !(v >= 0)) throw bad('planned_budget_inr must be >= 0');
    o.planned_budget_inr = v;
  }
  if (p.notes !== undefined) o.notes = String(p.notes).slice(0, 1000);
  const name = store.raw.campaigns.find((c) => c.campaign_id === id).campaign_name;
  store.log('decision', `${name}: status ${before.status} → ${o.status}${p.planned_budget_inr !== undefined ? `, planned budget ${before.planned_budget_inr ?? '-'} → ${o.planned_budget_inr ?? '-'}` : ''}${p.reason ? ` (${p.reason})` : ''}`, by);
  store.saveOps();
  return { campaign_id: id, ...o };
}

function updateInitiative(id, p, by = 'user') {
  const it = store.ops.initiatives.find((x) => x.id === id);
  if (!it) throw bad(`Initiative ${id} not found`);
  for (const k of ['scale_at', 'stop_at', 'budget_inr']) if (p[k] !== undefined) { const v = Number(p[k]); if (!isFinite(v)) throw bad(`${k} must be a number`); it[k] = v; }
  if (p.status !== undefined) { if (!['active', 'scaled', 'changed', 'stopped', 'planned'].includes(p.status)) throw bad('invalid initiative status'); it.status = p.status; }
  if (p.notes !== undefined) it.notes = String(p.notes).slice(0, 1000);
  if (p.owner_id !== undefined) it.owner_id = validateOwner(p.owner_id);
  store.log('decision', `Initiative ${id} updated: ${Object.keys(p).filter((k) => k !== 'reason').join(', ')}${p.reason ? ` (${p.reason})` : ''}`, by);
  store.saveOps();
  return it;
}

// ---------------------------------------------------------------- proposals (copilot)
const pending = new Map();
const ACTION_TYPES = ['create_task', 'update_task', 'set_campaign_status', 'update_initiative'];

function describe(type, p) {
  const camp = (id) => (store.raw.campaigns.find((c) => c.campaign_id === id) || {}).campaign_name || id || 'no campaign';
  switch (type) {
    case 'create_task': return `Create task "${p.title}" for ${camp(p.campaign_id)}${p.owner_id ? `, owner ${store.ops.owners[p.owner_id] || p.owner_id}` : ''}${p.due ? `, due ${p.due}` : ''} (${p.priority || 'medium'} priority)`;
    case 'update_task': return `Update ${p.task_id}: ${Object.entries(p).filter(([k]) => k !== 'task_id').map(([k, v]) => `${k} → ${v}`).join(', ')}`;
    case 'set_campaign_status': return `Set ${camp(p.campaign_id)} to ${p.status || '(unchanged status)'}${p.planned_budget_inr !== undefined ? `, planned budget ₹${p.planned_budget_inr}` : ''}`;
    case 'update_initiative': return `Update initiative ${p.initiative_id}: ${Object.entries(p).filter(([k]) => k !== 'initiative_id').map(([k, v]) => `${k} → ${v}`).join(', ')}`;
    default: return type;
  }
}

function propose(type, payload, rationale) {
  if (!ACTION_TYPES.includes(type)) throw bad(`Unknown action type ${type}. Allowed: ${ACTION_TYPES.join(', ')}`);
  payload = payload || {};
  // dry validation so the user never confirms something that will fail
  if (type === 'create_task') {
    if (!payload.title) throw bad('create_task needs a title');
    validateCampaign(payload.campaign_id); validateOwner(payload.owner_id);
    if (payload.due && !isDate(payload.due)) throw bad('due must be YYYY-MM-DD');
  }
  if (type === 'update_task' && !store.ops.tasks.find((t) => t.id === payload.task_id)) throw bad(`Task ${payload.task_id} not found`);
  if (type === 'set_campaign_status') {
    if (!validateCampaign(payload.campaign_id)) throw bad('campaign_id required');
    if (payload.status && !CAMPAIGN_STATUSES.includes(payload.status)) throw bad(`invalid campaign status '${payload.status}'. Use one of: ${CAMPAIGN_STATUSES.join(', ')}`);
    if (!payload.status && payload.planned_budget_inr === undefined) throw bad(`set_campaign_status needs a change: pass status (${CAMPAIGN_STATUSES.join(' | ')}, e.g. "paused" to pause) and/or planned_budget_inr`);
    const cur = (store.ops.campaigns[payload.campaign_id] || {}).status;
    if (payload.status && payload.status === cur && payload.planned_budget_inr === undefined) throw bad(`${payload.campaign_id} is already ${cur}; nothing to change`);
  }
  if (type === 'update_task' && Object.keys(payload).filter((k) => k !== 'task_id').length === 0) throw bad('update_task needs at least one field to change (status, due, owner_id, priority, notes, title)');
  if (type === 'update_initiative' && Object.keys(payload).filter((k) => !['initiative_id', 'reason'].includes(k)).length === 0) throw bad('update_initiative needs at least one field to change');
  if (type === 'update_initiative' && !store.ops.initiatives.find((i) => i.id === payload.initiative_id)) throw bad(`Initiative ${payload.initiative_id} not found`);
  const id = 'ACT-' + crypto.randomBytes(4).toString('hex');
  const proposal = { id, type, payload, rationale: rationale || '', summary: describe(type, payload), created_at: Date.now() };
  pending.set(id, proposal);
  for (const [k, v] of pending) if (Date.now() - v.created_at > 6 * 3600 * 1000) pending.delete(k);
  return proposal;
}

function executeAction(type, payload, by) {
  switch (type) {
    case 'create_task': return createTask(payload, by);
    case 'update_task': { const { task_id, ...rest } = payload; return updateTask(task_id, rest, by); }
    case 'set_campaign_status': return setCampaignStatus(payload, by);
    case 'update_initiative': { const { initiative_id, ...rest } = payload; return updateInitiative(initiative_id, rest, by); }
    default: throw bad('Unknown action');
  }
}

function confirm(id) {
  const p = pending.get(id);
  if (!p) throw bad('This proposal has expired or was already handled.');
  pending.delete(id);
  const result = executeAction(p.type, p.payload, 'copilot (confirmed by user)');
  return { proposal: p, result };
}
function reject(id) {
  const p = pending.get(id);
  if (!p) throw bad('This proposal has expired or was already handled.');
  pending.delete(id);
  store.log('copilot', `Proposal rejected by user: ${p.summary}`, 'user');
  store.saveOps();
  return { rejected: id };
}

// ---------------------------------------------------------------- raw data edits
function upsertDaily(p, by = 'user') {
  const raw = store.raw;
  const camp = raw.campaigns.find((c) => c.campaign_id === p.campaign_id);
  if (!camp) throw bad('Unknown campaign_id');
  if (!isDate(p.activity_date)) throw bad('activity_date must be YYYY-MM-DD');
  const nums = ['impressions', 'clicks', 'reported_reach', 'landing_page_sessions', 'registration_starts', 'marketing_spend_inr'];
  for (const k of nums) {
    if (p[k] === undefined || p[k] === null || p[k] === '') p[k] = 0;
    p[k] = Math.round(Number(p[k]));
    if (!isFinite(p[k])) throw bad(`${k} must be a number`);
    if (k !== 'marketing_spend_inr' && p[k] < 0) throw bad(`${k} cannot be negative`);
  }
  if (p.clicks > p.impressions && p.impressions > 0) throw bad('clicks cannot exceed impressions');
  const id = p.activity_id || `AD-${p.campaign_id}-${p.activity_date.slice(5, 7)}${p.activity_date.slice(8, 10)}`;
  const rows = raw.daily.filter((r) => r.activity_id === id);
  const row = { campaign_name: camp.campaign_name, owner_name: camp.owner_name, activity_date: p.activity_date, platform: p.platform || 'manual entry',
    activity_id: id, campaign_id: camp.campaign_id, owner_id: camp.owner_id };
  for (const k of nums) row[k] = p[k];
  if (rows.length) {
    // replace every copy (import duplicates share the id) with the edited row once
    raw.daily = raw.daily.filter((r) => r.activity_id !== id);
    raw.daily.push(row);
    store.log('data', `Daily row ${id} edited (spend ₹${row.marketing_spend_inr}, clicks ${row.clicks})`, by);
  } else {
    raw.daily.push(row);
    store.log('data', `Daily row ${id} added for ${camp.campaign_name} (spend ₹${row.marketing_spend_inr})`, by);
  }
  store.saveRaw(); store.saveOps();
  return row;
}

function deleteDaily(id, by = 'user') {
  const before = store.raw.daily.length;
  store.raw.daily = store.raw.daily.filter((r) => r.activity_id !== id);
  if (store.raw.daily.length === before) throw bad('Row not found');
  store.log('data', `Daily row ${id} deleted`, by);
  store.saveRaw(); store.saveOps();
  return { deleted: id };
}

function addTargets(p, by = 'user') {
  const fields = ['identified_external_people_goal', 'registration_goal', 'unique_external_visitors_goal', 'marketing_budget_inr'];
  const last = store.raw.targets.slice().sort((a, b) => (a.effective_at < b.effective_at ? -1 : 1)).pop() || {};
  const row = { effective_at: (p.effective_date && isDate(p.effective_date) ? p.effective_date : new Date().toISOString().slice(0, 10)) + 'T09:00:00', target_version: p.target_version || 'Edited plan' };
  for (const f of fields) {
    const v = p[f] === undefined || p[f] === '' ? last[f] : Number(p[f]);
    if (!(v >= 0)) throw bad(`${f} must be a non-negative number`);
    row[f] = Math.round(v);
  }
  store.raw.targets.push(row);
  store.log('data', `New target version "${row.target_version}" effective ${row.effective_at.slice(0, 10)}: regs ${row.registration_goal}, visitors ${row.unique_external_visitors_goal}, budget ₹${row.marketing_budget_inr}`, by);
  store.saveRaw(); store.saveOps();
  return row;
}

function setRegistrationStatus(registrationId, status, effectiveAt, by = 'user') {
  if (!['interested', 'confirmed', 'cancelled', 'waitlisted'].includes(status)) throw bad('invalid status');
  const reg = store.raw.registrations.find((r) => r.registration_id === registrationId);
  if (!reg) throw bad('Registration not found');
  const n = store.raw.regHistory.length + 1;
  const eff = effectiveAt && /^\d{4}-\d{2}-\d{2}/.test(effectiveAt) ? (effectiveAt.length === 10 ? effectiveAt + 'T12:00:00' : effectiveAt) : new Date().toISOString().slice(0, 19);
  const row = { person_name: reg.person_name, campaign_name: reg.campaign_name, owner_name: reg.owner_name, effective_at: eff, status,
    history_id: 'RH-M' + String(n).padStart(6, '0'), registration_id: reg.registration_id, person_id: reg.person_id, campaign_id: reg.campaign_id, owner_id: reg.owner_id };
  store.raw.regHistory.push(row);
  store.log('data', `Registration ${registrationId} status → ${status} (effective ${eff})`, by);
  store.saveRaw(); store.saveOps();
  return row;
}

module.exports = {
  createTask, updateTask, deleteTask, setCampaignStatus, updateInitiative,
  propose, confirm, reject, upsertDaily, deleteDaily, addTargets, setRegistrationStatus,
  TASK_STATUSES, PRIORITIES, CAMPAIGN_STATUSES, ACTION_TYPES,
};
