# Simulation Engine (server/sim.js, server/market.js)

## The turn loop — `sim.advanceTurn(steps, actor)`

Per step, in order:

1. `store.snapshot()` (rollback point)
2. `time.turn++`, date advances by `perTurn × unit` (hour/day/week)
3. **Events** whose trigger is due run (`every_turn`, `interval` n, `weekly`/`monthly`
   boundary crossings, `date` reached). Conditions checked against `globalVars`; each effect
   applied with per-effect error isolation (a failed effect logs and continues).
4. **`runEconomy`** — the per-turn production economy (below), ending with the war's
   civilian-mood hit (`applyWarHappinessImpact`, Phase 27 — see "War → happiness" below)
5. **`runForeignMilitary`** — foreign powers quietly re-arm off-books (Phase 27, below)
6. **`runBankCrisis`** — bank-reserve solvency check → economy-wide crash while underwater
7. `updateDerived()` — recompute globalVars (population, gdp, avgHappiness, avgApproval,
   moneySupply, treasury, econConfidence). Since Phase 27 `moneySupply` sums DOMESTIC
   accounts only — accounts owned by `foreign`/`org` entities (e.g. `acct_markasia`) are
   excluded so they can't inflate the national aggregate charts.
8. On month boundary: `gdpGrowth` updated, Statistical Bureau news auto-published
9. Lottery draws due this turn (`casino.drawDueLotteries`)
10. `recordHistory()` (chart time-series; polling sampled weekly) + `recordTradeHistory()`
11. `generateTradeOrders()` — opens the next turn's foreign-trade order book (below), then
    `runDemographics`, `redeemMaturedBonds`, `runDiplomacy`
12. `store.log('time', …)`

Then one `store.save()` + `broadcast('sync')` for the whole batch.

**Auto-advance:** long-lived process → `scheduleAuto()` interval timer; serverless →
`GET|POST /api/cron` calls `autoTick()` which advances however many turns became due
(capped 30) since `auto.lastTick`.

## Expression language

