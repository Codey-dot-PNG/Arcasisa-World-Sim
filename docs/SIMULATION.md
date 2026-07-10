# Simulation Engine (server/sim.js, server/market.js)

## The turn loop — `sim.advanceTurn(steps, actor)`

Per step, in order:

1. `store.snapshot()` (rollback point)
2. `time.turn++`, date advances by `perTurn × unit` (hour/day/week)
3. **Events** whose trigger is due run (`every_turn`, `interval` n, `weekly`/`monthly`
   boundary crossings, `date` reached). Conditions checked against `globalVars`; each effect
   applied with per-effect error isolation (a failed effect logs and continues).
4. **`runEconomy`** — the per-turn production economy (below)
5. **`runForeignTrade`** — exports/imports from the national stockpile
6. **`runBankCrisis`** — bank-reserve solvency check → economy-wide crash while underwater
7. `updateDerived()` — recompute globalVars (population, gdp, avgHappiness, avgApproval,
   moneySupply, treasury, econConfidence)
8. On month boundary: `gdpGrowth` updated, Statistical Bureau news auto-published
9. Lottery draws due this turn (`casino.drawDueLotteries`)
10. `recordHistory()` (chart time-series; polling sampled weekly) + `recordTradeHistory()`
11. `store.log('time', …)`

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

## Foreign trade — `runForeignTrade`

Works off `settings.trade`. **Exports:** every Commodities/Goods/Military item in the national
stockpile is offered at `retail × trade.exports[item].mult` (per-country overrides; `off`
parks an item). Partners whose authored price meets the ask buy up to their demand capacity
(`High/Med/Low` → 2500/750/250, or explicit `partner.capacity[item]`), **highest bidder
first**; money → treasury. **Imports:** standing orders (`trade.imports`) buy from the
cheapest qualifying supplier under `retail × maxMult`, never overdrawing the treasury; goods →
stockpile. Flows land in `trade.lastFlows` / `lastExportFill` / `stockIn` and the per-turn
`trade.history` for graphs.

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

**Ticking without a process:** `maybeDayTick(db)` is wall-clock-gated on `db._lastDayTick`
(default 5000ms, `economy.dayTickMs`); ridden by `GET /api/state` and the local 5s timer, plus
one tick per turn — the gate prevents double-ticking.

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
