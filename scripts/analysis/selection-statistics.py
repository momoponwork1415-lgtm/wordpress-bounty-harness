#!/usr/bin/env python3
"""Retrospective selection statistics for docs/reviews/2026-10-19-selection-statistics.md.

Inputs (both public, both read-only):
  --mirror  SQLite mirror of the Wordfence Intelligence feed (wordfence-history/v1 projection).
  --wporg   Directory of raw WordPress.org `query_plugins` responses (popular pages + policy tags).

Outputs aggregate tables only (counts, rates, lifts). No titles, descriptions, CVE ids or
researcher names are printed; researchers are reduced to anonymous counts via hashing.

Usage:
  python3 -I scripts/analysis/selection-statistics.py --mirror history.sqlite --wporg ./wporg > tables.md
"""

import argparse
import collections
import datetime as dt
import glob
import hashlib
import json
import os
import sqlite3
import statistics

PAYING = {
    "stored-xss",
    "sql-injection",
    "privilege-escalation",
    "privilege-escalation-to-admin",
    "authentication-bypass",
    "authentication-bypass-to-admin",
    "arbitrary-file-upload",
    "remote-code-execution",
}
POLICY_TAGS = {"forms", "contact-form", "membership", "page-builder", "elementor-addons", "multilingual", "backup", "booking"}
INSTALL_BANDS = [(0, 100_000, "<100k"), (100_000, 200_000, "100k-200k"), (200_000, 500_000, "200k-500k"),
                 (500_000, 1_000_000, "500k-1M"), (1_000_000, 5_000_000, "1M-5M"), (5_000_000, 10**12, ">5M")]
OWNER_REPORTS = [  # slug, report date (public CVE dates; aggregates only)
    ("custom-facebook-feed", "2026-09-01"), ("booking", "2026-08-30"), ("learnpress", "2026-08-30"),
    ("translatepress-multilingual", "2026-08-11"), ("translatepress-multilingual", "2026-07-30"),
    ("translatepress-multilingual", "2026-07-25"), ("geodirectory", "2026-08-11"), ("ad-inserter", "2026-08-08"),
    ("unlimited-elements-for-elementor", "2026-08-06"), ("unlimited-elements-for-elementor", "2026-08-01"),
    ("newsletter", "2026-08-03"), ("relevanssi", "2026-08-01"), ("sitepress-multilingual-cms", "2026-03-21"),
    ("woo-product-filter", "2026-03-21"), ("wp-user-frontend", "2026-03-09"), ("cost-calculator-builder", "2026-03-08"),
    ("lifterlms", "2026-03-08"), ("brizy", "2026-03-07"), ("booking-package", "2026-03-07"), ("tutor", "2026-03-04"),
    ("simply-schedule-appointments", "2026-03-03"),
]
TODAY = dt.date(2026, 10, 19)


def d(s):
    return dt.date.fromisoformat(s[:10])


def band(installs):
    for lo, hi, name in INSTALL_BANDS:
        if lo <= installs < hi:
            return name
    return "?"


def bucket(n, edges):
    """edges: list of (upper_inclusive, label); last label is used when above all."""
    for upper, label in edges:
        if n <= upper:
            return label
    return edges[-1][1]


def load_wporg(directory):
    plugins = {}
    for path in sorted(glob.glob(os.path.join(directory, "*.json"))):
        label = os.path.basename(path).rsplit("-", 1)[0]
        with open(path) as f:
            page = json.load(f)
        for p in page.get("plugins", []):
            slug = p["slug"]
            row = plugins.setdefault(slug, {
                "slug": slug, "installs": int(p.get("active_installs") or 0),
                "last_updated": p.get("last_updated"), "added": p.get("added"), "version": p.get("version"),
                "tags": set((p.get("tags") or {}).keys()) if isinstance(p.get("tags"), dict) else set(p.get("tags") or []),
                "author": p.get("author"), "requires_plugins": list(p.get("requires_plugins") or []),
                "sources": set(),
            })
            row["sources"].add(label)
    return plugins


