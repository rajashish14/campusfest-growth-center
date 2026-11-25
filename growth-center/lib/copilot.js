// AI Growth Analyst & Copilot.
//
// Design: the language model never sees the raw tables and never does arithmetic on its own.
// It calls tools that run on the live application data (lib/engine.js), so answers change when
// data changes. Write actions are only *proposed*; the user confirms them in the UI.
//
// Provider: Google Gemini (free key from Google AI Studio) via REST function calling.
// Without a key, an offline analyst routes common questions to the same tools so the product
// still works end to end (clearly labelled as offline mode).
const engine = require('./engine');
const actions = require('./actions');
const store = require('./store');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// Google retires and overloads models often (Nov 2026: 2.5-flash retired for new keys, flash models returning 503).
// So the copilot walks a chain: configured model first, then fallbacks, moving on after 503/429/404/timeouts.
const MODEL_CHAIN = [...new Set([GEMINI_MODEL, ...(process.env.GEMINI_FALLBACK_MODELS || 'gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-3.8-flash').split(',').map((m) => m.trim()).filter(Boolean)])];
const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 25000;
const cooldown = new Map(); // model -> timestamp until which we skip it (shared across requests)
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_TOOL_ROUNDS = 8;

// ------------------------------------------------------------------ data dictionary
const DATA_DICTIONARY = {
  available: {
    campaigns: '7 attendee campaigns (C01-C07) with channel, owner, planned dates',
    daily_marketing: 'Per campaign per day: impressions, clicks, reported_reach, landing_page_sessions, registration_starts (anonymous events) and net marketing_spend_inr',
    people: 'Identified people with person_type (external/internal/staff/test), first_seen_at, first-touch campaign',
    interactions: 'Identified actions: page_visit, brochure_download, registration_start, event_question_submitted, nurture_email_sent/opened/clicked, opted_out',
    registrations: 'One registration per person with acquisition campaign and timestamp',
    registration_history: 'Status versions: interested, confirmed, cancelled, waitlisted',
    checkins: 'Admission events on 12-13 April with result (admitted/denied/pending), verification, source (scanner/manual)',
    targets: 'Dated target versions: identified people, registrations, unique visitors, marketing budget',
    ops: 'Campaign status (active/scaling/paused/stopped), tasks, initiatives with scale/stop thresholds, decision log',
  },
  not_available: [
    'Demographics (age, gender, college, course, year of study, home location)',
    'Ticket price or revenue - registrations carry no price, so ROI/revenue cannot be computed',
    'Venue capacity numbers (only the waitlisted status hints a cap) - capacity in Settings is an assumption',
    'Why someone cancelled, did not show up, or was denied at the gate (no reason codes)',
    'Creative-level or ad-set-level data (only campaign/day aggregates)',
    'Unique reach across days (reported_reach cannot be summed into unique people)',
    'Satisfaction / NPS / post-event feedback',
    'Sponsor revenue (that is the separate sponsorship dataset, not loaded here)',
    'Competitor events, weather, exam calendars, or any external factor',
    'Causal / incremental lift - there is no holdout group, so channel effects are correlational',
  ],
  definitions: {
    identified_people: 'Distinct external person_ids first seen on or before the snapshot',
    registrations: 'Distinct external people with a registration on or before the snapshot',
    confirmed: 'Registrations whose latest status version at the snapshot is confirmed',
    visitors: 'Distinct external person_ids with at least one admitted + verified check-in',
    walk_ins: 'Verified external visitors with no registration (no campaign attribution)',
    show_rate: 'Verified registered visitors / confirmed registrations',
    attribution: 'Registrations and visitors are attributed to the registration campaign; people to their first-touch campaign',
    spend: 'Net posted spend (debits minus credits); negative rows are vendor credits',
    dedup: 'Repeated stable IDs are import copies and count once',
  },
};

// ------------------------------------------------------------------ tool declarations (Gemini schema)
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });
const AS_OF = S('Snapshot date YYYY-MM-DD (end of day IST). Omit to use the date selected in the app.');

