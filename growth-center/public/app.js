/* CampusFest Growth Center - frontend (vanilla JS, no build step). */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const state = { asOf: null, meta: null, snap: null, view: 'overview', charts: {}, chat: JSON.parse(localStorage.getItem('gc-chat') || '[]'), busy: false };

// ------------------------------------------------------------------ utils
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-IN'));
const inr = (n) => (n === null || n === undefined ? '—' : (n < 0 ? '−₹' : '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN'));
const pc = (x, d = 1) => (x === null || x === undefined ? '—' : (x * 100).toFixed(d) + '%');
const campName = (id) => (state.meta.campaigns.find((c) => c.campaign_id === id) || {}).campaign_name || (id ? id : 'Portfolio');

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof Blob || body instanceof ArrayBuffer) { opt.body = body; opt.headers['content-type'] = 'application/octet-stream'; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['content-type'] = 'application/json'; }
  const res = await fetch(url, opt);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}
function addDays(d, n) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

// minimal, safe markdown: escape first, then format
function md(src) {
  const lines = esc(src).split('\n');
  const out = []; let i = 0;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>').replace(/_(.+?)_/g, '<i>$1</i>').replace(/`(.+?)`/g, '<code>$1</code>');
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l); i += 2; const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*] /.test(l)) { const items = []; while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, '')); out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); continue; }
    if (/^\s*\d+\. /.test(l)) {
      const items = [];
      while (i < lines.length && (/^\s*\d+\. /.test(lines[i]) || /^\s{2,}[-*] /.test(lines[i]))) {
        if (/^\s{2,}[-*] /.test(lines[i])) { items[items.length - 1] += '<br><small>' + inline(lines[i].replace(/^\s*[-*] /, '')) + '</small>'; i++; }
        else items.push(inline(lines[i++].replace(/^\s*\d+\. /, '')));
      }
      out.push(`<ol>${items.map((x) => `<li>${x}</li>`).join('')}</ol>`); continue;
    }
    if (/^#{1,4} /.test(l)) { out.push(`<p><b>${inline(l.replace(/^#+ /, ''))}</b></p>`); i++; continue; }
    if (l.trim() === '') { i++; continue; }
    out.push(`<p>${inline(l)}</p>`); i++;
  }
  return out.join('');
}

function chart(id, cfg) {
  if (state.charts[id]) state.charts[id].destroy();
  const el = document.getElementById(id);
  if (!el) return;
  state.charts[id] = new Chart(el, cfg);
}
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
Chart.defaults.font.size = 11.5;
Chart.defaults.color = '#5d6a66';
const COLORS = { Scale: '#15803d', Hold: '#1d4f7a', Watch: '#1d4f7a', Fix: '#d97706', Cut: '#b91c1c' };
const SERIES = ['#0f766e', '#d97706', '#6d28d9', '#2563eb', '#be185d', '#65a30d', '#0891b2', '#78716c'];

// ------------------------------------------------------------------ boot
async function boot() {
  state.meta = await api('GET', '/api/meta');
  state.asOf = state.asOf && state.asOf <= state.meta.range.max ? state.asOf : (localStorage.getItem('gc-asof') || state.meta.range.max);
  if (state.asOf < state.meta.range.min || state.asOf > state.meta.range.max) state.asOf = state.meta.range.max;
  const ai = state.meta.ai;
  $('#ai-badge').textContent = ai.provider === 'gemini' ? `AI: Gemini (${ai.model})` : 'AI: offline analyst';
  $('#chat-mode').textContent = ai.provider === 'gemini' ? `Gemini · tool-calling on live data` : 'Offline mode · set GEMINI_API_KEY for full AI';
  const inp = $('#asof'); inp.min = state.meta.range.min; inp.max = state.meta.range.max;
  $('#asof-range').max = dayDiff(state.meta.range.min, state.meta.range.max);
  await refresh();
}

async function refresh() {
  $('#asof').value = state.asOf;
  $('#asof-range').value = dayDiff(state.meta.range.min, state.asOf);
  localStorage.setItem('gc-asof', state.asOf);
  state.snap = await api('GET', `/api/snapshot?asOf=${state.asOf}`);
  state.tasks = await api('GET', '/api/tasks');
  render();
}

function setAsOf(d) {
  if (d < state.meta.range.min) d = state.meta.range.min;
  if (d > state.meta.range.max) d = state.meta.range.max;
  state.asOf = d; refresh().catch((e) => toast(e.message, true));
}

