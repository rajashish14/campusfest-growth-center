"""
CampusFest 2026 (Bengaluru) attendee target model.
Baseline rates come from the CampusFest 2025 dataset (deduplicated, external people only).
Everything else is an explicit assumption, listed in ASSUMPTIONS below.
Run: python target_model.py
"""
# ---- 2025 evidence (computed from Attendee Dataset.xlsx, see README section 3) ----
B25 = {  # spend INR, identified external people, registrations, confirmed (final), verified visitors
    "College Partnerships": dict(spend=31000, people=500, regs=450, conf=420, vis=385),
    "Student Referrals":    dict(spend=19000, people=410, regs=350, conf=320, vis=275),
    "Campus Ambassadors":   dict(spend=42000, people=600, regs=520, conf=480, vis=390),
    "Community Groups":     dict(spend=16000, people=250, regs=200, conf=185, vis=165),
    "Organic Search":       dict(spend=14000, people=290, regs=250, conf=225, vis=195),
    "Paid Social":          dict(spend=93000, people=960, regs=680, conf=580, vis=340),
    "Creator Partners":     dict(spend=59000, people=490, regs=350, conf=290, vis=175),
}
WALKINS_25 = 125

# ---- 2026 plan: same approved budget as the 2025 revised plan (INR 3,00,000) ----
ALLOC = {
    "College Partnerships": 75000,
    "Student Referrals":    35000,
    "Campus Ambassadors":   48000,
    "Community Groups":     24000,
    "Organic Search":       14000,
    "Paid Social":          40000,   # retargeting + lookalikes only, fatigue kill-rule
    "Creator Partners":     12000,   # 2 micro-creator tests, not a channel bet
}
SHOWUP_ENGINE = 22000      # WhatsApp reminders, QR pass, waitlist auto-release, 2 extra scanners
RECOVERY = 10000           # abandoned-registration recovery flows
RESERVE = 300000 - sum(ALLOC.values()) - SHOWUP_ENGINE - RECOVERY

SCEN = {
  # elasticity: people scale as (spend ratio)^e  -> diminishing returns when e<1
  # noshow_cut: relative reduction in confirmed no-shows from the show-up engine
  "base":    dict(e_up=0.75, e_down=0.85, reg_uplift=0.00, noshow_cut=0.15, recover=0.10,
                  waitlist_release=0.40, gate_recover=0.70, walkins=125, referral_k=0.00),
  "stretch": dict(e_up=0.90, e_down=0.85, reg_uplift=0.03, noshow_cut=0.25, recover=0.20,
                  waitlist_release=0.70, gate_recover=0.90, walkins=175, referral_k=0.12),
}
CAPACITY_DAILY = 2600        # assumed safe daily admission limit for the venue
DAY1_SHARE = 1430/2050       # 2025: 69.8% of unique visitors came on day 1 (busier day)

def run(name, p):
    rows, tot = [], dict(spend=0, people=0, regs=0, conf=0, vis=0)
    for ch, b in B25.items():
        r = ALLOC[ch] / b["spend"]
        e = p["e_up"] if r >= 1 else p["e_down"]
        people = b["people"] * r ** e
        reg_rate = min(0.95, b["regs"]/b["people"] + (p["reg_uplift"] if ch in ("College Partnerships","Student Referrals","Campus Ambassadors") else 0))
        conf_rate = b["conf"]/b["regs"]
        show = b["vis"]/b["conf"]
        show_new = 1 - (1-show)*(1-p["noshow_cut"])
        regs = people*reg_rate; conf = regs*conf_rate; vis = conf*show_new
        rows.append((ch, ALLOC[ch], people, regs, conf, vis, ALLOC[ch]/vis))
        for k,v in zip(("spend","people","regs","conf","vis"),(ALLOC[ch],people,regs,conf,vis)): tot[k]+=v
    # referral loop on top: k = extra registrations per registrant from "bring your squad" group unlocks
    ref_regs = tot["regs"]*p["referral_k"]
    ref_vis = ref_regs*(320/350)*(1-(1-275/320)*(1-p["noshow_cut"]))  # referral-channel confirm and show rates
    # abandoned-form recovery: 20% of identified people did not register in 2025 (700/3500)
    not_reg = tot["people"]-tot["regs"]; rec_regs = not_reg*p["recover"]; rec_vis = rec_regs*(2500/2800)*(1-0.23*(1-p["noshow_cut"]))
    # waitlist + gate: 2025 had 88 stuck waitlisted (3.1% of regs) and 60 confirmed people lost at the gate (2.4% of confirmed)
    wl = tot["regs"]*88/2800*p["waitlist_release"]*0.77
    gate = tot["conf"]*60/2500*p["gate_recover"]
    vis = tot["vis"]+ref_vis+rec_vis+wl+gate+p["walkins"]
    regs = tot["regs"]+ref_regs+rec_regs
    print(f"\n=== {name.upper()} ===")
    print(f"{'channel':22s}{'spend':>8s}{'people':>8s}{'regs':>7s}{'conf':>7s}{'vis':>7s}{'Rs/vis':>8s}")
    for r in rows: print(f"{r[0]:22s}{r[1]:8.0f}{r[2]:8.0f}{r[3]:7.0f}{r[4]:7.0f}{r[5]:7.0f}{r[6]:8.0f}")
    print(f"identified ext people (pre-event) {tot['people']:.0f}")
    print(f"registrations {regs:.0f}  (channels {tot['regs']:.0f} + referral loop {ref_regs:.0f} + recovered {rec_regs:.0f})")
    print(f"visitors from channels {tot['vis']:.0f} | referral loop {ref_vis:.0f} | recovered {rec_vis:.0f} | waitlist {wl:.0f} | gate {gate:.0f} | walk-ins {p['walkins']}")
    print(f"UNIQUE VERIFIED EXTERNAL VISITORS (demand) {vis:.0f}")
    d1 = vis*DAY1_SHARE
    print(f"day-1 unique visitors {d1:.0f} vs capacity {CAPACITY_DAILY} -> {'OK' if d1<=CAPACITY_DAILY else 'CAPACITY BINDS'}")
    cap_vis = min(vis, CAPACITY_DAILY/DAY1_SHARE)
    print(f"capacity-limited visitors {cap_vis:.0f}; blended cost/visitor Rs {300000/cap_vis:.0f}")
    return vis

print("reserve", RESERVE)
b = run("base", SCEN["base"]); s = run("stretch", SCEN["stretch"])
print(f"\n2025 actual: 2050 visitors at Rs {274000/2050:.0f}/visitor")
print(f"base vs 2025: +{b/2050-1:.0%} ; stretch vs 2025: +{s/2050-1:.0%}")
