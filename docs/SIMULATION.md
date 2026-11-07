# Simulation Engine (server/sim.js, server/economy.js, server/market.js)

## The turn loop — `sim.advanceTurn(steps, actor)`

Per step, in order:

1. `store.snapshot()` (rollback point)
2. `time.turn++`, date advances by `perTurn × unit` (hour/day/week)
3. **Events** whose trigger is due run (`every_turn`, `interval` n, `weekly`/`monthly`
   boundary crossings, `date` reached). Conditions checked against `globalVars`; each effect
   applied with per-effect error isolation (a failed effect logs and continues).
4. **`runEconomy`** — the per-turn production economy (below): sites produce, the home
   market clears (`economy.clearMarket`), owners are settled (sales, upkeep, payroll, tax)
5. **`runForeignMilitary`** — foreign powers quietly re-arm off-books (Phase 27, below)
6. **`runBankCrisis`** — bank-reserve solvency check → sets `bankCrisisSeverity`, which the
   national economy reads (it no longer writes province numbers itself)
6b. **`economy.runTurn`** — the national economy (see "The national economy" below): jobs,
   wages, incomes, food, spending, taxes on people, prices, moods; monthly population
7. `updateDerived()` — recompute globalVars (population, gdp, avgHappiness, avgApproval,
   moneySupply, treasury, econConfidence). Since Phase 27 `moneySupply` sums DOMESTIC
   accounts only — accounts owned by `foreign`/`org` entities (e.g. `acct_markasia`) are
   excluded so they can't inflate the national aggregate charts.
8. On month boundary: `gdpGrowth` updated, Statistical Bureau news auto-published
9. Lottery draws due this turn (`casino.drawDueLotteries`)
10. `recordHistory()` (chart time-series; polling sampled weekly) + `recordTradeHistory()`
11. `generateTradeOrders()` — opens the next turn's foreign-trade order book (below), then
    `redeemMaturedBonds`, `runDiplomacy`
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
| `recompute_employment` | legacy: jobs→employment from property `employees` vs labour force. The national economy computes employment every turn now; an event using this is overwritten next turn |
| `adjust_trust` | drift company trust toward an expression (`avghappiness` exposed) |
| `reprice_shares` | fundamentals reprice: `price ×= 1 + a·(profit/valuation) + b·gdpGrowth + c·((trust−50)/100) + 0.05·((econC−50)/100) ± e` |
| `set_share_price` | direct set (`$price` = current) |

## The production economy — `runEconomy` (Phase 13/14, Economy v2)

Per property (owner required): output scales with province happiness
(`1 + (hap−50)/50 × happinessOutputK`) and a per-turn random wobble (`dailyVariance`).
`productionContext(db, pr, {noise:false})` gives the expected multiplier without the wobble
(the national economy sizes markets with it).
- `prodMode 'goods'`: mint `produces[].perTurn` units. Split per item (`keepPctFor`): `keepPct`%
  → the property's own inventory; the rest is **offered to the home market**. After the
  property loop the market clears (`economy.clearMarket`, below): each good sells as far as
  demand reaches, sellers sharing it pro rata at the turn's opening price; what is not bought
  goes back into the site's stock (`pr.lastSold[item] = {offered, sold}`).
- `prodMode 'cash'`: `cashPerTurn` revenue (shops, offices, casinos, ports) × the province's
  **services index** (what people spend there vs. normal — `economy.servicesIndex`).
- `prodMode 'none'`: pure cost.

Settlement per owner: sales − upkeep (`expenses × expensesMultiplier` + maintenance +
training) minted/burned at the edge; then **payroll** (`employees × wagePerTurn`) leaves the
owner's account (`'Payroll'`) for the population sector — an owner short of cash pays what it
can pro rata and its sites' morale drops; a sovereign (`allowNegative`) pays in full; then
corporate/property tax on profit **after** payroll. Company `vars.revenue/expenses/profit`
are annualised (×365). `globalVars.listedAverageWage`, `listedEmployees`, `lastWageSpend`
describe the listed payroll; `p.econ.listedGross` feeds province GDP.

**Wages & morale.** `sim.wageFor(db, pr)`: the site's `wagePerTurn`, else its company's
(₳1 default), else — state, character or party sites — the province's going wage
(`economy.marketWage`). Worker morale heads for `50 + 25·log2(wage ÷ going wage)` (±30).

