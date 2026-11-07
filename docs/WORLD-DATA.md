# The World Document

The entire game state is one JSON object (`data/world.json` locally; a JSONB row in cloud
mode). `store.get()` returns it; everything mutates it in place.

## Top-level shape

```js
{
  schema: 16,              // migration gate — bump only in store.migrate()
  settings: { ... },       // world config (see below)
  globalVars: { ... },     // national numbers: gdp, population, treasury, moneySupply,
                           // avgHappiness, avgApproval, gdpGrowth, gdpScale, econConfidence,
                           // bankCrisis, lastTaxIncome, lastExportIncome, lastImportSpend …
  variables: [ ... ],      // GM-defined variable metadata (labels/format) for the UI
  entities: [ ... ],       // people, companies, parties, government, foreign powers, orgs
  provinces: [ ... ],      // domestic provinces with vars + demographics
  cities: [ ... ],
  properties: [ ... ],     // mapped sites (factories, farms, ministries …)
  items: [ ... ],          // goods + share certificates + property deeds
  accounts: [ ... ],       // { id, ownerId, name, balance }
  transactions: [ ... ],   // append-only money log (cap 12000)
  timeline: [ ... ],       // append-only audit log "The Record" (cap 8000)
  news: [ ... ],           // articles (cap 400) — draft | published | retracted
  events: [ ... ],         // the GM-authored rulebook (triggers/conditions/effects)
  elections: [ ... ],      // past election records (cap 60)
  election: null | { ... }, // LIVE election doc (Phase 33) — see "Live election doc" below
  trades: [ ... ],         // negotiated trade offers (open/accepted/declined/cancelled)
  markers: [ ... ],        // GM map markers
  // (a conflict doc — war / protest — may also carry `factions` once a third
  //  power intervenes: { [entityId]: { side, stance, seize, ai, … } }; its
  //  units carry `fac`, its captured cells `f`; docs/WAR.md "Multi-way conflicts")
  militaryLog: [ ... ],    // nations' arsenal record — { at, turn, why, n:{ entityId: [arms, tanks, ships, aircraft, fuel, men] } } (docs/WAR.md "Armed forces")
  peaceOffers: [ ... ],    // peace negotiations — { id:'peace_…', conflict, talks (startedAt), side, status, rev, terms, … } (docs/WAR.md "Peace negotiations")
  mapFx: [ ... ],          // GM map effects — { id:'fx_…', kind, pos:[x,y], r, at, label } (visual only, see below)
  protestApplications: [ ... ], // Phase 36 — player petitions to start a protest (see below)
  history: [ ... ],        // per-turn time-series for charts (cap 240)
  econ: { ... },           // the national economy's state (cpi, indices, calibration) — never shipped
  roles: [ ... ],          // permission templates
  users: [ ... ],          // operator accounts (salt + scrypt passHash)
  sessions: { sid: { userId, ts } },
  casinoHands: { ... },    // live blackjack hands — NEVER shipped to clients
  _lastDayTick, _loreFixes1, _dossiersOpened   // internal gates/flags
}
```

## Id conventions

Prefixes matter — `sim.findEnt/findProv/findItem` resolve loose references by trying them:
`ent_` (company/gov/bank), `per_` (person), `party_`, `for_` (foreign power), `org_`,
`prov_`, `city_`, `prop_`, `item_`, `acct_`, `user_`, `ev_`, `elec_`, `trade_`, `txn_`,
`tl_`, `news_`, `mark_`, `fx_` (map effects), `var_`, `trk_` (music), `venue_`, `paper_`. Role ids are bare
(`gamemaster`, `citizen`, `president`, …). New ids via `store.uid(prefix)`.

