# The World Document

The entire game state is one JSON object (`data/world.json` locally; a JSONB row in cloud
mode). `store.get()` returns it; everything mutates it in place.

## Top-level shape

```js
{
  schema: 4,               // migration gate — bump only in store.migrate()
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
  trades: [ ... ],         // negotiated trade offers (open/accepted/declined/cancelled)
  markers: [ ... ],        // GM map markers
  history: [ ... ],        // per-turn time-series for charts (cap 1000)
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
`tl_`, `news_`, `mark_`, `var_`, `trk_` (music), `venue_`, `paper_`. Role ids are bare
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
`support { provId: { all|group: bonus } }`.

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

`{ id, name, color, path | shape, labelPos, capital, vars, demographics, voterBase? }`.
`vars`: population, gdp (₳M), employment, happiness, approval, education, crime, industry,
agriculture, oilProduction, trade, infrastructure, healthcare, politicalLeaning …
`demographics`: `{ GroupName: { population, income, education, politicalLeaning,
governmentSupport, happiness, economicConfidence, employment } }` for the seven seed groups
(Working/Middle/Upper Class, Students, Retired, Rural, Urban). `voterBase { partyId: pct }`
scripts a province's vote outright, bypassing the demographic election model.

## Properties (Phase 13 production model)

`{ id, name, type (commercial|industrial|government|military|…), kind (factory|mine|farm|
office|bank|…), provinceId, pos [x,y on 3840×2160 grid], ownerId, value, employees, expenses
(per-turn upkeep), texture, inventory, vars, prodMode: 'goods'|'cash'|'none',
produces: [{itemId, perTurn}], cashPerTurn, targetRevenue? }`.
`type: 'military'` sites are hidden from operators without the `military` map layer.

War-related notes (Phase 27): `prop_arc_arms` (ARC Arms Works, `type:'military'`) is seeded
in the Republic and produces the M38 rifle plus a slow M36 "Griz" tank line (fractional
`perTurn: 0.5` — runEconomy's per-turn rounding wobble turns that into "about one every
other turn"); a flag-gated migration (`world._armsWorksMoved2`) relocates it to the
capital's industrial fringe in Lachevan, deriving the spot from the capital city's CURRENT
position (live worlds are on the 3840×2160 master grid — never hardcode seed-space coords
in migrate). `prop_shipyards` (Kradon Shipyards) switches from a flat cash office to a
goods producer of the Kradon-class warship at `perTurn: 0.02` (~1 hull every 50 turns;
`world._kradonShipyardWarship`). During a war, `vars._preWarOwnerId` stashes a property's
pre-occupation owner while the occupier holds it — see docs/WAR.md "Occupation property
transfers"; `endWar` clears the stash, ownership stays wherever the war left it.

## Items

`{ id, name, category, marketValue, tradable, description, meta? }`. Categories:
`Commodities`, `Goods`, `Military` (exportable stockpile kinds), `Securities`, `Documents`, etc.
Two special mirror kinds — never edit their quantities directly:
- **Share certificates:** `meta.companyId` — mirror of the shareholder register
  (`market.setHolding` / `syncAllCertificates`). `marketValue` tracks the day price.
- **Property deeds:** `meta.propertyId` — qty-1 mirror of `property.ownerId`
  (`deeds.transfer` / `syncAllDeeds`).

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
corporateRate, propertyRate, vatRate, gamblingRate }, newspapers [4 fixed papers],
newspaperRouting { Category: paperId }, music { library, playlists, activePlaylist,
allowedPlaylists, lockPlaylist, forcedTrack, volume }, entertainment { venues: [casino|
lottery…] }, economy { baseDailyWage, wageHappinessK, wageEmploymentK, dailyVariance?,
happinessOutputK?, happinessConfK?, dayTickMs? }, trade { partners, govBuyPrices, govBuy,
exports, imports, lastFlows, lastExportFill, stockIn, history }, map { countries, labels,
roads, rails }, mapDecor`.

## Roles & users

Role: `{ id, name, perms: { pages: [...], inventories: 'all'|'own'|'none', accounts:
'all'|'own'|'none', companyFinancials, government, statistics, mapLayers: ['political',
'data', 'ownership', 'military'], manageNews, gm } }`. Ten seeded: gamemaster, citizen, mp,
judge, executive, president, minister, journalist, police, military.

User: `{ id, username, displayName, salt, passHash (scrypt), roleId, entityId (their persona),
newspaperId (journalists), created, lastLogin }`. Seeded users all use passphrase `arcasia`:
gm, president (Miron Valen), journalist (Jana Halden), executive (Kira Moss), citizen
(Toma Rill), plus MPs/executives/judge/military/police personas (verenne, stahl, kandel, suri,
hale, keller, odek, grazi, orn, krenn, voss, falk).

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
- Plus many ungated idempotent fixes (currency rename, newspapers, music defaults, casino
  owner self-heal, certificate/deed reconciliation…). Follow the existing patterns when adding.
