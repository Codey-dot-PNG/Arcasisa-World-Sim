# The Arcasia Simulation Engine

A persistent, browser-based multiplayer geopolitical simulation platform. The web application
is the source of truth for the fictional Republic of Arcasia (1962) while your community
roleplays on Discord. Everything — provinces, companies, items, events, roles — is data,
editable through the GM Studio. Nothing about Arcasia is hardcoded: the engine is a generic
world simulator that happens to ship configured as Arcasia.

## Running it

Requires only [Node.js](https://nodejs.org) (18+). No dependencies, no build step, no database server.

```
node server.js
```

Then open **http://localhost:4820**. To let players on your network in, share
`http://<your-ip>:4820` (or put it behind any reverse proxy for the internet).

**Hosting it free & 24/7:** see [DEPLOY.md](DEPLOY.md) — the engine also runs on
Vercel + Supabase (both free, no credit card), storing the world in Postgres and
pushing live updates over Supabase Realtime. It switches modes automatically based
on environment variables; local `node server.js` keeps working either way.

- The world lives in `data/world.json` (written atomically, autosaved).
- A snapshot is written before **every** turn into `data/snapshots/` — the GM can roll back from the UI.
- `node server.js --reseed` wipes everything back to the 1962 seed.
- Back up by copying `data/`, or use **GM Studio → Archive & Danger → Export World**.

## Seed accounts

| Operator | Role | Persona |
|---|---|---|
| `gm` | Gamemaster | — |
| `president` | President | Miron Valen (United Arcasia) |
| `journalist` | Journalist | Jana Halden, *The Arcasian Herald* |
| `executive` | Executive | Kira Moss, CEO of LEIKA |
| `citizen` | Citizen | Toma Rill (owns 500 AMCO shares) |

Passphrase for all: **arcasia**. Players can also self-register (configurable) and receive a stipend.

## The world of 1962

Five provinces traced from your map — **Grazi, Lachevan, Mezdov, Korota, Kordi** — plus the
foreign coasts of Valksland, Del' Casia, Solme, Madrosia, Mazon and Aldonesia. Six companies
(ARC, LEIKA, SATROM, AMCO, ALKO, GRAZIHALL) with your logos, five parties (United Arcasia,
PFJ, National Front, ACP, Kordish Freedom Front) with your logos, 150-seat Parliament,
33 mapped properties, 17 items, and a running economy. All images live in `public/assets/`.

## How the simulation works

**Time** — the GM chooses what a turn is (hour/day/week) and advances manually or on a real-time
schedule. Every turn, the engine evaluates all **events**.

**Events** (GM Studio → Event Engine) are the whole rulebook: a trigger (every turn, every N turns,
weekly, monthly, a date, or manual), optional conditions, and a list of effects — adjust variables,
move money, reprice items, shift demographics, transfer ownership, publish news, hold elections.
Values are safe arithmetic expressions:

```
$gdp * 0.0004 * ($employment - 88)
prov(kordi, oilProduction) * 1000 * item(crude) * 0.4
clamp(($happiness - 50) * 0.05, -1.5, 1.5) + rand(-1.4, 1.4)
```

Functions: `rand, round, floor, ceil, abs, sqrt, min, max, clamp, prov(id,key), ent(id,key),
item(id), balance(id), g(key), pop(all), turn()`. `$key` reads the current target's variable.
There is an expression tester at the top of the Event Engine tab.

**Population** — every province holds demographic groups (Working Class, Students, Rural, …)
with income, education, leaning, support, happiness. Seeded events drift these each turn.

**Elections** — computed from that population: each group in each province scores every party
by ideology distance, education, government approval and regional support modifiers; votes split
proportionally; seats are apportioned to provinces by population and allocated by D'Hondt.
No fixed numbers anywhere.

**Economy** — every entity has accounts; every movement of money is a logged transaction.
Item market values are global: repricing an item instantly revalues every inventory holding it.
Large transfers automatically draft news stories.

**News** — *The Arcasian Herald* receives auto-generated drafts from the simulation (elections,
big transfers, ownership changes, monthly statistical digests, event-authored stories);
journalists and the GM edit, publish, retract, delete.

**Timeline** — every mutation (money, ownership, variables, GM edits, system acts) is a
timestamped entry in The Record, filterable and searchable; the newest items stream across
the wire ticker at the bottom of the screen. Live updates reach all connected players via
server-sent events.

**Roles** — permissions gate *information*, not actions: pages visible, inventories, accounts,
company financials, government data, statistics/demographics, map layers (including military
sites). Ten templates seeded; create, rename, duplicate and edit freely in GM Studio.

## Layout

```
server.js            HTTP server + static files (zero dependencies)
server/store.js      persistence, snapshots, audit log
server/seed.js       the 1962 world (pure data — edit or replace at will)
server/sim.js        expression language, effects, turns, elections
server/api.js        auth, permission filtering, REST + SSE
public/              the client (vanilla JS, no build)
public/assets/       your flags, seals, party & company logos
data/                world.json + snapshots (created at runtime)
```

## Troubleshooting sync & realtime

For detailed sync layer architecture and debugging steps, see [docs/SYNC-ARCHITECTURE.md](docs/SYNC-ARCHITECTURE.md). Run `node tools/diagnose-sync.js https://your-app.vercel.app` to verify persistence, concurrency, and read-your-writes guarantees. Note: `supabase-setup.sql` must be re-run in the Supabase SQL editor whenever it changes (it creates/maintains the tables, RLS policies, and publication membership required for live updates).
