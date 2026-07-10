"""Mock API + static server for verifying the Arcasia CLIENT without node.

Serves public/ and fakes the handful of /api endpoints the client needs, with
a tiny in-memory world (two venues, a few entities). Useful for eyeballing UI
changes on a machine that has Python but no Node runtime.

    python tools/mock-client-server.py     → http://localhost:8765

Switch the signed-in user by setting the cookie: document.cookie =
'mockrole=citizen' (or 'gm', the default) and reloading.
"""
import json, os, random, re, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
PORT = int(os.environ.get("PORT", "8765"))

# ---------------- world state ----------------
VENUES = [
    {"id": "venue_satrom", "name": "Satrom Grand Casino", "kind": "casino",
     "ownerId": "ent_satrom", "enabled": True,
     "blurb": "The Republic's glittering house of chance, on the Lachevan strip.",
     "games": ["roulette", "blackjack"], "minBet": 10, "maxBet": 100000,
     "roulette": {"greenSlots": 1},
     "blackjack": {"blackjackPays": 1.5, "dealerStandsOn": 17}},
    {"id": "venue_arc_lottery", "name": "ARC National Lottery", "kind": "lottery",
     "ownerId": "ent_arc", "enabled": True,
     "blurb": "A flutter for the Republic. Drawn every third turn.",
     "ticketPrice": 50, "pick": 3, "maxNumber": 40, "drawEveryTurns": 3,
     "houseCutPct": 40, "jackpotSeed": 100000, "lastDrawTurn": 0, "pot": 100000, "tickets": []},
]

ENTITIES = [
    {"id": "ent_gov", "type": "government", "name": "Government of Arcasia", "color": "#4a5560",
     "description": "The federal government.", "vars": {}},
    {"id": "ent_arc", "type": "company", "name": "ARC", "industry": "State Corporation", "color": "#33424d",
     "description": "State holding company.", "ownerId": "ent_gov", "sharePrice": 900,
     "sharesOutstanding": 1000000, "publicFloat": 0, "confidence": 62, "marketDepth": 5, "vol": 0.02,
     "dayPrice": 912, "dayHistory": [900, 903, 898, 907, 912, 909, 915, 912],
     "dayAnchor": {"price": 912, "t0": 0, "seed": 4242},
     "shareholders": [{"entityId": "ent_gov", "shares": 1000000}], "vars": {}},
    {"id": "ent_satrom", "type": "company", "name": "SATROM", "industry": "Defence & Electronics (Saromite)",
     "color": "#5c3a4e", "ownerId": "for_sarom", "ceoId": "per_hale", "sharePrice": 1017,
     "sharesOutstanding": 600000, "publicFloat": 10, "confidence": 41, "marketDepth": 5, "vol": 0.03,
     "dayPrice": 988, "dayHistory": [1017, 1005, 996, 1002, 985, 972, 980, 988],
     "dayAnchor": {"price": 988, "t0": 0, "seed": 7777},
     "shareholders": [{"entityId": "for_sarom", "shares": 500000}, {"entityId": "per_hale", "shares": 100000}],
     "trust": 58, "sellPct": 60, "govPct": 25, "wage": 100, "govPctByItem": {"item_crude": 40},
     "vars": {"revenue": 74000000, "profit": 9100000, "valuation": 610000000},
     "description": "Saromite defence-electronics conglomerate, headquartered in the Federation of Sarom."},
    {"id": "for_qinal", "type": "foreign", "name": "People's Republic of Qinal", "color": "#726a58",
     "stance": "Hostile", "description": "Revolutionary power.", "vars": {}},
    {"id": "for_aldonesia", "type": "foreign", "name": "Aldonesia", "color": "#726a58",
     "stance": "Friendly", "description": "South-western archipelago power.", "vars": {}},
    {"id": "for_sarom", "type": "foreign", "name": "Federation of Sarom", "color": "#726a58",
     "stance": "Allied", "description": "Continental federation and treaty ally.", "vars": {}},
    {"id": "for_valksland", "type": "foreign", "name": "Valksland", "color": "#726a58",
     "stance": "Tense", "description": "The great power across the Strait of Valgos.", "vars": {}},
    {"id": "org_assembly", "type": "org", "name": "United Nations", "color": "#5b5e2c",
     "stance": "Member", "description": "The United Nations. Arcasia is a founding member.", "vars": {}},
    {"id": "per_rill", "type": "person", "name": "Toma Rill", "title": "Citizen", "color": "#5b5e2c",
     "description": "A citizen of Lachevan.", "vars": {},
     "inventory": [{"itemId": "item_radio", "qty": 1}, {"itemId": "item_gold", "qty": 3}]},
    {"id": "per_hale", "type": "person", "name": "Viktor Hale", "title": "Chief Executive, SATROM",
     "color": "#5c3a4e", "description": "Engineer-director.", "vars": {}},
]