def load_records(mirror):
    """One row per (record, plugin slug). Researchers hashed to anonymous ids."""
    con = sqlite3.connect(f"file:{mirror}?mode=ro", uri=True)
    sig = collections.defaultdict(set)
    for vid, value in con.execute("select vulnerability_id, value from signals"):
        sig[vid].add(value)
    soft = collections.defaultdict(list)
    for vid, slug in con.execute("select vulnerability_id, slug from software where type='plugin'"):
        soft[vid].append(slug)
    rows = []
    for vid, published, informational, rj in con.execute(
            "select id, published, informational, record_json from vulnerabilities"):
        if vid not in soft or not published:
            continue
        j = json.loads(rj)
        vector = (j.get("cvss") or {}).get("vector") or ""
        pr = dict(p.split(":", 1) for p in vector.split("/")[1:] if ":" in p).get("PR")
        researchers = frozenset(hashlib.sha256(r.strip().lower().encode()).hexdigest()[:16]
                                for r in (j.get("researchers") or []) if isinstance(r, str) and r.strip())
        paying = bool(sig[vid] & PAYING)
        for slug in soft[vid]:
            rows.append({
                "id": vid, "slug": slug, "published": d(published), "informational": bool(informational),
                "pr": pr, "paying": paying, "outcome_c": paying and pr in ("N", "L"), "researchers": researchers,
                "reward": reward_proxy(sig[vid], pr) if paying else 0.0,
                "high_value": bool(sig[vid] & (PAYING - {"stored-xss"})),
            })
    return rows


# Reward proxy per record, from the Wordfence Bug Bounty monthly reports Jul 2025 - Jun 2026 (public blog):
# 12-month average reward by vulnerability type, and the unauthenticated / subscriber average (316 / 216 USD)
# expressed as a multiplier around their submissions-weighted mean (282 USD). A proxy, not a payout prediction.
CLASS_VALUE_USD = {
    "stored-xss": 92, "sql-injection": 175, "arbitrary-file-upload": 471, "privilege-escalation": 434,
    "privilege-escalation-to-admin": 434, "authentication-bypass": 1620, "authentication-bypass-to-admin": 1620,
    "remote-code-execution": 455,
}
AUTH_MULTIPLIER = {"N": 316 / 282, "L": 216 / 282}


def reward_proxy(signals, pr):
    values = [CLASS_VALUE_USD[s] for s in signals if s in CLASS_VALUE_USD]
    if not values or pr not in AUTH_MULTIPLIER:
        return 0.0
    return max(values) * AUTH_MULTIPLIER[pr]


def features_at(records_by_slug, slug, cutoff):
    recs = [r for r in records_by_slug.get(slug, []) if r["published"] <= cutoff and not r["informational"]]
    recent = [r for r in recs if (cutoff - r["published"]).days < 365]
    last = max((r["published"] for r in recs), default=None)
    researchers = set()
    for r in recent:
        researchers |= r["researchers"]
    return {
        "n365": len(recent),
        "paying365": sum(1 for r in recent if r["paying"]),
        "highvalue365": sum(1 for r in recent if r["paying"] and r["high_value"]),
        "c365": sum(1 for r in recent if r["outcome_c"]),
        "days_since_last": (cutoff - last).days if last else None,
        "researchers365": len(researchers),
        "n_all": len(recs),
    }


def outcomes_in(records_by_slug, slug, start, end):
    recs = [r for r in records_by_slug.get(slug, []) if start < r["published"] <= end]
    return {
        "A": any(not r["informational"] for r in recs),
        "B": any(r["paying"] and not r["informational"] for r in recs),
        "C": any(r["outcome_c"] and not r["informational"] for r in recs),
        # D: reward proxy summed over the plugin's outcome-C records in the window (USD, proxy)
        "D": sum(r["reward"] for r in recs if r["outcome_c"] and not r["informational"]),
    }


