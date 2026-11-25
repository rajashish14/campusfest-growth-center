"""Marginal contribution of each bet: run the full plan, then remove one bet at a time.
Removing a bet = put that budget line back to its 2025 value / switch the ops effect off.
Reuses the same equations as target_model.py."""
import importlib.util, io, contextlib, copy
spec = importlib.util.spec_from_file_location("tm", "target_model.py")
tm = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(tm)

def visitors(alloc, p):
    tm.ALLOC = alloc
    with contextlib.redirect_stdout(io.StringIO()):
        return tm.run("x", p)

FULL = dict(tm.ALLOC)
B25 = {k: v["spend"] for k, v in tm.B25.items()}
def without(bet, scen):
    a = dict(FULL); p = dict(tm.SCEN[scen])
    if bet == "1 Show-up engine": p.update(noshow_cut=0, waitlist_release=0, gate_recover=0)
    if bet == "2 College Partnerships 2.0": a["College Partnerships"] = B25["College Partnerships"]; p["reg_uplift"] = 0 if scen=="stretch" else p["reg_uplift"]
    if bet == "3 Bring-your-squad referrals": a["Student Referrals"] = B25["Student Referrals"]; p["referral_k"] = 0
    if bet == "4 Abandoned-form recovery": p["recover"] = 0
    if bet == "5 Paid Social on a leash (+ creator cut)":
        a["Paid Social"] = B25["Paid Social"]; a["Creator Partners"] = B25["Creator Partners"]
    return visitors(a, p)

bets = ["1 Show-up engine","2 College Partnerships 2.0","3 Bring-your-squad referrals","4 Abandoned-form recovery","5 Paid Social on a leash (+ creator cut)"]
cost = {"1 Show-up engine":22000,"2 College Partnerships 2.0":75000-31000,"3 Bring-your-squad referrals":35000-19000,"4 Abandoned-form recovery":10000,"5 Paid Social on a leash (+ creator cut)":(40000-93000)+(12000-59000)}
for scen in ("base","stretch"):
    full = visitors(dict(FULL), dict(tm.SCEN[scen]))
    print(f"\n{scen.upper()} full plan = {full:.0f} visitors")
    for b in bets:
        d = full - without(b, scen)
        c = cost[b]
        per = f"Rs {c/d:,.0f}/incremental visitor" if c>0 and d>0 else ("frees Rs %s" % f"{-c:,}" if c<0 else "")
        print(f"  {b:42s} {d:+6.0f} visitors   incremental budget Rs {c:+,}   {per}")