Safe arithmetic evaluator (`sim.evalExpr`): numbers, `+ - * / %`, parens, `$var` (reads
`ctx.vars` — the current target's variable bag), bare identifiers as string args. Division by
zero yields 0; any non-finite → 0. Functions: `rand(a,b), round, floor, ceil, abs, sqrt,
min, max, clamp(v,lo,hi), turn(), g(key), prov(id,key), ent(id,key), item(id),
pop(all|provId), balance(entId)`. `interpolate(str)` substitutes `{expr}`, `{date}`, `{turn}`,
`{world}` in news/log text. Test endpoint: `POST /api/gm/test-expr`.

## Effect types (`sim.applyEffect`)

| type | what it does |
|---|---|
| `adjust_var` | `{scope: global\|province\|entity\|property, target, key, op: add\|set\|mul, value}` |
| `adjust_demo` | `{province, group\|'all', metric, op, value}` — demographic metrics; pct metrics clamped 0–100; province vars exposed as `$p_<key>` |
| `money` | `{kind: transfer\|deposit\|withdraw, from, to, amount, memo}` via `txn()` |
| `spawn_item` | `{entity, item, qty}` (negative removes) |
| `set_item_value` | `{item\|'all', category?, value}` — `$value` = current price; repricing revalues every inventory |
| `transfer_property` / `transfer_company` | reassign `ownerId`, auto-drafts news |
| `adjust_support` | `{party, province, group, value}` — regional support bonus used by elections |
| `news` | `{headline, body, category, publish, paperId?}` with `{expr}` interpolation |
| `election` | run a general election now |
| `property_pl` | legacy monthly property P&L (kept as a manual GM tool) |
| `log` | timeline entry |
| `recompute_employment` | jobs→employment from property `employees` vs labour force |
| `adjust_trust` | drift company trust toward an expression (`avghappiness` exposed) |
| `reprice_shares` | fundamentals reprice: `price ×= 1 + a·(profit/valuation) + b·gdpGrowth + c·((trust−50)/100) + 0.05·((econC−50)/100) ± e` |
| `set_share_price` | direct set (`$price` = current) |

## The production economy — `runEconomy` (Phase 13/14)

Per property (owner required): output scales with province happiness
(`1 + (hap−50)/50 × happinessOutputK`) and a per-turn random wobble (`dailyVariance`).
- `prodMode 'goods'`: mint `produces[].perTurn` units. Split per item: `keepPct`% → the
  property's own inventory; of the sellable rest, `govMix`% (or `govMixByItem`) is offered to
  the state. The state buys only if the company's ask (`retail × co.govPriceMult`) ≤ the
  government ceiling (`trade.govBuy[item].maxMult`, per-company overrides), up to remaining
  quota — bought goods go into `ent_gov.inventory` (the national stockpile), paid from the
  treasury. Whatever the state declines sells on the abstract domestic market.
- `prodMode 'cash'`: `cashPerTurn` revenue (casinos, offices, banks).
- `prodMode 'none'`: pure cost; its `expenses` count as public output for GDP.

Settlement per owner: domestic revenue is scaled by **economic confidence**
(`0.7 + 0.006 × econConfidence`); minus per-turn `expenses` and the wage delta
(`employees × baseDailyWage × (wage−100)/100`); per-turn tax on positive net (corporate /
property rate) when `taxation.enabled`; net minted/burned at the world edge via `ledgerTxn`
(no per-call timeline spam — one summary log per turn). Government purchases transfer
treasury → company. Company `vars.revenue/profit` are annualised (×365). Wage index nudges
province happiness/employment; confidence shifts happiness/approval
(`happinessConfK`, default 1.6 — a major driver). Province GDP = production gross ×
`globalVars.gdpScale` (calibrated once at migration).

**Zero-property companies bleed (Phase 27, war overhaul):** company profit is now tied
STRICTLY to properties. A company that owns no property at all this turn (lost them to war
occupation, sold them off) no longer coasts on a stale authored `vars.revenue/profit`:
runEconomy zeroes its `vars.revenue`, charges a per-turn **corporate overhead**
(`vars.overheadPerTurn` — HQ upkeep/admin baseline, drawn from its account down to zero,
set by the Phase 27 migration at 12% of the company's pre-rebalance property expense
footprint), sets `vars.profit` to the annualised overhead loss, and decays `vars.valuation`
0.5%/turn toward the zero property-backed value it can actually justify. The other half is
the migration's one-shot **company profit rebalance** (`world._companyProfitRebalance`):
each company's existing properties were scaled (produces `perTurn` / `cashPerTurn` /
`employees` / `expenses` together) so their property-derived annual revenue matches the
company's authored `vars.revenue` — without it, flipping to property-only income would have
silently slashed every company's earnings. The wartime mechanism that actually strips
properties from companies is documented in docs/WAR.md "Occupation property transfers".

**War → happiness (`applyWarHappinessImpact`, Phase 27):** called at the end of runEconomy
while a war is active. Every province takes a flat nationwide −0.05 happiness/turn (people
worry about a distant war too), plus an occupation hit scaling with
`war.stats.provinceControl[provId]` — up to −0.6 happiness/turn at full occupation; approval
takes 0.6× of the same hit. Generic: reads only `db.war`/`db.provinces`, no
scenario-specific knowledge. (The market-side war effects live in server/market.js — see
"War → market" below.)

## Foreign trade — the order book (`generateTradeOrders` / `executeTrade`)

Nothing settles automatically. Each turn `generateTradeOrders` resets the per-turn
accumulators and posts procedural ORDERS per partner from `settings.trade.partners[]`
authored data: **buy orders** (goods the partner wants from Arcasia — our exports, from
`partner.exports`/`demand`) and **sell orders** (goods it offers us — our imports, from
`partner.imports`/`supply`). Price = the item's global retail `marketValue` × the partner's
per-item `priceMult`, shaded by relations (±10%, Phase 25), demand/supply level
(High/Med/Low) and a small random drift. Players fill orders by hand via `executeTrade`
(the President from the national stockpile, CEOs from company stock): the more of an order
you fill, the worse your effective price (`TRADE_IMPACT` 35% at a full fill), tariffs go to
the treasury, and — since Phase 27 — an **export's goods actually land in the buying
partner's own inventory** (`addInventory(partner, …)`, mirroring how imports have always
landed in the holder's), so foreign arsenals genuinely accumulate what they buy (tanks
included — the Phase 27 migration authors Satrom '42E and Type 50M tank imports onto the
Sarom/Qinal trade desks). Flows land in `trade.lastFlows` and the per-turn `trade.history`
for graphs.