**Well-known ids the engine relies on:** `ent_gov` (the government; falls back to
`type === 'government'`), `ent_bank` / its account (National Bank market-maker reserve),
`acct_treasury` (state treasury). Seed companies: `ent_arc, ent_leika, ent_satrom, ent_amco,
ent_alko, ent_grazihall`. Provinces: `prov_grazi, prov_lachevan, prov_mezdov, prov_korota,
prov_kordi`. Papers: `paper_today, paper_herald, paper_economists, paper_radical`.

## Entities

Common: `{ id, type, name, abbrev?, title?, color, logo?, description, vars: {}, inventory:
[{itemId, qty}] }`. Types: `person`, `company`, `party`, `government`, `foreign`, `org`.

**Company extras:** `ownerId`, `ceoId`, `industry`, `sharesOutstanding`, `shareholders:
[{entityId, shares}]` (CANONICAL share register), `sharePrice` (turn price), `dayPrice`,
`dayHistory` (≤120), `dayAnchor {price, t0, seed}`, `marketDepth`, `vol`, `confidence`,
`trust`, `publicFloat` (% cap on ordinary-person holdings), plus CEO controls `keepPct`,
`govMix`, `govMixByItem?`, `govPriceMult`, `wage`, and engine outputs `fulfil`, `govFulfil`,
`vars.profit/revenue/valuation`.

**Company extras (Phase 27):** `vars.overheadPerTurn` — a per-turn corporate admin cost
charged even when the company owns zero properties, so a war that strips it bare bleeds its
cash (set by the Phase 27 profit-rebalance migration at 12% of its pre-rebalance property
expense footprint; see docs/SIMULATION.md "Zero-property companies bleed").

**Party extras:** `ideology {econ, soc}`, `leaderId`, `inGovernment`, `mpCount`,
`support { provId: { all|group: bonus } }` — campaign support is PERMANENT: earned
points stay in `support` (shaping polling) until moved by other means. During a live
election: `vars.campaignPointsByProvince` is the cumulative tally of every support
point each campaign drive earned per province (informational — nothing unwinds it).

### Live election doc (Phase 33) — `db.election` or `null`

Present only while an election is underway; every field is transient and lives on the
world doc so it survives serverless restarts and rides turns (`sim.advanceTurn` calls
`election.onTurn` — no timers).

| Field | Phase | Meaning |
|---|---|---|
| `id` | both | `elec_…` |
| `active`, `phase` | both | `'campaign'` | `'voting'` |
| `calledTurn`, `calledDate` | both | when the GM called the election |
| `pollingAtCall` | both | national polling snapshot the press uses as the "last poll" |
| `durationTurns` | both | count length (days of the count, default 14) |
| `deviationPct` | both | GM uncertainty dial (0–50); polls → true ballots |
| `supportToVotes` | both | late-vote multiplier: `strength × supportToVotes` fed in during the count |
| `rng` | voting | 32-bit xorshift state; all randomness (ballot roll, batch noise, late votes) derives from it — server-authoritative |
| `votingTurn`, `votingDate`, `step` | voting | count position (one batch per turn) |
| `electorate`, `totalBallots`, `progress` | voting | % of `totalBallots` counted |
| `targets`, `baseTargets` | voting | per-province per-party true ballots: `{ provId: { partyId: votes } }`. **GM-only via `election.forPlayers`** — the unrevealed roll until the final step snaps to it |
| `counted` | voting | per-province per-party ballots counted so far (public) |
| `steps` | voting | per-batch `{turn, date, counted}` history (≤ durationTurns) — the count chart |
| `log` | both | `{ts, turn, date, kind: 'campaign'|'adjust', …}` — public |

When the count finishes, `db.election` becomes `null` and a record is appended to
`db.elections` (`live: true`, national seat totals, province results).

**Where a player is:** `entity.whereabouts = { pos:[x,y], at, provinceId, near }` — the pin a player puts their character on the map with (`PUT/DELETE /api/me/pin`, public, drawn by public/js/map-pins.js). Absent = not on the map.

