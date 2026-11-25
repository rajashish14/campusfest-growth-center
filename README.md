# CampusFest 2026: Attendee Growth Strategy and Growth Center

**Ashish Ranjan Kumar · Roll no. 22CE36001 · RISA Labs Growth APM assignment**
**Challenge chosen: A, Attendee Growth.** City: **Bengaluru**.

> **Live app:** https://campusfest-growth-center-9exd.onrender.com · **Code:** https://github.com/rajashish14/campusfest-growth-center
> It is hosted on Render's free plan, so the first visit after ~15 idle minutes takes about 50 seconds to wake up. Edits made in the app are kept while it runs. *Data & settings → Reset* restores the original dataset at any time.

| Deliverable | Where |
|---|---|
| 3-slide strategy (PDF) | [`slides/Ashish_Ranjan_Kumar_22CE36001_Growth_Strategy.pdf`](slides/Ashish_Ranjan_Kumar_22CE36001_Growth_Strategy.pdf) (source: `slides/slides.html`) |
| Working product (dashboard, campaign and task manager, AI copilot) | [`growth-center/`](growth-center/). Run it locally in two commands (§9) or deploy with `render.yaml` |
| Target model and calculations | [`model/`](model/): `target_model.py`, `bet_contribution.py`, `sensitivity.py`, plus their saved outputs |
| This README | research, assumptions, calculations, sources, framework, setup, tools, limitations |

---

## 1. The short version

- **2025 baseline, after cleaning the data properly:** 2,050 verified unique external visitors against a goal of 2,200; 2,800 external registrations against 3,200; ₹2,74,000 spent of a ₹3,00,000 budget, or ₹134 per visitor.
- **Where it leaked:** 700 identified people never registered (275 of them started the form and stopped). 575 confirmed people did not come. 88 sat on the waitlist and were never released. 60 confirmed people were denied or stuck as pending at the gate.
- **Where the money went:** Paid Social and Creator Partners took **56% of spend** but produced **27% of campaign-attributed visitors**, at ₹274 and ₹337 per visitor. College Partnerships, Referrals and Organic produced visitors at **₹69–81**.
- **2026 target on the same ₹3L:** **2,550 verified visitors (base, +24%)** and **3,280 (stretch, +60%)**. The worst case in the sensitivity analysis is 2,158, which still beats 2025.
- **How:** move ₹1L from paid and creators into college clubs and referrals; add a show-up engine (reminders, QR pass, waitlist release, gate fix); recover form-abandoners; keep paid on a leash with a kill rule.
- **Proof the rules work:** replayed on the 2025 data, my fatigue rule flags Paid Social on **16 March 2025**. After that date it spent ₹25,800 for 61 visitors (₹423 each).

---

## 2. Why Bengaluru

1. **Campus density.** Bengaluru Urban has the most colleges of any district in India: **1,106** in AISHE 2021-22, ahead of Jaipur (703) and Hyderabad (491). It has led every AISHE edition I checked. My best channels (college clubs, referrals, ambassadors) scale with the number of campuses within commuting distance, not with ad budget.
2. **It fits the strategy.** Groups and peer invitations produce people who actually show up (81–92% show-rate in 2025). A city with many campuses lets me buy more of those.
3. **Sponsor upside.** A deep consumer-tech and D2C brand base. The sponsor dataset already links 3 sponsor activations to attendee campaigns, which could co-fund the group passes and squad rewards later.

I also considered Mumbai and Delhi NCR. Both are large, but the venue cost per square foot is higher and the colleges are more spread out, which works against a group-led, low-budget plan.

---

## 3. Data understanding and cleaning

The dataset's own "Read me" sheet describes several traps. The engine (`growth-center/lib/engine.js`) implements each one, and I cross-checked every headline number with an independent pandas script before writing a line of UI.