## Foreign military production — `runForeignMilitary` (Phase 27)

Every foreign power with an authored `entity.meta.military` profile (`{ navy, army, size,
focus, alliance, allies, importsFrom }` — seeded by store.migrate, see docs/WORLD-DATA.md)
slowly accrues **off-books materiel into its own inventory** each turn. No money changes
hands — this is not trade, just the world quietly re-arming itself in the background.
Runs right after runEconomy in the turn loop; Arcasia itself is skipped (`type:'foreign'`
only — the Republic's arms come from properties: ARC Arms Works rifles/tanks, Kradon
Shipyards hulls).

Per power, fractional per-turn accruals build up in `e.vars.milAccum = {fuel, guns, tanks,
ships}` and pay out whole units into inventory when they cross 1. Rates = a base × a size
multiplier (tiny 0.4 … big 1.8) × a strength multiplier (none 0 … strong 1.8):

- **fuel** (`MIL_FUEL_BASE` 1.5/turn at medium) — every armed power;
- **small arms** (`MIL_GUN_BASE` 10/turn) — the power's own national pattern
  (`item.meta.originId === entity id`), else its `importsFrom` exporter's pattern, else
  whatever model it already holds (complements existing stock, never a second type);
- **tanks** (`MIL_TANK_BASE` 0.03/turn) — only strong armies, or quality-focused
  medium-and-up ones, with an owned/imported tank pattern;
- **warships** (`MIL_SHIP_BASE` 0.015/turn) — strong navies only, owned pattern only.

Entirely data-driven (profile + `item.meta.originId`) — the engine carries no per-nation
special cases. These inventories are exactly what docs/WAR.md's arsenal deployment and
per-unit resupply draw on when that nation ends up in a war.

## Stock market — server/market.js

**Two prices per company:**
- `sharePrice` — the TURN price ("company value"), repriced once per turn from fundamentals
  (`repriceAllShares` in runEconomy, coefficients 0.3/0.4/0.075/0.015).
- `dayPrice` — the DAY-MARKET speculative price. Ticks every ~5s (`dayMarketTick`): mean
  reversion toward `sharePrice` (3 %/tick), econ-confidence bias (±0.6 %/tick), seeded noise
  (`vol`), clamped to the circuit-breaker band 0.25×–4× of fundamental value. Order flow moves
  it via `applyDayImpact` (impact = `depth × qty/sharesOutstanding`, capped ±25 % per trade).
  Between ticks clients and server compute the identical live wiggle from `dayAnchor` via the
  shared **pricepath** function.

**War → market (Phase 27):** two mechanisms in `dayMarketTick`, both generic (they read
only `db.war`/`db.provinces`/`db.cities`):
- **`warSeverity(db)`** — 0 (no war / war going nowhere) to 1 (country mostly occupied,
  cities in enemy hands): 0.6 × mean province occupation (`war.stats.provinceControl`) +
  0.4 × fraction of cities lost (`war.stats.citiesHeld`). Applied per tick as a bearish
  day-price drift (`warBias`, up to −1.2%/tick at severity 1, alongside the confidence
  bias) and as a direct `econConfidence` bleed (−`sev × 0.8` per tick).
- **`checkWarShock(db)`** — a ONE-OFF confidence shock the moment the war doc's "shape"
  changes (war starts/ends, a city changes hands), detected by comparing a cheap
  fingerprint stashed on `db._warMarketMark` — fires exactly once per change, serverless-
  safe (no timers). Every company's `confidence` takes −12 and `econConfidence` −8; the
  first observation after boot sets the mark without shocking.