const TITLES = {
  overview: ['Overview', 'Funnel vs targets, where the money goes, and what needs attention'],
  campaigns: ['Campaigns', 'Per-campaign funnel, efficiency and the rule-based scale / hold / fix / cut verdict'],
  decisions: ['Decisions', 'Five strategic bets with live thresholds, budget simulator and decision log'],
  execution: ['Execution', 'Tasks, owners and deadlines. Drag cards between columns'],
  data: ['Data & settings', 'Edit source data, targets and assumptions. Every change recomputes the analytics'],
};
function render() {
  const [t, sub] = TITLES[state.view];
  $('#view-title').textContent = t;
  const s = state.snap;
  $('#view-sub').innerHTML = `${esc(sub)} · <b>${s.event_started ? 'Post-event snapshot' : `${s.projection.days_to_event} days to event`}</b> · targets: ${esc(s.target_version || '—')}`;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${state.view}`).classList.remove('hidden');
  ({ overview: renderOverview, campaigns: renderCampaigns, decisions: renderDecisions, execution: renderExecution, data: renderData })[state.view](s);
}

// ------------------------------------------------------------------ overview
function kpiCard(label, k, money, extra = '') {
  const att = k.attainment;
  return `<div class="card kpi"><div class="label">${label}</div>
    <div class="value">${money ? inr(k.value) : fmt(k.value)}</div>
    <div class="goal">${k.goal !== null && k.goal !== undefined ? `Goal ${money ? inr(k.goal) : fmt(k.goal)} · <b>${pc(att, 0)}</b>` : 'No goal set'}</div>
    <div class="bar ${money && att > 1 ? 'over' : ''}"><i style="width:${Math.min(100, (att || 0) * 100)}%"></i></div>${extra}</div>`;
}

function findingHtml(f, withActions = true) {
  const camp = f.campaign_id ? ` <span class="tag low">${esc(campName(f.campaign_id))}</span>` : '';
  return `<div class="finding ${f.severity}"><div class="row"><div><span class="tag ${f.severity}">${f.severity}</span> <small>${esc(f.area)}</small>${camp}
    <div class="t">${esc(f.title)}</div></div>
    ${withActions ? `<div style="display:flex;gap:4px;flex-shrink:0">
      ${f.suggested_task ? `<button class="small" data-task-from="${esc(f.id)}">+ Task</button>` : ''}
      <button class="small ghost" data-ask="${esc(`Explain this finding and what we should do: ${f.title}`)}">Ask</button></div>` : ''}</div>
    <div class="ev">${f.evidence.map(esc).join(' · ')}</div><div class="rec">→ ${esc(f.recommendation)}</div></div>`;
}

function renderOverview(s) {
  const el = $('#view-overview');
  const p = s.projection;
  const visExtra = !s.event_started && p.projected_visitors ? `<div class="proj">Projected: <b>${fmt(p.projected_visitors)}</b> <small>(assumes ${pc(state.meta.settings.assumed_show_rate, 0)} show-rate)</small></div>` : (s.event_started ? `<div class="proj"><small>${fmt(s.totals.visitors_registered)} registered + ${fmt(s.totals.visitors_walkin)} walk-ins</small></div>` : '');
  const regExtra = !s.event_started ? `<div class="proj">Projected: <b>${fmt(p.projected_registrations)}</b> <small>at ${p.registration_run_rate_per_day}/day</small></div>` : `<div class="proj"><small>${fmt(s.totals.confirmed)} confirmed · ${fmt(s.totals.cancelled)} cancelled · ${fmt(s.totals.waitlisted)} waitlisted</small></div>`;
  const spendExtra = !s.event_started ? `<div class="proj">Projected at event: <b>${inr(p.projected_spend)}</b></div>` : `<div class="proj"><small>${inr(s.rates.cost_per_visitor)} per verified visitor</small></div>`;
  el.innerHTML = `
    <div class="grid g4">
      ${kpiCard('Identified external people', s.kpis.identified_people, false, `<div class="proj"><small>${fmt(s.totals.identified_people_campaign)} via campaigns · ${fmt(s.totals.identified_walkins)} walk-ins</small></div>`)}
      ${kpiCard('Registrations (external)', s.kpis.registrations, false, regExtra)}
      ${kpiCard('Verified unique visitors', s.kpis.visitors, false, visExtra)}
      ${kpiCard('Marketing spend vs budget', s.kpis.spend, true, spendExtra)}
    </div>
    <div class="grid g21 section">
      <div class="card"><div class="card-head"><h2>Registrations per week vs goal pace</h2><small>bars: weekly · line: cumulative · dashed: straight-line goal pace</small></div><div class="chart-box tall"><canvas id="c-weekly"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>Identified funnel</h2><small>distinct people</small></div><div class="chart-box tall"><canvas id="c-funnel"></canvas></div>
        <div class="note">Anonymous top of funnel: ${fmt(s.totals.impressions)} impressions → ${fmt(s.totals.clicks)} clicks (CTR ${pc(s.rates.ctr)}) → ${fmt(s.totals.landing_page_sessions)} sessions. These are events, not people.</div></div>
    </div>
    <div class="grid g2 section">
      <div class="card"><div class="card-head"><h2>Cost per ${s.event_started ? 'verified visitor' : 'confirmed registrant'}</h2><small>colour = rule verdict</small></div><div class="chart-box"><canvas id="c-cost"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>Share of spend vs share of ${s.event_started ? 'visitors' : 'confirmed'}</h2><small>where money goes vs where results come from</small></div><div class="chart-box"><canvas id="c-share"></canvas></div></div>
    </div>
    <div class="grid g21 section">
      <div class="card"><div class="card-head"><h2>What needs attention</h2><small>${s.diagnosis.length} findings · rule-based, thresholds in Settings</small></div>
        <div id="findings">${s.diagnosis.slice(0, 8).map((f) => findingHtml(f)).join('')}</div>
        ${s.diagnosis.length > 8 ? `<a id="more-findings">Show all ${s.diagnosis.length}</a>` : ''}</div>
      <div class="card"><h2>Data hygiene applied</h2>
        <div class="stat-inline" style="margin-bottom:10px">
          <div><b>${Object.values(s.data_quality.duplicate_rows_removed).reduce((a, b) => a + b, 0)}</b>duplicate rows removed</div>
          <div><b>${Object.values(s.data_quality.excluded_people_by_type).reduce((a, b) => a + b, 0)}</b>non-external people excluded</div>
        </div>
        <div class="note" style="margin-top:0">
          ${Object.entries(s.data_quality.duplicate_rows_removed).filter(([, v]) => v).map(([k, v]) => `${v} × ${esc(k)}`).join(', ') || 'No duplicates'} (same stable ID = import copy).<br>
          ${s.data_quality.internal_registrations_excluded} internal registrations and ${s.data_quality.non_external_verified_admissions_excluded} staff/test/internal admissions do not count toward targets.<br>
          Visitors = distinct people with an <i>admitted + verified</i> check-in. ${s.event_started ? `${s.event_ops.denied_events} denied and ${s.event_ops.pending_events} pending events excluded.` : ''}</div>
        ${s.event_started ? `<h2 style="margin-top:14px">Event days</h2>
        <div class="stat-inline">${Object.entries(s.event_ops.unique_visitors_by_day).map(([d, v]) => `<div><b>${fmt(v)}</b>${d}</div>`).join('')}<div><b>${fmt(s.event_ops.visitors_both_days)}</b>came both days</div><div><b>${fmt(s.event_ops.manual_only_visitors)}</b>manual-only check-in</div></div>
        <div class="chart-box short" style="margin-top:8px"><canvas id="c-hours"></canvas></div>` : ''}
      </div>
    </div>`;

  // weekly chart
  const w = s.weekly;
  chart('c-weekly', { data: { labels: w.map((x) => x.week.slice(5)), datasets: [
    { type: 'bar', label: 'Registrations / week', data: w.map((x) => x.registrations), backgroundColor: '#99d5cd', yAxisID: 'y' },
    { type: 'line', label: 'Cumulative', data: w.map((x) => x.cumulative_registrations), borderColor: '#0f766e', backgroundColor: '#0f766e', tension: .25, yAxisID: 'y1', pointRadius: 2 },
    { type: 'line', label: 'Goal pace', data: w.map((x) => x.registration_goal_pace), borderColor: '#d97706', borderDash: [5, 4], pointRadius: 0, yAxisID: 'y1' },
  ] }, options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom' } },
    scales: { y: { beginAtZero: true, title: { display: true, text: 'per week' }, grid: { color: '#eef1ee' } }, y1: { beginAtZero: true, position: 'right', grid: { display: false }, title: { display: true, text: 'cumulative' } }, x: { grid: { display: false } } } } });

  const fstages = [...s.funnel.identified];
  chart('c-funnel', { type: 'bar', data: { labels: ['Identified', 'Registered', 'Confirmed', 'Visited'], datasets: [{ data: fstages.map((x) => x.value), backgroundColor: ['#0f766e', '#14958a', '#2bb3a5', '#d97706'] }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => c.dataIndex ? `${pc(fstages[c.dataIndex].value / fstages[c.dataIndex - 1].value)} of previous stage` : '' } } }, scales: { x: { beginAtZero: true, grid: { color: '#eef1ee' } }, y: { grid: { display: false } } } } });

  const key = s.event_started ? 'cost_per_visitor' : 'cost_per_confirmed';
  const cs = s.campaigns.filter((k) => k[key] !== null).sort((a, b) => a[key] - b[key]);
  chart('c-cost', { type: 'bar', data: { labels: cs.map((k) => k.campaign_name), datasets: [{ data: cs.map((k) => k[key]), backgroundColor: cs.map((k) => COLORS[k.decision.action] || '#78716c') }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${inr(c.raw)} · ${cs[c.dataIndex].decision.action}` } } }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => '₹' + v }, grid: { color: '#eef1ee' } }, x: { grid: { display: false } } } } });

  const outKey = s.event_started ? 'visitors' : 'confirmed';
  const totOut = s.campaigns.reduce((a, k) => a + k[outKey], 0) || 1;
  chart('c-share', { type: 'bar', data: { labels: s.campaigns.map((k) => k.campaign_name), datasets: [
    { label: 'Share of spend', data: s.campaigns.map((k) => +(100 * (k.spend_share || 0)).toFixed(1)), backgroundColor: '#d97706' },
    { label: `Share of ${outKey}`, data: s.campaigns.map((k) => +(100 * k[outKey] / totOut).toFixed(1)), backgroundColor: '#0f766e' },
  ] }, options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { ticks: { callback: (v) => v + '%' }, grid: { color: '#eef1ee' } }, x: { grid: { display: false } } } } });

  if (s.event_started) {
    const hrs = Object.entries(s.event_ops.admissions_by_hour).sort();
    chart('c-hours', { type: 'bar', data: { labels: hrs.map(([k]) => k.slice(5).replace(' ', ' ')), datasets: [{ label: 'Verified admissions per hour', data: hrs.map(([, v]) => v), backgroundColor: hrs.map(([, v]) => (v >= 300 ? '#b91c1c' : '#2bb3a5')) }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false }, title: { display: true, text: 'Gate load by hour (red = peak ≥300/h)' } }, scales: { x: { ticks: { maxRotation: 90, autoSkip: true }, grid: { display: false } }, y: { grid: { color: '#eef1ee' } } } } });
  }
  const more = $('#more-findings');
  if (more) more.onclick = () => { $('#findings').innerHTML = s.diagnosis.map((f) => findingHtml(f)).join(''); more.remove(); };
}