| Rule | What I did | Effect |
|---|---|---|
| Exact repeated IDs are import copies | Dedupe on stable IDs (`activity_id`, `history_id`, `event_id`, …) | 2 daily rows, 4 status rows and 20 check-in rows removed |
| Targets apply to external people | Exclude `internal`, `staff` and `test` person types | 40 internal registrations (all tagged Organic Search) and 40 staff/test/internal admissions excluded. Without this, Organic would look 16% better. |
| Only *admitted + verified* establishes a visit | 50 denied and 30 pending check-in events ignored; visitor = distinct `person_id` | 3,250 admission events → **2,050 unique visitors** (725 came both days) |
| Status = latest version at the snapshot | Status history replayed per registration; e.g. R0001 is cancelled on 10 March and confirmed again by 20 March | Final: 2,500 confirmed, 183 cancelled, 88 waitlisted, 29 interested |
| A snapshot means end of that day IST; no later data may leak in | Every query takes an `as_of` date and filters each table by its own timestamp | The "time machine" in the app |
| Reach and impressions are anonymous events | Never summed into "people"; shown separately from the identified funnel | Summed reach (6.66 L) is labelled as not unique |
| Spend is net (credits negative) | Kept negative rows (−₹3,000 Paid, −₹2,000 Creator, −₹500 Referrals) | Net spend ₹2,74,000 |
| Walk-ins have no campaign | Reported separately as unattributed | 125 walk-ins |

### Reconciled 2025 funnel by campaign (end state, 20 April 2025)

Attribution: people by first-touch campaign; registrations and visitors by registration campaign. These agree 100% in this dataset, which I checked.

| Campaign | Spend | Identified | Registered | Confirmed | Visitors | Reg. rate | Show-rate | ₹/visitor | Opt-out |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Campus Ambassadors | 42,000 | 600 | 520 | 480 | 390 | 86.7% | 81.3% | 108 | 3.0% |
| Paid Social | 93,000 | 960 | 680 | 580 | 340 | 70.8% | 58.6% | **274** | **12.2%** |
| Creator Partners | 59,000 | 490 | 350 | 290 | 175 | 71.4% | 60.3% | **337** | 8.8% |
| College Partnerships | 31,000 | 500 | 450 | 420 | 385 | **90.0%** | **91.7%** | 81 | 3.2% |
| Student Referrals | 19,000 | 410 | 350 | 320 | 275 | 85.4% | 85.9% | **69** | 3.4% |
| Organic Search | 14,000 | 290 | 250 | 225 | 195 | 86.2% | 86.7% | 72 | 3.8% |
| Community Groups | 16,000 | 250 | 200 | 185 | 165 | 80.0% | 89.2% | 97 | 4.0% |
| Walk-ins | – | 125 | – | – | 125 | – | – | – | – |
| **Total** | **2,74,000** | **3,625** | **2,800** | **2,500** | **2,050** | 80.0% | 77.0% | 134 | 6.3% |

These are covered by automated tests (`npm test`). If a number in the app ever drifts from this table, a test fails.

---

## 4. What the data says (the findings that shaped the plan)

1. **Paid Social burned out mid-campaign.** Weekly CTR was 2.6–3.0% through February, then fell to 1.2% from the week of 10 March. Weekly registrations dropped from ~110 to ~35, yet spend kept posting (₹9,600 roughly every 10 days). It also had the worst opt-out rate (12.2%) and show-rate (58.6%).
2. **College Partnerships started late, not weak.** It produced 0–28 registrations a week until mid-March, then 64→97 a week, with the best registration rate (90%) and show-rate (91.7%).
3. **The same pattern repeats across channels:** group and peer channels show up 81–92% of the time; cold-audience channels (paid, creators) about 59–60%.
4. **Show-up signals exist early.** Confirmed people who downloaded the brochure showed up 82.4% of the time vs 70.6% without (+11.8 pts). Those who asked an event question showed up 85.7%. Nurture emails show no difference (77.0% either way), so I don't count them as a lever.
5. **Operational leaks are concrete and fixable:** 88 waitlisted people were never released even though 183 cancellations freed seats; 60 confirmed people were lost at the gate; the 6 pm hour on day 1 took 400 admissions, about 2× a normal hour; 165 visitors were only ever checked in manually.
6. **There is a recoverable pool.** 700 identified people never registered. 275 of them started the form; 160 of the 700 opted out of nurture emails, so they should be excluded from re-contact.
7. **Show-rate rises with registration recency.** Confirmed registrants from mid-March onward showed up at 76–83%, against ~70% for mid-February cohorts. This argues for keeping late-stage campus pushes running.

---

## 5. Target model (slide 1)

**Method:** for each channel *c*, take its 2025 funnel rates (evidence) and change only the budget, with diminishing returns:

```
people_c(2026) = people_c(2025) × (spend_c(2026) / spend_c(2025)) ^ e     e = 0.75 base, 0.90 stretch when scaling up, 0.85 when cutting
regs_c        = people_c × regrate_c(2025)  (+3 pts for group channels in stretch)
confirmed_c   = regs_c × confirmrate_c(2025)
visitors_c    = confirmed_c × [1 − noshow_c(2025) × (1 − reminder_cut)]   reminder_cut = 15% base, 25% stretch
+ referral loop (k = 0 base, 0.12 stretch) + abandoned-form recovery (10% / 20%)
+ waitlist release (40% / 70% of the 3.1% stuck) + gate recovery (70% / 90% of the 2.4% lost) + walk-ins (125 / 175)
```

| Assumption | Base | Stretch | Type | Basis |
|---|---|---|---|---|
| Channel rates (reg, confirm, show) | 2025 actuals | 2025 actuals | Evidence | Dataset |
| Scale elasticity *e* | 0.75 | 0.90 | Assumption | Doubling spend → 1.7× people. Tested at 0.5 in the sensitivity analysis. |
| Reminder effect on no-shows | −15% | −25% | Assumption, anchored | Meta-analysis of 26 studies: RR 0.75 (−25%) |
| Referral k-factor | 0 | 0.12 | Assumption | Untested; has a week-2 indicator |
| Recovery of form-abandoners | 10% | 20% | Assumption | Untested; has a week-2 indicator |
| Venue daily capacity | 2,600 | 2,600 | Assumption | Day-1 share 69.8% (evidence) → ceiling ≈ 3,700 unique |
| Budget | ₹3,00,000 | ₹3,00,000 | Constraint | Same as the 2025 revised plan |

**Results** (`python model/target_model.py`):

| | 2025 actual | 2026 base | 2026 stretch |
|---|---:|---:|---:|
| Identified people | 3,500 | 3,505 | 3,740 |
| Registrations | 2,800 | 3,001 | 3,715 |
| Confirmed (channels) | 2,500 | 2,685 | 2,945 |
| Show-rate (channels) | 77.0% | 86.0% | 88.0% |
| **Verified unique visitors** | **2,050** | **2,548** | **3,277** |
| ₹ per visitor | 134 | 118 | 92 |
| Day-1 visitors vs 2,600 limit | 1,430 | 1,777 | 2,286 |

Most of the show-rate gain comes from **mix shift** (less money in channels that show up at 59–60%), not from the reminders.

**Sensitivity** (`python model/sensitivity.py`), base = 2,548:

| Scenario | Visitors |
|---|---:|
| Channels saturate fast (e = 0.5) | 2,288 |
| Reminders do nothing | 2,480 |
| No walk-ins | 2,423 |
| All of the above plus no waitlist or gate fix | **2,158** |
| Reminders work as in the meta-analysis | 2,593 |
| Near-linear scaling (e = 0.9) | 2,728 |

Audience pool sizes on slide 1 (60k club members, etc.) are **assumptions** used to show headroom. The model never uses them as inputs: it is driven by spend and 2025 rates, so a wrong pool estimate does not change the target.

---

## 6. Prioritisation (slide 2)

**Framework:** score = incremental visitors (base) × confidence ÷ incremental ₹10k, with ties going to the faster signal. Incremental visitors come from `model/bet_contribution.py`, which removes **one bet at a time from the full plan**, so overlapping bets are not double-counted.

| # | Bet | +Visitors base / stretch | Incremental ₹ | Confidence | Score |
|---|---|---:|---:|---:|---:|
| 1 | College Partnerships 2.0 | +381 / +623 | +44,000 | 0.8 | 69 |
| 2 | Bring-your-squad referrals | +171 / +549 | +16,000 | 0.6 | 64 |
| 3 | Show-up engine | +142 / +254 | +22,000 | 0.9 | 58 |
| 4 | Paid Social on a leash (+ creator cut) | −367 / −473 | **−1,00,000** | 0.9 | funding move |
| 5 | Abandoned-form recovery | +40 / +76 | +10,000 | 0.6 | 24 |