**Ticking without a process:** `maybeDayTick(db)` is wall-clock-gated on `db._lastDayTick`
(default 5000ms, `economy.dayTickMs`); ridden by `GET /api/state` and the local 5s timer, plus
one tick per turn — the gate prevents double-ticking. A day tick `store.save()`s but does
**not** `broadcast('sync')` (same rule as war ticks): a per-tick broadcast forced every
client, market-watching or not, into a full refetch every ~5s. Exchange watchers stay live
on their own: the wiggle is client-side (pricepath), and `startPriceTicker`'s overdue nudge
(below) refetches — and thereby drives the server gate — once the next committed tick is due.

**Day Market client prediction** — the read-only half of the war layer's
snapshot → local prediction → rebase pattern (see docs/WAR.md's "Client-side
prediction"), applied where it's actually safe: nothing here predicts a
trade or any money movement, only what's already public, deterministic
display state.
- `server/api.js`'s `filterState` exposes `dayTick: { lastAt, intervalMs }` —
  `db._lastDayTick`/the resolved `dayTickMs` gate `maybeDayTick` itself already
  reads, just surfaced to every operator (a timestamp and an interval, not
  sensitive). `public/js/views.js`'s `viewExchange` renders a "next Day
  Market tick in ~Xs" countdown from it (`dayTickCountdownText`), ticked by
  the same 900ms interval that already drives the live-price label
  (`startPriceTicker`), instead of only updating on the next full refetch.
- The DAY MARKET (LIVE) sparkline (`dayChartNode`) appends ONE extra trailing
  point beyond the real `dayHistory` array: the current live wiggle price
  (the same `PricePath.price(...)` call `livePrice`/`livePriceEl` already
  use for the text label), recomputed from scratch on every 900ms tick and
  never written back into `c.dayHistory`. This is why it's safe: the
  server remains the sole source of the next REAL `dayPrice` (`dayMarketTick`
  draws `Math.random()` noise, deliberately not reproducible client-side,
  unlike the war engine's seeded PRNG) — the chart's live point is always
  discarded and recomputed, never asserted as a committed history entry.

**Counterparty = the National Bank (`ent_bank`).** Buys pay the Bank; sells and offerings are
paid BY the Bank from its finite visible reserve; buybacks pay the Bank. The Bank may go
negative on sells (players can always exit) — which triggers…

**Bank crisis (`runBankCrisis`):** reserve ≤ 0 → per-turn hits to company confidence, day
prices, and province happiness/employment/approval, scaling with shortfall depth (full
severity at 4 % of money supply underwater). Auto-news on crash and on recovery.
`globalVars.bankCrisis/bankCrisisSeverity`.

**Confidence plumbing:** per-company `confidence` moves on meaningful price moves (deadband
0.6 %, drops sting harder) and reverts toward the level the day-price premium/discount implies.
`econConfidence` = cap-weighted smoothed mean; feeds revenue, the turn reprice, happiness
drift, and the day-market bias.

**Operations:** `buy`/`sell` (at live day price, VAT applies on buys, `publicFloat` caps
ordinary-person holdings), `transfer` (P2P, no cash), `offer` (primary raise at market price,
Bank fronts cash, day price marked down by the supply flood), `bonusMint` (free shares, both
prices dilute), `buyback` (retire float, price up), `remarkFromTrade` (block trades through
the trade-offer system re-mark the day quote, clamped ±25 %). The shareholder register is
canonical; `setHolding` mirrors into certificate items.

## Elections & polling

`computePolling`: per province, per demographic group — turnout from happiness/education;
party scores from ideology distance vs `politicalLeaning`, education vs `soc`, government
approval (`inGovernment` flips the sign), and regional `support` bonuses; votes split by
softmax. A province `voterBase` overrides all of it. `runElection`: seats apportioned to
provinces by population (largest remainder, min 2), allocated by **D'Hondt**; writes an
election record, sets `party.mpCount`, publishes news. Manual entry supported
(`/api/gm/election` with `manual: { rows, turnout }`). `GET /api/polling` is public.

## Presidency

`syncPresidency(db)` keeps `ent_gov.ceoId` + `executives` matching all users holding the
`president` role (co-presidencies supported). Called after user CRUD and from `migrate()`.
Titles are flipped between "President of the Republic" and "Former President".