**Staffing after losses.** `pr.staffTarget` is the headcount the owner chose (set whenever
the owner or GM sets `employees`). Accidents thin the crew; each turn the site rehires 15%
of the gap (down to a fifth of that at very low morale). Before this, unattended sites bled
staff to every accident for ever.

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

**War → the economy (Economy v2):** a live war's severity (`market.warSeverity`) and each
province's occupation (`war.stats.provinceControl`) feed the national economy: occupied
provinces lose local jobs and rural self-sufficiency, imports shrink under blockade, and
moods carry a war term. (The old flat per-turn happiness hit is gone.)

**Strikes (`applyStrikes`, Phase 31):** at the top of runEconomy, every live `att` (crowd)
unit in an active protest marks nearby sites on strike. A property within
`STRIKE_RADIUS` (120px) of a crowd gets `pr.vars.strike = {degree, sinceTurn}` — `degree`
is capped by the protest's `tuning.strikeFrac` (default 0.5) and scales with crowd
strength (Σ min(1, strength/5000), so a 5000-strong crowd applies its full fraction).
Production is multiplied by `Math.max(0, 1 − degree)` for both goods and cash modes, AFTER
the staff/hour multipliers (the workforce multiplier composes first; the strike factor
multiplies that result). The flags clear the moment the crowds leave or the protest ends
(a closing timeline log marks it), employees stay employed and wages keep flowing, and the
first strike of each protest emits a Wire Service `draftNews`. Companies and property
owners see the banner in their Operations desks.