Confidence is 0.9 when my data and outside evidence agree, 0.8 when only my data supports it, and 0.6 for mechanics we haven't tried yet. Bet 4 loses 367 visitors but frees ₹1L. At bets 1–3's marginal cost (₹93–155 per visitor) that buys roughly 650–1,000 visitors, so each lost paid visitor is replaced about twice.

**Rejected or deprioritised:**
- **Scaling creators:** ₹337 per visitor and 60% show-rate. Kept as a ₹12k test.
- **Celebrity headliner:** it would take the whole budget and draw a non-student crowd into a capped venue. Mood Indigo cancelled its pre-registrations in 2025 after crowd chaos at the gate.
- **Sign-up freebies:** they inflate low-intent registrations, and free events already see a ~28% median no-show (PheedLoop).
- **Hoardings:** no way to attribute them to people.

---

## 7. Experimentation and adaptation (slide 3)

Every bet has a critical variable, an early signal by week 2, and pre-agreed scale, change and stop lines. Slide 3 has the full table. The thresholds are stored in the app as live **initiatives** (Decisions view), so the verdict updates when data changes.

**Backtest on 2025.** Stepping the snapshot date day by day:
- The creative-fatigue rule (CTR down ≥30% vs the previous 14 days) first fires for Paid Social on **2025-03-16** (2.7% → 1.8%). After that date Paid spent **₹25,800 and produced 61 visitors (₹423 each)**, against ₹81 per visitor at College Partnerships.
- The 2025-03-20 snapshot projects **~1,720 visitors** against the 2,200 goal (the actual was 2,050): the shortfall was visible three weeks out.

**The only clean causal test** in the plan is a 10% holdout for the reminders. Everything else is compared against 2025 baselines and is labelled correlational, both in the app and by the copilot.

---

## 8. The Growth Center (product)

Node.js and Express with a vanilla-JS frontend and Chart.js. Data is stored in JSON files on disk with atomic writes. The AI uses Gemini through REST function calling. There is no build step.

### How it maps to the brief

| Requirement | Where in the app |
|---|---|
| **1. Measure:** full funnel, campaign KPIs, targets vs actuals, conversion, budgets, projections | **Overview:** KPI cards vs the target version in force, weekly registrations vs goal pace, identified funnel, cost per outcome, spend share vs visitor share, gate load by hour. A **snapshot date selector** (date, ±7 days, slider) shows the business as it looked on any day. Before the event it shows projections built on stated assumptions; after, actuals. |
| **2. Diagnose:** what works, what doesn't, bottlenecks, drivers | **Campaigns:** scorecard with a rule-based **Scale / Hold / Fix / Cut** verdict and its reasons, 14-day trend windows, where each campaign leaks. **"What needs attention"** feed: target gaps, biggest funnel leak, weak stage per campaign, creative fatigue, spending into decline, cost outliers, opt-outs, abandoned starts, waitlist backlog, gate failures, budget pacing, overdue tasks. |
| **3. Decide:** prioritise, allocate, scale/change/stop | **Decisions:** the five bets with live KPI vs editable scale/stop thresholds; a **budget reallocation simulator** with diminishing returns; a decision log. Campaign status (active, scaling, paused, stopped) and planned budget can be set per campaign. |
| **4. Execute:** campaigns, tasks, owners, deadlines; data changes update analytics | **Execution:** kanban board (drag between columns), owners, deadlines, overdue flags at the snapshot date, AI-created tasks tagged. **Data & settings:** add or edit daily marketing rows, add target versions, change a registration's status, import a modified workbook, reset. Every write recomputes analytics, and all of it is persisted. |
| **5. AI Growth Analyst and Copilot** | Side panel on every page. See below. |

### Copilot design