PROPERTIES = [
    {"id": "prop_satrom_casino", "name": "Satrom Grand Casino", "type": "commercial", "kind": "office",
     "provinceId": "prov_lachevan", "pos": [2278, 499], "ownerId": "ent_satrom", "value": 24000000,
     "employees": 650, "income": 300000, "expenses": 4667, "prodMode": "cash", "cashPerTurn": 10000,
     "produces": [], "texture": "civ-tall.png",
     "description": "House of chance on the Lachevan strip.", "inventory": [], "vars": {}},
    {"id": "prop_satrom_works", "name": "SATROM Radar Works", "type": "industrial", "kind": "factory",
     "provinceId": "prov_lachevan", "pos": [2290, 510], "ownerId": "ent_satrom", "value": 34000000,
     "employees": 3100, "income": 380000, "expenses": 8333, "prodMode": "goods",
     "produces": [{"itemId": "item_crude", "perTurn": 4400}], "texture": "industrial-complex.png",
     "description": "Restricted site.", "inventory": [], "vars": {}},
    {"id": "prop_gov_house", "name": "Government House", "type": "government", "kind": "government",
     "provinceId": "prov_lachevan", "pos": [2400, 470], "ownerId": "ent_gov", "value": 40000000,
     "employees": 900, "income": 0, "expenses": 4000, "prodMode": "none", "produces": [],
     "texture": "bank-court.png", "description": "Seat of government.", "inventory": [], "vars": {}},
    {"id": "prop_arc_mill", "name": "ARC Timber Mill", "type": "industrial", "kind": "factory",
     "provinceId": "prov_lachevan", "pos": [2200, 620], "ownerId": "ent_arc", "value": 9000000,
     "employees": 400, "income": 60000, "expenses": 1500, "prodMode": "cash", "cashPerTurn": 2000,
     "produces": [], "texture": "industrial.png", "description": "State sawmill.", "inventory": [], "vars": {}},
    {"id": "prop_rill_house", "name": "Rill Residence", "type": "residential", "kind": "house",
     "provinceId": "prov_lachevan", "pos": [2361, 524], "ownerId": "per_rill", "value": 18000,
     "employees": 0, "income": 0, "expenses": 40, "description": "A modest house.",
     "inventory": [{"itemId": "item_radio", "qty": 2}], "vars": {}},
]

ITEMS = [
    {"id": "item_radio", "name": "LEIKA Model-9 Radio", "icon": "R", "category": "Goods",
     "marketValue": 34, "tradable": True, "meta": {}, "description": "The people's receiver."},
    {"id": "item_gold", "name": "Gold Bar (400 oz)", "icon": "A", "category": "Reserves",
     "marketValue": 15800, "tradable": True, "meta": {}, "description": "Reserve bullion."},
    {"id": "item_crude", "name": "Crude Oil (barrel)", "icon": "O", "category": "Commodities",
     "marketValue": 2.9, "tradable": True, "meta": {}, "description": "Unrefined crude."},
    {"id": "item_weapons", "name": "Weapons (crate)", "icon": "W", "category": "Military",
     "marketValue": 520, "tradable": True, "meta": {}, "description": "Small arms, crated."},
]