**Riot refugees (Phase 31):** while a protest is violent (`protestorsViolent`), each
fighting tick kills civilians around the clashes (`tuning.civFrac` × the tick's losses)
and every `tuning.refugeeEvery` ticks (default 4) a wave moves `tuning.refugeeFrac`
(default 0.04) of the affected population into shelter via the same `moveRefugees` /
`settleRefugees` machinery as war refugees (see docs/WAR.md "Refugee columns"); columns
render and settle identically, and `war.stats.civilianDeaths`/`refugees` feed the War
Room strip.

## The national economy — `server/economy.js` (Economy v2)

The people the players govern, employ, feed and sell to. It replaced households.js (175
representative households with bank accounts that received wages and never spent them),
`runDemographics` and the seeded drift events, which together let a famine halve the
population while approval rose.

**The people are a sector, not accounts.** Each province × demographic group ("segment",
`p.demographics[g]`) carries `income` (₳ per person per month), `netIncome`, `incomeTax`,
`savings` (₳ per person), `employment`/`unemployment`, `foodAccess`, `poverty` (% below the
line) and the attitudes (`happiness`, `economicConfidence`, `governmentSupport`). Real money
lives only in actors' accounts. It crosses the edge metered: payroll leaves employers,
consumer spending arrives as sales revenue, income tax and VAT reach the treasury, welfare and
unemployment benefit leave it.

**Roles** come from `settings.economy.groupRoles` (`worker` default, `rural`, `student`,
`retired`); `referenceGroup` anchors the wage scale; `ladder` (low → high) is the class
ladder; `urbanize {from, to}` the rural → urban drift. The engine assumes no names.

**Calibration.** The first time it runs (or after "Recalibrate") the engine reads the world
as it stands as normal: each group's wage multiple, unemployment exposure and food share,
the steady-state flow rates of the population, every good's market size, the food need per
head. Then **settling**: from turn 16 to 45 it measures what actually happens (sites run a
little below rated output — accidents, rehiring, moods, inputs) and re-reads each good's
market, the food need, the spending/output baselines and each province's normal employment
from that, once. Change after that comes from conditions, not from the rules drifting.

**Jobs.** Each listed employee stands for `jobsPerEmployee` (200) jobs in the province's
industry and suppliers; the **local economy** (shops, services, small farms) supplies the
rest and heads for its calibrated size × population × services index^0.5 × (1 − 0.35·occupation)
× (1 − 0.10·bank crisis), closing 3% of the gap a day. Employment = jobs ÷ labour force
(worker + rural groups); each group's unemployment is the province rate × its calibrated
exposure, renormalised.

**The wage scale.** The going wage of the reference group is pegged to a good:
`settings.economy.wageAnchor = { itemId, units }` — a day's work buys `units` of it at its
normal price (seeded as 0.0577 t of grain ≈ 58 kg ≈ ₳3/day; prices sit close to 1960
dollars). `settings.economy.wageScale` records the scale the world is on. Moving the anchor
(`economy.applyWageAnchor`, run once by `store.migrate` flag `world._wageAnchor1` and again
whenever the GM changes it) scales incomes, savings, the poverty line, income-tax brackets,
stipends and every company's and site's wage by k, and runs each site with k times fewer,
k times better-paid workers (headcounts ÷k, `jobsPerEmployee` ×k) — payroll in ₳, profits
and provincial jobs stay as they were; the engine's ₳ baselines scale with it, so nothing
re-settles, and GDP keeps its level (`gdpTarget`). New companies default to the going wage (`economy.nationalWage`).

**Wages.** The province's market wage heads (2% a day) for `w0 × CPI^0.85 × productivity
growth × (1 + 0.01 × employment gap)` — a level, so it cannot drift away. Listed employers
lead it: `going wage = market wage × (listed average ÷ market wage)^(listed share of jobs)`
(relative to calibration; listed pay counts up to 3× the market). Workers earn
`going wage × group multiple × 30 × employment`; students and retirees a calibrated share
of working incomes; plus opt-in stipends and unemployment benefit (paid by the treasury).

**Spending.** Per group: income − income tax (if `taxation.enabled && pitEnabled`, brackets
in ₳/person/month) = disposable; food first (a full bought diet costs the group's
calibrated food share × base income × food price index); the rest is spent less a saving
rate that rises with income, with savings drawn down when income falls. VAT is inside what
people pay (the state takes `vat/(1+vat)`).

**The home market — `clearMarket(db, offers)`.** Every produced good has
`item.meta.demand = {kind, base, home0, backlog}` (`staple` by `meta.stapleFood`,
`military`/`consumer` by category, else `industrial`). Demand = `base × index ×
(price ÷ (basePrice × CPI))^−elasticity` + what industry buys. Indices: staple = commercial
food need × affordability; consumer = real non-food spending; industrial = real GDP;
military = 1 (+0.6 in a war). Lumpy goods sell against built-up demand (`backlog`);
staples never carry over. Prices move `0.05 × ln(demand ÷ supply)` a turn on smoothed values
(max 3%; staples 1.5%), within 0.3–3× base. **The rest of the world**: at import parity
(base × (1 + 25% + import tariff)) imports cover part of a shortage (30% of demand for a
good the country makes; in full for one it does not; less under blockade); at export parity
(base × (1 − 20% − export tariff)) part of a glut goes abroad. Military goods have no
background trade. A GM/event reprice (`marketValue` changed outside the engine) rebases
`basePrice`. Result per good: `item.meta.market = {offered, demand, sold, imports, exports,
price, base, turn}` (public).

**Industrial purchasing.** Sites with `requires` (supply chains) and `autoSupply !== false`
buy inputs from the home market each turn, up to `reorderTurns` (10) of stock and 3 turns'
use at a time, paid by the owner (never more than half its cash).

**Food.** Need = population × need per head (per turn, the farms' perTurn scale). Rural
groups grow `subsistenceShare` of theirs (less under occupation); the rest is bought from
the market (sales + imports), rationed by demand × affordability, with a pantry buffer
(smoothed fill) so a day's shortfall is not a famine. Relief food released from the national
reserve (`releaseFood` → `p.vars.foodStock`) feeds whoever is still short and spoils
`reliefDecay` a turn. The reserve (government inventory) is filled only by what the state
keeps or buys — domestic sales no longer pour into it. `foodSecurity` per province;
hunger deaths only below 90% access (`famineMortalityK × shortfall²` a year).

**Population (monthly).** Births (`birthRate`, lower with misery, hunger and war) join the
working groups; deaths by age, disease (`diseaseK × (100 − healthcare)/100`) and hunger;
ageing into retirement and school enrolment/graduation at the calibrated steady-state
rates; the class ladder moves up with education and growth and down with unemployment
(balanced at calibration); urbanisation speeds up when towns pay better.

**Attitudes.** Each group's targets: happiness = baseline + real (after-tax, VAT-inclusive)
income vs. what it has come to expect (adapts over ~a year) + unemployment vs. normal + food
access + healthcare/education/crime vs. calibration + war + inequality change. Confidence
adds the short-run income trend, inflation and the stock market. Government support follows
happiness and confidence plus how far the governing parties sit from the group. They drift
toward the targets (between turns on the demographics cadence). GM/event changes to a
province's happiness or approval are folded into its groups as shocks that fade; employment,
GDP and population are the engine's (writes to them are overwritten next turn).

**Statistics** (`globalVars`): `gdp` (₳M/yr nominal). Its level is set by
`settings.economy.gdpTarget` (₳36,000M, seeded by `store.migrate` flag `world._gdpLevel1`):
the first turn after calibration a national factor makes GDP equal it (a GM change of the
target re-sets it; Recalibrate keeps the current level), and from there it moves with the
wage bill, employment and listed output — a wage-scale move leaves it where it is (wage
units changed, not output). With `gdpTarget` 0 it is the wage bill ÷ `labourShare`. When the
factor is (re)set, the industrial-demand and growth baselines are carried onto the new level
so no index jumps. The authored record sits on the level too (`store.migrate` flag
`world._gdpSeedLevel1`): the seed's 1958–59 history keeps its shape with its last month at the
level, and a world whose economy has not run yet reads the level at turn 0 — so turns 0, 1 and
2 all read ₳36B, with no cliff from the old ₳13B seed figure. A world reset under a canon that
wiped its economy settings (see WORLD-DATA.md, the baseline canon) gets the missing keys back
once (`world._econKeysRestored1`): its played GDP record is put on the level and the economy
recalibrates, so the next turn reads exactly the level. `gdpReal`, `realGrowthAnnual`, `cpi`, `inflation` (12-month), `foodPriceIndex`,
`averageDailyWage` (going wage), `wageIndex`, `realWageIndex`, `laborForce`,
`totalEmployment`, `unemploymentRate`, `avgIncome`, `consumerSpending` (₳/day),
`householdSavings`, `povertyLineNominal`, `povertyRateNational`, `giniNational`,
`foodSecurity`, `foodSupplied`/`foodNeed`/`foodImported`, `famineDeaths`, `lastMonthBirths`,
`lastMortalityDeaths`, `populationGrowthAnnual`, `pitRevenue`, `vatRevenue`,
`welfareSpending`, `bgImports`/`bgExports`. Province `vars`: `employment`, `unemployment`,
`wage`, `income`, `gdp`, `gdpReal`, `foodSecurity`, `foodStock`, `povertyRate`,
`povertyGap`, `giniIndex`, `happiness`, `approval`, `economicConfidence`, `lifeExpectancy`,
`infantMortality`, `mortalityRate`, `birthRate`. Poverty and Gini assume a lognormal spread
of income inside each group (`incomeSpread`).

**Tunables** (`settings.economy`, GM Studio › Economy & Trade › Levers & Tax): see `DEF` at
the top of server/economy.js. `PATCH /api/gm/settings {economy:{recalibrate:true}}` forgets
the calibration (re-read next turn).

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

### Ongoing contracts (`runTradeContracts`)

Two kinds share one register (`db.tradeContracts[]`) and one per-turn pass, which runs
immediately after `generateTradeOrders` opens the fresh book (or right after a
tradeReset-cadence turn's flow reset — matching never uses order ids):

- **`kind:'order'`** — automates an open-market fill. Every turn it re-fills whichever
  listing matches its `{side, partnerId, itemId}` — ids are regenerated every turn, so
  the pair is the stable key — by calling the same `executeTrade` a manual fill uses
  (identical volume pricing, tariffs, embargoes, stock/funds checks). A turn with no
  matching order (or an already-filled / unaffordable one) just idles: `lastTurnNote`
  records why for the dossier row and nothing else happens.
- **`kind:'transfer'`** — a standing player-to-player supply agreement
  (`{fromEntityId, toEntityId, itemId, qtyPerTurn, payByFrom, payByTo, memo}`): goods
  drawn from the deliverer's own stock *and its sites* (`drawHolderStock`, like any
  export) land in the recipient's inventory, and agreed payments move through
  `ledgerTxn`. Short stock delivers partially; a broke payer is noted — neither voids
  the agreement. Certificates/deeds/leveraged items are refused at signing so the
  canonical-record mirrors can't be bypassed by an unattended loop. The counterparty
  consents once: unless the creator controls both ends (or is GM) it starts
  'proposed' and only activates on accept (`POST …/:id/accept`); either party can
  cancel any time.

Duration counts turn-openings regardless of idling; `turnsLeft === null` runs until
cancelled. Signed / cancelled via `POST /api/trade/contracts`,
`POST /api/trade/contracts/:id/cancel`, removed (when not running) via
`DELETE /api/trade/contracts/:id`. Order contracts are managed from Economy → Markets →
International trade → Contracts; transfer contracts from Economy → Trades.

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

**×100 leveraged trades (Phase 34):** a buy with `x100: true` books a DERIVATIVE position on
`co.x100` (not the register — no ordinary certificate is created, though a non-tradable
"×100 Leveraged Shares" item mirrors the book into the holder's inventory so it shows up
there and in the Shareholdings tab). The position is bought at the ordinary day price, but
its value tracks the day quote with `settings.economy.x100Mult` (default 100×) sensitivity
from its entry price, floored at zero: +1 % doubles it, −1 % wipes it out — the Bank pays
the amplified payout on sale and absorbs the loss (its reserve going negative is the same
designed failure mode as ordinary sales). Positions are locked for
`settings.economy.x100LockSec` (default 60) REAL seconds after purchase (`pos.at =
Date.now()`), enforced in `sell()` (GM exempt); both knobs are adjustable in the GM Economy
tab. The book counts against the float (`heldTotal`) and the public-float cap
(`personPublicHeld`), and a transfer/trade of the mirrored item is rejected — the only exit
is selling back through the exchange. Ordinary buys additionally record the holder's
average entry price on the register row (`rec.entry`, carried by transfers), so the
Exchange can show position value and gain/loss for normal holdings too.

## Elections & polling

`computePolling`: per province, per demographic group — turnout from happiness/education;
party scores from ideology distance vs `politicalLeaning`, education vs `soc`, government
approval (`inGovernment` flips the sign), a party's `appeal`, and regional `support` —
negative standing counts too (it used to be ignored, so a regional party authored at −30
outside its home polled a third of the national vote); votes split by softmax.
`computePollingFor(db, noise)` is the pure form. `party.appeal` is calibrated once
(`world._pollAppeal1`) so national polling opens at each party's share of the seats it holds;
group `governmentSupport` then moves with lived conditions (economy.js). A province `voterBase` overrides all of it. `runElection`: seats apportioned to
provinces by population (largest remainder, min 2), allocated by **D'Hondt**; writes an
election record, sets `party.mpCount`, publishes news. Manual entry supported
(`/api/gm/election` with `manual: { rows, turnout }`). `GET /api/polling` is public.

### Live elections (Phase 33) — `server/election.js`

The GM calls an election (`POST /api/gm/election/campaign`) and the world doc gets a live
`db.election` riding turns (no timers — serverless-safe). Two phases:

- **campaign** — parties spend money + campaign stock on catalogue campaigns
  (`POST /api/election/campaign`, any controller of the party or the GM; defaults
  migrate into `settings.election.campaigns`). Each run adds `strength` to the party's
  support in one province (visible in polling), charges `moneyCost` from the party treasury
  account, consumes stock items (rows may offer `or` alternatives), and accrues
  `party.vars.campaignPointsByProvince`. **Support is permanent**: once earned it stays on
  the party's books in that province (shaping the simulated polls between elections too) —
  the campaign's `durationMinutes` only gates the party's next launch (one drive at a
  time), it never unwinds support.
- **voting** — `POST /api/gm/election/vote` closes the polls and rolls the true ballots
  per province: each party's polling share is nudged by `(rand×2−1) × deviationPct` and
  renormalised per province (the renorm amplifies the swing — an 8 pp polling gap can
  become ~12–27 pp of the true result; GMs dial this with `deviationPct`). The count
  then advances **one batch per turn** (`el.durationTurns` turns total): per turn each
  province reports `batch × provTotal / nationalTargetsTotal` votes with
  `BATCH_NOISE=0.6` noise, so leads grow and shrink dramatically until the final step
  snaps to the true totals (`el.targets`). `campaignPoints` translate into late votes
  (`strength × supportToVotes`) fed in as the count runs. Finalize apportions
  `el.targets` (the shared `sim.apportionSeats`), writes a `db.elections` record
  (`live: true`), and publishes Election Commission news. Campaign support is
  **not** decayed at finalize — every point earned stays on the books.
- Mid-count levers: `POST /api/gm/election/adjust` (per-party vote correction,
  re-spread proportionally and logged), `POST /api/gm/election/tick-count` (count a
  batch now), `POST /api/gm/election/cancel` (abort; support already earned stays).
  Tuning
  (`PATCH /api/gm/settings` `election: {durationTurns, deviationPct, supportToVotes,
  campaigns}`) applies to the next call and re-derives an in-flight count's unrevealed
  ballots from the new deviation.
- Public spectacle: every operator sees the live doc via `election.forPlayers` —
  counted batches, steps, progress, log — but `targets` (the unrevealed roll),
  `baseTargets`, `rng`, `deviationPct` and `supportToVotes` stay GM-only. The GM Studio
  Election tab exposes the true totals mid-count; the client never fabricates outcomes.

## Presidency

`syncPresidency(db)` keeps `ent_gov.ceoId` + `executives` matching all users holding the
`president` role (co-presidencies supported). Called after user CRUD and from `migrate()`.
Titles are flipped between "President of the Republic" and "Former President".

## Real-time cadences (Phase 35)

A single scheduler (server/cadence.js) runs subsystems on **world-clock** intervals —
paused clocks pause everything. State: world._cadence (per-cadence
lastWorldMs/
extWorldMs), seeded idempotently by cadence.migrate(), which runs from
store.migrate() **unconditionally** so new cadences self-seed on old worlds. Ticks ride
requests (GET /api/state) and a local timer; catch-up is capped at 50 handler calls and
advances one interval per scheduled slice, never jumping to "now". Intervals are GM-tunable via
settings.cadence.{productionHours,demographicsHours,tradeResetHours} (0.25–72h clamp);
progress ships in GET /api/state as cadence.{name}.{progress,nextAt,hours}.

Catch-up after a forward clock jump (GM date move, import, rate rebase) collapses the
backlog into at most 50 handler calls with proportionally wider world-time windows —
handlers scale their slice math to the window argument, so totals match elapsed world
time without machine-gunning per-request bursts. No single window exceeds one turn, and
backlog older than ~50 turns is dropped rather than replayed. The GM settings PATCH
preserves clock continuity: it re-anchors the world clock only when the date,
time-of-day, or rate was actually changed — never on a plain echo of the Studio form.

Cadences:
- production (1h): the hourly production engine below + condition decay/maintenance,
  capital projects, tender closing.
- demographics (4h): moods drift toward the targets the last turn's economy set
  (`economy.drift`), by the elapsed world time; the turn pass then skips its own drift.
- 	radeReset (1h): rerolls the foreign order book WITHOUT resetting per-turn flow
  accounting; orders.seq is the monotonic stamp clients key drafts off.

The Day Market deliberately has NO cadence: it already advances on its own ~5s gate plus
once per turn.

## Hourly production & turn settlement


unHourlyProductionTick pays out each active property's per-turn budget in world-hourly
slices using fractional accumulators (ars._prodAccum for items with whole-unit flooring,
ars._cashAccum for cash-mode deposits). Sold slices accumulate on the property and are
settled into revenue ONCE per turn by 
unEconomy, which reads its hourlyAccrued flag:
when any production tick fired since the last turn boundary it only settles what accrued;
otherwise it falls back to the legacy lump pass (so paused-clock / manual-turn worlds keep
a working economy). Wages, upkeep, tax, accidents, morale and share repricing stay strictly
turn-scoped. Both paths share productionContext() — the single source of truth for the
output-multiplier stack.

## Supply chains

property.requires = [{ itemId, perUnit }] — inputs consumed from the SITE inventory per
1 unit of primary output, every production hour. The worst input-availability ratio scales
ALL outputs and persists as ars.supplyFulfillment. Absent 
equires ⇒ byte-identical
behaviour. Edited via PATCH /api/property/:id/controls (
equires), GM Studio editor.

## Tenders

- Tenders (6d): db.tenders, lowest qualifying bid before the world-clock deadline wins;
  the full order is delivered and paid in ONE SHOT at award time through the pooled-stock
  trade helpers + txn. Opened by the government or any manage_tenders grantee.
  (The standing-contracts feature was retired — no db.contracts. Capital projects were
  removed; migrate() sheds any pr.projects data from older worlds.)

## Roster delegation

entity.roster[].grants.scopes + ownership.canAct(db, userId, entityId, scope, opts) —
the ONE delegation primitive (chain first, then grants narrowed by spendLimitPerTurn,
properties/accounts/unitFilter lists). Over-cap spends land in entity.pendingRequests
with an action snapshot; approving replays the original mutation verbatim then deletes the
request. Party members with empty scopes render as rank-and-file.