- **Grounded, not decorative.** The model gets 12 tools that run on live app data: overview, campaign performance, funnel, time series, diagnosis, a **flexible `query_records` aggregator** over six deduplicated record-level views (for unfamiliar questions), an exact **calculator**, a budget simulator, tasks, initiatives, a **data dictionary**, and `propose_action`. The system prompt forbids stating any number that did not come from a tool in that turn.
- **Honest about limits.** The data dictionary lists what the data cannot answer: demographics, revenue or ROI, venue capacity, cancellation or no-show reasons, creative-level data, unique reach, satisfaction, external factors, and causal lift. The copilot checks it before answering questions about unknown fields.
- **Evidence vs assumption.** Projections, show-rate assumptions, simulator elasticity and any causal claim must be labelled as assumptions.
- **Insight → action with confirmation.** `propose_action` only creates a *proposal card*. Nothing changes until the user clicks **Confirm**, and the decision log records "copilot (confirmed by user)". Proposals are validated before they are shown, so a confirm never fails on bad input.
- **Follow-ups.** Conversation history is sent each turn. "It" and "that campaign" resolve from context.
- **Transparency.** Every answer shows an expandable tool trace (tool, arguments, result) and the snapshot date it used.
- **Never dead.** Gemini calls walk a chain of models (overloaded or retired models are skipped automatically). Without a `GEMINI_API_KEY`, or if every model in the chain fails, an **offline analyst** routes common questions (status, rankings, trends, diagnosis, simulations, tasks, refusals, follow-ups, drafting tasks or status changes) to the same tools. It is clearly labelled as offline, and it says when a question needs the full model.

### Demo workflow (what I walk through)

1. Set the snapshot to **2025-03-20**. Overview shows 1,778 registrations (56% of goal) and a projected ~1,720 visitors vs 2,200. The feed flags *"Paid Social: CTR down 46% in 14 days"* and *"registrations halved while spend continued"*.
2. Ask the copilot: *"Why is Paid Social underperforming?"* → a grounded diagnosis with the numbers. Follow-up: *"show the weekly CTR trend for it"* → weekly table from the time-series tool.
3. *"Move ₹20k from Paid Social to College Partnerships"* → simulation with the assumption labelled. On 20 March it shows only **+7 confirmed**, because College Partnerships had only just started ramping and its cost per confirmed was still ₹135. On the final snapshot the same shift is **+128 visitors**. The tool reports what the data says on that date; it doesn't echo my strategy back.
4. *"Pause it"* → a proposal card → **Confirm** → the campaign status changes and the decision log shows it was done by the copilot with user confirmation.
5. *"Create a task for #1"* → task proposal with owner Arjun Verma → Confirm → appears on the Execution board tagged AI.
6. *"What was the gender split of visitors?"* → "The data cannot answer this", naming what is missing and what would be needed.
7. Change the data: in Data & settings add ₹10,000 of Paid Social spend on 2025-04-11 → cost per visitor goes from ₹274 to ₹303, and the copilot's next answer uses the new number.

### Testing

`npm test` runs 33 automated checks against a throwaway data folder:
- baseline numbers (all of §3);
- snapshot rules (no visitors before the event, target versions switching on 15 March, status replay for R0001);
- data edits propagating (spend, duplicate-ID edits, new targets, status changes, reset, re-importing the workbook);
- execution (overdue detection);
- copilot (proposals not executed without confirmation, proposals that would change nothing rejected, refusals for demographics and ROI, follow-up context, numbers following changed data, a calculator that rejects code);
- a **mocked Gemini round trip** (function call → tool on live data → functionResponse sent back → proposal still pending), plus the fallback when Gemini returns 429.

I also checked every view visually in headless Chrome.

---

## 9. Setup

Requirements: Node 18+ (built and tested on Node 20).

```bash
cd growth-center
npm install
cp .env.example .env        # optional: paste a free Gemini key from https://aistudio.google.com/apikey
npm start                   # http://localhost:3000
npm test                    # 33 checks
```

- **First run** builds `data/raw.json` and `data/ops.json` from `data/Attendee Dataset.xlsx` (the original file is kept untouched for testing). **Reset** in *Data & settings* restores it.
- **Testing with changed data:** edit the workbook (keep the sheet names) and upload it in *Data & settings → Import workbook*, or edit rows in the app.
- **Deploy (free):** push this `submission` folder to GitHub → Render → *New → Blueprint* → select the repo (`render.yaml` is included) → add `GEMINI_API_KEY`. Note that Render's free disk is ephemeral: data edits persist while the service runs and reset to the original workbook on redeploy.
- `GEMINI_MODEL` can be set to any Gemini model that supports function calling (default `gemini-flash-latest`). If it is overloaded (503), rate-limited (429), retired (404) or slow (25s timeout), the copilot automatically moves along `GEMINI_FALLBACK_MODELS` (default `gemini-flash-lite-latest, gemini-3.5-flash-lite, gemini-3.8-flash`), skips failing models for a few minutes, and only then falls back to the offline analyst. I added this after Google retired `gemini-2.5-flash` for new keys during testing.