ACCOUNTS = [
    {"id": "acct_rill", "ownerId": "per_rill", "name": "Personal Account", "balance": 5000},
    {"id": "acct_treasury", "ownerId": "ent_gov", "name": "Federal Treasury", "balance": 1200000000},
    {"id": "acct_satrom", "ownerId": "ent_satrom", "name": "SATROM Operating", "balance": 45000000},
]

TRADE = {
    "govBuyPrices": {"item_crude": 2.61},
    "partners": [
        {"entityId": "for_sarom", "tariff": "Low", "exports": ["item_crude"],
         "imports": ["item_weapons"], "prices": {"item_crude": 3.04, "item_weapons": 676.0}, "priceDrift": 0.05},
        {"entityId": "for_valksland", "tariff": "High", "exports": ["item_crude"],
         "imports": ["item_weapons"], "prices": {"item_crude": 3.04, "item_weapons": 598.0}, "priceDrift": 0.05},
        {"entityId": "for_qinal", "tariff": "High", "exports": ["item_crude"],
         "imports": [], "prices": {"item_crude": 3.04}, "priceDrift": 0.05},
        {"entityId": "for_aldonesia", "tariff": "Low", "exports": ["item_crude"],
         "imports": [], "prices": {"item_crude": 3.13}, "priceDrift": 0.05},
    ],
    "lastFlows": [
        {"itemId": "item_crude", "partnerId": "for_sarom", "qty": 300, "value": 912.0},
        {"itemId": "item_crude", "partnerId": "for_valksland", "qty": 300, "value": 905.0},
        {"itemId": "item_weapons", "partnerId": "for_sarom", "qty": 5, "value": -3380.0},
    ],
    "history": [{"turn": t, "date": "1960-01-0%d" % (t + 1), "exportValue": 1500 + t * 120,
                 "importValue": 300 + t * 40, "byItem": {"item_crude": 1500 + t * 120}} for t in range(4)],
    "exportPool": {"item_crude": 740},
    "exportAlloc": {"item_crude": 70},
    "imports": [{"itemId": "item_weapons", "partnerId": "for_sarom", "qtyPerTurn": 5}],
    "tariffs": {"global": {"import": 0, "export": 0}, "byCountry": {}, "byCompany": {}},
    "orders": {"turn": 4, "buys": [], "sells": []},
}

HISTORY = [
    {"turn": t, "date": "1960-01-0%d" % (t + 1), "gdp": 12400 + t * 22, "population": 39000000 + t * 900,
     "avgHappiness": 51 + t * 0.2, "avgApproval": 47 + t * 0.1,
     "moneySupply": 1927584400 + t * 240000, "treasury": 1199000000 + t * 350000,
     "tax": 9000 + t * 300, "exports": 1500 + t * 120, "imports": 300 + t * 40,
     "provinces": {}, "shares": {"ent_satrom": 1017 + t * 4, "ent_arc": 900 + t * 2},
     "profits": {"ent_satrom": 9100000 + t * 30000, "ent_arc": 22000000 + t * 15000},
     "revenues": {"ent_satrom": 74000000 + t * 90000, "ent_arc": 310000000 + t * 60000}}
    for t in range(5)
]

TRANSACTIONS = [
    {"id": "txn1", "ts": 0, "turn": 3, "simDate": "1960-01-04", "from": "acct_satrom", "to": "acct_treasury",
     "amount": 9300, "memo": "Tax", "actor": "TREASURY", "kind": "transfer"},
    {"id": "txn2", "ts": 0, "turn": 3, "simDate": "1960-01-04", "from": None, "to": "acct_treasury",
     "amount": 1817, "memo": "Export to Federation of Sarom", "actor": "TREASURY", "kind": "deposit"},
    {"id": "txn3", "ts": 0, "turn": 3, "simDate": "1960-01-04", "from": "acct_treasury", "to": None,
     "amount": 3380, "memo": "Import of Weapons (crate) from Federation of Sarom", "actor": "TREASURY", "kind": "withdraw"},
    {"id": "txn4", "ts": 0, "turn": 3, "simDate": "1960-01-04", "from": "acct_treasury", "to": "acct_satrom",
     "amount": 3350, "memo": "Government goods purchase", "actor": "TREASURY", "kind": "transfer"},
    {"id": "txn5", "ts": 0, "turn": 2, "simDate": "1960-01-03", "from": "acct_rill", "to": "acct_treasury",
     "amount": 120, "memo": "Gambling tax (15%)", "actor": "TREASURY", "kind": "transfer"},
]