**Standing military orders:** `entity.militaryPlan = { doctrine: { issue:'best'|'conserve',
arms, fuel }, posts: { 'city:<id>'|'prop:<id>': 0..3 }, armourAt, fleetAt, police: { cities,
per } }` — absent means the defaults; set from War Room › Military (`POST
/api/military/plan`) and read at war/protest start and in every resupply pass (docs/WAR.md
"Armed forces"). Shipped only with the entity's inventory.

**Foreign-power extras (Phase 27):** `meta.military = { navy, army ('none'|'weak'|'medium'|
'strong'), size ('tiny'|'small'|'medium'|'big'), focus ('size'|'quality'), alliance (e.g.
'GRACE'|null), allies: [entityIds], importsFrom: [entityIds] }` — the authored military
profile driving per-turn off-books production (`sim.runForeignMilitary`) and war-time
alliance auto-join + contingent sizing (docs/WAR.md "Alliance-aware wars"). Seeded once by
store.migrate (`world._militaryProfilesSeeded`) for every seed nation plus `ent_gov`;
skips nations not present in a world. `vars.milAccum = {fuel, guns, tanks, ships}` holds
the fractional production accumulators.

**Government:** `ceoId` + `executives: [entityIds]` — maintained by `sim.syncPresidency()`
from whoever holds the `president` role. Don't set these by hand.

## Provinces

`{ id, name, color, path | shape, labelPos, capital, vars, demographics, voterBase?, econ? }`.
`vars`: population, gdp (₳M/yr), gdpReal, employment, unemployment, wage (₳/day), income
(₳/person/month), happiness, approval, economicConfidence, foodSecurity, foodStock (relief
food), povertyRate, povertyGap, giniIndex, lifeExpectancy, infantMortality, mortalityRate,
birthRate, education, crime, industry, agriculture, oilProduction, trade, infrastructure,
healthcare, politicalLeaning … — the economic ones are written by the national economy each
turn (docs/SIMULATION.md "The national economy").
`demographics`: `{ GroupName: { population, income (₳/person/month), netIncome, incomeTax,
savings (₳/person), education, politicalLeaning, governmentSupport, happiness,
economicConfidence, employment, unemployment, foodAccess, poverty } }` for the seven seed
groups (Working/Middle/Upper Class, Students, Retired, Rural, Urban). Their roles in the
economy come from `settings.economy.groupRoles`. `econ` is the engine's calibration and
working state for the province (GM-only in `filterState`). `voterBase { partyId: pct }`
scripts a province's vote outright, bypassing the demographic election model.
Territory is `shape` (SVG path data, evenodd); the GM border painter rewrites it for the
regions it touches (docs/FRONTEND.md "Border painter"). `settings.map.land` — the pristine
coastline, frozen on the first border save — is never shipped to clients (GM-only
`GET /api/gm/map/land`). `settings.map.kmPerPx` is the map's real-world scale (2.17 km per
map pixel — Arcasia is about the size of Brazil); `store.migrate` seeds it only when
missing. The war map's grid, scale bar, ruler and travel times read it.

## Properties (Phase 13 production model)

`{ id, name, type (commercial|industrial|government|military|…), kind (factory|mine|farm|
office|bank|…), provinceId, pos [x,y on 3840×2160 grid], ownerId, value, employees,
maxEmployees (employee cap — GM-only lever; seeded from the authored headcount, never
derived from live staffing), expenses (per-turn upkeep), texture, inventory, vars,
prodMode: 'goods'|'cash'|'none',
produces: [{itemId, perTurn}], cashPerTurn, targetRevenue? }`.

**Staffing target & inputs (Economy v2):** `staffTarget` — the headcount the owner chose
(set with `employees`); after accidents the site rehires toward it. `autoSupply` (default
on) — a site with `requires` buys its inputs from the home market each turn; `false` leaves
supply to its owner. `lastSold[itemId] = { offered, sold }` — last turn's home sales.

