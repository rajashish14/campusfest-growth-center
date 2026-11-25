// Analytics engine. Every number in the dashboard and every number the copilot quotes comes from here.
//
// Rules taken from the dataset's own "Read me" sheet:
//  * Exact repeated IDs are import copies -> count once (dedupe on stable IDs).
//  * Targets apply to EXTERNAL people only (internal, staff and test are excluded and reported separately).
//  * Only result=admitted AND verification=verified establishes a visit. A visitor is a distinct person_id.
//  * Registration status = latest history version effective at or before the snapshot.
//  * A snapshot date means end of that day (IST). Nothing after it is allowed to leak in.
//  * Daily reach/impressions/clicks are anonymous event counts -> never presented as unique people.
const store = require('./store');

// ------------------------------------------------------------------ helpers
const r1 = (x) => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const div = (a, b) => (b ? a / b : null);
const dayOf = (iso) => (iso ? iso.slice(0, 10) : null);

function addDays(dateStr, n) {
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { // b - a in days
  return Math.round((Date.parse(b.slice(0, 10) + 'T00:00:00Z') - Date.parse(a.slice(0, 10) + 'T00:00:00Z')) / 86400000);
}
function weekStart(dateStr) { // Monday
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function dedupe(rows, key) {
  const seen = new Set(); const out = []; let dups = 0;
  for (const r of rows) {
    const k = r[key];
    if (k === null || k === undefined) { out.push(r); continue; }
    if (seen.has(k)) { dups++; continue; }
    seen.add(k); out.push(r);
  }
  return { rows: out, dups };
}

// ------------------------------------------------------------------ clean layer (cached per data version)
let cleanCache = { version: -1, data: null };
function clean() {
  if (cleanCache.version === store.version) return cleanCache.data;
  const raw = store.raw;
  const dq = {};
  const invalid = {};
  // A row whose date cannot be read (bad edit, malformed import) is skipped and reported, never allowed to crash analytics.
  const okDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v.slice(0, 10) + 'T00:00:00Z'))
    && new Date(v.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === v.slice(0, 10);
  const valid = (name, rows, field) => { const out = rows.filter((r) => okDate(r[field])); if (rows.length - out.length) invalid[name] = rows.length - out.length; return out; };
  const d = (name, key, field) => { const x = dedupe(raw[name] || [], key); dq[name] = x.dups; return valid(name, x.rows, field); };
  const daily = d('daily', 'activity_id', 'activity_date');
  const people = d('people', 'person_id', 'first_seen_at');
  const interactions = d('interactions', 'interaction_id', 'occurred_at');
  const registrations = d('registrations', 'registration_id', 'registered_at');
  const regHistory = d('regHistory', 'history_id', 'effective_at').slice().sort((a, b) => (a.effective_at < b.effective_at ? -1 : a.effective_at > b.effective_at ? 1 : 0));
  const checkins = d('checkins', 'event_id', 'occurred_at');
  const targets = valid('targets', raw.targets || [], 'effective_at').slice().sort((a, b) => (a.effective_at < b.effective_at ? -1 : 1));
  const campaigns = raw.campaigns || [];
  const event = (raw.event || [])[0] || {};
  const personType = new Map(people.map((p) => [p.person_id, p.person_type]));
  const personById = new Map(people.map((p) => [p.person_id, p]));
  const regById = new Map(registrations.map((r) => [r.registration_id, r]));
  const campaignName = new Map(campaigns.map((c) => [c.campaign_id, c.campaign_name]));
  const histByReg = new Map();
  for (const h of regHistory) {
    if (!histByReg.has(h.registration_id)) histByReg.set(h.registration_id, []);
    histByReg.get(h.registration_id).push(h);
  }
  const data = { daily, people, interactions, registrations, regHistory, checkins, targets, campaigns, event,
    personType, personById, regById, campaignName, histByReg, dq, invalid };
  cleanCache = { version: store.version, data };
  return data;
}

function dataRange() {
  const c = clean();
  const ev = c.event;
  let maxDate = dayOf(ev.history_end) || '2025-04-20';
  for (const r of c.daily) if (r.activity_date > maxDate) maxDate = r.activity_date;
  return { min: dayOf(ev.history_start) || '2025-01-15', max: maxDate, event_start: ev.event_starts_at, event_end: ev.event_ends_at };
}

function statusAsOf(regId, cutoff) {
  const hist = clean().histByReg.get(regId) || [];
  let s = null;
  for (const h of hist) { if (h.effective_at <= cutoff) s = h.status; else break; }
  return s;
}

function targetsAsOf(cutoff) {
  const { targets } = clean();
  let t = targets[0] || null;
  for (const x of targets) if (x.effective_at <= cutoff) t = x;
  return t;
}

// ------------------------------------------------------------------ snapshot
const snapCache = new Map();

function snapshot(asOfInput) {
  const range = dataRange();
  const asOf = (asOfInput || range.max).slice(0, 10);
  const key = store.version + '|' + asOf;
  if (snapCache.has(key)) return snapCache.get(key);
  if (snapCache.size > 40) snapCache.clear();

  const c = clean();
  const ops = store.ops;
  const settings = ops.settings;
  const cutoff = asOf + 'T23:59:59';
  const eventStart = c.event.event_starts_at || '2025-04-12T10:00:00';
  const eventStarted = cutoff >= eventStart;
  const isExt = (pid) => c.personType.get(pid) === 'external';
  // Trend windows: the last 14 days up to the snapshot. Once the event has started, acquisition is over,
  // so the window is anchored to the day before the event instead (otherwise everything looks "halved").
  const trendAnchor = eventStarted ? addDays(eventStart, -1) : asOf;
  const last14From = addDays(trendAnchor, -13);
  const prev14From = addDays(trendAnchor, -27);
  const prev14To = addDays(trendAnchor, -14);

  // per-campaign accumulator
  const camp = new Map();
  const blank = (id, name) => ({
    campaign_id: id, campaign_name: name,
    spend: 0, impressions: 0, clicks: 0, reported_reach: 0, landing_page_sessions: 0, registration_starts_anon: 0,
    identified_people: 0, registrations: 0, status: { interested: 0, confirmed: 0, cancelled: 0, waitlisted: 0, unknown: 0 },
    visitors: 0, opted_out_people: 0, brochure_people: 0, question_people: 0, abandoned_starts: 0,
    gate_failures: 0, regs_last14: 0, regs_prev14: 0, spend_last14: 0, spend_prev14: 0,
    clicks_last14: 0, impr_last14: 0, clicks_prev14: 0, impr_prev14: 0,
  });
  for (const cc of c.campaigns) camp.set(cc.campaign_id, blank(cc.campaign_id, cc.campaign_name));
  const getC = (id) => {
    if (!id) return null;
    if (!camp.has(id)) camp.set(id, blank(id, c.campaignName.get(id) || id));
    return camp.get(id);
  };

  // anonymous daily activity + spend
  const dailyByDay = new Map();
  for (const r of c.daily) {
    if (r.activity_date > asOf) continue;
    const k = getC(r.campaign_id);
    if (!k) continue;
    const spend = Number(r.marketing_spend_inr) || 0;
    k.spend += spend;
    k.impressions += Number(r.impressions) || 0;
    k.clicks += Number(r.clicks) || 0;
    k.reported_reach += Number(r.reported_reach) || 0;
    k.landing_page_sessions += Number(r.landing_page_sessions) || 0;
    k.registration_starts_anon += Number(r.registration_starts) || 0;
    if (r.activity_date >= last14From && r.activity_date <= trendAnchor) { k.spend_last14 += spend; k.clicks_last14 += Number(r.clicks) || 0; k.impr_last14 += Number(r.impressions) || 0; }
    else if (r.activity_date >= prev14From && r.activity_date <= prev14To) { k.spend_prev14 += spend; k.clicks_prev14 += Number(r.clicks) || 0; k.impr_prev14 += Number(r.impressions) || 0; }
    dailyByDay.set(r.activity_date, (dailyByDay.get(r.activity_date) || 0) + spend);
  }

  // identified people (first-touch attribution)
  const excluded = { internal: 0, staff: 0, test: 0 };
  let walkinPeople = 0; let identified = 0;
  for (const p of c.people) {
    if (!p.first_seen_at || p.first_seen_at > cutoff) continue;
    if (p.person_type !== 'external') { excluded[p.person_type] = (excluded[p.person_type] || 0) + 1; continue; }
    identified++;
    const k = getC(p.first_campaign_id);
    if (k) k.identified_people++; else walkinPeople++;
  }

  // registrations + status as of snapshot
  const regsAsOf = [];
  let internalRegs = 0;
  for (const r of c.registrations) {
    if (!r.registered_at || r.registered_at > cutoff) continue;
    if (!isExt(r.person_id)) { internalRegs++; continue; }
    const st = statusAsOf(r.registration_id, cutoff) || 'unknown';
    regsAsOf.push({ ...r, status: st });
    const k = getC(r.campaign_id);
    if (k) {
      k.registrations++;
      k.status[st] = (k.status[st] || 0) + 1;
      if (r.registered_at.slice(0, 10) >= last14From && r.registered_at.slice(0, 10) <= trendAnchor) k.regs_last14++;
      else if (r.registered_at.slice(0, 10) >= prev14From && r.registered_at.slice(0, 10) <= prev14To) k.regs_prev14++;
    }
  }
  const registeredPids = new Set(regsAsOf.map((r) => r.person_id));
  const regStatusByPid = new Map(regsAsOf.map((r) => [r.person_id, r.status]));

  // engagement signals (identified, person-level)
  const optOut = new Map(); const brochure = new Map(); const question = new Map(); const startedForm = new Map();
  const interactionCounts = {};
  for (const i of c.interactions) {
    if (!i.occurred_at || i.occurred_at > cutoff || !isExt(i.person_id)) continue;
    interactionCounts[i.event_type] = (interactionCounts[i.event_type] || 0) + 1;
    const bucket = i.event_type === 'opted_out' ? optOut : i.event_type === 'brochure_download' ? brochure
      : i.event_type === 'event_question_submitted' ? question : i.event_type === 'registration_start' ? startedForm : null;
    if (bucket) bucket.set(i.person_id, i.campaign_id);
  }
  for (const [pid, cid] of optOut) { const k = getC(cid); if (k) k.opted_out_people++; }
  for (const [pid, cid] of brochure) { const k = getC(cid); if (k) k.brochure_people++; }
  for (const [pid, cid] of question) { const k = getC(cid); if (k) k.question_people++; }
  let abandoned = 0;
  for (const [pid, cid] of startedForm) {
    if (registeredPids.has(pid)) continue;
    abandoned++;
    const first = c.personById.get(pid);
    const k = getC((first && first.first_campaign_id) || cid);
    if (k) k.abandoned_starts++;
  }

  // check-ins
  const verifiedPids = new Set(); const visitorCampaign = new Map(); const visitorDays = new Map();
  let admitEvents = 0; const nonVerified = { denied: 0, pending: 0 }; let nonExternalAdmits = new Set();
  const sourceByPid = new Map(); const hourly = {};
  const failedPids = new Set();
  for (const ch of c.checkins) {
    if (!ch.occurred_at || ch.occurred_at > cutoff) continue;
    const ok = ch.result === 'admitted' && ch.verification === 'verified';
    if (!isExt(ch.person_id)) { if (ok) nonExternalAdmits.add(ch.person_id); continue; }
    if (!ok) { nonVerified[ch.result] = (nonVerified[ch.result] || 0) + 1; failedPids.add(ch.person_id); continue; }
    admitEvents++;
    verifiedPids.add(ch.person_id);
    const reg = ch.registration_id ? c.regById.get(ch.registration_id) : null;
    visitorCampaign.set(ch.person_id, reg ? reg.campaign_id : null);
    if (!visitorDays.has(ch.person_id)) visitorDays.set(ch.person_id, new Set());
    visitorDays.get(ch.person_id).add(dayOf(ch.occurred_at));
    if (!sourceByPid.has(ch.person_id)) sourceByPid.set(ch.person_id, new Set());
    sourceByPid.get(ch.person_id).add(ch.source);
    const hk = dayOf(ch.occurred_at) + ' ' + ch.occurred_at.slice(11, 13) + ':00';
    hourly[hk] = (hourly[hk] || 0) + 1;
  }
  let walkinVisitors = 0;
  for (const [pid, cid] of visitorCampaign) {
    const k = getC(cid);
    if (k) k.visitors++; else walkinVisitors++;
  }
  // confirmed registrants who hit the gate, were denied/pending and never got a verified admission
  let gateFailures = 0;
  for (const pid of failedPids) {
    if (verifiedPids.has(pid)) continue;
    if (regStatusByPid.get(pid) === 'confirmed') {
      gateFailures++;
      const reg = regsAsOf.find((r) => r.person_id === pid);
      const k = reg && getC(reg.campaign_id); if (k) k.gate_failures++;
    }
  }
  const manualOnly = [...sourceByPid.values()].filter((s) => s.size === 1 && s.has('manual')).length;
  const visitsByDay = {};
  for (const days of visitorDays.values()) for (const dd of days) visitsByDay[dd] = (visitsByDay[dd] || 0) + 1;
  const bothDays = [...visitorDays.values()].filter((s) => s.size >= 2).length;

  // ---------------------------------------------------------------- totals
  const list = [...camp.values()];
  const sum = (f) => list.reduce((a, k) => a + (typeof f === 'function' ? f(k) : k[f]), 0);
  const totals = {
    spend: sum('spend'), impressions: sum('impressions'), clicks: sum('clicks'), reported_reach_summed: sum('reported_reach'),
    landing_page_sessions: sum('landing_page_sessions'), registration_starts_anon: sum('registration_starts_anon'),
    identified_people: identified, identified_people_campaign: sum('identified_people'), identified_walkins: walkinPeople,
    registrations: regsAsOf.length,
    confirmed: regsAsOf.filter((r) => r.status === 'confirmed').length,
    cancelled: regsAsOf.filter((r) => r.status === 'cancelled').length,
    waitlisted: regsAsOf.filter((r) => r.status === 'waitlisted').length,
    interested: regsAsOf.filter((r) => r.status === 'interested').length,
    visitors: verifiedPids.size, visitors_registered: verifiedPids.size - walkinVisitors, visitors_walkin: walkinVisitors,
    abandoned_starts: abandoned, opted_out_people: optOut.size, gate_failures: gateFailures,
  };
  const targets = targetsAsOf(cutoff);
  const budget = targets ? targets.marketing_budget_inr : null;

  // ---------------------------------------------------------------- per-campaign derived metrics + decision
  const portfolioCostPerVisitor = div(totals.spend, totals.visitors_registered);
  const portfolioCostPerConfirmed = div(totals.spend, totals.confirmed);
  const campaigns = list.map((k) => {
    const confirmed = k.status.confirmed || 0;
    const m = {
      ...k,
      confirmed,
      cancelled: k.status.cancelled || 0,
      waitlisted: k.status.waitlisted || 0,
      ctr: r3(div(k.clicks, k.impressions)),
      ctr_last14: r3(div(k.clicks_last14, k.impr_last14)),
      ctr_prev14: r3(div(k.clicks_prev14, k.impr_prev14)),
      reg_rate: r3(div(k.registrations, k.identified_people)),
      confirm_rate: r3(div(confirmed, k.registrations)),
      cancel_rate: r3(div(k.status.cancelled || 0, k.registrations)),
      show_rate: eventStarted ? r3(div(k.visitors, confirmed)) : null,
      reg_to_visit: eventStarted ? r3(div(k.visitors, k.registrations)) : null,
      opt_out_rate: r3(div(k.opted_out_people, k.identified_people)),
      cost_per_person: r1(div(k.spend, k.identified_people)),
      cost_per_registration: r1(div(k.spend, k.registrations)),
      cost_per_confirmed: r1(div(k.spend, confirmed)),
      cost_per_visitor: eventStarted ? r1(div(k.spend, k.visitors)) : null,
      spend_share: r3(div(k.spend, totals.spend)),
      visitor_share: eventStarted ? r3(div(k.visitors, totals.visitors_registered)) : null,
      ops: store.ops.campaigns[k.campaign_id] || { status: 'active' },
      owner_name: (c.campaigns.find((x) => x.campaign_id === k.campaign_id) || {}).owner_name || null,
      owner_id: (c.campaigns.find((x) => x.campaign_id === k.campaign_id) || {}).owner_id || null,
      channel: (c.campaigns.find((x) => x.campaign_id === k.campaign_id) || {}).channel || null,
    };
    m.decision = decide(m, { eventStarted, portfolioCostPerVisitor, portfolioCostPerConfirmed, settings });
    return m;
  });

  // ---------------------------------------------------------------- funnel
  const funnel = {
    anonymous: [
      { stage: 'Impressions', value: totals.impressions },
      { stage: 'Clicks', value: totals.clicks },
      { stage: 'Landing-page sessions', value: totals.landing_page_sessions },
      { stage: 'Form starts (anonymous events)', value: totals.registration_starts_anon },
    ],
    identified: [
      { stage: 'Identified external people (campaign-sourced)', value: totals.identified_people_campaign },
      { stage: 'Registered', value: totals.registrations },
      { stage: 'Confirmed (current status)', value: totals.confirmed },
      { stage: 'Verified visitors (registered)', value: totals.visitors_registered },
    ],
    walkin_visitors: totals.visitors_walkin,
    note: 'Anonymous counts are platform events, not unique people. The identified funnel uses distinct person_ids.',
  };

  // ---------------------------------------------------------------- weekly series
  const weeks = new Map();
  const wk = (d) => { const w = weekStart(d); if (!weeks.has(w)) weeks.set(w, { week: w, registrations: 0, spend: 0, people: 0, cancellations: 0, by_campaign: {} }); return weeks.get(w); };
  for (const r of regsAsOf) { const w = wk(r.registered_at); w.registrations++; w.by_campaign[r.campaign_id] = (w.by_campaign[r.campaign_id] || 0) + 1; }
  for (const [day, s] of dailyByDay) wk(day).spend += s;
  for (const p of c.people) { if (p.person_type === 'external' && p.first_seen_at && p.first_seen_at <= cutoff && p.first_campaign_id) wk(p.first_seen_at).people++; }
  const weekly = [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  let cum = 0; let cumSpend = 0;
  const start = dayOf(c.event.history_start) || '2025-01-15';
  const totalDays = Math.max(1, daysBetween(start, eventStart));
  for (const w of weekly) {
    cum += w.registrations; cumSpend += w.spend;
    w.cumulative_registrations = cum; w.cumulative_spend = cumSpend;
    const weekEnd = addDays(w.week, 6) < asOf ? addDays(w.week, 6) : asOf;
    const t = targetsAsOf(weekEnd + 'T23:59:59');
    const elapsed = Math.min(1, Math.max(0, daysBetween(start, weekEnd) / totalDays));
    w.registration_goal_pace = t ? Math.round(t.registration_goal * elapsed) : null;
  }

  // ---------------------------------------------------------------- projection (pre-event) / outcome (post-event)
  const regsLast14 = regsAsOf.filter((r) => r.registered_at.slice(0, 10) >= last14From).length;
  const spendLast14 = sum('spend_last14');
  const daysLeft = Math.max(0, daysBetween(asOf, eventStart));
  const confirmRate = div(totals.confirmed, totals.registrations) || 0;
  const projection = eventStarted ? {
    mode: 'actual',
    registrations: totals.registrations, visitors: totals.visitors, spend: totals.spend,
    note: 'Event has started by this snapshot; figures are actuals, not projections.',
  } : {
    mode: 'projected',
    days_to_event: daysLeft,
    registration_run_rate_per_day: r1(regsLast14 / 14),
    projected_registrations: Math.round(totals.registrations + (regsLast14 / 14) * daysLeft),
    projected_confirmed: Math.round((totals.registrations + (regsLast14 / 14) * daysLeft) * confirmRate),
    projected_visitors: Math.round((totals.registrations + (regsLast14 / 14) * daysLeft) * confirmRate * settings.assumed_show_rate + settings.assumed_walkins),
    projected_spend: Math.round(totals.spend + (spendLast14 / 14) * daysLeft),
    assumptions: {
      run_rate: 'Trailing 14-day registration pace continues unchanged until the event (evidence-based).',
      confirm_rate: `Current confirmed/registered ratio ${r3(confirmRate)} holds (evidence-based).`,
      show_rate: `${settings.assumed_show_rate} of confirmed people attend (ASSUMPTION - editable in Settings).`,
      walkins: `${settings.assumed_walkins} unregistered walk-ins (ASSUMPTION - editable in Settings).`,
    },
  };

  const goalFor = (g) => (targets ? targets[g] : null);
  const kpis = {
    identified_people: { value: totals.identified_people, goal: goalFor('identified_external_people_goal') },
    registrations: { value: totals.registrations, goal: goalFor('registration_goal') },
    visitors: { value: totals.visitors, goal: goalFor('unique_external_visitors_goal'), projected: projection.projected_visitors || null },
    spend: { value: totals.spend, goal: budget },
  };
  for (const k of Object.values(kpis)) k.attainment = r3(div(k.value, k.goal));

  const snap = {
    as_of: asOf, cutoff, event_started: eventStarted,
    trend_window: { last14: [last14From, trendAnchor], prev14: [prev14From, prev14To] }, event: c.event, targets,
    target_version: targets ? targets.target_version : null,
    kpis, totals, campaigns, funnel, weekly, projection,
    rates: {
      ctr: r3(div(totals.clicks, totals.impressions)),
      reg_rate: r3(div(totals.registrations, totals.identified_people_campaign)),
      confirm_rate: r3(confirmRate),
      show_rate: eventStarted ? r3(div(totals.visitors_registered, totals.confirmed)) : null,
      cost_per_registration: r1(div(totals.spend, totals.registrations)),
      cost_per_visitor: eventStarted ? r1(div(totals.spend, totals.visitors)) : null,
      cost_per_registered_visitor: eventStarted ? r1(portfolioCostPerVisitor) : null,
    },
    event_ops: {
      verified_admission_events: admitEvents, unique_visitors_by_day: visitsByDay, visitors_both_days: bothDays,
      denied_events: nonVerified.denied || 0, pending_events: nonVerified.pending || 0, gate_failures_confirmed: gateFailures,
      manual_only_visitors: manualOnly, admissions_by_hour: hourly,
    },
    engagement: { interaction_counts: interactionCounts, brochure_people: brochure.size, question_people: question.size },
    data_quality: {
      duplicate_rows_removed: c.dq,
      invalid_date_rows_skipped: c.invalid,
      excluded_people_by_type: excluded,
      internal_registrations_excluded: internalRegs,
      non_external_verified_admissions_excluded: nonExternalAdmits.size,
      reported_reach_warning: 'Summed daily reach is not unique people (no cross-day identity).',
    },
  };
  snap.diagnosis = diagnose(snap);
  snapCache.set(key, snap);
  return snap;
}

// ------------------------------------------------------------------ decision rule per campaign
function decide(m, { eventStarted, portfolioCostPerVisitor, portfolioCostPerConfirmed, settings }) {
  const reasons = [];
  const metric = eventStarted ? 'cost_per_visitor' : 'cost_per_confirmed';
  const value = eventStarted ? m.cost_per_visitor : m.cost_per_confirmed;
  const base = eventStarted ? portfolioCostPerVisitor : portfolioCostPerConfirmed;
  if (!m.spend || value === null || !base) {
    return { action: 'Watch', ratio: null, metric, reasons: ['Not enough spend or outcomes to judge efficiency yet.'] };
  }
  const ratio = value / base;
  let action = ratio <= settings.scale_ratio ? 'Scale' : ratio <= settings.fix_ratio ? 'Hold' : ratio <= settings.stop_ratio ? 'Fix' : 'Cut';
  reasons.push(`${metric.replace(/_/g, ' ')} ₹${Math.round(value)} is ${ratio.toFixed(2)}x the portfolio average (₹${Math.round(base)}).`);
  if (m.ctr_last14 !== null && m.ctr_prev14 && m.ctr_last14 < m.ctr_prev14 * (1 - settings.fatigue_drop)) {
    reasons.push(`CTR fell from ${(m.ctr_prev14 * 100).toFixed(1)}% to ${(m.ctr_last14 * 100).toFixed(1)}% over the last 14 days (creative fatigue).`);
    if (action === 'Scale' || action === 'Hold') action = 'Fix';
  }
  if (m.regs_prev14 >= 20 && m.regs_last14 < m.regs_prev14 * 0.5 && m.spend_last14 > 0) {
    reasons.push(`Registrations dropped from ${m.regs_prev14} to ${m.regs_last14} in the last 14 days while ₹${Math.round(m.spend_last14)} was still spent.`);
    if (action === 'Scale') action = 'Hold';
  }
  if (eventStarted && m.show_rate !== null && m.show_rate < 0.7) reasons.push(`Only ${(m.show_rate * 100).toFixed(0)}% of confirmed registrants showed up.`);
  if (m.opt_out_rate !== null && m.opt_out_rate > 0.08) reasons.push(`${(m.opt_out_rate * 100).toFixed(0)}% of identified people opted out.`);
  return { action, ratio: r3(ratio), metric, reasons };
}

// ------------------------------------------------------------------ diagnosis
function diagnose(s) {
  const out = [];
  const pct = (x) => (x === null ? 'n/a' : (x * 100).toFixed(1) + '%');
  const inr = (x) => '₹' + Math.round(x).toLocaleString('en-IN');
  const C = s.campaigns.filter((k) => k.spend > 0 || k.registrations > 0);
  const add = (o) => out.push({ id: 'D' + (out.length + 1), ...o });

  // 1. target gaps
  for (const [k, label] of [['registrations', 'Registrations'], ['visitors', 'Verified visitors'], ['identified_people', 'Identified people']]) {
    const v = s.kpis[k];
    if (!v.goal) continue;
    if (s.event_started || k !== 'visitors') {
      const gap = v.goal - v.value;
      if (gap > 0) add({ severity: v.attainment < 0.9 ? 'high' : 'medium', area: 'Targets', title: `${label} ${v.value.toLocaleString('en-IN')} vs goal ${v.goal.toLocaleString('en-IN')} (${pct(v.attainment)})`,
        evidence: [`Target version: ${s.target_version}`, `Gap: ${gap.toLocaleString('en-IN')}`], recommendation: k === 'visitors' ? 'Most of the gap is confirmed people who did not show up - see show-rate findings.' : 'Shift budget to the channels with the lowest cost per outcome.' });
    }
  }
  if (!s.event_started && s.projection.projected_visitors && s.kpis.visitors.goal) {
    const p = s.projection;
    add({ severity: p.projected_visitors < s.kpis.visitors.goal ? 'high' : 'low', area: 'Projection',
      title: `Projected visitors ${p.projected_visitors.toLocaleString('en-IN')} vs goal ${s.kpis.visitors.goal.toLocaleString('en-IN')}`,
      evidence: [`Run-rate ${p.registration_run_rate_per_day}/day for ${p.days_to_event} days`, p.assumptions.show_rate],
      recommendation: p.projected_visitors < s.kpis.visitors.goal ? 'Pull forward reminders and group registrations; do not rely on paid reach in the last 2 weeks.' : 'On track - protect show-rate.' });
  }

  // 2. biggest stage loss in the identified funnel
  const stages = [
    ['identified → registered', s.totals.identified_people_campaign, s.totals.registrations],
    ['registered → confirmed', s.totals.registrations, s.totals.confirmed],
  ];
  if (s.event_started) stages.push(['confirmed → visited', s.totals.confirmed, s.totals.visitors_registered]);
  const losses = stages.map(([n, a, b]) => ({ n, lost: a - b, rate: div(b, a) })).sort((x, y) => y.lost - x.lost);
  if (losses[0] && losses[0].lost > 0) {
    add({ severity: 'high', area: 'Bottleneck', title: `Biggest leak: ${losses[0].n} (${losses[0].lost.toLocaleString('en-IN')} people lost, ${pct(losses[0].rate)} conversion)`,
      evidence: losses.map((l) => `${l.n}: ${pct(l.rate)} (${l.lost} lost)`),
      recommendation: losses[0].n === 'confirmed → visited' ? 'Run the show-up engine: reminders at T-7/T-2/T-0, QR pass in WhatsApp, waitlist release.' : 'Simplify the registration form and follow up on abandoned starts within 24h.',
      suggested_task: { title: losses[0].n === 'confirmed → visited' ? 'Launch T-7/T-2/T-0 reminder sequence for confirmed registrants' : 'Follow up with abandoned registration starts', campaign_id: null, priority: 'high' } });
  }

  // 3. weak stage per campaign vs portfolio
  for (const k of C) {
    if (s.event_started && k.show_rate !== null && s.rates.show_rate && k.show_rate < s.rates.show_rate - 0.1 && k.confirmed >= 50) {
      add({ severity: 'high', area: 'Campaign', campaign_id: k.campaign_id, title: `${k.campaign_name}: show-rate ${pct(k.show_rate)} vs portfolio ${pct(s.rates.show_rate)}`,
        evidence: [`${k.confirmed} confirmed → ${k.visitors} verified visitors`, `Cost per visitor ${inr(k.cost_per_visitor || 0)}`],
        recommendation: 'Audience is curious, not committed. Add a commitment step (group pass, programme pick) before confirmation.',
        suggested_task: { title: `Add a commitment step for ${k.campaign_name} registrants`, campaign_id: k.campaign_id, priority: 'medium' } });
    }
    if (k.reg_rate !== null && s.rates.reg_rate && k.reg_rate < s.rates.reg_rate - 0.07 && k.identified_people >= 100) {
      add({ severity: 'medium', area: 'Campaign', campaign_id: k.campaign_id, title: `${k.campaign_name}: only ${pct(k.reg_rate)} of identified people register (portfolio ${pct(s.rates.reg_rate)})`,
        evidence: [`${k.identified_people} identified → ${k.registrations} registered`, `${k.abandoned_starts} started the form and stopped`],
        recommendation: 'Retarget form abandoners with a one-tap WhatsApp registration link.',
        suggested_task: { title: `Recover ${k.abandoned_starts} abandoned starts from ${k.campaign_name}`, campaign_id: k.campaign_id, priority: 'medium' } });
    }
  }

  // 4. creative fatigue + spending into decline
  for (const k of C) {
    if (k.ctr_last14 !== null && k.ctr_prev14 && k.ctr_last14 < k.ctr_prev14 * (1 - store.ops.settings.fatigue_drop) && k.impr_last14 > 1000) {
      add({ severity: 'high', area: 'Creative', campaign_id: k.campaign_id, title: `${k.campaign_name}: CTR down ${pct(1 - k.ctr_last14 / k.ctr_prev14)} in 14 days`,
        evidence: [`CTR prior 14d ${pct(k.ctr_prev14)} → last 14d ${pct(k.ctr_last14)}`, `Spend last 14d ${inr(k.spend_last14)}`],
        recommendation: 'Rotate creatives now; if CTR does not recover within 5 days, pause and move budget.',
        suggested_task: { title: `Rotate ${k.campaign_name} creatives and re-check CTR in 5 days`, campaign_id: k.campaign_id, priority: 'high' } });
    }
    if (k.regs_prev14 >= 20 && k.regs_last14 < k.regs_prev14 * 0.5 && k.spend_last14 > 0) {
      add({ severity: 'high', area: 'Spend', campaign_id: k.campaign_id, title: `${k.campaign_name}: registrations halved while spend continued`,
        evidence: [`Registrations prior 14d ${k.regs_prev14} → last 14d ${k.regs_last14}`, `Spend last 14d ${inr(k.spend_last14)}`],
        recommendation: 'Freeze new spend until the cause is found (creative, audience saturation or tracking).',
        suggested_task: { title: `Freeze ${k.campaign_name} spend pending review`, campaign_id: k.campaign_id, priority: 'high' } });
    }
  }

  // 5. cost outliers / winners
  const sorted = C.filter((k) => k.decision && k.decision.ratio !== null).sort((a, b) => a.decision.ratio - b.decision.ratio);
  if (sorted.length >= 2) {
    const best = sorted[0]; const worst = sorted[sorted.length - 1];
    const metric = s.event_started ? 'cost_per_visitor' : 'cost_per_confirmed';
    add({ severity: 'medium', area: 'Allocation', campaign_id: worst.campaign_id,
      title: `${worst.campaign_name} costs ${(worst[metric] / best[metric]).toFixed(1)}x more per ${s.event_started ? 'visitor' : 'confirmed registrant'} than ${best.campaign_name}`,
      evidence: sorted.map((k) => `${k.campaign_name}: ${inr(k[metric] || 0)} (${pct(k.spend_share)} of spend)`),
      recommendation: `Move budget from ${worst.campaign_name} to ${best.campaign_name} in steps; use the simulator to size the shift.`,
      suggested_task: { title: `Reallocate budget from ${worst.campaign_name} to ${best.campaign_name}`, campaign_id: worst.campaign_id, priority: 'high' } });
  }

  // 6. opt-outs
  for (const k of C) if (k.opt_out_rate !== null && k.opt_out_rate > 0.08 && k.identified_people >= 100) {
    add({ severity: 'medium', area: 'Audience', campaign_id: k.campaign_id, title: `${k.campaign_name}: ${pct(k.opt_out_rate)} of identified people opted out`,
      evidence: [`${k.opted_out_people} of ${k.identified_people} people`], recommendation: 'Cut nurture frequency for this audience and tighten targeting.' });
  }

  // 7. execution leaks
  if (s.totals.abandoned_starts > 0) add({ severity: 'medium', area: 'Recovery', title: `${s.totals.abandoned_starts} identified people started registration but never finished`,
    evidence: ['Identified registration_start interaction with no registration as of this date'], recommendation: 'One WhatsApp nudge with a prefilled link within 24h; second nudge after 3 days.',
    suggested_task: { title: 'Send prefilled registration link to abandoned starts', campaign_id: null, priority: 'medium' } });
  if (s.totals.waitlisted > 0) add({ severity: s.totals.waitlisted > 50 ? 'high' : 'medium', area: 'Capacity', title: `${s.totals.waitlisted} registrations stuck on the waitlist`,
    evidence: [`${s.totals.cancelled} cancellations freed seats in the same period`], recommendation: 'Auto-release a waitlist seat for every cancellation, 48h before the event at the latest.',
    suggested_task: { title: 'Release waitlist seats against cancellations', campaign_id: null, priority: 'high' } });
  if (s.event_started && s.totals.gate_failures > 0) add({ severity: 'medium', area: 'Event ops', title: `${s.totals.gate_failures} confirmed registrants were denied or stuck pending at the gate`,
    evidence: [`Denied events ${s.event_ops.denied_events}, pending events ${s.event_ops.pending_events}`, `${s.event_ops.manual_only_visitors} visitors were only ever checked in manually`],
    recommendation: 'Pre-send QR passes and add a help desk at the gate for ID mismatches.' });

  // 8. budget pacing
  if (s.kpis.spend.goal) {
    const used = s.kpis.spend.attainment;
    add({ severity: used > 1 ? 'high' : 'low', area: 'Budget', title: `Spend ${inr(s.kpis.spend.value)} of ${inr(s.kpis.spend.goal)} budget (${pct(used)})`,
      evidence: s.projection.projected_spend ? [`Projected spend at event: ${inr(s.projection.projected_spend)}`] : [`Unspent: ${inr(s.kpis.spend.goal - s.kpis.spend.value)}`],
      recommendation: used > 1 ? 'Over budget - stop the highest cost-per-outcome campaign first.' : 'Headroom exists; deploy it only into Scale-rated campaigns.' });
  }

  // 9. overdue tasks
  const overdue = store.ops.tasks.filter((t) => t.status !== 'done' && t.due && t.due < s.as_of);
  if (overdue.length) add({ severity: 'medium', area: 'Execution', title: `${overdue.length} open task(s) past their deadline`,
    evidence: overdue.slice(0, 5).map((t) => `${t.id} ${t.title} (due ${t.due}, ${t.owner_name || 'unassigned'})`), recommendation: 'Re-assign or re-date in the Execution board.' });

  const rank = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

// ------------------------------------------------------------------ metric catalog (initiatives + copilot)
const METRICS = {
  show_rate: 'Share of confirmed registrants with a verified admission (post-event only)',
  reg_rate: 'Registrations / identified people',
  confirm_rate: 'Confirmed / registrations',
  cost_per_visitor: 'Spend / verified visitors (post-event only)',
  cost_per_registration: 'Spend / registrations',
  cost_per_confirmed: 'Spend / confirmed registrations',
  ctr_last14: 'Clicks / impressions over the last 14 days',
  registrations_last14: 'Registrations in the last 14 days',
  abandoned_starts: 'Identified people who started the form but have no registration',
  waitlist_backlog: 'Registrations whose current status is waitlisted',
  gate_failures: 'Confirmed registrants denied/pending at the gate with no verified admission',
  opt_out_rate: 'Opted-out people / identified people',
  cancel_rate: 'Cancelled / registrations',
};

function metricValue(snap, key, campaignId) {
  if (campaignId) {
    const k = snap.campaigns.find((x) => x.campaign_id === campaignId);
    if (!k) return null;
    const map = { registrations_last14: k.regs_last14, waitlist_backlog: k.waitlisted, gate_failures: k.gate_failures, abandoned_starts: k.abandoned_starts };
    return key in map ? map[key] : (k[key] ?? null);
  }
  const t = snap.totals;
  const map = {
    show_rate: snap.rates.show_rate, reg_rate: snap.rates.reg_rate, confirm_rate: snap.rates.confirm_rate,
    cost_per_visitor: snap.rates.cost_per_visitor, cost_per_registration: snap.rates.cost_per_registration,
    cost_per_confirmed: r1(div(t.spend, t.confirmed)), ctr_last14: r3(div(snap.campaigns.reduce((a, k) => a + k.clicks_last14, 0), snap.campaigns.reduce((a, k) => a + k.impr_last14, 0))),
    registrations_last14: snap.campaigns.reduce((a, k) => a + k.regs_last14, 0), abandoned_starts: t.abandoned_starts,
    waitlist_backlog: t.waitlisted, gate_failures: t.gate_failures, opt_out_rate: r3(div(t.opted_out_people, t.identified_people)),
    cancel_rate: r3(div(t.cancelled, t.registrations)),
  };
  return map[key] ?? null;
}

function evaluateInitiatives(snap) {
  return store.ops.initiatives.map((i) => {
    const value = metricValue(snap, i.metric.key, i.metric.campaign_id);
    let verdict = 'No data';
    if (value !== null && value !== undefined) {
      if (i.direction === 'higher') verdict = value >= i.scale_at ? 'Scale' : value < i.stop_at ? 'Stop / rethink' : 'Change';
      else verdict = value <= i.scale_at ? 'Scale' : value > i.stop_at ? 'Stop / rethink' : 'Change';
    }
    return { ...i, owner_name: store.ops.owners[i.owner_id] || i.owner_id, current_value: value, verdict, metric_label: METRICS[i.metric.key] || i.metric.key };
  });
}

// ------------------------------------------------------------------ budget simulator
// Outcome(s) = outcome_now * (s / s_now)^e. e<1 encodes diminishing returns (assumption, default 0.8).
function simulateShift(asOf, fromId, toId, amount, elasticity = 0.8) {
  const snap = snapshot(asOf);
  const f = snap.campaigns.find((k) => k.campaign_id === fromId);
  const t = snap.campaigns.find((k) => k.campaign_id === toId);
  if (!f || !t) return { error: 'Unknown campaign id. Use ids like C01..C07.' };
  amount = Number(amount);
  if (!(amount > 0)) return { error: 'Amount must be a positive number of rupees.' };
  if (amount > f.spend) return { error: `Cannot move ₹${amount}: ${f.campaign_name} has only spent ₹${f.spend} so far.` };
  const outcomeKey = snap.event_started ? 'visitors' : 'confirmed';
  const proj = (k, newSpend) => (k.spend > 0 ? k[outcomeKey] * Math.pow(newSpend / k.spend, elasticity) : 0);
  const fromAfter = proj(f, f.spend - amount); const toAfter = proj(t, t.spend + amount);
  const delta = (fromAfter - f[outcomeKey]) + (toAfter - t[outcomeKey]);
  return {
    as_of: snap.as_of, outcome: outcomeKey, amount_inr: amount, elasticity,
    from: { campaign: f.campaign_name, spend_before: f.spend, outcome_before: f[outcomeKey], outcome_after: Math.round(fromAfter) },
    to: { campaign: t.campaign_name, spend_before: t.spend, outcome_before: t[outcomeKey], outcome_after: Math.round(toAfter) },
    net_change: Math.round(delta),
    caveat: 'Model assumes past cost-efficiency holds and returns diminish with elasticity ' + elasticity + ' (an assumption, not observed). Treat as a sizing aid; validate with a 1-week test.',
  };
}

// ------------------------------------------------------------------ generic query layer (for copilot)
const VIEWS = {
  people: { time: 'first_seen_at', fields: ['person_id', 'person_name', 'person_type', 'first_seen_at', 'first_seen_date', 'first_touch_source', 'first_campaign_id', 'first_campaign_name', 'registered', 'current_status', 'visited'] },
  registrations: { time: 'registered_at', fields: ['registration_id', 'person_id', 'person_name', 'person_type', 'campaign_id', 'campaign_name', 'registered_at', 'registered_date', 'registered_week', 'current_status', 'visited', 'status_path', 'times_cancelled', 'was_reconfirmed', 'ever_waitlisted'] },
  interactions: { time: 'occurred_at', fields: ['interaction_id', 'person_id', 'person_type', 'campaign_id', 'campaign_name', 'event_type', 'occurred_at', 'occurred_date', 'occurred_week'] },
  checkins: { time: 'occurred_at', fields: ['event_id', 'person_id', 'person_type', 'registration_id', 'campaign_id', 'campaign_name', 'result', 'verification', 'source', 'occurred_at', 'occurred_date', 'occurred_hour', 'is_verified_admission'] },
  daily_marketing: { time: 'activity_date', fields: ['activity_id', 'campaign_id', 'campaign_name', 'activity_date', 'activity_week', 'impressions', 'clicks', 'reported_reach', 'landing_page_sessions', 'registration_starts', 'marketing_spend_inr', 'platform'] },
  registration_history: { time: 'effective_at', fields: ['history_id', 'registration_id', 'person_id', 'campaign_id', 'campaign_name', 'status', 'effective_at', 'effective_date'] },
};

function viewRows(name, asOf) {
  const c = clean();
  const snap = snapshot(asOf);
  const cutoff = snap.cutoff;
  const regStatus = new Map(); const regPid = new Set();
  for (const r of c.registrations) if (r.registered_at <= cutoff) { regPid.add(r.person_id); regStatus.set(r.person_id, statusAsOf(r.registration_id, cutoff)); }
  const visited = new Set();
  for (const ch of c.checkins) if (ch.occurred_at <= cutoff && ch.result === 'admitted' && ch.verification === 'verified') visited.add(ch.person_id);
  const cn = (id) => c.campaignName.get(id) || null;
  switch (name) {
    case 'people': return c.people.filter((p) => p.first_seen_at <= cutoff).map((p) => ({ ...p, first_seen_date: dayOf(p.first_seen_at), registered: regPid.has(p.person_id), current_status: regStatus.get(p.person_id) || null, visited: visited.has(p.person_id) }));
    case 'registrations': return c.registrations.filter((r) => r.registered_at <= cutoff).map((r) => {
      // status transitions up to the snapshot, e.g. "interested>confirmed>cancelled>confirmed"
      const path = (c.histByReg.get(r.registration_id) || []).filter((h) => h.effective_at <= cutoff).map((h) => h.status);
      const ci = path.indexOf('cancelled');
      return { ...r, person_type: c.personType.get(r.person_id), registered_date: dayOf(r.registered_at), registered_week: weekStart(r.registered_at),
        current_status: statusAsOf(r.registration_id, cutoff), visited: visited.has(r.person_id), status_path: path.join('>'),
        times_cancelled: path.filter((x) => x === 'cancelled').length, was_reconfirmed: ci >= 0 && path.slice(ci + 1).includes('confirmed'),
        ever_waitlisted: path.includes('waitlisted') };
    });
    case 'interactions': return c.interactions.filter((i) => i.occurred_at <= cutoff).map((i) => ({ ...i, person_type: c.personType.get(i.person_id), occurred_date: dayOf(i.occurred_at), occurred_week: weekStart(i.occurred_at) }));
    case 'checkins': return c.checkins.filter((x) => x.occurred_at <= cutoff).map((x) => { const reg = x.registration_id ? c.regById.get(x.registration_id) : null; const cid = reg ? reg.campaign_id : null; return { ...x, campaign_id: cid, campaign_name: cn(cid), person_type: c.personType.get(x.person_id), occurred_date: dayOf(x.occurred_at), occurred_hour: Number(x.occurred_at.slice(11, 13)), is_verified_admission: x.result === 'admitted' && x.verification === 'verified' }; });
    case 'daily_marketing': return c.daily.filter((d) => d.activity_date <= snap.as_of).map((d) => ({ ...d, activity_week: weekStart(d.activity_date) }));
    case 'registration_history': return c.regHistory.filter((h) => h.effective_at <= cutoff).map((h) => ({ ...h, effective_date: dayOf(h.effective_at) }));
    default: return null;
  }
}

function query({ table, filters = [], group_by, measure = 'count', field, as_of, limit = 40, sort = 'desc' }) {
  if (!VIEWS[table]) return { error: `Unknown table '${table}'. Available: ${Object.keys(VIEWS).join(', ')}` };
  const v = VIEWS[table];
  const groups = (Array.isArray(group_by) ? group_by : group_by ? [group_by] : []).slice(0, 2);
  for (const f of [...groups, ...(field ? [field] : []), ...filters.map((x) => x.field)]) {
    if (!v.fields.includes(f)) return { error: `Field '${f}' does not exist in ${table}. Fields: ${v.fields.join(', ')}` };
  }
  if (['sum', 'avg', 'min', 'max', 'count_distinct'].includes(measure) && !field) return { error: `measure '${measure}' needs a field` };
  let rows = viewRows(table, as_of);
  const test = (val, op, x) => {
    switch (op) {
      case 'eq': return String(val) === String(x);
      case 'ne': return String(val) !== String(x);
      case 'in': return (Array.isArray(x) ? x : String(x).split(',')).map(String).includes(String(val));
      case 'gt': return val > x; case 'gte': return val >= x; case 'lt': return val < x; case 'lte': return val <= x;
      case 'contains': return String(val || '').toLowerCase().includes(String(x).toLowerCase());
      case 'is_null': return val === null || val === undefined;
      case 'not_null': return !(val === null || val === undefined);
      default: return true;
    }
  };
  for (const f of filters) rows = rows.filter((r) => test(r[f.field], f.op || 'eq', f.value));
  const agg = (rs) => {
    if (measure === 'count') return rs.length;
    if (measure === 'count_distinct') return new Set(rs.map((r) => r[field])).size;
    const nums = rs.map((r) => Number(r[field])).filter((n) => isFinite(n));
    if (!nums.length) return null;
    if (measure === 'sum') return nums.reduce((a, b) => a + b, 0);
    if (measure === 'avg') return r3(nums.reduce((a, b) => a + b, 0) / nums.length);
    if (measure === 'min') return Math.min(...nums);
    if (measure === 'max') return Math.max(...nums);
    return null;
  };
  const note = 'Raw view: deduplicated by stable id, NOT filtered by person_type unless you add a filter (use person_type eq external for target metrics).';
  if (!groups.length) return { table, as_of: snapshot(as_of).as_of, filters, measure, field: field || null, value: agg(rows), rows_matched: rows.length, note };
  const map = new Map();
  for (const r of rows) { const k = groups.map((g) => r[g]).join(' | '); if (!map.has(k)) map.set(k, []); map.get(k).push(r); }
  let result = [...map.entries()].map(([k, rs]) => ({ group: k, value: agg(rs), rows: rs.length }));
  result.sort((a, b) => (sort === 'asc' ? 1 : -1) * ((a.value ?? -Infinity) - (b.value ?? -Infinity)) || (a.group < b.group ? -1 : 1));
  const truncated = result.length > limit;
  return { table, as_of: snapshot(as_of).as_of, group_by: groups, filters, measure, field: field || null, groups: result.slice(0, limit), total_groups: result.length, truncated, rows_matched: rows.length, note };
}

function timeSeries({ metric, campaign_id, granularity = 'week', from, to, as_of }) {
  const snap = snapshot(as_of);
  const c = clean();
  const end = to && to < snap.as_of ? to : snap.as_of;
  const start = from || dataRange().min;
  const bucket = (d) => (granularity === 'day' ? d.slice(0, 10) : weekStart(d));
  const m = new Map();
  const add = (d, k, v) => { if (!d) return; const day = d.slice(0, 10); if (day < start || day > end) return; const b = bucket(day); if (!m.has(b)) m.set(b, {}); const o = m.get(b); o[k] = (o[k] || 0) + v; };
  const ext = (pid) => c.personType.get(pid) === 'external';
  const okC = (cid) => !campaign_id || cid === campaign_id;
  const dailyMetrics = ['spend', 'impressions', 'clicks', 'landing_page_sessions', 'registration_starts', 'reported_reach', 'ctr'];
  if (dailyMetrics.includes(metric)) {
    for (const d of c.daily) if (okC(d.campaign_id)) {
      add(d.activity_date, 'spend', Number(d.marketing_spend_inr) || 0); add(d.activity_date, 'impressions', Number(d.impressions) || 0);
      add(d.activity_date, 'clicks', Number(d.clicks) || 0); add(d.activity_date, 'landing_page_sessions', Number(d.landing_page_sessions) || 0);
      add(d.activity_date, 'registration_starts', Number(d.registration_starts) || 0); add(d.activity_date, 'reported_reach', Number(d.reported_reach) || 0);
    }
  } else if (metric === 'registrations') {
    for (const r of c.registrations) if (ext(r.person_id) && okC(r.campaign_id)) add(r.registered_at, 'registrations', 1);
  } else if (metric === 'identified_people') {
    for (const p of c.people) if (p.person_type === 'external' && okC(p.first_campaign_id)) add(p.first_seen_at, 'identified_people', 1);
  } else if (metric === 'cancellations' || metric === 'confirmations') {
    const want = metric === 'cancellations' ? 'cancelled' : 'confirmed';
    for (const h of c.regHistory) if (h.status === want && ext(h.person_id) && okC(h.campaign_id)) add(h.effective_at, metric, 1);
  } else if (metric === 'opt_outs') {
    for (const i of c.interactions) if (i.event_type === 'opted_out' && ext(i.person_id) && okC(i.campaign_id)) add(i.occurred_at, 'opt_outs', 1);
  } else if (metric === 'verified_admissions') {
    for (const ch of c.checkins) if (ch.result === 'admitted' && ch.verification === 'verified' && ext(ch.person_id)) {
      const reg = ch.registration_id ? c.regById.get(ch.registration_id) : null;
      if (okC(reg ? reg.campaign_id : null)) add(ch.occurred_at, 'verified_admissions', 1);
    }
  } else {
    return { error: `Unknown metric '${metric}'. Use one of: spend, impressions, clicks, ctr, landing_page_sessions, registration_starts, reported_reach, registrations, identified_people, cancellations, confirmations, opt_outs, verified_admissions` };
  }
  const points = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([b, o]) => ({
    period: b, value: metric === 'ctr' ? r3(div(o.clicks || 0, o.impressions || 0)) : (o[metric] || 0),
  }));
  return { metric, campaign_id: campaign_id || 'all', granularity, from: start, to: end, points,
    note: ['impressions', 'clicks', 'reported_reach', 'landing_page_sessions', 'registration_starts'].includes(metric) ? 'Anonymous event counts, not unique people.' : undefined };
}

module.exports = { snapshot, dataRange, evaluateInitiatives, simulateShift, query, timeSeries, metricValue, METRICS, VIEWS, clean, addDays, weekStart };
