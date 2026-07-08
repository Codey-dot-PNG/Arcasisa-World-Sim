"""Mock API + static server for verifying the Arcasia CLIENT without node.

Serves public/ and fakes the handful of /api endpoints the client needs, with
a tiny in-memory world (two venues, a few entities). Useful for eyeballing UI
changes on a machine that has Python but no Node runtime.

    python tools/mock-client-server.py     → http://localhost:8765

Switch the signed-in user by setting the cookie: document.cookie =
'mockrole=citizen' (or 'gm', the default) and reloading.
"""
import json, os, random, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public")
PORT = 8765

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
     "description": "State holding company.", "ownerId": "ent_gov", "sharePrice": 900, "vars": {}},
    {"id": "ent_satrom", "type": "company", "name": "SATROM", "industry": "Defence & Electronics (Saromite)",
     "color": "#5c3a4e", "ownerId": "for_sarom", "ceoId": "per_hale", "sharePrice": 1017,
     "description": "Saromite defence-electronics conglomerate, headquartered in the Federation of Sarom."},
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
     "employees": 650, "income": 300000, "expenses": 140000,
     "description": "House of chance on the Lachevan strip.", "inventory": [], "vars": {}},
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
]

ACCOUNTS = [{"id": "acct_rill", "ownerId": "per_rill", "name": "Personal Account", "balance": 5000}]

PAGES = ["parliament", "companies", "economy", "population", "news", "entertainment"]

def role_perms(gm):
    if gm:
        return {"pages": PAGES + ["timeline", "gm"], "inventories": "all", "accounts": "all",
                "companyFinancials": True, "government": True, "statistics": True,
                "mapLayers": ["political"], "manageNews": True, "gm": True}
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
            "taxation": {"enabled": False, "gamblingRate": 15},
            "demographics": {"groups": [], "metrics": []},
            "newspapers": [],
            "entertainment": {"venues": VENUES},
            "music": {"enabled": False, "library": [], "playlists": [], "activePlaylist": None,
                      "forcedTrack": None, "volume": 0.7, "shuffle": False},
        },
        "globalVars": {"population": 39000000},
        "variables": [],
        "entities": ENTITIES, "provinces": [], "cities": [], "properties": PROPERTIES,
        "accounts": ACCOUNTS, "transactions": [], "news": [], "items": ITEMS, "markers": [],
        "history": [], "timeline": [], "trades": [], "elections": [],
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