def feature_labels(p, f):
    return {
        "install_band": band(p["installs"]),
        "records_365": bucket(f["n365"], [(0, "0"), (1, "1"), (4, "2-4"), (9, "5-9"), (10**9, "10+")]),
        "paying_365": bucket(f["paying365"], [(0, "0"), (1, "1"), (10**9, "2+")]),
        "outcome_c_class_365": bucket(f["c365"], [(0, "0"), (1, "1"), (10**9, "2+")]),
        "days_since_last_record": ("none" if f["days_since_last"] is None else
                                   bucket(f["days_since_last"], [(90, "<=90"), (365, "91-365"), (10**9, ">365")])),
        "researchers_365": bucket(f["researchers365"], [(0, "0"), (1, "1"), (3, "2-3"), (10**9, "4+")]),
        "plugin_age_years": ("?" if not p["added"] else
                             bucket((TODAY - d(p["added"])).days // 365, [(1, "<2y"), (4, "2-4y"), (9, "5-9y"), (10**9, "10y+")])),
        "days_since_last_updated(leak)": ("?" if not p["last_updated"] else
                                         bucket((TODAY - d(p["last_updated"])).days, [(30, "<=30"), (90, "31-90"), (365, "91-365"), (10**9, ">365")])),
        "policy_tag": "yes" if p["tags"] & POLICY_TAGS else "no",
        "requires_plugins": "yes" if p["requires_plugins"] else "no",
    }


def score(p, f, weights):
    """Additive, hand-writable. Terms mirror what selection.json can hold."""
    import math
    s = 0.0
    s += weights.get("payingClass", 0) * min(f["paying365"], weights.get("payingClassCap", 3))
    s += weights.get("highValue", 0) * min(f["highvalue365"], weights.get("payingClassCap", 3))
    if f["days_since_last"] is not None:
        s += weights.get("recordRecency", 0) * max(0.0, 1 - f["days_since_last"] / 365)
    s += weights.get("records", 0) * min(f["n365"], weights.get("recordsCap", 5))
    s += weights.get("installations", 0) * math.log10(1 + p["installs"])
    return s


def fmt(x):
    return f"{x:.1%}" if isinstance(x, float) else str(x)


def table(title, rows, header):
    out = [f"\n### {title}\n", "| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    for r in rows:
        out.append("| " + " | ".join(fmt(c) for c in r) + " |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mirror", required=True)
    ap.add_argument("--wporg", required=True)
    args = ap.parse_args()

    plugins = load_wporg(args.wporg)
    rows = load_records(args.mirror)
    by_slug = collections.defaultdict(list)
    for r in rows:
        by_slug[r["slug"]].append(r)
    print(f"plugins pulled: {len(plugins)}; mirror plugin-record rows: {len(rows)}; "
          f"pulled plugins with >=1 mirror record: {sum(1 for s in plugins if s in by_slug)}")
    print("sources:", dict(collections.Counter(src for p in plugins.values() for src in p['sources'])))
    print("install bands:", dict(collections.Counter(band(p['installs']) for p in plugins.values())))

    cutoffs = {"T1": (dt.date(2026, 4, 14), 183), "T2": (dt.date(2025, 10, 14), 365)}
    weights_candidates = {
        "W-pay": {"payingClass": 1},
        "W-pay+rec": {"payingClass": 1, "recordRecency": 1},
        "W-pay+rec+n": {"payingClass": 1, "recordRecency": 1, "records": 0.25},
        "W-pay+rec+n+inst": {"payingClass": 1, "recordRecency": 1, "records": 0.25, "installations": 0.5},
        "W-current(inst+wporg-recency)": None,  # computed separately below
    }

    for name, (cutoff, window) in cutoffs.items():
        end = cutoff + dt.timedelta(days=window)
        pop = []
        for slug, p in plugins.items():
            f = features_at(by_slug, slug, cutoff)
            o = outcomes_in(by_slug, slug, cutoff, end)
            pop.append((slug, p, f, o, feature_labels(p, f)))
        n = len(pop)
        base = {k: sum(1 for *_, o, _l in pop if o[k]) / n for k in "ABC"}
        print(f"\n## {name}: cutoff {cutoff}, window ({cutoff}, {end}] — N={n}; base A={base['A']:.1%} B={base['B']:.1%} C={base['C']:.1%} "
              f"(C count {sum(1 for *_, o, _l in pop if o['C'])})")
        in_band = [x for x in pop if 100_000 <= x[1]["installs"] < 1_000_000]
        nb = len(in_band)
        base_band = {k: sum(1 for *_, o, _l in in_band if o[k]) / nb for k in "ABC"}
        print(f"100k-1M band: N={nb}; base A={base_band['A']:.1%} B={base_band['B']:.1%} C={base_band['C']:.1%} "
              f"(C count {sum(1 for *_, o, _l in in_band if o['C'])})")

        for feat in pop[0][4].keys():
            groups = collections.defaultdict(list)
            for slug, p, f, o, labels in pop:
                groups[labels[feat]].append(o)
            trs = []
            for label, os_ in sorted(groups.items(), key=lambda kv: kv[0]):
                cnt = len(os_)
                rates = {k: sum(1 for o in os_ if o[k]) / cnt for k in "ABC"}
                trs.append((label, cnt, rates["A"], f"{rates['A'] / base['A']:.2f}", rates["B"], f"{rates['B'] / base['B']:.2f}",
                            rates["C"], f"{rates['C'] / base['C']:.2f}"))
            print(table(f"{name} × {feat}", trs, ["値", "n", "A率", "A lift", "B率", "B lift", "C率", "C lift"]))

        # same for the band only, for the features that matter
        for feat in ["paying_365", "days_since_last_record", "records_365", "researchers_365", "install_band"]:
            groups = collections.defaultdict(list)
            for slug, p, f, o, labels in in_band:
                groups[labels[feat]].append(o)
            trs = []
            for label, os_ in sorted(groups.items()):
                cnt = len(os_)
                rc = sum(1 for o in os_ if o["C"]) / cnt
                trs.append((label, cnt, rc, f"{rc / base_band['C']:.2f}" if base_band["C"] else "-"))
            print(table(f"{name} 100k-1M band × {feat} (outcome C)", trs, ["値", "n", "C率", "C lift"]))

        # cross: paying_365 × days_since_last_record (outcome C) on full population
        groups = collections.defaultdict(list)
        for slug, p, f, o, labels in pop:
            groups[(labels["paying_365"], labels["days_since_last_record"])].append(o)
        trs = []
        for (a, b), os_ in sorted(groups.items()):
            cnt = len(os_)
            rc = sum(1 for o in os_ if o["C"]) / cnt
            trs.append((f"{a} / {b}", cnt, rc, f"{rc / base['C']:.2f}"))
        print(table(f"{name} paying_365 × days_since_last_record (outcome C)", trs, ["paying365 / last record", "n", "C率", "C lift"]))

        # ranking precision
        print(f"\n### {name} ranking precision for outcome C (full population N={n}, band N={nb})\n")
        print("| score | top-50 全体 | top-100 全体 | top-50 帯 | top-100 帯 | 帯 base |")
        print("|---|---|---|---|---|---|")
        import math
        for wname, w in weights_candidates.items():
            def sc(x):
                slug, p, f, o, labels = x
                if w is None:
                    upd = (TODAY - d(p["last_updated"])).days if p["last_updated"] else 365
                    return 10 * math.log10(1 + p["installs"]) + 5 * max(0.0, 1 - upd / 365)
                return score(p, f, w)
            ranked = sorted(pop, key=lambda x: (-sc(x), x[0]))
            rankedb = sorted(in_band, key=lambda x: (-sc(x), x[0]))
            def prec(lst, k):
                top = lst[:k]
                return sum(1 for x in top if x[3]["C"]) / len(top)
            print(f"| {wname} | {prec(ranked, 50):.0%} | {prec(ranked, 100):.0%} | {prec(rankedb, 50):.0%} | {prec(rankedb, 100):.0%} | {base_band['C']:.1%} |")

        # duplicate-risk side
        multi = [(slug, f) for slug, p, f, o, labels in pop if f["n365"] >= 2]
        dist = collections.Counter(bucket(f["researchers365"], [(1, "1"), (2, "2"), (3, "3"), (10**9, "4+")]) for _, f in multi)
        print(f"\n### {name} duplicate risk\n")
        print(f"plugins with >=2 records in prior 365d: {len(multi)}; distinct-researcher distribution: {dict(sorted(dist.items()))}")
        same = total = same365 = 0
        for slug, p, f, o, labels in pop:
            recs = sorted(by_slug.get(slug, []), key=lambda r: r["published"])
            for i, r in enumerate(recs):
                if not (cutoff < r["published"] <= end and r["outcome_c"] and not r["informational"]):
                    continue
                total += 1
                earlier = [e for e in recs[:i] if e["published"] < r["published"]]
                if any(e["researchers"] & r["researchers"] for e in earlier if r["researchers"]):
                    same += 1
                if any(e["researchers"] & r["researchers"] for e in earlier if r["researchers"] and (r["published"] - e["published"]).days <= 365):
                    same365 += 1
        print(f"outcome-C records in window (pulled plugins): {total}; same researcher as an earlier record on the same plugin: "
              f"{same} ({same / total:.1%}); within prior 365d: {same365} ({same365 / total:.1%})")

        # finer install bands below 100k (floor cascade 100k -> 50k -> 30k) and above 1M
        fine = [(0, 10_000, "<10k"), (10_000, 30_000, "10k-30k"), (30_000, 50_000, "30k-50k"), (50_000, 100_000, "50k-100k"),
                (100_000, 1_000_000, "100k-1M"), (1_000_000, 10**12, ">=1M")]
        trs = []
        for lo, hi, label in fine:
            grp = [x for x in pop if lo <= x[1]["installs"] < hi]
            if not grp:
                continue
            rc = sum(1 for x in grp if x[3]["C"]) / len(grp)
            rc_pay = [x for x in grp if x[2]["paying365"] >= 1]
            rc_pay_rate = sum(1 for x in rc_pay if x[3]["C"]) / len(rc_pay) if rc_pay else 0.0
            trs.append((label, len(grp), rc, f"{rc / base['C']:.2f}", len(rc_pay), rc_pay_rate))
        print(table(f"{name} fine install bands (outcome C; right two columns: plugins with paying365>=1)", trs,
                    ["帯", "n", "C率", "C lift", "n(paying365>=1)", "C率(paying365>=1)"]))

        many = [x for x in pop if x[2]["researchers365"] >= 4]
        print(f"\nresearchers365>=4: n={len(many)}, of which paying365>=2: {sum(1 for x in many if x[2]['paying365'] >= 2)}, paying365>=1: {sum(1 for x in many if x[2]['paying365'] >= 1)}")

        # weight sensitivity on the band (top-50 precision for C)
        variants = {
            "pay1": {"payingClass": 1},
            "pay1 cap2": {"payingClass": 1, "payingClassCap": 2},
            "pay1+rec0.5": {"payingClass": 1, "recordRecency": 0.5},
            "pay1+rec1": {"payingClass": 1, "recordRecency": 1},
            "pay1+rec2": {"payingClass": 1, "recordRecency": 2},
            "pay1+rec1+n0.25": {"payingClass": 1, "recordRecency": 1, "records": 0.25},
            "pay1+rec1+n0.5": {"payingClass": 1, "recordRecency": 1, "records": 0.5},
            "pay1+rec1+n0.25+inst0.5": {"payingClass": 1, "recordRecency": 1, "records": 0.25, "installations": 0.5},
            "pay1+rec1+n0.25+inst1": {"payingClass": 1, "recordRecency": 1, "records": 0.25, "installations": 1},
            "pay1+rec1+inst0.5": {"payingClass": 1, "recordRecency": 1, "installations": 0.5},
            "rec1 only": {"recordRecency": 1},
            "n0.25 only": {"records": 0.25},
        }
        print(f"\n### {name} weight sensitivity (band N={nb}, outcome C)\n")
        print("| weights | top-10 | top-25 | top-50 | top-100 | 全体 top-50 |")
        print("|---|---|---|---|---|---|")
        for vname, w in variants.items():
            rankedb = sorted(in_band, key=lambda x: (-score(x[1], x[2], w), x[0]))
            ranked = sorted(pop, key=lambda x: (-score(x[1], x[2], w), x[0]))
            def prec(lst, k):
                top = lst[:k]
                return sum(1 for x in top if x[3]["C"]) / len(top)
            print(f"| {vname} | {prec(rankedb, 10):.0%} | {prec(rankedb, 25):.0%} | {prec(rankedb, 50):.0%} | {prec(rankedb, 100):.0%} | {prec(ranked, 50):.0%} |")

        # reward-weighted view (outcome D = reward proxy summed over outcome-C records in the window)
        pop_mean_d = sum(x[3]["D"] for x in pop) / n
        band_mean_d = sum(x[3]["D"] for x in in_band) / nb
        print(f"\n### {name} reward proxy D (USD per plugin in window; population mean {pop_mean_d:.0f}, band mean {band_mean_d:.0f})\n")
        print("| 群 | n | 平均D | D>0 の割合 | D>0 のときの平均D |")
        print("|---|---|---|---|---|")
        for lo, hi, label in fine:
            grp = [x for x in pop if lo <= x[1]["installs"] < hi]
            if not grp:
                continue
            pos = [x for x in grp if x[3]["D"] > 0]
            print(f"| install {label} | {len(grp)} | {sum(x[3]['D'] for x in grp) / len(grp):.0f} | {len(pos) / len(grp):.1%} | {(sum(x[3]['D'] for x in pos) / len(pos)) if pos else 0:.0f} |")
        for label in ["0", "1", "2+"]:
            grp = [x for x in in_band if x[4]["paying_365"] == label]
            pos = [x for x in grp if x[3]["D"] > 0]
            print(f"| 帯内 paying365={label} | {len(grp)} | {sum(x[3]['D'] for x in grp) / len(grp):.0f} | {len(pos) / len(grp):.1%} | {(sum(x[3]['D'] for x in pos) / len(pos)) if pos else 0:.0f} |")
        print(f"\n### {name} top-50 mean reward proxy D by score (band; band mean {band_mean_d:.0f})\n")
        print("| weights | band top-50 mean D | band top-50 C精度 | 全体 top-50 mean D | 全体 top-50 C精度 |")
        print("|---|---|---|---|---|")
        for vname, w in {
            "pay1+rec1+inst0.5 (proposed)": {"payingClass": 1, "recordRecency": 1, "installations": 0.5},
            "pay1+rec1+n0.25+inst0.5": {"payingClass": 1, "recordRecency": 1, "records": 0.25, "installations": 0.5},
            "pay1+hv1+rec1+inst0.5": {"payingClass": 1, "highValue": 1, "recordRecency": 1, "installations": 0.5},
            "hv1+rec1+inst0.5": {"highValue": 1, "recordRecency": 1, "installations": 0.5},
            "pay1": {"payingClass": 1},
        }.items():
            rankedb = sorted(in_band, key=lambda x: (-score(x[1], x[2], w), x[0]))[:50]
            ranked = sorted(pop, key=lambda x: (-score(x[1], x[2], w), x[0]))[:50]
            print(f"| {vname} | {sum(x[3]['D'] for x in rankedb) / 50:.0f} | {sum(1 for x in rankedb if x[3]['C']) / 50:.0%} | {sum(x[3]['D'] for x in ranked) / 50:.0f} | {sum(1 for x in ranked if x[3]['C']) / 50:.0%} |")
        cur_ranked = sorted(in_band, key=lambda x: (-(10 * math.log10(1 + x[1]["installs"]) + 5 * max(0.0, 1 - ((TODAY - d(x[1]["last_updated"])).days if x[1]["last_updated"] else 365) / 365)), x[0]))[:50]
        print(f"| current(inst+wporg-recency) | {sum(x[3]['D'] for x in cur_ranked) / 50:.0f} | {sum(1 for x in cur_ranked if x[3]['C']) / 50:.0%} | - | - |")

        # threshold pools in the band: how many candidates and their C rate
        print(f"\n### {name} band candidate pools by threshold (outcome C)\n")
        print("| 条件 | n | C率 |")
        print("|---|---|---|")
        for label, pred in [
            ("paying365>=1", lambda f: f["paying365"] >= 1),
            ("paying365>=2", lambda f: f["paying365"] >= 2),
            ("paying365>=1 かつ 最終記録<=90日", lambda f: f["paying365"] >= 1 and f["days_since_last"] is not None and f["days_since_last"] <= 90),
            ("paying365>=1 かつ 最終記録<=180日", lambda f: f["paying365"] >= 1 and f["days_since_last"] is not None and f["days_since_last"] <= 180),
            ("n365>=1", lambda f: f["n365"] >= 1),
            ("最終記録<=90日", lambda f: f["days_since_last"] is not None and f["days_since_last"] <= 90),
            ("記録なし(全期間)", lambda f: f["n_all"] == 0),
        ]:
            grp = [x for x in in_band if pred(x[2])]
            rc = sum(1 for x in grp if x[3]["C"]) / len(grp) if grp else 0.0
            print(f"| {label} | {len(grp)} | {rc:.1%} |")

    # inter-record gaps on the same plugin (band): justifies a revisit interval
    gaps = []
    gaps_c = []
    for slug, p in plugins.items():
        if not (100_000 <= p["installs"] < 1_000_000):
            continue
        recs = sorted({(r["published"], r["id"]) for r in by_slug.get(slug, []) if not r["informational"] and r["published"] >= dt.date(2023, 10, 14)})
        dates = sorted({x[0] for x in recs})
        gaps += [(b - a).days for a, b in zip(dates, dates[1:])]
        cdates = sorted({r["published"] for r in by_slug.get(slug, []) if r["outcome_c"] and not r["informational"] and r["published"] >= dt.date(2023, 10, 14)})
        gaps_c += [(b - a).days for a, b in zip(cdates, cdates[1:])]
    def q(xs, p):
        xs = sorted(xs)
        return xs[int(p * (len(xs) - 1))] if xs else None
    print("\n## Inter-record gaps on the same plugin, 100k-1M band, records published since 2023-10-14 (distinct publish dates)\n")
    print(f"all records: n gaps={len(gaps)}; p25={q(gaps, .25)} median={q(gaps, .5)} p75={q(gaps, .75)} days; share <=90d {sum(1 for g in gaps if g <= 90) / len(gaps):.1%}; <=180d {sum(1 for g in gaps if g <= 180) / len(gaps):.1%}")
    print(f"outcome-C records: n gaps={len(gaps_c)}; p25={q(gaps_c, .25)} median={q(gaps_c, .5)} p75={q(gaps_c, .75)} days; share <=90d {sum(1 for g in gaps_c if g <= 90) / len(gaps_c):.1%}; <=180d {sum(1 for g in gaps_c if g <= 180) / len(gaps_c):.1%}")

    # current pool as of the mirror date (operational numbers for the next weeks)
    now = dt.date(2026, 10, 14)
    print(f"\n## Current pool as of {now} (100k-1M band, features only)\n")
    cur = [(slug, p, features_at(by_slug, slug, now)) for slug, p in plugins.items() if 100_000 <= p["installs"] < 1_000_000]
    print(f"band N={len(cur)}; paying365>=1: {sum(1 for x in cur if x[2]['paying365'] >= 1)}; paying365>=2: {sum(1 for x in cur if x[2]['paying365'] >= 2)}; "
          f"last record <=90d: {sum(1 for x in cur if x[2]['days_since_last'] is not None and x[2]['days_since_last'] <= 90)}; "
          f"paying365>=1 and last<=90d: {sum(1 for x in cur if x[2]['paying365'] >= 1 and x[2]['days_since_last'] is not None and x[2]['days_since_last'] <= 90)}; "
          f"no record ever: {sum(1 for x in cur if x[2]['n_all'] == 0)}")
    for lo, hi, label in [(50_000, 100_000, "50k-100k"), (30_000, 50_000, "30k-50k"), (1_000_000, 10**12, ">=1M")]:
        grp = [(slug, p, features_at(by_slug, slug, now)) for slug, p in plugins.items() if lo <= p["installs"] < hi]
        print(f"{label}: N={len(grp)}; paying365>=1: {sum(1 for x in grp if x[2]['paying365'] >= 1)}; paying365>=2: {sum(1 for x in grp if x[2]['paying365'] >= 2)}")

    # does the current enumeration (popular 10 pages x 50 = top 500) cover the band?
    first500 = set()
    for path in sorted(glob.glob(os.path.join(args.wporg, "popular-00[12].json"))):
        with open(path) as f:
            first500 |= {x["slug"] for x in json.load(f)["plugins"]}
    bandslugs = {s for s, p in plugins.items() if 100_000 <= p["installs"] < 1_000_000}
    print(f"\n## Enumeration coverage: band plugins {len(bandslugs)}, of which in popular top-500 {len(bandslugs & first500)}; "
          f">=1M plugins in top-500: {sum(1 for s in first500 if plugins[s]['installs'] >= 1_000_000)}")
    first1000 = set()
    for path in sorted(glob.glob(os.path.join(args.wporg, "popular-00[1-4].json"))):
        with open(path) as f:
            first1000 |= {x["slug"] for x in json.load(f)["plugins"]}
    print(f"band plugins in popular top-1000: {len(bandslugs & first1000)}; 50k-100k plugins pulled: {sum(1 for p in plugins.values() if 50_000 <= p['installs'] < 100_000)}, in top-1000: {sum(1 for s in first1000 if 50_000 <= plugins[s]['installs'] < 100_000)}")

    # owner sanity check with the proposed weights and with the current score
    import math
    proposed = {"payingClass": 1, "recordRecency": 1, "installations": 0.5}
    def current_score(p):
        upd = (TODAY - d(p["last_updated"])).days if p["last_updated"] else 365
        return 10 * math.log10(1 + p["installs"]) + 5 * max(0.0, 1 - upd / 365)
    print("\n## Owner sanity check (proposed score pay1+rec1+inst0.5 vs current installs+wporg-recency; band as of today)\n")
    print("| # | 日付 | 帯(今日のinstall) | 提案: 帯内順位 / 帯N | 提案: 全体順位 / N | 現行: 帯内順位 | paying365 | 最終記録からの日数 | n365 |")
    print("|---|---|---|---|---|---|---|---|---|")
    ranks, ranks_cur, ranks_all = [], [], []
    for i, (slug, date) in enumerate(OWNER_REPORTS, 1):
        cutoff = d(date) - dt.timedelta(days=1)
        p = plugins.get(slug)
        f = features_at(by_slug, slug, cutoff)
        if p is None:
            print(f"| {i} | {date} | pull外 | - | - | - | {f['paying365']} | {f['days_since_last']} | {f['n365']} |")
            continue
        scored = sorted(((s2, score(p2, features_at(by_slug, s2, cutoff), proposed)) for s2, p2 in plugins.items()), key=lambda x: (-x[1], x[0]))
        rank_all = next(j for j, (s2, _) in enumerate(scored, 1) if s2 == slug)
        ranks_all.append(rank_all)
        bandlist = [s2 for s2, _ in scored if 100_000 <= plugins[s2]["installs"] < 1_000_000]
        inb = 100_000 <= p["installs"] < 1_000_000
        rank_band = bandlist.index(slug) + 1 if inb else None
        cur_sorted = sorted(bandlist, key=lambda s2: (-current_score(plugins[s2]), s2))
        rank_cur = cur_sorted.index(slug) + 1 if inb else None
        if inb:
            ranks.append(rank_band)
            ranks_cur.append(rank_cur)
        print(f"| {i} | {date} | {band(p['installs'])} | {rank_band if inb else '-'} / {len(bandlist)} | {rank_all} / {len(scored)} | {rank_cur if inb else '-'} | "
              f"{f['paying365']} | {f['days_since_last']} | {f['n365']} |")
    print(f"\nin-band reports: {len(ranks)}; proposed: median band rank {statistics.median(ranks)}, top-50 {sum(1 for r in ranks if r <= 50)}, top-100 {sum(1 for r in ranks if r <= 100)}; "
          f"current: median band rank {statistics.median(ranks_cur)}, top-50 {sum(1 for r in ranks_cur if r <= 50)}, top-100 {sum(1 for r in ranks_cur if r <= 100)}")
    print(f"all pulled reports: {len(ranks_all)}; proposed full-population median rank {statistics.median(ranks_all)}, top-100 {sum(1 for r in ranks_all if r <= 100)}, top-300 {sum(1 for r in ranks_all if r <= 300)}")
    owner_f = [features_at(by_slug, s, d(date) - dt.timedelta(days=1)) for s, date in OWNER_REPORTS]
    print(f"owner features at report date: paying365>=1: {sum(1 for f in owner_f if f['paying365'] >= 1)}/21; paying365>=2: {sum(1 for f in owner_f if f['paying365'] >= 2)}/21; "
          f"last record <=90d: {sum(1 for f in owner_f if f['days_since_last'] is not None and f['days_since_last'] <= 90)}/21; n365>=1: {sum(1 for f in owner_f if f['n365'] >= 1)}/21")


if __name__ == "__main__":
    main()