PAGES = ["map", "parliament", "companies", "economy", "population", "news", "entertainment"]

PROVINCES = [
    {"id": "prov_lachevan", "name": "Lachevan", "color": "#c99a2e",
     "path": [[2000, 300], [2600, 250], [2700, 700], [2200, 800], [1950, 600]],
     "labelPos": [2300, 520], "vars": {"population": 4600000, "gdp": 1850, "happiness": 61},
     "description": "The federal heartland."},
]

def role_perms(gm):
    if gm:
        return {"pages": PAGES + ["timeline", "gm"], "inventories": "all", "accounts": "all",
                "companyFinancials": True, "government": True, "statistics": True,
                "mapLayers": ["political", "data", "ownership"], "manageNews": True, "gm": True}
    return {"pages": PAGES, "inventories": "own", "accounts": "own", "companyFinancials": True,
            "government": False, "statistics": False, "mapLayers": ["political"],
            "manageNews": False, "gm": False}

def make_state():
    return {
        "settings": {
            "worldName": "Republic of Arcasia", "currency": "₳", "currencyName": "Arcasian Koren",
            "time": {"turn": 4, "unit": "day", "perTurn": 1, "date": "1960-01-05", "auto": {"enabled": False}},
            "parliamentSeats": 150,
            "registration": {"open": True},
            "taxation": {"enabled": False, "gamblingRate": 15, "corporateRate": 10, "propertyRate": 0, "vatRate": 0},
            "newsThresholds": {"transaction": 5000000},
            "demographics": {"groups": [], "metrics": []},
            "newspapers": [],
            "entertainment": {"venues": VENUES},
            "music": {"enabled": False, "library": [], "playlists": [], "activePlaylist": None,
                      "forcedTrack": None, "volume": 0.7, "shuffle": False},
            "trade": TRADE,
            "map": {"schema": 1, "countries": [], "labels": [], "roads": [], "rails": []},
            "economy": {"baseDailyWage": 4, "wageHappinessK": 0.03, "wageEmploymentK": 0.03,
                        "dailyVariance": 0.06, "happinessOutputK": 0.15},
        },
        "globalVars": {"population": 39000000, "gdp": 12500, "moneySupply": 1927584400,
                       "treasury": 1200000000, "avgHappiness": 51.6, "avgApproval": 47.3,
                       "lastTaxIncome": 10200, "lastExportIncome": 1817, "lastImportSpend": 3380,
                       "econConfidence": 54},
        "variables": [],
        "entities": ENTITIES, "provinces": PROVINCES, "cities": [], "properties": PROPERTIES,
        "accounts": ACCOUNTS, "transactions": TRANSACTIONS, "news": [], "items": ITEMS, "markers": [],
        "history": HISTORY, "timeline": [], "trades": [], "elections": [],
        "roles": [{"id": "citizen", "name": "Citizen"}],
    }

VERSION = [1]
BJ = {}  # per-role blackjack hand

RED = {1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36}