const TOOLS = [
  { name: 'get_overview', description: 'Headline KPIs vs the target version in force, budget use, rates, projection (pre-event) or actuals (post-event), event operations and data-quality notes.',
    parameters: { type: 'object', properties: { as_of: AS_OF } } },
  { name: 'get_campaign_performance', description: 'Per-campaign metrics: spend, anonymous activity, identified people, registrations, status mix, visitors, conversion rates, cost per outcome, 14-day trends, opt-outs, abandoned starts, and the rule-based Scale/Hold/Fix/Cut verdict with reasons. Omit campaign_id for all campaigns.',
    parameters: { type: 'object', properties: { as_of: AS_OF, campaign_id: S('Campaign id such as C02. Omit for all.') } } },
  { name: 'get_funnel', description: 'Funnel stage counts and stage conversion. Anonymous stages (impressions, clicks, sessions, form-start events) are separated from identified person-level stages.',
    parameters: { type: 'object', properties: { as_of: AS_OF, campaign_id: S('Optional campaign id') } } },
  { name: 'get_time_series', description: 'Daily or weekly series for one metric, optionally for one campaign. Use for trends, peaks and before/after comparisons.',
    parameters: { type: 'object', properties: {
      metric: S('One of: spend, impressions, clicks, ctr, landing_page_sessions, registration_starts, reported_reach, registrations, identified_people, cancellations, confirmations, opt_outs, verified_admissions'),
      campaign_id: S('Optional campaign id'), granularity: S('day or week', { enum: ['day', 'week'] }),
      from: S('Optional start date YYYY-MM-DD'), to: S('Optional end date YYYY-MM-DD'), as_of: AS_OF }, required: ['metric'] } },
  { name: 'diagnose', description: 'Rule-based findings for the snapshot: target gaps, biggest funnel leak, weak campaigns, creative fatigue, spend into decline, cost outliers, opt-outs, abandoned starts, waitlist, gate failures, budget pacing, overdue tasks. Each finding has evidence and a suggested action.',
    parameters: { type: 'object', properties: { as_of: AS_OF } } },
  { name: 'query_records', description: 'Flexible aggregation over deduplicated record-level views for questions the other tools do not cover. Views: people, registrations, interactions, checkins, daily_marketing, registration_history. Views are NOT filtered to external people unless you add filter person_type eq external.',
    parameters: { type: 'object', properties: {
      table: S('people | registrations | interactions | checkins | daily_marketing | registration_history'),
      filters: { type: 'array', description: 'Filters ANDed together', items: { type: 'object', properties: {
        field: S('Field name'), op: S('eq, ne, in, gt, gte, lt, lte, contains, is_null, not_null'), value: S('Value as text; for in use comma-separated values; booleans as true/false') }, required: ['field', 'op'] } },
      group_by: { type: 'array', items: { type: 'string' }, description: 'Up to two fields to group by' },
      measure: S('count, count_distinct, sum, avg, min, max'), field: S('Field for the measure (needed except for count)'),
      sort: S('desc or asc'), limit: N('Max groups returned, default 40'), as_of: AS_OF }, required: ['table'] } },
  { name: 'calculate', description: 'Evaluate an arithmetic expression exactly (+ - * / parentheses). Use for any derived number you state that a tool did not return directly.',
    parameters: { type: 'object', properties: { expression: S('e.g. (2200-2050)/2200*100') }, required: ['expression'] } },
  { name: 'simulate_budget_shift', description: 'Estimate the net change in visitors (post-event) or confirmed registrations (pre-event) from moving rupees between two campaigns, using a diminishing-returns assumption.',
    parameters: { type: 'object', properties: { from_campaign_id: S('Campaign to take budget from'), to_campaign_id: S('Campaign to give budget to'),
      amount_inr: N('Rupees to move'), elasticity: N('Optional, default 0.8 (assumption)'), as_of: AS_OF }, required: ['from_campaign_id', 'to_campaign_id', 'amount_inr'] } },
  { name: 'list_tasks', description: 'List execution tasks with owner, deadline, status, priority and whether overdue relative to the snapshot date.',
    parameters: { type: 'object', properties: { status: S('todo, doing, blocked, done (optional)'), campaign_id: S('Optional'), owner_id: S('Optional T01-T06'), as_of: AS_OF } } },
  { name: 'list_initiatives', description: 'The five strategic bets with their KPI, current value, scale/stop thresholds and verdict.',
    parameters: { type: 'object', properties: { as_of: AS_OF } } },
  // no parameters block: Gemini rejects an OBJECT schema with empty properties
  { name: 'get_data_dictionary', description: 'What data exists, metric definitions, and what the data CANNOT answer. Call this before answering anything about fields you are not sure exist.' },
  { name: 'propose_action', description: 'Propose a write action. It is NOT executed until the user clicks Confirm in the UI. Types: create_task {title, campaign_id?, owner_id?, due?, priority?, notes?}; update_task {task_id, status?, due?, owner_id?, priority?, notes?}; set_campaign_status {campaign_id, status: active|scaling|paused|stopped, planned_budget_inr?, reason?}; update_initiative {initiative_id, status?, scale_at?, stop_at?, notes?}.',
    parameters: { type: 'object', properties: {
      type: S('create_task | update_task | set_campaign_status | update_initiative'),
      rationale: S('One-sentence reason grounded in the data'),
      title: S('create_task / update_task: task title'), task_id: S('update_task: task id like TSK-004'),
      campaign_id: S('Campaign id C01-C07'), owner_id: S('Owner id T01-T06'), due: S('YYYY-MM-DD'),
      priority: S('high | medium | low'), status: S('Task status or campaign status or initiative status'),
      notes: S('Free text'), planned_budget_inr: N('set_campaign_status: planned budget'),
      initiative_id: S('update_initiative: I1-I5'), scale_at: N('update_initiative'), stop_at: N('update_initiative'), reason: S('Optional reason for the log') },
      required: ['type', 'rationale'] } },
];

// ------------------------------------------------------------------ tool execution
function compactCampaign(k) {
  const { status, ops, by_campaign, ...rest } = k;
  return { ...rest, status_mix: status, ops_status: ops.status, planned_budget_inr: ops.planned_budget_inr };
}