Model scripts: `cd model && python target_model.py && python bet_contribution.py && python sensitivity.py` (standard library only).

---

## 10. Tools used, and what was reused vs written

| Tool | Plan | Used for |
|---|---|---|
| VS Code | free | editing |
| Node.js 20, Express 4 | open source | API server |
| SheetJS `xlsx` 0.20.3 (official CDN build) | open source | reading the workbook. The npm 0.18.5 build was avoided because of known advisories. |
| Chart.js 4 | open source | charts |
| Google Gemini API (`gemini-flash-latest` with a fallback chain) via AI Studio | free tier | copilot reasoning with function calling |
| Python 3 + pandas | open source | independent verification of every headline number; target model |
| Headless Chrome | free | rendering the slides to PDF; visual checks of the app |
| Claude Code (Anthropic) | AI coding assistant | pair-programming and drafting code and copy, which I reviewed, ran and verified against the data |

No templates or UI kits were used. The analytics engine, decision rules, copilot tool layer, offline analyst, frontend and tests were written for this assignment. Every number in the slides was produced by the scripts in `model/` or by the app and checked against the pandas analysis.

---

## 11. Known limitations

- **Simulated future.** 2026 numbers are a model on 2025 data, and the elasticities and new-mechanic effects are assumptions (labelled everywhere). The plan includes holdouts and week-2 gates to replace them with evidence quickly.
- **Attribution is single-touch.** The dataset records one acquisition campaign per person; multi-touch effects (e.g. paid ads warming people who later register through a friend) are invisible. Paid Social may be slightly undervalued, which is why it is leashed rather than killed.
- **No causal lift.** There were no holdouts in 2025, so channel comparisons are correlational.
- **Capacity** (2,600 a day) is an assumption, because the dataset has no venue numbers.
- **The offline analyst** handles common question types only. Open-ended questions need the Gemini key.
- **Persistence is file-based** with a single writer. That is fine for a team tool and a demo, but a production version would use a database (e.g. Supabase) with authentication and per-user audit trails.
- **No authentication.** Anyone with the link can edit. That is acceptable for a review demo but not for production.
- **Gemini integration** is tested with a mocked API and implemented to the published REST spec. Live behaviour depends on the model version and quota.

---

## 12. Sources

- AISHE 2021-22 district college counts (Bengaluru Urban 1,106; Jaipur 703; Hyderabad 491): Ministry of Education AISHE report, as reported by [Deccan Herald](https://deccanherald.com/india/bangalore-urban-district-tops-list-with-highest-number-of-colleges-1186213.html) and [Careers360](https://news.careers360.com/up-has-highest-number-of-colleges-in-country-followed-maharashtra-karnataka-aishe-report).
- Robotham D. et al. (2016), *Using digital notifications to improve attendance in clinic: systematic review and meta-analysis*, BMJ Open (26 studies; no-show RR 0.75): [PubMed 27798006](https://pubmed.ncbi.nlm.nih.gov/27798006/).
- Free-event no-show benchmarks: [PheedLoop Event Data Lab #05](https://pheedloop.com/blog/event-data-lab-report-5) (median ~20% overall, ~28% free events); [Eventbrite](https://www.eventbrite.co.uk/blog/how-to-manage-attendance-free-events-ds00/) (up to 50% reported by organisers).
- Mood Indigo 2025 pre-registrations cancelled after crowding at the gate: [Careers360](https://news.careers360.com/iit-bombay-cancels-mood-indigo-pre-registrations-stops-entry-outsiders-crowd-chaos-seedhe-maut-concert-sonu-nigam-vicky-kaushal).
- WhatsApp Business marketing message pricing in India (~₹0.86–1.09 per message): [Meta pricing docs](https://developers.facebook.com/docs/whatsapp/pricing), [MyOperator](https://myoperator.com/blog/whatsapp-business-api-pricing-india-2026).
- Meta ads CPM/CTR ranges for India (context for the paid-social thresholds): [OwlClaw benchmarks](https://owlclaw.com/benchmarks/meta-ads-benchmarks-india), [upGrowth](https://upgrowth.in/instagram-ads-pricing-india-2026/).
- CampusFest 2025 attendee dataset (provided; fictional and synthetic).
