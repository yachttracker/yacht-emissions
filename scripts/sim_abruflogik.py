"""
Simulation der Abruflogik-Varianten (Masterarbeit Yacht-Emissionen).

Alle Verhaltensparameter sind ANNAHMEN (keine Quelle), außer wo anders vermerkt.
Kosten: MyShipTracking-Regeln (belegt, API-Doku 2026-10-17):
  simple 1 Credit/Yacht, extended 3 Credits/Yacht, Historie 5 Credits je Kalendertag im Ergebnis,
  leere Antworten kostenlos.
Ziel: Credits/Monat vs. Anteil der Fahrstunden, die per 5-min-Historie erfasst werden.
"""
import math, random, statistics, json, sys

DAY = 24.0

# ---------------- Verhaltensmodell (Annahmen) ----------------
P_MOVE_DAY = 0.15        # Anteil Tage mit Fahrtbeginn (Annahme; Recherche: 6–16 % Zeit in Fahrt)
MIX = {"daytrip_stop": 0.25, "daytrip_loop": 0.15, "relocation": 0.45, "passage": 0.15}
P_RETURN_EXACT = 0.5     # Tagesausfahrt endet am exakt gleichen Liegeplatz (Marina/Boje)
P_AIS_OFF_DAY = 0.03     # Tag ohne jede AIS-Meldung
P_POLL_FAIL = 0.10       # einzelner Live-Abruf liefert keine aktuelle Position
DISP_THRESH_SM = 0.3     # Verschiebung, ab der "bewegt" gilt (Schwojkreis ~0,1 sm, Annahme)


def gen_yacht(days, rng):
    """Liefert Liste von Fahrtintervallen (start_h, end_h) und Positionsfunktion."""
    trips = []          # (start, end, kind)
    stops = []          # Positionswechsel-Zeitpunkte: (t, new_pos_id)
    pos_id = 0
    cur = 0           # aktuelle Liegeposition (ID)
    t_busy = -1
    for d in range(days):
        if d * DAY < t_busy:
            continue
        if rng.random() >= P_MOVE_DAY:
            continue
        kind = rng.choices(list(MIX), weights=list(MIX.values()))[0]
        start = d * DAY + rng.uniform(6, 16)
        if kind == "daytrip_stop":
            out = rng.uniform(0.5, 2); stay = rng.uniform(1, 5); back = rng.uniform(0.5, 2)
            trips.append((start, start + out, kind))
            trips.append((start + out + stay, start + out + stay + back, kind))
            pos_id += 1; stops.append((start + out, pos_id))            # Badebucht
            end = start + out + stay + back
            if rng.random() < P_RETURN_EXACT:
                stops.append((end, cur))                                 # exakt zurück
            else:
                pos_id += 1; stops.append((end, pos_id)); cur = pos_id
        elif kind == "daytrip_loop":
            dur = rng.uniform(1, 6)
            trips.append((start, start + dur, kind)); end = start + dur
            if rng.random() >= P_RETURN_EXACT:
                pos_id += 1; stops.append((end, pos_id)); cur = pos_id
        elif kind == "relocation":
            dur = rng.uniform(1, 10)
            trips.append((start, start + dur, kind)); end = start + dur
            pos_id += 1; stops.append((end, pos_id)); cur = pos_id
        else:  # passage
            start = d * DAY + rng.uniform(0, 24)
            dur = rng.uniform(20, 60)
            trips.append((start, start + dur, kind)); end = start + dur
            pos_id += 1; stops.append((end, pos_id)); cur = pos_id
        t_busy = end
    return trips, stops


def home_at(t, stops, home_ids):
    """Positions-ID zum Zeitpunkt t (Liegeposition, nur gültig außerhalb Fahrt)."""
    cur = 0
    for (ts, pid) in stops:
        if ts <= t:
            cur = pid
    return cur


def underway(t, trips):
    return any(s <= t < e for (s, e, _) in trips)


def hours_in_day(trips, d):
    a, b = d * DAY, (d + 1) * DAY
    return sum(max(0, min(e, b) - max(s, a)) for (s, e, _) in trips)


