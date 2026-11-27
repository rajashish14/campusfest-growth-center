"""Sensitivity of the base case to the assumptions we are least sure about."""
import importlib.util, io, contextlib
spec = importlib.util.spec_from_file_location("tm", "target_model.py")
tm = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(tm)
def v(**over):
    p = dict(tm.SCEN["base"]); p.update(over)
    with contextlib.redirect_stdout(io.StringIO()):
        return tm.run("x", p)
base = v()
print(f"base {base:.0f}")
for label, over in [
    ("scaling elasticity 0.5 instead of 0.75 (much faster saturation)", dict(e_up=0.5)),
    ("scaling elasticity 0.9 (near-linear)", dict(e_up=0.9)),
    ("reminders cut no-shows 0% (show-up engine fails)", dict(noshow_cut=0.0)),
    ("reminders cut no-shows 25% (meta-analysis central estimate)", dict(noshow_cut=0.25)),
    ("no walk-ins at all", dict(walkins=0)),
    ("the three main risks together: e=0.5, no reminder effect, no walk-ins", dict(e_up=0.5, noshow_cut=0.0, walkins=0)),
    ("...and the waitlist/gate fixes also fail (everything goes wrong)", dict(e_up=0.5, noshow_cut=0.0, walkins=0, waitlist_release=0, gate_recover=0)),
    ("e=0.5, no reminder effect, no waitlist/gate fix (walk-ins kept)", dict(e_up=0.5, noshow_cut=0.0, waitlist_release=0, gate_recover=0)),
]:
    x = v(**over); print(f"  {label:70s} {x:6.0f}  ({x-base:+.0f})")
# confirmed + show-rate per scenario (channel level)
for scen in ("base", "stretch"):
    p = tm.SCEN[scen]; conf = vis = 0
    for ch, b in tm.B25.items():
        r = tm.ALLOC[ch] / b["spend"]; e = p["e_up"] if r >= 1 else p["e_down"]
        people = b["people"] * r ** e
        reg = min(0.95, b["regs"]/b["people"] + (p["reg_uplift"] if ch in ("College Partnerships","Student Referrals","Campus Ambassadors") else 0))
        c = people*reg*b["conf"]/b["regs"]; s = 1-(1-b["vis"]/b["conf"])*(1-p["noshow_cut"])
        conf += c; vis += c*s
    print(f"{scen}: channel confirmed {conf:.0f}, channel visitors {vis:.0f}, show-rate {vis/conf:.1%}")