// ------------------------------------------------------------------ campaigns
function renderCampaigns(s) {
  const el = $('#view-campaigns');
  const post = s.event_started;
  el.innerHTML = `<div class="card"><div class="card-head"><h2>Campaign scorecard</h2><small>Click a row for trends and actions. Visitors are attributed to the registration campaign.</small></div>
    <div class="table-wrap"><table><thead><tr>
      <th>Campaign</th><th>Verdict</th><th>Status</th><th class="num">Spend</th><th class="num">People</th><th class="num">Reg. rate</th><th class="num">Regs</th><th class="num">Confirmed</th>
      ${post ? '<th class="num">Visitors</th><th class="num">Show rate</th><th class="num">₹ / visitor</th>' : '<th class="num">₹ / confirmed</th>'}
      <th class="num">CTR 14d</th><th class="num">Regs 14d</th><th class="num">Opt-out</th></tr></thead><tbody>
      ${s.campaigns.map((k) => `<tr class="clickable" data-camp="${k.campaign_id}">
        <td><b>${esc(k.campaign_name)}</b><br><small>${esc(k.owner_name || '')} · ${esc(k.channel || '')}</small></td><td><span class="tag ${k.decision.action}" title="${esc(k.decision.reasons.join(' '))}">${k.decision.action}</span></td>
        <td><select data-status="${k.campaign_id}" onclick="event.stopPropagation()">${['active', 'scaling', 'paused', 'stopped'].map((x) => `<option ${k.ops.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
        <td class="num">${inr(k.spend)}</td><td class="num">${fmt(k.identified_people)}</td><td class="num">${pc(k.reg_rate)}</td><td class="num">${fmt(k.registrations)}</td><td class="num">${fmt(k.confirmed)}</td>
        ${post ? `<td class="num">${fmt(k.visitors)}</td><td class="num">${pc(k.show_rate)}</td><td class="num"><b>${inr(k.cost_per_visitor)}</b></td>` : `<td class="num"><b>${inr(k.cost_per_confirmed)}</b></td>`}
        <td class="num">${pc(k.ctr_last14)} <small>${k.ctr_prev14 ? (k.ctr_last14 < k.ctr_prev14 ? '↓' : '↑') : ''}</small></td>
        <td class="num">${k.regs_last14} <small>(${k.regs_prev14})</small></td><td class="num">${pc(k.opt_out_rate)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="note">Verdict rule: ${post ? 'cost per verified visitor' : 'cost per confirmed registrant'} vs portfolio average — ≤${state.meta.settings.scale_ratio}× Scale, ≤${state.meta.settings.fix_ratio}× Hold, ≤${state.meta.settings.stop_ratio}× Fix, above that Cut. Creative fatigue (CTR down ≥${pc(state.meta.settings.fatigue_drop, 0)}) or falling registrations with continued spend downgrade the verdict. 14-day windows: ${s.trend_window.prev14.join(' → ')} vs ${s.trend_window.last14.join(' → ')}.</div></div>
    <div class="grid g2 section">
      <div class="card"><div class="card-head"><h2>Weekly registrations by campaign</h2></div><div class="chart-box tall"><canvas id="c-camp-weekly"></canvas></div></div>
      <div class="card"><div class="card-head"><h2>Where each campaign leaks</h2><small>stage conversion</small></div><div class="chart-box tall"><canvas id="c-leak"></canvas></div></div>
    </div>`;
  $$('[data-camp]', el).forEach((tr) => tr.onclick = () => openCampaign(tr.dataset.camp));
  $$('[data-status]', el).forEach((sel) => sel.onchange = async () => {
    try { await api('PATCH', `/api/campaigns/${sel.dataset.status}`, { status: sel.value }); toast(`${campName(sel.dataset.status)} → ${sel.value} (logged)`); await refresh(); } catch (e) { toast(e.message, true); }
  });
  const weeks = s.weekly.map((w) => w.week);
  chart('c-camp-weekly', { type: 'line', data: { labels: weeks.map((x) => x.slice(5)), datasets: s.campaigns.map((k, i) => ({ label: k.campaign_name, data: s.weekly.map((w) => w.by_campaign[k.campaign_id] || 0), borderColor: SERIES[i], backgroundColor: SERIES[i], tension: .25, pointRadius: 1.5 })) },
    options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } } }, scales: { y: { beginAtZero: true, grid: { color: '#eef1ee' } }, x: { grid: { display: false } } } } });
  const stages = [['reg_rate', 'Identified → registered'], ['confirm_rate', 'Registered → confirmed']];
  if (post) stages.push(['show_rate', 'Confirmed → visited']);
  chart('c-leak', { type: 'bar', data: { labels: s.campaigns.map((k) => k.campaign_name), datasets: stages.map(([k, l], i) => ({ label: l, data: s.campaigns.map((c) => c[k] === null ? null : +(c[k] * 100).toFixed(1)), backgroundColor: ['#0f766e', '#2bb3a5', '#d97706'][i] })) },
    options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, scales: { y: { min: 40, max: 100, ticks: { callback: (v) => v + '%' }, grid: { color: '#eef1ee' } }, x: { grid: { display: false } } } } });
}