function calc(expr) {
  const e = String(expr || '').replace(/,/g, '');
  if (!/^[\d\s+\-*/().%]+$/.test(e)) return { error: 'Only numbers and + - * / ( ) % are allowed' };
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${e.replace(/(\d+(?:\.\d+)?)%/g, '($1/100)')});`)();
    if (!isFinite(v)) return { error: 'Result is not finite (division by zero?)' };
    return { expression: expr, result: Math.round(v * 1e6) / 1e6 };
  } catch (err) { return { error: 'Could not parse expression' }; }
}

function runTool(name, args, ctx) {
  args = args || {};
  const asOf = args.as_of || ctx.asOf;
  switch (name) {
    case 'get_overview': {
      const s = engine.snapshot(asOf);
      return { as_of: s.as_of, event_started: s.event_started, target_version: s.target_version, kpis: s.kpis, totals: s.totals, rates: s.rates,
        projection: s.projection, event_ops: { ...s.event_ops, admissions_by_hour: undefined }, data_quality: s.data_quality,
        trend_window: s.trend_window, campaigns_count: s.campaigns.length };
    }
    case 'get_campaign_performance': {
      const s = engine.snapshot(asOf);
      let list = s.campaigns;
      if (args.campaign_id) {
        list = list.filter((k) => k.campaign_id === args.campaign_id || k.campaign_name.toLowerCase() === String(args.campaign_id).toLowerCase());
        if (!list.length) return { error: `No campaign ${args.campaign_id}. Ids: ${s.campaigns.map((k) => `${k.campaign_id}=${k.campaign_name}`).join(', ')}` };
      }
      return { as_of: s.as_of, event_started: s.event_started, trend_window: s.trend_window, portfolio_rates: s.rates, campaigns: list.map(compactCampaign) };
    }
    case 'get_funnel': {
      const s = engine.snapshot(asOf);
      if (!args.campaign_id) {
        const stages = s.funnel.identified.map((x, i, a) => ({ ...x, conversion_from_previous: i ? (a[i - 1].value ? Math.round((x.value / a[i - 1].value) * 1000) / 1000 : null) : null }));
        return { as_of: s.as_of, anonymous: s.funnel.anonymous, identified: stages, walkin_visitors: s.funnel.walkin_visitors, note: s.funnel.note };
      }
      const k = s.campaigns.find((x) => x.campaign_id === args.campaign_id);
      if (!k) return { error: 'Unknown campaign id' };
      return { as_of: s.as_of, campaign: k.campaign_name,
        anonymous: { impressions: k.impressions, clicks: k.clicks, landing_page_sessions: k.landing_page_sessions, registration_starts_events: k.registration_starts_anon },
        identified: { identified_people: k.identified_people, registrations: k.registrations, confirmed: k.confirmed, visitors: k.visitors },
        rates: { ctr: k.ctr, reg_rate: k.reg_rate, confirm_rate: k.confirm_rate, show_rate: k.show_rate }, note: s.funnel.note };
    }
    case 'get_time_series': return engine.timeSeries({ ...args, as_of: asOf });
    case 'diagnose': { const s = engine.snapshot(asOf); return { as_of: s.as_of, findings: s.diagnosis }; }
    case 'query_records': {
      const filters = (args.filters || []).map((f) => {
        let v = f.value;
        if (v === 'true') v = true; else if (v === 'false') v = false;
        else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && ['gt', 'gte', 'lt', 'lte'].includes(f.op)) v = Number(v);
        return { field: f.field, op: f.op, value: v };
      });
      return engine.query({ ...args, filters, as_of: asOf });
    }
    case 'calculate': return calc(args.expression);
    case 'simulate_budget_shift': return engine.simulateShift(asOf, args.from_campaign_id, args.to_campaign_id, args.amount_inr, args.elasticity || 0.8);
    case 'list_tasks': {
      const s = engine.snapshot(asOf);
      let t = store.ops.tasks;
      if (args.status) t = t.filter((x) => x.status === args.status);
      if (args.campaign_id) t = t.filter((x) => x.campaign_id === args.campaign_id);
      if (args.owner_id) t = t.filter((x) => x.owner_id === args.owner_id);
      return { as_of: s.as_of, count: t.length, tasks: t.map((x) => ({ ...x, overdue: x.status !== 'done' && !!x.due && x.due < s.as_of })) };
    }
    case 'list_initiatives': { const s = engine.snapshot(asOf); return { as_of: s.as_of, initiatives: engine.evaluateInitiatives(s) }; }
    case 'get_data_dictionary': return { ...DATA_DICTIONARY, owners: store.ops.owners, campaigns: store.raw.campaigns.map((c) => ({ id: c.campaign_id, name: c.campaign_name, channel: c.channel, owner: c.owner_name })), date_range: engine.dataRange() };
    case 'propose_action': {
      const { type, rationale, ...payload } = args;
      for (const k of Object.keys(payload)) if (payload[k] === undefined || payload[k] === null || payload[k] === '') delete payload[k];
      const p = actions.propose(type, payload, rationale);
      ctx.proposals.push(p);
      return { proposal_id: p.id, summary: p.summary, status: 'awaiting user confirmation - NOT executed yet' };
    }
    default: return { error: `Unknown tool ${name}` };
  }
}

function safeRun(name, args, ctx) {
  try { return runTool(name, args, ctx); } catch (e) { return { error: e.message }; }
}

// ------------------------------------------------------------------ system prompt
function systemPrompt(ctx) {
  const s = engine.snapshot(ctx.asOf);
  const camps = s.campaigns.map((k) => `${k.campaign_id}=${k.campaign_name} (owner ${k.owner_name})`).join('; ');
  return `You are the Growth Analyst & Copilot inside the CampusFest Attendee Growth Center. The team uses you to understand performance, investigate problems and decide what to scale, change or stop.

CURRENT CONTEXT
- Snapshot date selected in the app: ${s.as_of} (end of day IST). Event: ${s.event.event_name}, ${String(s.event.event_starts_at).slice(0, 10)} to ${String(s.event.event_ends_at).slice(0, 10)}. Event started by snapshot: ${s.event_started}.
- Campaigns: ${camps}.
- Owners: ${Object.entries(store.ops.owners).map(([k, v]) => `${k}=${v}`).join(', ')}.
- Initiatives: ${store.ops.initiatives.map((i) => `${i.id}=${i.name}`).join('; ')}.