def play_roulette(body):
    bets = body.get("bets", [])
    staked = sum(int(b.get("amount", 0)) for b in bets)
    n = random.randrange(37)
    color = "green" if n == 0 else ("red" if n in RED else "black")
    returned = 0
    for b in bets:
        t, val, amt = b.get("type"), b.get("value"), int(b.get("amount", 0))
        win, mult = False, 0
        if t == "straight": win, mult = (val == n), 35
        elif t == "red": win, mult = color == "red", 1
        elif t == "black": win, mult = color == "black", 1
        elif t == "odd": win, mult = n != 0 and n % 2 == 1, 1
        elif t == "even": win, mult = n != 0 and n % 2 == 0, 1
        elif t == "low": win, mult = 1 <= n <= 18, 1
        elif t == "high": win, mult = 19 <= n <= 36, 1
        elif t == "dozen": win, mult = n != 0 and -(-n // 12) == val, 2
        elif t == "column": win, mult = n != 0 and n % 3 == (val % 3), 2
        if win: returned += amt * (mult + 1)
    delta = returned - staked
    ACCOUNTS[0]["balance"] += delta
    VERSION[0] += 1
    return {"number": n, "color": color, "staked": staked, "returned": returned,
            "playerDelta": delta, "balance": ACCOUNTS[0]["balance"]}

def hand_value(cards):
    total, aces = 0, 0
    for c in cards:
        v = 11 if c["r"] == 1 else min(10, c["r"])
        total += v
        if c["r"] == 1: aces += 1
    while total > 21 and aces: total -= 10; aces -= 1
    return total

def bj_public(h, reveal):
    return {"bet": h["bet"], "done": h["done"], "outcome": h.get("outcome"),
            "player": h["player"], "playerValue": hand_value(h["player"]),
            "dealer": h["dealer"] if reveal else [h["dealer"][0]],
            "dealerValue": hand_value(h["dealer"] if reveal else [h["dealer"][0]]),
            "doubled": h.get("doubled", False)}

def bj_resolve(h):
    pv = hand_value(h["player"])
    if pv <= 21:
        while hand_value(h["dealer"]) < 17: h["dealer"].append(h["shoe"].pop())
    dv = hand_value(h["dealer"])
    pn = len(h["player"]) == 2 and pv == 21
    dn = len(h["dealer"]) == 2 and dv == 21
    if pn and not dn: delta, h["outcome"] = round(h["bet"] * 1.5), "blackjack"
    elif pv > 21: delta, h["outcome"] = -h["bet"], "bust"
    elif dv > 21: delta, h["outcome"] = h["bet"], "dealer_bust"
    elif pv > dv: delta, h["outcome"] = h["bet"], "win"
    elif pv < dv: delta, h["outcome"] = -h["bet"], "lose"
    else: delta, h["outcome"] = 0, "push"
    h["done"] = True
    ACCOUNTS[0]["balance"] += delta
    return {"state": bj_public(h, True), "playerDelta": delta, "balance": ACCOUNTS[0]["balance"]}

def play_blackjack(body, who):
    act = body.get("action")
    if act == "deal":
        shoe = [{"r": r, "s": s} for r in range(1, 14) for s in range(4) for _ in range(4)]
        random.shuffle(shoe)
        h = {"bet": int(body.get("bet") or 10), "shoe": shoe, "done": False,
             "player": [shoe.pop(), shoe.pop()], "dealer": [shoe.pop(), shoe.pop()]}
        BJ[who] = h
        pv, dv = hand_value(h["player"]), hand_value(h["dealer"])
        if pv == 21 or dv == 21: return bj_resolve(h)
        return {"state": bj_public(h, False)}
    h = BJ.get(who)
    if not h or h["done"]: return {"error": "No hand in play."}, 400
    if act == "hit":
        h["player"].append(h["shoe"].pop())
        if hand_value(h["player"]) >= 21: return bj_resolve(h)
        return {"state": bj_public(h, False)}
    if act == "double":
        h["bet"] *= 2; h["doubled"] = True
        h["player"].append(h["shoe"].pop())
        return bj_resolve(h)
    return bj_resolve(h)  # stand

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a): pass

    def _role(self):
        q = parse_qs(urlparse(self.path).query)
        if "role" in q: return q["role"][0]
        ck = self.headers.get("Cookie", "")
        for part in ck.split(";"):
            if part.strip().startswith("mockrole="): return part.strip().split("=", 1)[1]
        return "gm"

    def _json(self, obj, code=200, set_role=None):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if set_role: self.send_header("Set-Cookie", "mockrole=%s; Path=/" % set_role)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = urlparse(self.path).path
        role = self._role()
        gm = role != "citizen"
        if p == "/api/config":
            return self._json({"storage": "file", "realtime": "sse"}, set_role=role)
        if p == "/api/state":
            user = {"id": "u1", "username": role, "displayName": "The Gamemaster" if gm else "Toma Rill",
                    "entityId": None if gm else "per_rill", "roleId": "gamemaster" if gm else "citizen",
                    "newspaperId": None,
                    "role": {"id": "gamemaster" if gm else "citizen",
                             "name": "Gamemaster" if gm else "Citizen", "perms": role_perms(gm)}}
            return self._json({"user": user, "state": make_state(), "v": VERSION[0]})
        if p == "/api/polling":
            return self._json({"national": {}, "byProvince": {}})
        if p == "/api/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                # close right away with a long retry so screenshots never see
                # a perpetually-pending request
                self.wfile.write(b"retry: 600000\n\n")
            except Exception:
                pass
            return
        if p.startswith("/api/"):
            return self._json({"error": "mock: unknown GET " + p}, 404)
        return super().do_GET()

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        p = urlparse(self.path).path
        b = self._body()
        if p == "/api/casino/roulette":
            return self._json(play_roulette(b))
        if p == "/api/casino/blackjack":
            r = play_blackjack(b, self._role())
            if isinstance(r, tuple): return self._json(r[0], r[1])
            VERSION[0] += 1
            return self._json(r)
        if p == "/api/casino/lottery":
            v = VENUES[1]
            v["pot"] += v["ticketPrice"]
            ACCOUNTS[0]["balance"] -= v["ticketPrice"]
            VERSION[0] += 1
            return self._json({"pot": v["pot"], "ticket": sorted(b.get("numbers", []))})
        return self._json({"ok": True})

    def do_PATCH(self):
        p = urlparse(self.path).path
        b = self._body()
        if p == "/api/trade/tariffs":
            tf = b.get("tariffs") or {}
            def _pair(o): return {"import": max(0, min(90, round(float((o or {}).get("import") or 0)))),
                                  "export": max(0, min(90, round(float((o or {}).get("export") or 0))))}
            def _map(o):
                out = {}
                for k, v in (o or {}).items():
                    pr = _pair(v)
                    if pr["import"] or pr["export"]: out[k] = pr
                return out
            TRADE["tariffs"] = {"global": _pair(tf.get("global")), "byCountry": _map(tf.get("byCountry")), "byCompany": _map(tf.get("byCompany"))}
            VERSION[0] += 1
            return self._json({"tariffs": TRADE["tariffs"]})
        m = re.match(r"^/api/company/([\w-]+)/controls$", p)
        if m:
            for e in ENTITIES:
                if e["id"] == m.group(1) and e.get("type") == "company":
                    if "keepPct" in b: e["keepPct"] = max(0, min(100, round(float(b["keepPct"] or 0))))
                    if "wage" in b: e["wage"] = max(0, min(300, round(float(b["wage"] or 0))))
                    VERSION[0] += 1
                    return self._json({"ok": True, "company": {"id": e["id"], "keepPct": e.get("keepPct", 0), "wage": e.get("wage", 100)}})
            return self._json({"error": "no such company"}, 400)
        if p.startswith("/api/casino/venue/"):
            vid = p.rsplit("/", 1)[1]
            for v in VENUES:
                if v["id"] == vid:
                    for k in ("name", "blurb", "ownerId", "minBet", "maxBet", "ticketPrice",
                              "houseCutPct", "pot", "jackpotSeed", "enabled", "roulette", "blackjack"):
                        if k in b: v[k] = b[k]
                    VERSION[0] += 1
                    return self._json({"venue": v})
        return self._json({"ok": True})

if __name__ == "__main__":
    print("mock server on http://localhost:%d  (?role=gm | ?role=citizen)" % PORT)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