**Staffing vs employee cap (Phase 28b):** `employees` (staffing) is CEO-editable and may
EXCEED `maxEmployees` (the cap) — over-staffing raises output linearly (capped at 5× rated)
while doubling accident risk per extra 100% of capacity on the payroll. Only the GM may
change `maxEmployees` (GM Studio property editors, or `PATCH /api/property/:id/controls`
with `maxEmployees`).
Every property is visible to every operator — government and `type: 'military'` sites
included (the old `military` map-layer clearance no longer hides anything); a site's
`inventory` still follows its owner's inventory visibility.

War-related notes (Phase 27): `prop_arc_arms` (ARC Arms Works, `type:'military'`) is seeded
in the Republic and produces the M38 rifle plus a slow M36 "Griz" tank line (fractional
`perTurn: 0.5` — runEconomy's per-turn rounding wobble turns that into "about one every
other turn"); a flag-gated migration (`world._armsWorksMoved2`) relocates it to the
capital's industrial fringe in Lachevan, deriving the spot from the capital city's CURRENT
position (live worlds are on the 3840×2160 master grid — never hardcode seed-space coords
in migrate). `prop_shipyards` (Kradon Shipyards) switches from a flat cash office to a
goods producer of the Kradon-class warship at `perTurn: 0.02` (~1 hull every 50 turns;
`world._kradonShipyardWarship`). During a war, `vars._preWarOwnerId` stashes a property's
pre-occupation owner while the occupier holds it (`vars._preProtestOwnerId` for a
protest's seized districts) — see docs/WAR.md "Occupation property transfers": a peace
deal settles them; otherwise a war's occupier keeps them and a protest returns them.

## Items

`{ id, name, category, marketValue, tradable, description, meta? }`. Categories:
`Commodities`, `Goods`, `Military` (exportable stockpile kinds), `Securities`, `Documents`, etc.
Two special mirror kinds — never edit their quantities directly:
- **Share certificates:** `meta.companyId` — mirror of the shareholder register
  (`market.setHolding` / `syncAllCertificates`). `marketValue` tracks the day price.
- **Property deeds:** `meta.propertyId` — qty-1 mirror of `property.ownerId`
  (`deeds.transfer` / `syncAllDeeds`).

**Home market (Economy v2):** every good sold at home gets `meta.demand = { kind
('staple'|'consumer'|'industrial'|'military'), base, home0, backlog, sEma, dEma }`,
`meta.basePrice` (its normal price — moved when the GM or an event reprices the item) and,
after each turn, `meta.market = { offered, demand, sold, imports, exports, price, base, turn }`
(public). `marketValue` now moves with demand against supply (within 0.3–3× base). Staple
foods carry `meta.stapleFood` + `meta.foodCalorieWeight`.

**Weapon items** carry `meta.weapon` stats that feed the war engine, plus `meta.originId`
(which nation's national pattern this is — `null` for Arcasian designs; used by
`runForeignMilitary` to pick what a power produces). Kinds:
`{kind:'smallarms', dmg, hp, morale}`, `{kind:'fuel', speed}` (Phase 23), and since the
Phase 27 war overhaul `{kind:'tank', model, dmg, hp, armor, speed, fuelUse}` and
`{kind:'warship', model, dmg, hp, range, speed}`. Seeded once by store.migrate
(`world._armorNavySeeded`), three tank models and three warship classes with deliberately
wide stat spreads: `item_tank_m36griz` (M36 "Griz", old Arcasian), `item_tank_satrom42e`
("Muhit" Satrom '42E, Saromese export), `item_tank_type50m` (Type 50M, modern Qinali
export); `item_warship_kradon` (Kradon-class Cruiser, Arcasian), `item_warship_madrosian`
(Madrosian Frigate), `item_warship_valkslandic` (Valkslandic Dreadnought). The GM can mint
more from the item templates — the war engine derives unit stats from `meta.weapon`
numbers alone (docs/WAR.md "Tank & warship arsenal deployment"), no hardcoded model table.

## Events

`{ id, name, enabled, trigger: { type: 'every_turn'|'interval'(n)|'weekly'|'monthly'|
'date'(date)|'manual' }, conditions: [{a, op, b}] (expressions on globalVars), effects: [fx…],
lastTurn, runs }`. Effect types are documented in docs/SIMULATION.md.

## Settings

`worldName, currency ('₳'), currencyName, parliamentSeats (150), time { turn, date, unit
(hour|day|week), perTurn, auto { enabled, seconds, lastTick } }, registration { open,
defaultRole, stipend }, newsThresholds { transaction }, demographics, taxation { enabled,
pitEnabled (income tax on the population), pitBrackets [{upTo ₳/person/month, rate}],
corporateRate, propertyRate, vatRate, gamblingRate }, newspapers [4 fixed papers],
newspaperRouting { Category: paperId }, music { library, playlists, activePlaylist,
allowedPlaylists, lockPlaylist, forcedTrack, volume }, entertainment { venues: [casino|
lottery…] }, economy { dailyVariance?, happinessOutputK?, domesticMultiplier?,
expensesMultiplier?, dayTickMs?, x100Mult?, x100LockSec?, and the national economy's
groupRoles, referenceGroup, ladder, urbanize, jobsPerEmployee, wageAnchor { itemId, units }
(a day's work buys this much of a good — the wage scale), wageScale (the scale the world is
on — engine bookkeeping), gdpTarget (₳M a year — the level GDP is set to, then moves from;
0 = wage bill ÷ labourShare), dependentStipend, dependentGroups + the tunables in economy.js
DEF }, trade { partners, govBuyPrices, govBuy,
exports, imports, lastFlows, lastExportFill, stockIn, history }, map { countries [{id, name,
entityId, fill, shape}], labels, roads, rails, lights, land? }, mapDecor, election { durationTurns (14), deviationPct (12), supportToVotes
(2500), campaigns: [{ id, name, description, moneyCost, itemCosts: [{itemId, qty,
or?: [{itemId, qty}]}], strength, enabled }] }`.

**Phase 33 migration** (flag `world._partyStockSeeded`, no schema bump): seeds the five
default campaigns, creates a "Party Treasury" account (`acct_party_…`, owner = the party)
for every party lacking one, and grants each party a campaign war-chest (grain ×150 +
fuel ×60) so a fresh 1962 world can run its first election immediately. The party
treasury is a normal account — funds it via `POST /api/gm/mint` (GM Studio → Election →
Party Treasuries).

## Roles & users

Role: `{ id, name, perms: { pages: [...], inventories: 'all'|'own'|'none', accounts:
'all'|'own'|'none', companyFinancials, government, statistics, mapLayers: ['political',
'data', 'ownership', 'military'], manageNews, gm, abilities: [...] } }`. Ten seeded: gamemaster,
citizen, mp, judge, executive, president, minister, journalist, police, military.

**Abilities (Phase 36)** — actions, separate from the information clearances above:
`command_police` (police in a protest), `authorize_force` (order force against a protest),
`command_military` (the national defence in a war), `order_airstrikes`, and
`distribute_food` (release food from the national stockpile — President, Cabinet and GM by
default; added to existing worlds by the `world._abilitiesFood` flag). Seeded once
(`world._abilitiesSeeded`): president all four; minister police + force + military; police
`command_police`; military `command_military` + `order_airstrikes`; custom roles with the
military map layer get military + airstrikes; everyone else none. GM-editable in Roles &
Operators.

**Protest applications (Phase 36)** — `{ id, organizerId, name, demands, baseCities (≤3),
crowds (1–3), perCity (500–5000), status: 'pending'|'approved'|'denied'|'withdrawn', filedBy,
filedByEntityId, ts, turn, note?, decidedBy?, decidedAt? }`, capped at 60 (oldest decided
dropped first).

User: `{ id, username, displayName, salt, passHash (scrypt), roleId, entityId (their persona),
office ({widgets, updatedAt} — the Office tab layout, Phase 36),
newspaperId (journalists), lastReadNewsTs (news "News (n)" badge waterline, migrate-defaulted
to 0), created, lastLogin, roleHistory ([{roleId, at, turn}] — migrate-seeded, appended on every
role change), revolver ({loaded, pos, at} while a loaded revolver is closed — server/mortality.js),
deadAt, obituary (the record of the run, written at death) }`. Role **`dead`** is seeded by
migrate; a dead character's entity carries `deceased: { at, turn, date }`. Seeded users all use passphrase `arcasia`:
gm, president (Miron Valen), journalist (Jana Halden), executive (Kira Moss), citizen
(Toma Rill), plus MPs/executives/judge/military/police personas (verenne, stahl, kandel, suri,
hale, keller, odek, grazi, orn, krenn, voss, falk).

## The baseline canon (`world.canon`, server/canon.js)

What survives a reset. A reset (`store.reset`, `--reseed`) builds the next world from the seed
(`data/baseline-world.json`) + `store.migrate` (engine content: weapons, arsenals, airbases…)
and then **applies the canon** the old world kept — so authored changes the GM marked canon
come back and the campaign's play state does not. Rollback keeps the current canon list (it
is about the next world, not the restored one). `filterState` never ships it.

```
canon: { v: 1, updatedAt, lastApplied: { at, applied, skipped: [{ key, why }] },
  entries: { "<key>": entry } }
key   = "<collection>/<id>#<kind>" | "settings/<dotted.path>"
entry = { key, kind, coll, id, label, savedAt, savedBy, …one of:
  fields: { field: value }          // kind text | setup | ownership (null = delete the field)
  record, extras: { accounts, items } // kind add — the record as first created
  value                              // kind setting — settings path (economy, trade.partners, map.countries…)
  (nothing)                          // kind remove — only applied if nothing points at the record
}
```

Field groups per collection (`canon.GROUPS`): **text** (names, descriptions, titles, logos,
colours…; for variables/events/roles/markers the whole definition), **setup** (entity type/meta/
military plan; property placement and production line; province borders; item price/meta) and
**ownership** (owner, CEO, leader, board, share register). Everything else is play state.
Derived items (deeds, share certificates, ×100 positions) are never kept — `apply` re-runs
`deeds.syncAllDeeds` / `market.syncAllCertificates`, and clears references from kept records to
entities that are not in the new world (reported in `lastApplied.skipped`). Values compare by
meaning (object key order and the order of simple lists are ignored — cloud exports come back
from Postgres reordered).

**Settings merge, they are not swapped in.** A kept setting is merged onto the new world's:
plain objects key by key (all the way down), lists and values replaced. A key the canon does
not name keeps what seed + migrate gave it, so a setting kept on an older engine cannot erase
what the engine has added since. (Until this rule a kept `economy` replaced the whole object:
a canon kept before economy v2 reset worlds without the GDP level, wage scale, group roles and
class ladder — GDP read ₳107–115B, the going wage ₳1. `store.migrate` flag
`world._econKeysRestored1` repairs such worlds once from a freshly migrated seed.)
`economy.wageScale` is bookkeeping for the scale a world is on, never taken from the canon:
the new world keeps its own and `economy.applyWageAnchor` then moves it to the kept anchor.

## Schema history (migration gates in store.migrate)

- **< 2:** removed Kordistan foreign power, population ×2.79 / GDP ×2.686 rescale, Valen no
  longer sitting president.
- **< 3 (Phase 13):** monthly income/expenses → per-turn production model (`prodMode`,
  `produces`, `cashPerTurn`), `gdpScale` calibration, CEO controls, `settings.trade` +
  `settings.economy` seeded, old profit-generator events retired.
- **< 4 (Phase 14):** `sellPct/govPct` → `keepPct/govMix/govPriceMult`, `trade.govBuy` /
  `trade.exports` / partner `demand/supply` levels, export pool folded into `gov.inventory`.
- **Phase 27 (war overhaul, no schema bump — all one-shot flag-gated):**
  `_companyProfitRebalance` (scale each company's properties so property-derived revenue
  matches its authored `vars.revenue`; sets `vars.overheadPerTurn`), `_armorNavySeeded`
  (3 tank + 3 warship items), `_militaryProfilesSeeded` (`entity.meta.military` roster),
  `_arcArmsTank` / `_kradonShipyardWarship` (domestic tank/warship production lines),
  `_tankTradeSeeded` (Satrom/Qinal tank imports on the trade desk), `_armsWorksMoved2`
  (ARC Arms Works to Lachevan, derived from the capital's live position).
- **Phase 33 (live elections, no schema bump):** `_partyStockSeeded` — default election
  settings + campaign catalogue, per-party Party Treasury accounts, grain/fuel war-chest.
- **Phase 36 (permissions & protests, no schema bump):** `_abilitiesSeeded` (role
  abilities), `protestApplications: []`, the `settings.war.protest` opinion/application
  defaults, and a heal of users whose persona was stored as the literal `'__null__'`.
- **Atlas map & map effects (no schema bump):** `settings.ambience.mapStyle`
  (`'atlas'` default | `'classic'`) and `settings.ambience.shadows` (default `true`) —
  how every client draws the map (GM Studio › World › Settings & Time; client-only, the
  engine never reads them). `mapFx: []` — GM-staged disasters drawn on the map: `kind` ∈
  `nuke, explosion, fire, flood, quake, storm, eruption, toxic`, `pos` on the master grid,
  `r` radius in map units (15–900), `at` the start time (ms) every client animates from,
  optional `label` (≤60 chars). Purely visual: nothing in the simulation reads them; cap
  40. Public in `filterState` (everyone sees the same map).
- **War map & air force (no schema bump):** `settings.map.kmPerPx` (2.17, only when
  missing). Optional GM knobs `settings.war.air = { squadronSize, fuelPerPlane }`
  (defaults 4 / 10) and `settings.war.defaultSpeed` (1). `_airbasesSeeded` — one
  `airbase` property per foreign nation with map territory (`prop_airbase_<countryId>`,
  type military, owned by the nation, inland on the side facing the capital, no
  province); deeds issue in the same pass. Airfields — kinds `airport`, `airbase`,
  `military_base` — are ordinary properties and where every air force flies from. A conflict doc's `war.air` (squadrons mirrored from the aircraft
  stock, bases, fuel) is built by `server/war.js` `syncAirWings` on the next tick of any
  war or protest — no migration needed (docs/WAR.md "The air force").
- **The national economy's GDP level (no schema bump):** `_gdpLevel1` (seeds
  `settings.economy.gdpTarget` 36,000), `_wageAnchor1` (the wage scale pegged to grain),
  `_econKeysRestored1` (a world reset under a canon that wiped its economy settings gets the
  missing keys back from a freshly migrated seed, its played GDP record on the level, and a
  recalibration — docs above, "Settings merge"), `_gdpSeedLevel1` (the authored pre-game GDP
  history and a not-yet-run world's turn-0 GDP put on the level, so the record has no cliff).
- **Icon fields without emoji (no schema bump):** `_iconGlyphs1` — item icons that were emoji
  become letters (✈ → P, 🛢 → F, else the name's initial), marker icons ◈. The F55 fighter
  is now seeded with `P`.
- Plus many ungated idempotent fixes (currency rename, newspapers, music defaults, casino
  owner self-heal, certificate/deed reconciliation…). Follow the existing patterns when adding.