def simulate(variant, n_yachts=50, days=30, seed=0, budget=None):
    rng = random.Random(seed)
    polls = variant["polls_utc"]
    ext = variant.get("extended", None)   # None | "perfect" | float (Trefferwahrsch.)
    credits = 0
    total_uw = 0.0; captured_uw = 0.0
    move_days = 0; move_days_hit = 0
    hist_days_bought = 0
    undetected_candidates = []            # (yacht, day) für Auffüllung
    per_yacht = []
    for y in range(n_yachts):
        trips, stops = gen_yacht(days, rng)
        ais_off = {d for d in range(days) if rng.random() < P_AIS_OFF_DAY}
        flagged = set()
        last = None   # (t, pos_id)
        for d in range(days):
            for hp in polls:
                t = d * DAY + hp
                if d in ais_off or rng.random() < P_POLL_FAIL:
                    continue
                credits += 1
                if underway(t, trips):
                    flagged.add(d); last = None; continue
                pid = home_at(t, stops, None)
                if last is not None and last[1] != pid:
                    for dd in range(int(last[0] // DAY), d + 1):
                        flagged.add(dd)
                last = (t, pid)
            if ext is not None and d not in ais_off:
                credits += 2   # extended ersetzt einen simple-Abruf: 3 statt 1
                moved = hours_in_day(trips, d) > 0
                if moved and (ext == "perfect" or rng.random() < ext):
                    flagged.add(d)
        if variant.get("all_history"):
            flagged = set(range(days))
        for d in range(days):
            h = hours_in_day(trips, d)
            total_uw += h
            if h > 0:
                move_days += 1
            if d in flagged and d not in ais_off:
                credits += 5; hist_days_bought += 1
                captured_uw += h
                if h > 0:
                    move_days_hit += 1
            elif d not in ais_off:
                undetected_candidates.append((h, d))
    # Budget-Auffüllung: Rest des Monatsbudgets in zufällige, nicht gekaufte Tage
    filler = 0
    if budget is not None and credits < budget:
        rng.shuffle(undetected_candidates)
        for (h, d) in undetected_candidates:
            if credits + 5 > budget:
                break
            credits += 5; filler += 1
            captured_uw += h
            if h > 0:
                move_days_hit += 1
    return {
        "credits": credits,
        "uw_captured_pct": 100 * captured_uw / total_uw if total_uw else 100,
        "move_days_hit_pct": 100 * move_days_hit / move_days if move_days else 100,
        "hist_days": hist_days_bought + filler,
        "filler_days": filler,
    }


VARIANTS = {
    "V1 2x/Tag (Paul)":            {"polls_utc": [6, 18]},
    "V2 4x/Tag":                   {"polls_utc": [4, 10, 16, 22]},
    "V3 8x/Tag (3 h)":             {"polls_utc": [1, 4, 7, 10, 13, 16, 19, 22]},
    "V4 Tagfokus 6x":              {"polls_utc": [3, 9, 12, 15, 18, 22]},
    "V5 4x + extended (80 %)":     {"polls_utc": [4, 10, 16, 22], "extended": 0.8},
    "V6 4x + extended (ideal)":    {"polls_utc": [4, 10, 16, 22], "extended": "perfect"},
    "V7 Vollhistorie + 4x Karte":  {"polls_utc": [4, 10, 16, 22], "all_history": True},
}


def run(n_yachts=50, runs=200, budget=None, p_move=None):
    global P_MOVE_DAY
    if p_move is not None:
        P_MOVE_DAY = p_move
    out = {}
    for name, v in VARIANTS.items():
        rs = [simulate(v, n_yachts=n_yachts, seed=s, budget=budget) for s in range(runs)]
        out[name] = {k: round(statistics.mean(r[k] for r in rs), 1) for k in rs[0]}
        out[name]["uw_p5"] = round(sorted(r["uw_captured_pct"] for r in rs)[int(0.05 * runs)], 1)
    return out


if __name__ == "__main__":
    res = {}
    for label, kw in {
        "50 Yachten, ohne Budget-Auffüllung": dict(n_yachts=50),
        "50 Yachten, Auffüllung bis 20.000 Credits": dict(n_yachts=50, budget=20000),
        "50 Yachten, p_move 0.30, ohne Auffüllung": dict(n_yachts=50, p_move=0.30),
        "100 Yachten, Auffüllung bis 50.000": dict(n_yachts=100, budget=50000, p_move=0.15),
    }.items():
        res[label] = run(**kw)
    print(json.dumps(res, indent=1, ensure_ascii=False))