HOW YOU WORK
1. Every number you state must come from a tool result in this conversation turn (or the calculate tool). Never estimate from memory or general marketing knowledge. If the user asks about another date, pass as_of.
2. Use the cheapest tool that answers: get_overview, get_campaign_performance, get_funnel, get_time_series, diagnose, list_tasks, list_initiatives. Use query_records for unusual questions (remember to filter person_type eq external for target-style counts). Use calculate for any derived arithmetic (differences, percentages, ratios).
3. Separate EVIDENCE from ASSUMPTION. Label projections, the show-rate assumption, simulator elasticity and any causal claim as assumptions. Correlation across channels is not proven lift (no holdout groups exist).
4. If the data cannot answer (check get_data_dictionary when unsure), say so plainly, say what data would be needed, and offer the closest thing the data can show. Do not invent fields.
5. Recommendations: say what to scale, fix or stop, why (cite the numbers), the expected effect, and the risk. Prefer few, decisive recommendations.
6. Execution: when the user wants something done, or when a clear action follows from your analysis and the user asked for actions, call propose_action. Proposals are NOT executed until the user clicks Confirm on the card - say so. Never claim a change was made.
7. Follow-ups: resolve "it", "that campaign", "the second one" from the earlier conversation.
8. Style: concise, direct, written for a busy growth team. Use Indian number formatting with ₹. Use short bullet lists or a small markdown table when comparing. End with an "Evidence:" line naming the tools/metrics used. No filler, no generic marketing advice.`;
}

// ------------------------------------------------------------------ Gemini loop
async function callOnce(model, body, key) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body), signal: ctrl.signal });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
      const err = new Error(`${model}: ${msg}`); err.status = res.status; throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') { const err = new Error(`${model}: timed out after ${CALL_TIMEOUT_MS / 1000}s`); err.status = 504; throw err; }
    throw e;
  } finally { clearTimeout(timer); }
}

// Try the model that already worked in this conversation first, then the rest of the chain.
async function callGemini(body, key, ctx) {
  const now = Date.now();
  const healthy = MODEL_CHAIN.filter((m) => !(cooldown.get(m) > now));
  const base = healthy.length ? healthy : MODEL_CHAIN; // if everything is cooling down, try them all anyway
  const order = ctx.model ? [ctx.model, ...base.filter((m) => m !== ctx.model)] : base;
  const errors = [];
  const retired = new Set();
  // Two passes: the second ignores cooldowns, because overload spikes on the free tier are usually seconds long.
  for (let pass = 0; pass < 2; pass++) {
    const list = pass === 0 ? order : MODEL_CHAIN.filter((m) => !retired.has(m));
    if (pass === 1) { if (!list.length) break; await new Promise((r) => setTimeout(r, 1500)); }
    for (const model of list) {
      try {
        const json = await callOnce(model, body, key);
        ctx.model = model;
        cooldown.delete(model);
        return json;
      } catch (e) {
        errors.push(e.message.slice(0, 120));
        if (e.status === 404) { retired.add(model); cooldown.set(model, Date.now() + 24 * 3600 * 1000); }
        else if (e.status === 429 || e.status === 503) cooldown.set(model, Date.now() + COOLDOWN_MS);
        else if (e.status === 504) cooldown.set(model, Date.now() + 60 * 1000); // one slow call: short pause only
        if (![404, 429, 500, 502, 503, 504].includes(e.status) && e.status !== undefined) { pass = 2; break; } // real request errors: do not mask them
      }
    }
  }
  const err = new Error(`Gemini API error (${errors.slice(-3).join(' | ')})`); throw err;
}

async function chatGemini(messages, ctx, key) {
  const contents = messages.slice(-16).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '').slice(0, 8000) }] }));
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt(ctx) }] },
    contents,
    tools: [{ functionDeclarations: TOOLS }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
  };
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const json = await callGemini(body, key, ctx);
    const cand = (json.candidates || [])[0];
    if (!cand || !cand.content) {
      const reason = (json.promptFeedback && json.promptFeedback.blockReason) || (cand && cand.finishReason) || 'empty response';
      return `The model returned no answer (${reason}). Please rephrase.`;
    }
    const parts = cand.content.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) return parts.map((p) => p.text || '').join('').trim() || '(no text returned)';
    body.contents.push(cand.content); // keep the model turn exactly as returned (incl. thought signatures)
    const responses = calls.map((p) => {
      const { name, args } = p.functionCall;
      const result = safeRun(name, args, ctx);
      ctx.trace.push({ tool: name, args, result: summarise(result) });
      return { functionResponse: { name, response: { result: truncate(result) } } };
    });
    body.contents.push({ role: 'user', parts: responses });
  }
  return 'I stopped after several tool calls without reaching an answer. Try asking a narrower question.';
}

function truncate(obj) {
  const s = JSON.stringify(obj);
  if (s.length <= 30000) return obj;
  return { truncated: true, preview: s.slice(0, 30000) };
}
function summarise(result) {
  if (!result || typeof result !== 'object') return result;
  if (result.error) return { error: result.error };
  const s = JSON.stringify(result);
  return s.length > 600 ? s.slice(0, 600) + '…' : result;
}

// ------------------------------------------------------------------ offline analyst (no API key)
const fmt = (n) => (n === null || n === undefined ? 'n/a' : Number(n).toLocaleString('en-IN'));
const pc = (x) => (x === null || x === undefined ? 'n/a' : (x * 100).toFixed(1) + '%');
const inr = (n) => (n === null || n === undefined ? 'n/a' : '₹' + Math.round(n).toLocaleString('en-IN'));

const CAMPAIGN_WORDS = [
  ['C01', /ambassador/], ['C02', /paid|social|ads?\b|meta|instagram ad/], ['C03', /creator|influencer/],
  ['C04', /college|partnership|club/], ['C05', /referr/], ['C06', /organic|search|seo/], ['C07', /community|group/],
];
function findCampaign(text) {
  const t = text.toLowerCase();
  const id = t.match(/\bc0[1-9]\b/);
  if (id) return id[0].toUpperCase();
  for (const [cid, re] of CAMPAIGN_WORDS) if (re.test(t)) return cid;
  return null;
}
function findCampaigns(text) {
  const t = text.toLowerCase(); const out = [];
  for (const [cid, re] of CAMPAIGN_WORDS) { const m = t.search(re); if (m >= 0) out.push([m, cid]); }
  return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}
const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function findDate(text) {
  const iso = text.match(/\b(20\d\d-\d\d-\d\d)\b/); if (iso) return iso[1];
  const m = text.toLowerCase().match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/);
  if (m) return `2025-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}`;
  const m2 = text.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/);
  if (m2) return `2025-${MONTHS[m2[1]]}-${m2[2].padStart(2, '0')}`;
  return null;
}

const UNANSWERABLE = [
  [/\b(age|gender|male|female|demograph|year of study|course|branch)\b/, 'demographics (age, gender, course, year of study)'],
  [/\b(revenue|ticket price|price|profit|roi|roas)\b/, 'ticket price or revenue, so ROI/ROAS cannot be computed (cost per outcome is the closest measure)'],
  [/\b(nps|satisf|feedback|rating|review)\b/, 'satisfaction or post-event feedback'],
  [/\b(weather|rain|competitor|exam|holiday)\b/, 'external factors such as weather, competitor events or exam calendars'],
  [/\b(which college|college name|from which college|university name)\b/, 'the college each person comes from'],
  [/\bwhy did .*(cancel|not show|no.?show|denied)|reason.*(cancel|no.?show|denied)/, 'reason codes for cancellations, no-shows or gate denials'],
  [/\b(creative|ad set|adset|which ad)\b.*\b(best|perform|ctr)/, 'creative-level or ad-set-level data (only campaign/day totals)'],
  [/\bsponsor/, 'sponsorship data (this Growth Center runs on the attendee dataset only)'],
  [/\bunique reach|how many unique people (saw|reached)/, 'unique reach across days (daily reach cannot be summed into unique people)'],
];

function offline(messages, ctx) {
  const userMsgs = messages.filter((m) => m.role === 'user');
  const q = String((userMsgs[userMsgs.length - 1] || {}).content || '');
  const t = q.toLowerCase();
  const asOf = findDate(q) || ctx.asOf;
  ctx.asOf = asOf;
  // follow-up context: inherit the campaign from earlier user turns if this one has none
  let cid = findCampaign(q);
  if (!cid && (/\b(it|its|that|this|them|they|their|same)\b/.test(t) || /#\s?\d/.test(t))) {
    // walk back through BOTH sides of the conversation: the answer usually names the campaign the user means
    const prior = messages.slice(0, -1);
    for (let i = prior.length - 1; i >= 0 && !cid; i--) {
      const text = String(prior[i].content || '');
      cid = prior[i].role === 'assistant' ? (findCampaign((text.match(/\bC0[1-9]\b/) || [''])[0]) || findCampaigns(text)[0] || null) : findCampaign(text);
    }
  }
  const use = (name, args = {}) => { const r = safeRun(name, { ...args, as_of: asOf }, ctx); ctx.trace.push({ tool: name, args, result: summarise(r) }); return r; };
  const lines = [];

  for (const [re, what] of UNANSWERABLE) {
    if (re.test(t)) {
      use('get_data_dictionary');
      return `**The data cannot answer this.** The dataset has no ${what}.\n\nWhat it can show instead: campaign-level funnel, cost per outcome, status changes and verified check-ins. If you need this, it would have to be collected (e.g. a field on the registration form or a post-event survey).\n\nEvidence: get_data_dictionary (not_available list).`;
    }
  }

  // ---- write intents -> proposals
  const statusWord = t.match(/\b(pause|stop|scale|resume|activate)\b/);
  if (statusWord && cid && /\b(pause|stop|scale|resume|activate)\b.*\b(campaign|it|c0\d|paid|creator|college|referr|ambassador|organic|community)/.test(t)) {
    const map = { pause: 'paused', stop: 'stopped', scale: 'scaling', resume: 'active', activate: 'active' };
    const perf = use('get_campaign_performance', { campaign_id: cid }).campaigns[0];
    const p = use('propose_action', { type: 'set_campaign_status', campaign_id: cid, status: map[statusWord[1]], rationale: perf.decision.reasons[0] || 'Requested by user', reason: perf.decision.reasons[0] });
    return `I've prepared this change. **Nothing has been changed yet.** Click **Confirm** on the card to apply it.\n\n- ${p.summary}\n- Current rule verdict for ${perf.campaign_name}: **${perf.decision.action}**. ${perf.decision.reasons.join(' ')}\n\nEvidence: get_campaign_performance (${asOf}).`;
  }
  if (/\b(create|add|make|turn .* into|log)\b.*\btask/.test(t) || /\btask for\b/.test(t)) {
    // explicit title: "task: X", "task to X", "task for them to X, due ..."
    let title = (q.match(/task(?:\s+for\s+[^,]*?)?\s+to\s+(.+?)(?:,|\s+due\b|\s+by\s+20\d\d|$)/i) || q.match(/task[:\s]+["“]?([^"”]+?)["”]?(?:,|\s+due\b|$)/i) || [])[1];
    if (title) title = title.trim().replace(/^./, (ch) => ch.toUpperCase());
    const owner = (q.match(/\bT0[1-6]\b/i) || [])[0];
    const due = (q.match(/\b(20\d\d-\d\d-\d\d)\b/) || [])[1];
    let rationale = 'Requested by user'; let priority = /urgent|high/.test(t) ? 'high' : 'medium';
    if (!title || title.length < 6 || /^(for|from|based|out of)\b/i.test(title)) {
      const findings = use('diagnose').findings;
      const all = findings.filter((f) => f.suggested_task);
      // campaign-specific findings first when we know the campaign; "#2" picks the 2nd finding shown earlier
      let d = cid ? [...all.filter((f) => f.campaign_id === cid), ...all.filter((f) => !f.campaign_id)] : all;
      const nth = t.match(/#\s?(\d)/);
      if (nth) {
        const shown = cid ? findings.filter((f) => f.campaign_id === cid) : findings;
        const pick = shown[Number(nth[1]) - 1];
        if (pick && pick.suggested_task) d = [pick];
      }
      if (!d.length) return 'I could not find a finding to turn into a task. Tell me the task title, e.g. "create task: brief creators on line-up content for C03".';
      title = d[0].suggested_task.title; cid = cid || d[0].suggested_task.campaign_id; rationale = d[0].title; priority = d[0].suggested_task.priority || priority;
    }
    const camp = cid ? store.raw.campaigns.find((c) => c.campaign_id === cid) : null;
    const p = use('propose_action', { type: 'create_task', title, campaign_id: cid, owner_id: owner ? owner.toUpperCase() : camp ? camp.owner_id : undefined, due, priority, rationale });
    return `Task drafted from the data. **It is not saved until you click Confirm.**\n\n- ${p.summary}\n- Why: ${rationale}\n\nEvidence: ${ctx.trace.map((x) => x.tool).join(', ')}.`;
  }

  // ---- simulator
  const amt = t.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|lakh|l\b)?/);
  if (/\b(move|shift|reallocat|transfer)\b/.test(t)) {
    const cs = findCampaigns(q);
    if (cs.length >= 2 && amt) {
      let a = Number(amt[1].replace(/,/g, '')); if (amt[2] === 'k') a *= 1000; if (amt[2] === 'lakh' || amt[2] === 'l') a *= 100000;
      const r = use('simulate_budget_shift', { from_campaign_id: cs[0], to_campaign_id: cs[1], amount_inr: a });
      if (r.error) return r.error;
      return `**Moving ${inr(a)} from ${r.from.campaign} to ${r.to.campaign}** (as of ${r.as_of}):\n\n| | Spend before | ${r.outcome} before | ${r.outcome} after |\n|---|---|---|---|\n| ${r.from.campaign} | ${inr(r.from.spend_before)} | ${fmt(r.from.outcome_before)} | ${fmt(r.from.outcome_after)} |\n| ${r.to.campaign} | ${inr(r.to.spend_before)} | ${fmt(r.to.outcome_before)} | ${fmt(r.to.outcome_after)} |\n\n**Net change: ${r.net_change >= 0 ? '+' : ''}${fmt(r.net_change)} ${r.outcome}.**\n\nAssumption: ${r.caveat}\n\nEvidence: simulate_budget_shift.`;
    }
    return 'To simulate a shift, name two campaigns and an amount, e.g. "move ₹30,000 from Paid Social to College Partnerships".';
  }

  // ---- diagnosis
  if (/\b(why|bottleneck|diagnos|problem|issue|wrong|underperform|leak|worst|fix|risk|concern)\b/.test(t) && !/\btask/.test(t)) {
    const d = use('diagnose').findings.filter((f) => !cid || f.campaign_id === cid || (!f.campaign_id && !cid));
    if (!d.length) return `No rule-based issues found${cid ? ' for that campaign' : ''} as of ${asOf}.`;
    lines.push(`**What is going wrong${cid ? ` in ${store.raw.campaigns.find((c) => c.campaign_id === cid).campaign_name}` : ''} (as of ${asOf})**\n`);
    d.slice(0, 5).forEach((f, i) => lines.push(`${i + 1}. **${f.title}** — ${f.recommendation}\n   - ${f.evidence.slice(0, 3).join('; ')}`));
    lines.push('\nThese are rule-based findings (thresholds in Settings). They show where the drop happens, not why people behaved that way: the data has no reason codes.');
    lines.push('\nAsk me to "create a task for #1" to put it on the board. Evidence: diagnose.');
    return lines.join('\n');
  }

  // ---- ranking / comparison
  if (/\b(compare|best|rank|top|which campaign|most|least|cheapest|efficient)\b/.test(t)) {
    const r = use('get_campaign_performance');
    const costKey = r.event_started ? 'cost_per_visitor' : 'cost_per_confirmed';
    const metricMap = [
      [/cheap|per visitor|expensive|efficien|cpv|cost(?! per reg)/, costKey, false, inr],
      [/show/, 'show_rate', true, pc], [/ctr|click/, 'ctr', true, pc], [/opt.?out/, 'opt_out_rate', false, pc],
      [/registration rate|reg rate|convert/, 'reg_rate', true, pc], [/cancel/, 'cancel_rate', false, pc],
      [/cost per reg|cpr\b/, 'cost_per_registration', false, inr], [/spend|budget/, 'spend', false, inr],
      [/registr/, 'registrations', true, fmt], [/visitor|attend|footfall/, 'visitors', true, fmt],
    ];
    let [key, higherBetter, f] = r.event_started ? ['cost_per_visitor', false, inr] : ['cost_per_confirmed', false, inr];
    for (const [re, k, hb, ff] of metricMap) if (re.test(t)) { key = k; higherBetter = hb; f = ff; break; }
    if (/least|lowest|worst/.test(t) && ['registrations', 'visitors', 'show_rate', 'ctr', 'reg_rate'].includes(key)) higherBetter = !higherBetter;
    if (/most expensive|worst|highest cost/.test(t) && /cost/.test(key)) higherBetter = !higherBetter;
    const rows = r.campaigns.filter((k) => k[key] !== null).sort((a, b) => (higherBetter ? b[key] - a[key] : a[key] - b[key]));
    lines.push(`**Campaigns ranked by ${key.replace(/_/g, ' ')}** (as of ${r.as_of}, best first)\n`);
    lines.push(`| # | Campaign | ${key.replace(/_/g, ' ')} | Spend | Visitors | Verdict |\n|---|---|---|---|---|---|`);
    rows.forEach((k, i) => lines.push(`| ${i + 1} | ${k.campaign_name} | ${f(k[key])} | ${inr(k.spend)} | ${fmt(k.visitors)} | ${k.decision.action} |`));
    lines.push(`\nEvidence: get_campaign_performance. Channel comparisons are correlational: there were no holdout groups.`);
    return lines.join('\n');
  }

  // ---- trends
  if (/\b(trend|over time|weekly|week by week|daily|per week|per day|timeline|peak)\b/.test(t)) {
    let metric = 'registrations';
    for (const [re, m] of [[/ctr/, 'ctr'], [/spend/, 'spend'], [/click/, 'clicks'], [/impression/, 'impressions'], [/cancel/, 'cancellations'], [/opt.?out/, 'opt_outs'], [/admission|check.?in|visitor/, 'verified_admissions'], [/people|lead/, 'identified_people']]) if (re.test(t)) { metric = m; break; }
    const gran = /daily|per day|by day/.test(t) ? 'day' : 'week';
    const r = use('get_time_series', { metric, campaign_id: cid || undefined, granularity: gran });
    if (r.error) return r.error;
    const pts = r.points.slice(-14);
    const peak = r.points.reduce((a, b) => (b.value > (a ? a.value : -Infinity) ? b : a), null);
    lines.push(`**${metric.replace(/_/g, ' ')} by ${gran}${cid ? ` — ${store.raw.campaigns.find((c) => c.campaign_id === cid).campaign_name}` : ''}** (to ${r.to})\n`);
    lines.push(`| ${gran === 'week' ? 'Week of' : 'Day'} | Value |\n|---|---|`);
    pts.forEach((p) => lines.push(`| ${p.period} | ${metric === 'ctr' ? pc(p.value) : fmt(p.value)} |`));
    if (peak) lines.push(`\nPeak: ${peak.period} (${metric === 'ctr' ? pc(peak.value) : fmt(peak.value)}).${r.note ? ' ' + r.note : ''}`);
    lines.push('\nEvidence: get_time_series.');
    return lines.join('\n');
  }

  // ---- tasks
  if (/\b(task|todo|to-do|owner|overdue|deadline|assigned)\b/.test(t)) {
    const r = use('list_tasks', { campaign_id: cid || undefined });
    const open = r.tasks.filter((x) => x.status !== 'done');
    lines.push(`**${open.length} open task(s)** of ${r.count}${cid ? ' for this campaign' : ''} (as of ${r.as_of})\n`);
    lines.push('| Task | Owner | Due | Status | Priority |\n|---|---|---|---|---|');
    open.forEach((x) => lines.push(`| ${x.id} ${x.title} | ${x.owner_name || '—'} | ${x.due || '—'}${x.overdue ? ' ⚠ overdue' : ''} | ${x.status} | ${x.priority} |`));
    lines.push('\nEvidence: list_tasks.');
    return lines.join('\n');
  }

  // ---- initiatives
  if (/\b(initiative|bet|experiment|threshold)\b/.test(t)) {
    const r = use('list_initiatives');
    lines.push('| # | Initiative | KPI now | Scale at | Stop at | Verdict |\n|---|---|---|---|---|---|');
    r.initiatives.forEach((i) => lines.push(`| ${i.rank} | ${i.name} | ${i.current_value ?? 'n/a'} | ${i.scale_at} | ${i.stop_at} | ${i.verdict} |`));
    lines.push('\nEvidence: list_initiatives.');
    return lines.join('\n');
  }

  // ---- single campaign
  if (cid) {
    const k = use('get_campaign_performance', { campaign_id: cid }).campaigns[0];
    lines.push(`**${k.campaign_name}** (${k.channel}, owner ${k.owner_name}) as of ${asOf} — verdict **${k.decision.action}**\n`);
    lines.push(`- Spend ${inr(k.spend)} (${pc(k.spend_share)} of total)`);
    lines.push(`- Identified people ${fmt(k.identified_people)} → registrations ${fmt(k.registrations)} (${pc(k.reg_rate)}) → confirmed ${fmt(k.confirmed)} → visitors ${fmt(k.visitors)}${k.show_rate !== null ? ` (show-rate ${pc(k.show_rate)})` : ''}`);
    lines.push(`- Cost per registration ${inr(k.cost_per_registration)}; per confirmed ${inr(k.cost_per_confirmed)}${k.cost_per_visitor !== null ? `; per visitor ${inr(k.cost_per_visitor)}` : ''}`);
    lines.push(`- CTR ${pc(k.ctr)} overall; prior 14d ${pc(k.ctr_prev14)} → last 14d ${pc(k.ctr_last14)}; registrations ${k.regs_prev14} → ${k.regs_last14}`);
    lines.push(`- Opt-outs ${fmt(k.opted_out_people)} (${pc(k.opt_out_rate)}); abandoned form starts ${fmt(k.abandoned_starts)}; cancelled ${fmt(k.cancelled)}; waitlisted ${fmt(k.waitlisted)}`);
    lines.push(`\nWhy the verdict: ${k.decision.reasons.join(' ')}`);
    lines.push('\nEvidence: get_campaign_performance.');
    return lines.join('\n');
  }

  // ---- overview / targets / budget (default for status questions)
  if (/\b(overview|how are we|status|target|goal|on track|summary|kpi|budget|spend|visitor|registration|attend|footfall|how many|total)\b/.test(t)) {
    const o = use('get_overview');
    const k = o.kpis;
    const gaps = [['registrations', 'registrations'], ['visitors', 'verified visitors'], ['identified_people', 'identified people']]
      .filter(([kk]) => k[kk].goal && (o.event_started || kk !== 'visitors'))
      .map(([kk, label]) => ({ label, gap: k[kk].goal - k[kk].value }));
    const short = gaps.filter((g) => g.gap > 0);
    lines.push(`**Status as of ${o.as_of}** (target version: ${o.target_version})\n`);
    if (o.event_started) {
      lines.push(short.length
        ? `**Verdict: below target** on ${short.map((g) => `${g.label} (short by ${fmt(g.gap)})`).join(' and ')}.${gaps.some((g) => g.gap <= 0) ? ` Met: ${gaps.filter((g) => g.gap <= 0).map((g) => g.label).join(', ')}.` : ''}\n`
        : '**Verdict: all targets met.**\n');
    } else if (o.projection.projected_visitors && k.visitors.goal) {
      lines.push(`**Verdict: ${o.projection.projected_visitors >= k.visitors.goal ? 'on track' : 'off track'}** for visitors: projected ${fmt(o.projection.projected_visitors)} vs goal ${fmt(k.visitors.goal)} (the projection rests on the assumptions below).\n`);
    }
    lines.push('| KPI | Actual | Goal | Attainment |\n|---|---|---|---|');
    lines.push(`| Identified external people | ${fmt(k.identified_people.value)} | ${fmt(k.identified_people.goal)} | ${pc(k.identified_people.attainment)} |`);
    lines.push(`| Registrations (external) | ${fmt(k.registrations.value)} | ${fmt(k.registrations.goal)} | ${pc(k.registrations.attainment)} |`);
    lines.push(`| Verified unique visitors | ${fmt(k.visitors.value)} | ${fmt(k.visitors.goal)} | ${pc(k.visitors.attainment)} |`);
    lines.push(`| Marketing spend | ${inr(k.spend.value)} | ${inr(k.spend.goal)} | ${pc(k.spend.attainment)} |`);
    if (o.projection.mode === 'projected') lines.push(`\nProjection (${o.projection.days_to_event} days to event): ~${fmt(o.projection.projected_registrations)} registrations and ~${fmt(o.projection.projected_visitors)} visitors. Assumptions: ${o.projection.assumptions.show_rate} ${o.projection.assumptions.walkins}`);
    else lines.push(`\nShow-rate ${pc(o.rates.show_rate)} of confirmed; cost per visitor ${inr(o.rates.cost_per_visitor)}; ${fmt(o.totals.visitors_walkin)} walk-ins; ${fmt(o.event_ops.visitors_both_days)} visitors came both days.`);
    lines.push(`\nData hygiene applied: ${Object.entries(o.data_quality.duplicate_rows_removed).filter(([, v]) => v).map(([k2, v]) => `${v} duplicate ${k2} rows`).join(', ') || 'no duplicates'}; ${o.data_quality.internal_registrations_excluded} internal registrations and ${o.data_quality.non_external_verified_admissions_excluded} staff/test/internal admissions excluded.`);
    lines.push('\nEvidence: get_overview.');
    return lines.join('\n');
  }

  return `I'm running in **offline mode** (no Gemini API key configured), so I can only handle common question types: status vs targets, campaign deep-dives, rankings, trends, diagnosis, budget shifts, tasks and initiatives, plus drafting tasks or status changes for you to confirm.\n\nI couldn't map "${q.slice(0, 120)}" to one of those. Try e.g. "Why are we below the visitor target?", "Compare campaigns by show rate", "Weekly CTR trend for Paid Social", or "Move ₹20k from Creator Partners to Student Referrals".\n\nWith a GEMINI_API_KEY set, I can answer open-ended questions using the flexible query tool.`;
}

// ------------------------------------------------------------------ entry point
async function chat({ messages, asOf, mode }) {
  const ctx = { asOf: asOf || engine.dataRange().max, trace: [], proposals: [] };
  const key = process.env.GEMINI_API_KEY;
  if (key && mode !== 'offline') {
    try {
      const reply = await chatGemini(messages, ctx, key);
      return { reply, mode: 'gemini', model: ctx.model || GEMINI_MODEL, trace: ctx.trace, proposals: ctx.proposals };
    } catch (e) {
      const reply = offline(messages, ctx);
      return { reply: `_Gemini unavailable (${e.message}). Answered by the offline analyst instead._\n\n${reply}`, mode: 'offline-fallback', trace: ctx.trace, proposals: ctx.proposals };
    }
  }
  return { reply: offline(messages, ctx), mode: 'offline', trace: ctx.trace, proposals: ctx.proposals };
}

module.exports = { MODEL_CHAIN, chat, TOOLS, runTool: safeRun, DATA_DICTIONARY, offline };