async function openCampaign(id) {
  const s = state.snap; const k = s.campaigns.find((x) => x.campaign_id === id);
  const [regs, ctr, spend] = await Promise.all([
    api('GET', `/api/timeseries?metric=registrations&campaign_id=${id}&granularity=week&asOf=${state.asOf}`),
    api('GET', `/api/timeseries?metric=ctr&campaign_id=${id}&granularity=week&asOf=${state.asOf}`),
    api('GET', `/api/timeseries?metric=spend&campaign_id=${id}&granularity=week&asOf=${state.asOf}`),
  ]);
  const tasks = state.tasks.filter((t) => t.campaign_id === id);
  openModal(`<div class="card-head"><h2>${esc(k.campaign_name)} <span class="tag ${k.decision.action}">${k.decision.action}</span></h2><button class="ghost small" data-close>✕</button></div>
    <div class="stat-inline" style="margin-bottom:10px">
      <div><b>${inr(k.spend)}</b>spend</div><div><b>${fmt(k.registrations)}</b>registrations</div><div><b>${fmt(k.confirmed)}</b>confirmed</div>
      ${s.event_started ? `<div><b>${fmt(k.visitors)}</b>visitors</div><div><b>${pc(k.show_rate)}</b>show rate</div><div><b>${inr(k.cost_per_visitor)}</b>per visitor</div>` : `<div><b>${inr(k.cost_per_confirmed)}</b>per confirmed</div>`}
      <div><b>${fmt(k.abandoned_starts)}</b>abandoned starts</div></div>
    <div class="callout ${['Fix', 'Cut'].includes(k.decision.action) ? 'warn' : ''}">${k.decision.reasons.map(esc).join('<br>')}</div>
    <div class="chart-box section"><canvas id="c-cd"></canvas></div>
    <div class="form-row section">
      <label>Status<select id="cd-status">${['active', 'scaling', 'paused', 'stopped'].map((x) => `<option ${k.ops.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Planned budget (₹)<input id="cd-budget" type="number" min="0" value="${k.ops.planned_budget_inr ?? ''}" placeholder="${k.spend}"></label>
      <label style="flex:1">Decision note<input id="cd-notes" value="${esc(k.ops.notes || '')}" placeholder="Why this decision?"></label>
      <button class="primary" id="cd-save">Save decision</button>
    </div>
    <h2 class="section">Tasks (${tasks.length})</h2>
    ${tasks.map((t) => `<div class="log-item"><span class="tag ${t.status}">${t.status}</span> <b>${esc(t.id)}</b> ${esc(t.title)} <small>· ${esc(t.owner_name || '—')} · due ${esc(t.due || '—')}</small></div>`).join('') || '<small>No tasks yet.</small>'}
    <div style="margin-top:10px;display:flex;gap:8px"><button id="cd-task">+ New task for this campaign</button><button class="ghost" id="cd-ask">Ask copilot about it</button></div>`);
  const labels = [...new Set([...regs.points, ...spend.points].map((p) => p.period))].sort();
  const get = (arr, l) => (arr.points.find((p) => p.period === l) || {}).value ?? null;
  chart('c-cd', { data: { labels: labels.map((x) => x.slice(5)), datasets: [
    { type: 'bar', label: 'Registrations', data: labels.map((l) => get(regs, l) || 0), backgroundColor: '#99d5cd', yAxisID: 'y' },
    { type: 'line', label: 'Spend (₹)', data: labels.map((l) => get(spend, l) || 0), borderColor: '#d97706', yAxisID: 'y1', pointRadius: 1.5 },
    { type: 'line', label: 'CTR %', data: labels.map((l) => { const v = get(ctr, l); return v === null ? null : +(v * 100).toFixed(2); }), borderColor: '#6d28d9', borderDash: [4, 3], yAxisID: 'y2', pointRadius: 1.5 },
  ] }, options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom' } },
    scales: { y: { beginAtZero: true, grid: { color: '#eef1ee' } }, y1: { position: 'right', beginAtZero: true, grid: { display: false } }, y2: { display: false, beginAtZero: true }, x: { grid: { display: false } } } } });
  $('#cd-save').onclick = async () => {
    try {
      await api('PATCH', `/api/campaigns/${id}`, { status: $('#cd-status').value, planned_budget_inr: $('#cd-budget').value === '' ? null : Number($('#cd-budget').value), notes: $('#cd-notes').value });
      toast('Decision saved and logged'); closeModal(); await refresh();
    } catch (e) { toast(e.message, true); }
  };
  $('#cd-task').onclick = () => taskModal({ campaign_id: id, owner_id: k.owner_id });
  $('#cd-ask').onclick = () => { closeModal(); askCopilot(`Diagnose ${k.campaign_name} (${id}). What is driving its performance and what should we do next?`); };
}

// ------------------------------------------------------------------ decisions
function renderDecisions(s) {
  const el = $('#view-decisions');
  const fmtV = (i, v) => (v === null || v === undefined ? '—' : /cost/.test(i.metric.key) ? inr(v) : /rate|ctr/.test(i.metric.key) ? pc(v) : fmt(v));
  el.innerHTML = `<div class="card"><div class="card-head"><h2>Strategic bets — live scale / change / stop thresholds</h2><small>Edit a threshold and the verdict recalculates</small></div>
    <div class="table-wrap"><table><thead><tr><th>#</th><th>Initiative</th><th>Owner</th><th class="num">Budget</th><th>KPI</th><th class="num">Now</th><th class="num">Scale at</th><th class="num">Stop at</th><th>Verdict</th><th>Status</th></tr></thead><tbody>
    ${s.initiatives.map((i) => `<tr><td>${i.rank}</td><td class="wrap"><b>${esc(i.name)}</b><br><small>${esc(i.hypothesis)}</small></td><td>${esc(i.owner_name)}</td><td class="num">${inr(i.budget_inr)}</td>
      <td class="wrap"><small>${esc(i.metric.key.replace(/_/g, ' '))}${i.metric.campaign_id ? ' · ' + esc(campName(i.metric.campaign_id)) : ''} (${i.direction} is better)</small></td>
      <td class="num"><b>${fmtV(i, i.current_value)}</b></td>
      <td class="num"><input style="width:72px" type="number" step="any" value="${i.scale_at}" data-init="${i.id}" data-k="scale_at"></td>
      <td class="num"><input style="width:72px" type="number" step="any" value="${i.stop_at}" data-init="${i.id}" data-k="stop_at"></td>
      <td><span class="tag ${i.verdict.startsWith('Stop') ? 'Stop' : i.verdict}">${esc(i.verdict)}</span></td>
      <td><select data-init-status="${i.id}">${['planned', 'active', 'scaled', 'changed', 'stopped'].map((x) => `<option ${i.status === x ? 'selected' : ''}>${x}</option>`).join('')}</select></td></tr>`).join('')}
    </tbody></table></div>
    <div class="note">The 2025 dataset is the baseline these 2026 bets are judged against; thresholds come from the strategy deck (slide 3).</div></div>

    <div class="grid g2 section">
      <div class="card"><h2>Budget reallocation simulator</h2>
        <div class="form-row">
          <label>From<select id="sim-from">${s.campaigns.map((k) => `<option value="${k.campaign_id}" ${k.decision.action === 'Cut' ? 'selected' : ''}>${esc(k.campaign_name)}</option>`).join('')}</select></label>
          <label>To<select id="sim-to">${s.campaigns.slice().sort((a, b) => (a.decision.ratio ?? 9) - (b.decision.ratio ?? 9)).map((k) => `<option value="${k.campaign_id}">${esc(k.campaign_name)}</option>`).join('')}</select></label>
          <label>Amount ₹<input id="sim-amt" type="number" value="20000" min="0" step="1000" style="width:110px"></label>
          <label>Elasticity<input id="sim-e" type="number" value="0.8" min="0.1" max="1" step="0.05" style="width:70px"></label>
          <button class="primary" id="sim-run">Simulate</button>
        </div>
        <div id="sim-out" class="note">Outcome(spend) = outcome × (new spend / old spend)<sup>elasticity</sup>. Elasticity &lt; 1 means diminishing returns. It is an assumption — validate with a one-week test before moving real money.</div>
      </div>
      <div class="card"><h2>Decision log</h2><div id="log" style="max-height:330px;overflow:auto"><small>Loading…</small></div></div>
    </div>`;
  $$('[data-init]', el).forEach((inp) => inp.onchange = async () => {
    try { await api('PATCH', `/api/initiatives/${inp.dataset.init}`, { [inp.dataset.k]: Number(inp.value) }); toast('Threshold updated'); await refresh(); } catch (e) { toast(e.message, true); }
  });
  $$('[data-init-status]', el).forEach((sel) => sel.onchange = async () => {
    try { await api('PATCH', `/api/initiatives/${sel.dataset.initStatus}`, { status: sel.value }); toast('Initiative status updated'); await refresh(); } catch (e) { toast(e.message, true); }
  });
  $('#sim-run').onclick = async () => {
    try {
      const r = await api('GET', `/api/simulate?asOf=${state.asOf}&from=${$('#sim-from').value}&to=${$('#sim-to').value}&amount=${$('#sim-amt').value}&elasticity=${$('#sim-e').value}`);
      if (r.error) { $('#sim-out').innerHTML = esc(r.error); return; }
      $('#sim-out').innerHTML = `<table><thead><tr><th></th><th class="num">Spend</th><th class="num">${r.outcome} now</th><th class="num">${r.outcome} after</th></tr></thead><tbody>
        <tr><td>${esc(r.from.campaign)}</td><td class="num">${inr(r.from.spend_before)} → ${inr(r.from.spend_before - r.amount_inr)}</td><td class="num">${fmt(r.from.outcome_before)}</td><td class="num">${fmt(r.from.outcome_after)}</td></tr>
        <tr><td>${esc(r.to.campaign)}</td><td class="num">${inr(r.to.spend_before)} → ${inr(r.to.spend_before + r.amount_inr)}</td><td class="num">${fmt(r.to.outcome_before)}</td><td class="num">${fmt(r.to.outcome_after)}</td></tr></tbody></table>
        <p><b>Net: ${r.net_change >= 0 ? '+' : ''}${fmt(r.net_change)} ${r.outcome}</b>. <small>${esc(r.caveat)}</small></p>
        <button class="small" id="sim-task">Turn into a task</button>`;
      $('#sim-task').onclick = () => taskModal({ title: `Move ${inr(r.amount_inr)} from ${r.from.campaign} to ${r.to.campaign} (sim: ${r.net_change >= 0 ? '+' : ''}${r.net_change} ${r.outcome})`, campaign_id: $('#sim-from').value, priority: 'high' });
    } catch (e) { toast(e.message, true); }
  };
  api('GET', '/api/log').then((log) => {
    $('#log').innerHTML = log.length ? log.map((l) => `<div class="log-item"><span class="tag ${l.by.startsWith('copilot') ? 'ai' : 'low'}">${esc(l.by)}</span> ${esc(l.message)}<div class="when">${new Date(l.at).toLocaleString('en-IN')} · ${esc(l.kind)}</div></div>`).join('') : '<small>No decisions logged yet. Status changes, task changes and data edits appear here.</small>';
  });
}

// ------------------------------------------------------------------ execution
function renderExecution(s) {
  const el = $('#view-execution');
  const f = state.taskFilter || { owner: '', campaign: '' };
  const tasks = state.tasks.filter((t) => (!f.owner || t.owner_id === f.owner) && (!f.campaign || (f.campaign === 'none' ? !t.campaign_id : t.campaign_id === f.campaign)));
  const cols = [['todo', 'To do'], ['doing', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
  const overdue = state.tasks.filter((t) => t.status !== 'done' && t.due && t.due < s.as_of).length;
  el.innerHTML = `<div class="card" style="margin-bottom:14px"><div class="form-row" style="margin:0">
      <button class="primary" id="new-task">+ New task</button>
      <label>Owner<select id="f-owner"><option value="">All</option>${Object.entries(state.meta.owners).map(([k, v]) => `<option value="${k}" ${f.owner === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label>Campaign<select id="f-camp"><option value="">All</option><option value="none" ${f.campaign === 'none' ? 'selected' : ''}>Cross-campaign</option>${state.meta.campaigns.map((c) => `<option value="${c.campaign_id}" ${f.campaign === c.campaign_id ? 'selected' : ''}>${esc(c.campaign_name)}</option>`).join('')}</select></label>
      <div style="margin-left:auto" class="stat-inline"><div><b>${state.tasks.filter((t) => t.status !== 'done').length}</b>open</div><div><b style="color:${overdue ? 'var(--bad)' : 'inherit'}">${overdue}</b>overdue at ${s.as_of}</div><div><b>${state.tasks.filter((t) => t.created_by.startsWith('copilot')).length}</b>from copilot</div></div>
    </div></div>
    <div class="kanban">${cols.map(([k, label]) => {
      const list = tasks.filter((t) => t.status === k).sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]) || String(a.due).localeCompare(String(b.due)));
      return `<div class="col" data-col="${k}"><h3><span>${label}</span><span>${list.length}</span></h3>
      ${list.map((t) => { const od = t.status !== 'done' && t.due && t.due < s.as_of; return `<div class="tcard ${od ? 'overdue' : ''}" draggable="true" data-task="${t.id}">
        <div class="tt">${esc(t.title)}</div>
        <div class="meta"><span class="tag ${t.priority}">${t.priority}</span>${t.created_by.startsWith('copilot') ? '<span class="tag ai">AI</span>' : ''}<span>${esc(t.id)}</span><span>${esc(t.owner_name || 'unassigned')}</span>
        <span class="${od ? 'overdue-lbl' : ''}">${t.due ? 'due ' + t.due : 'no date'}${od ? ' · overdue' : ''}</span>${t.campaign_id ? `<span>· ${esc(campName(t.campaign_id))}</span>` : ''}</div></div>`; }).join('')}</div>`;
    }).join('')}</div>`;
  $('#new-task').onclick = () => taskModal({});
  $('#f-owner').onchange = (e) => { state.taskFilter = { ...f, owner: e.target.value }; renderExecution(s); };
  $('#f-camp').onchange = (e) => { state.taskFilter = { ...f, campaign: e.target.value }; renderExecution(s); };
  $$('.tcard', el).forEach((c) => {
    c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.task);
    c.onclick = () => taskModal(state.tasks.find((t) => t.id === c.dataset.task));
  });
  $$('.col', el).forEach((col) => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('drop'); };
    col.ondragleave = () => col.classList.remove('drop');
    col.ondrop = async (e) => {
      e.preventDefault(); col.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain');
      try { await api('PATCH', `/api/tasks/${id}`, { status: col.dataset.col }); await refresh(); } catch (er) { toast(er.message, true); }
    };
  });
}

function taskModal(t) {
  const isNew = !t.id;
  openModal(`<div class="card-head"><h2>${isNew ? 'New task' : esc(t.id)}</h2><button class="ghost small" data-close>✕</button></div>
    <div class="form-row"><label style="flex:1">Title<input id="tm-title" value="${esc(t.title || '')}" placeholder="What needs to happen?"></label></div>
    <div class="form-row">
      <label>Campaign<select id="tm-camp"><option value="">Cross-campaign</option>${state.meta.campaigns.map((c) => `<option value="${c.campaign_id}" ${t.campaign_id === c.campaign_id ? 'selected' : ''}>${esc(c.campaign_name)}</option>`).join('')}</select></label>
      <label>Owner<select id="tm-owner"><option value="">Unassigned</option>${Object.entries(state.meta.owners).map(([k, v]) => `<option value="${k}" ${t.owner_id === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label>Due<input id="tm-due" type="date" value="${esc(t.due || '')}"></label>
      <label>Priority<select id="tm-pri">${['high', 'medium', 'low'].map((x) => `<option ${(t.priority || 'medium') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>Status<select id="tm-status">${['todo', 'doing', 'blocked', 'done'].map((x) => `<option ${(t.status || 'todo') === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    </div>
    <div class="form-row"><label style="flex:1">Notes<textarea id="tm-notes" rows="3">${esc(t.notes || '')}</textarea></label></div>
    ${!isNew ? `<small>Created by ${esc(t.created_by)} · ${new Date(t.created_at).toLocaleString('en-IN')}</small>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px"><button class="primary" id="tm-save">${isNew ? 'Create task' : 'Save'}</button>${!isNew ? '<button class="danger" id="tm-del">Delete</button>' : ''}</div>`);
  $('#tm-save').onclick = async () => {
    const body = { title: $('#tm-title').value, campaign_id: $('#tm-camp').value || null, owner_id: $('#tm-owner').value || null, due: $('#tm-due').value || null, priority: $('#tm-pri').value, status: $('#tm-status').value, notes: $('#tm-notes').value };
    try { if (isNew) await api('POST', '/api/tasks', body); else await api('PATCH', `/api/tasks/${t.id}`, body); toast(isNew ? 'Task created' : 'Task saved'); closeModal(); await refresh(); } catch (e) { toast(e.message, true); }
  };
  if (!isNew) $('#tm-del').onclick = async () => { if (!confirm(`Delete ${t.id}?`)) return; try { await api('DELETE', `/api/tasks/${t.id}`); closeModal(); await refresh(); } catch (e) { toast(e.message, true); } };
}

// ------------------------------------------------------------------ data & settings
async function renderData(s) {
  const el = $('#view-data');
  const st = state.meta.settings;
  const dcamp = state.dailyCamp || state.meta.campaigns[0].campaign_id;
  el.innerHTML = `<div class="grid g2">
    <div class="card"><h2>Assumptions & rule thresholds</h2>
      <div class="form-row">
        <label>Assumed show-rate (projections)<input type="number" step="0.01" min="0" max="1" data-set="assumed_show_rate" value="${st.assumed_show_rate}"></label>
        <label>Assumed walk-ins<input type="number" min="0" data-set="assumed_walkins" value="${st.assumed_walkins}"></label>
        <label>Venue daily capacity<input type="number" min="0" data-set="venue_daily_capacity" value="${st.venue_daily_capacity}"></label>
      </div>
      <div class="form-row">
        <label>Scale if ≤ × avg<input type="number" step="0.05" data-set="scale_ratio" value="${st.scale_ratio}"></label>
        <label>Fix if > × avg<input type="number" step="0.05" data-set="fix_ratio" value="${st.fix_ratio}"></label>
        <label>Cut if > × avg<input type="number" step="0.1" data-set="stop_ratio" value="${st.stop_ratio}"></label>
        <label>Fatigue: CTR drop ≥<input type="number" step="0.05" data-set="fatigue_drop" value="${st.fatigue_drop}"></label>
      </div>
      <div class="note">Assumptions only drive projections and verdicts; they never change actuals.</div>
      <h2 class="section">Targets (dated versions)</h2>
      <div class="table-wrap"><table><thead><tr><th>Effective</th><th>Version</th><th class="num">People</th><th class="num">Regs</th><th class="num">Visitors</th><th class="num">Budget</th></tr></thead><tbody id="targets-body"></tbody></table></div>
      <div class="form-row section">
        <label>Effective date<input id="tg-date" type="date" value="${s.as_of}"></label>
        <label>Label<input id="tg-label" value="Edited plan" style="width:120px"></label>
        <label>Regs goal<input id="tg-reg" type="number" style="width:90px" placeholder="${s.targets ? s.targets.registration_goal : ''}"></label>
        <label>Visitors goal<input id="tg-vis" type="number" style="width:90px" placeholder="${s.targets ? s.targets.unique_external_visitors_goal : ''}"></label>
        <label>Budget ₹<input id="tg-bud" type="number" style="width:100px" placeholder="${s.targets ? s.targets.marketing_budget_inr : ''}"></label>
        <button id="tg-add">Add version</button>
      </div>
    </div>
    <div class="card"><h2>Dataset</h2>
      <p class="muted" style="margin-top:0">The app starts from the provided <b>Attendee Dataset.xlsx</b>. Upload a modified workbook (same sheet names) to test with changed data, or reset to the original.</p>
      <div class="form-row"><input type="file" id="imp-file" accept=".xlsx"><button id="imp-go">Import workbook</button></div>
      <div class="form-row"><button class="danger" id="reset-all">Reset data + tasks to original</button><button id="reset-data">Reset data only (keep tasks)</button></div>
      <h2 class="section">Change a registration status</h2>
      <div class="form-row"><input id="rs-q" placeholder="Name, person_id or registration_id" style="flex:1"><button id="rs-go">Search</button></div>
      <div id="rs-out"></div>
    </div></div>
    <div class="card section"><div class="card-head"><h2>Daily marketing records</h2>
      <div class="form-row" style="margin:0"><label>Campaign<select id="dm-camp">${state.meta.campaigns.map((c) => `<option value="${c.campaign_id}" ${c.campaign_id === dcamp ? 'selected' : ''}>${esc(c.campaign_name)}</option>`).join('')}</select></label></div></div>
      <div class="form-row">
        <label>Date<input id="dm-date" type="date" value="${s.as_of}"></label>
        <label>Impressions<input id="dm-imp" type="number" min="0" style="width:100px"></label>
        <label>Clicks<input id="dm-clk" type="number" min="0" style="width:80px"></label>
        <label>Reach<input id="dm-rch" type="number" min="0" style="width:80px"></label>
        <label>LP sessions<input id="dm-lps" type="number" min="0" style="width:80px"></label>
        <label>Form starts<input id="dm-rs" type="number" min="0" style="width:80px"></label>
        <label>Spend ₹ (net)<input id="dm-sp" type="number" style="width:90px"></label>
        <button class="primary" id="dm-save">Add / update day</button>
      </div>
      <div class="table-wrap" style="max-height:340px"><table><thead><tr><th>Date</th><th>ID</th><th class="num">Impr.</th><th class="num">Clicks</th><th class="num">Reach</th><th class="num">Sessions</th><th class="num">Form starts</th><th class="num">Spend</th><th>Platform</th><th></th></tr></thead><tbody id="dm-body"><tr><td colspan="10">Loading…</td></tr></tbody></table></div>
      <div class="note">Same date + campaign overwrites that day. Negative spend = vendor credit. Edits flow straight into every chart, verdict and copilot answer.</div>
    </div>`;

  $$('[data-set]', el).forEach((inp) => inp.onchange = async () => {
    try { state.meta.settings = await api('PATCH', '/api/settings', { [inp.dataset.set]: Number(inp.value) }); toast('Setting saved'); await refresh(); } catch (e) { toast(e.message, true); }
  });
  api('GET', '/api/targets').then((ts) => {
    $('#targets-body').innerHTML = ts.slice().sort((a, b) => (a.effective_at < b.effective_at ? -1 : 1)).map((t) => `<tr ${s.targets && t.effective_at === s.targets.effective_at ? 'style="background:#eef7f5"' : ''}><td>${esc(t.effective_at.slice(0, 10))}</td><td>${esc(t.target_version)}</td><td class="num">${fmt(t.identified_external_people_goal)}</td><td class="num">${fmt(t.registration_goal)}</td><td class="num">${fmt(t.unique_external_visitors_goal)}</td><td class="num">${inr(t.marketing_budget_inr)}</td></tr>`).join('');
  });
  $('#tg-add').onclick = async () => {
    try { await api('POST', '/api/targets', { effective_date: $('#tg-date').value, target_version: $('#tg-label').value, registration_goal: $('#tg-reg').value, unique_external_visitors_goal: $('#tg-vis').value, marketing_budget_inr: $('#tg-bud').value }); toast('Target version added'); await refresh(); } catch (e) { toast(e.message, true); }
  };
  const loadDaily = async () => {
    const rows = await api('GET', `/api/daily?campaign=${dcamp}&limit=120`);
    $('#dm-body').innerHTML = rows.map((r) => `<tr><td>${r.activity_date}</td><td><small>${esc(r.activity_id)}</small></td><td class="num">${fmt(r.impressions)}</td><td class="num">${fmt(r.clicks)}</td><td class="num">${fmt(r.reported_reach)}</td><td class="num">${fmt(r.landing_page_sessions)}</td><td class="num">${fmt(r.registration_starts)}</td><td class="num">${inr(r.marketing_spend_inr)}</td><td><small>${esc(r.platform)}</small></td>
      <td><button class="small ghost" data-edit='${esc(JSON.stringify(r))}'>Edit</button><button class="small ghost danger" data-del="${esc(r.activity_id)}">✕</button></td></tr>`).join('');
    $$('[data-edit]').forEach((b) => b.onclick = () => { const r = JSON.parse(b.dataset.edit); $('#dm-date').value = r.activity_date; $('#dm-imp').value = r.impressions; $('#dm-clk').value = r.clicks; $('#dm-rch').value = r.reported_reach; $('#dm-lps').value = r.landing_page_sessions; $('#dm-rs').value = r.registration_starts; $('#dm-sp').value = r.marketing_spend_inr; $('#dm-save').dataset.id = r.activity_id; window.scrollTo({ top: $('#dm-date').getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' }); });
    $$('[data-del]').forEach((b) => b.onclick = async () => { if (!confirm(`Delete ${b.dataset.del}?`)) return; try { await api('DELETE', `/api/daily/${b.dataset.del}`); toast('Row deleted'); await refresh(); } catch (e) { toast(e.message, true); } });
  };
  loadDaily();
  $('#dm-camp').onchange = (e) => { state.dailyCamp = e.target.value; renderData(s); };
  $('#dm-save').onclick = async () => {
    const date = $('#dm-date').value;
    const editId = $('#dm-save').dataset.id;
    const body = { campaign_id: dcamp, activity_date: date, impressions: $('#dm-imp').value, clicks: $('#dm-clk').value, reported_reach: $('#dm-rch').value, landing_page_sessions: $('#dm-lps').value, registration_starts: $('#dm-rs').value, marketing_spend_inr: $('#dm-sp').value };
    if (editId && editId.includes(date.slice(5, 7) + date.slice(8, 10))) body.activity_id = editId;
    try { await api('POST', '/api/daily', body); toast('Daily record saved — analytics updated'); state.meta = await api('GET', '/api/meta'); await refresh(); } catch (e) { toast(e.message, true); }
  };
  $('#imp-go').onclick = async () => {
    const f = $('#imp-file').files[0]; if (!f) return toast('Choose an .xlsx file first', true);
    try { const r = await api('POST', '/api/import', f); toast(`Imported: ${r.people} people, ${r.daily} daily rows`); state.meta = await api('GET', '/api/meta'); await boot(); } catch (e) { toast(e.message, true); }
  };
  $('#reset-all').onclick = async () => { if (!confirm('Reset all data, tasks, initiatives and the log to the original state?')) return; await api('POST', '/api/reset', {}); toast('Reset to original'); await boot(); };
  $('#reset-data').onclick = async () => { if (!confirm('Reset source data to the original workbook (tasks kept)?')) return; await api('POST', '/api/reset', { keepOps: true }); toast('Data reset'); await boot(); };
  $('#rs-go').onclick = async () => {
    const r = await api('GET', `/api/registrations/search?q=${encodeURIComponent($('#rs-q').value)}`);
    $('#rs-out').innerHTML = r.length ? `<table><thead><tr><th>Person</th><th>Campaign</th><th>History</th><th>New status</th></tr></thead><tbody>${r.map((x) => `<tr><td>${esc(x.person_name)}<br><small>${esc(x.person_id)} · ${esc(x.registration_id)} · ${esc(x.person_type)}</small></td><td>${esc(x.campaign_name)}</td><td><small>${x.history.map((h) => `${esc(h.status)} (${h.effective_at.slice(0, 10)})`).join(' → ')}</small></td>
      <td><select data-rs="${esc(x.registration_id)}"><option value="">—</option>${['confirmed', 'cancelled', 'waitlisted', 'interested'].map((o) => `<option>${o}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table><div class="note">The new status takes effect at the end of the selected snapshot date (${s.as_of}).</div>` : '<small>No match.</small>';
    $$('[data-rs]').forEach((sel) => sel.onchange = async () => { if (!sel.value) return; try { await api('POST', `/api/registrations/${sel.dataset.rs}/status`, { status: sel.value, effective_at: s.as_of + 'T23:00:00' }); toast('Status recorded'); await refresh(); } catch (e) { toast(e.message, true); } });
  };
}

// ------------------------------------------------------------------ modal
function openModal(html) { $('#modal-card').innerHTML = html; $('#modal').classList.remove('hidden'); $$('[data-close]').forEach((b) => b.onclick = closeModal); }
function closeModal() { $('#modal').classList.add('hidden'); if (state.charts['c-cd']) { state.charts['c-cd'].destroy(); delete state.charts['c-cd']; } }
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ------------------------------------------------------------------ copilot
const SUGGESTIONS = [
  'Are we on track for the visitor target? Why or why not?',
  'Which campaign should we cut, and where should that money go?',
  'Where is the biggest bottleneck in the funnel?',
  'Show the weekly CTR trend for Paid Social',
  'What share of confirmed people actually came, by campaign?',
  'What was the age profile of attendees?',
];
function saveChat() { localStorage.setItem('gc-chat', JSON.stringify(state.chat.slice(-40))); }
function renderChat() {
  const log = $('#chat-log');
  if (!state.chat.length) {
    log.innerHTML = `<div class="msg bot"><p><b>Hi, I'm the growth analyst for this workspace.</b></p><p>I answer from the live campaign data at the snapshot date you've selected (${esc(state.asOf || '')}). I'll show the tools I used, tell you when the data can't answer something, and draft tasks or status changes. Nothing is changed until you confirm.</p></div>`;
  } else {
    log.innerHTML = state.chat.map((m, idx) => m.role === 'user' ? `<div class="msg user">${esc(m.content)}</div>` : `<div class="msg bot">${md(m.content)}
      ${(m.proposals || []).map((p) => `<div class="proposal" data-prop="${esc(p.id)}"><div class="ps">Proposed: ${esc(p.summary)}</div><div class="pr">${esc(p.rationale || '')}</div>
        ${p.state ? `<div class="done">${p.state === 'confirmed' ? '✓ Confirmed and applied' : p.state === 'rejected' ? '✕ Rejected' : esc(p.state)}</div>` : `<button class="primary small" data-confirm="${esc(p.id)}" data-idx="${idx}">Confirm</button> <button class="small" data-reject="${esc(p.id)}" data-idx="${idx}">Reject</button>`}</div>`).join('')}
      ${m.trace && m.trace.length ? `<details class="trace"><summary>${m.trace.length} tool call${m.trace.length > 1 ? 's' : ''} · ${esc(m.mode || '')} · snapshot ${esc(m.asOf || '')}</summary>${m.trace.map((t) => `<pre><b>${esc(t.tool)}</b>(${esc(JSON.stringify(t.args))})\n→ ${esc(typeof t.result === 'string' ? t.result : JSON.stringify(t.result))}</pre>`).join('')}</details>` : ''}</div>`).join('');
  }
  if (state.busy) log.insertAdjacentHTML('beforeend', '<div class="typing">Analysing live data…</div>');
  log.scrollTop = log.scrollHeight;
  $$('[data-confirm]', log).forEach((b) => b.onclick = () => handleProposal(b.dataset.confirm, Number(b.dataset.idx), 'confirm'));
  $$('[data-reject]', log).forEach((b) => b.onclick = () => handleProposal(b.dataset.reject, Number(b.dataset.idx), 'reject'));
  $('#chat-suggest').innerHTML = state.chat.length > 1 ? '' : SUGGESTIONS.map((s) => `<button data-sug="${esc(s)}">${esc(s)}</button>`).join('');
  $$('[data-sug]').forEach((b) => b.onclick = () => askCopilot(b.dataset.sug));
}
async function handleProposal(id, idx, verb) {
  try {
    const r = await api('POST', `/api/actions/${id}/${verb}`);
    const p = state.chat[idx].proposals.find((x) => x.id === id);
    p.state = verb === 'confirm' ? 'confirmed' : 'rejected';
    saveChat(); renderChat();
    if (verb === 'confirm') { toast(r.result && r.result.id ? `${r.result.id} created` : 'Change applied'); await refresh(); }
  } catch (e) {
    const p = state.chat[idx].proposals.find((x) => x.id === id); p.state = e.message; saveChat(); renderChat(); toast(e.message, true);
  }
}
async function askCopilot(text) {
  openChat();
  if (!text.trim() || state.busy) return;
  state.chat.push({ role: 'user', content: text.trim() });
  state.busy = true; renderChat(); saveChat();
  try {
    const r = await api('POST', '/api/chat', { messages: state.chat.map(({ role, content }) => ({ role, content })), asOf: state.asOf });
    state.chat.push({ role: 'assistant', content: r.reply, trace: r.trace, proposals: r.proposals, mode: r.mode, asOf: state.asOf });
  } catch (e) {
    state.chat.push({ role: 'assistant', content: `Sorry — the request failed: ${e.message}` });
  }
  state.busy = false; saveChat(); renderChat();
}
function openChat() { $('#chat').classList.remove('hidden-chat'); localStorage.setItem('gc-chat-open', '1'); }
$('#toggle-chat').onclick = () => { const c = $('#chat'); c.classList.toggle('hidden-chat'); localStorage.setItem('gc-chat-open', c.classList.contains('hidden-chat') ? '0' : '1'); Object.values(state.charts).forEach((ch) => ch.resize()); };
$('#chat-close').onclick = () => { $('#chat').classList.add('hidden-chat'); localStorage.setItem('gc-chat-open', '0'); };
$('#chat-clear').onclick = () => { state.chat = []; saveChat(); renderChat(); };
$('#chat-form').onsubmit = (e) => { e.preventDefault(); const v = $('#chat-input').value; $('#chat-input').value = ''; askCopilot(v); };
$('#chat-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#chat-form').requestSubmit(); } };
{ const pref = localStorage.getItem('gc-chat-open'); if (pref === '0' || (pref === null && window.innerWidth < 900)) $('#chat').classList.add('hidden-chat'); } // phones: start with the dashboard visible

// ------------------------------------------------------------------ global events
function goView(v) {
  if (!TITLES[v]) v = 'overview';
  state.view = v;
  $$('#nav a').forEach((x) => x.classList.toggle('active', x.dataset.view === v));
  if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v);
  if (state.snap) render();
}
$('#nav').onclick = (e) => { const a = e.target.closest('a[data-view]'); if (a) goView(a.dataset.view); };
window.addEventListener('hashchange', () => goView(location.hash.slice(1)));
if (location.hash) goView(location.hash.slice(1));
$('#asof').onchange = (e) => e.target.value && setAsOf(e.target.value);
$('#asof-range').oninput = (e) => { $('#asof').value = addDays(state.meta.range.min, Number(e.target.value)); };
$('#asof-range').onchange = (e) => setAsOf(addDays(state.meta.range.min, Number(e.target.value)));
$('#asof-prev').onclick = () => setAsOf(addDays(state.asOf, -7));
$('#asof-next').onclick = () => setAsOf(addDays(state.asOf, 7));
$('#asof-latest').onclick = () => setAsOf(state.meta.range.max);
document.addEventListener('click', (e) => {
  const ask = e.target.closest('[data-ask]'); if (ask) askCopilot(ask.dataset.ask);
  const tf = e.target.closest('[data-task-from]');
  if (tf) {
    const f = state.snap.diagnosis.find((x) => x.id === tf.dataset.taskFrom);
    const camp = f.suggested_task.campaign_id && state.meta.campaigns.find((c) => c.campaign_id === f.suggested_task.campaign_id);
    taskModal({ title: f.suggested_task.title, campaign_id: f.suggested_task.campaign_id, owner_id: camp ? camp.owner_id : '', priority: f.suggested_task.priority, notes: `From finding: ${f.title}\nEvidence: ${f.evidence.join('; ')}` });
  }
});

boot().then(renderChat).catch((e) => { document.body.innerHTML = `<p style="padding:30px">Could not load the Growth Center: ${esc(e.message)}</p>`; });
