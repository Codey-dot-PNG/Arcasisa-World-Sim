# Sync & Realtime Architecture

## Overview

**Hosting modes:**
- **Local** (`node server.js`): Node.js HTTP server, file store (data/world.json), SSE for live updates, no external dependencies.
- **Cloud** (Vercel + Supabase): Serverless function (api/index.js routes all /api/* requests) + PostgreSQL (Supabase) + Supabase Realtime for push notifications.

**Storage model:** The entire world is a single JSONB row in table `world` (id=1, version bigint, doc jsonb). Mutations increment the version and are recorded in append-only audit tables:
- `timeline` — all mutations (money moves, ownership changes, variables, edits) with timestamps, player, action type.
- `transactions` — detailed debit/credit ledger for economic traceability.
- `snapshots` — world state snapshots before each turn (for rollback).
- `world_version` (id=1, version bigint) — a tiny public-readable row whose UPDATE is the realtime change signal broadcast to all clients.

---

## Request Lifecycle (Cloud)

All mutations follow the same 5-step pattern, implemented in `api/index.js` and `server/store.js`:

```
┌─────────────────────────────────────────────────────────────┐
│  1. api/index.js reads req.body ONCE (safe for retries)    │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  2. store.begin()                                           │
│     - SELECT world.version                                  │
│     - Reload doc from Supabase only if version changed      │
│     - Reset per-request buffers (pending timeline/txn)      │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  3. Handler (server/api.js) runs                            │
│     - Works against buffered doc (in-memory cache)          │
│     - Calls store.save() → marks dirty + buffers mutations  │
│     - Calls store.log() → appends to timeline buffer        │
│     - Response body is buffered; NOT YET sent to client     │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  4. store.commit()                                          │
│     - If dirty: COMPARE-AND-SWAP on world table             │
│       PATCH world SET version=newVersion, doc=...           │
│       WHERE id=1 AND version=<version from step 2>          │
│     - Zero rows updated → conflict; throw WORLD_CONFLICT    │
│     - If success: insert timeline/txn/snapshot rows         │
│     - Upsert world_version row                              │
│     - POST to Supabase Realtime topic 'world' event 'sync'  │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  5. api/index.js flushes response to client                 │
│     (only if commit succeeded)                              │
└──────────────────────────────────────────────────────────────┘
```

**Retry loop:** On WORLD_CONFLICT, `api/index.js` catches the error and retries the entire request (fresh begin → handler → commit) up to 3 attempts. Only after a durable commit succeeds is the buffered response sent to the client. If a handler throws mid-mutation, `store.invalidate()` drops the warm cache so a half-mutated doc is never reused or committed.

**Response-sync (Phase 21):** `server/api.js json()` attaches `sync: {v, user, state: filterState(u), polling}` to every successful world-mutating response (see docs/API.md for exclusions). The mutating client applies this payload directly (`applySync` in core.js) instead of refetching — its own write lands in ONE round-trip where it used to take three (POST → 250ms debounce → GET /api/state → GET /api/polling). Because the payload is composed inside the handler (pre-commit in cloud mode), `json()` marks the buffered response with header `X-World-V: pending` and `api/index.js` rewrites `v`/`sync.v` to the post-commit version right before flushing. File mode needs no patch: `save()` bumps `fileRev` synchronously inside the handler.

**Version fast-path:** `GET /api/state?ifv=<v>` answers `{v, unchanged: true, user}` (no `filterState`, ~100× smaller) when the client's version still matches and the request itself didn't mutate (`store.hasUncommitted()`), making broadcast echoes of a client's own writes and the fallback poll nearly free.

---

## Realtime Signal Path

**Server → Client:**
1. Handler commits successfully → `store.commit()` writes the world doc via CAS on version.
2. Only if the handler explicitly called `broadcast('sync')` (→ `store.requestBroadcast()`): the `world_version` row is upserted (id=1, version=newVersion) and the Realtime broadcast fires. **Silent saves do not ping.** War ticks, war orders, and other high-frequency churn call `store.save()` without `broadcast('sync')` — their consumers pull via the ~1s `/api/war/state` heartbeat, and pinging every client into a full refetch per tick/order was the single biggest cause of app-wide lag during a war (the world doc still commits and `v` still advances; the 20s fallback poll and the next real broadcast converge everyone else).
3. Supabase observes the `world_version` UPDATE and broadcasts event `{topic: 'world', event: 'sync'}` to all subscribed clients.
4. Client receives two signals:
   - **Supabase postgres_changes:** subscription on `world_version`, listens for UPDATE events (lowest latency, ~100ms).
   - **Supabase broadcast:** channel 'world', event 'sync' (fallback for network partition).
   - Both channels auto-resubscribe with 2s→30s backoff on CHANNEL_ERROR, TIMED_OUT, or CLOSED.
5. Client has fallback poll: every 20s, GET /api/state to fetch the latest world version.
6. Tab focus/visibility change triggers an immediate refresh.

**Client fetches:** GET /api/state returns `{user, state, v, polling}` where `v` is the current world version (polling is bundled — no separate serial GET /api/polling round-trip). The client sends `?ifv=<lastV>` on non-forced refreshes and **skips re-rendering** if `v` is unchanged from the last render.

**Optimistic outbox (core.js `Optimistic`):** the war layer's optimistic-order outbox generalised. A hot action (wire transfer, market buy/sell, goods trade) passes `opts.optimistic = fn(state)` to `POST(...)`; the fn paints the expected result into `W.state` synchronously (0ms feedback), re-applies across any authoritative state swaps that land while the request is in flight, and is settled (removed) the moment its own response arrives — BEFORE that response's sync payload applies, so the guess is never double-counted on top of server truth. A failed request forces a refetch to roll the guess back. Purely cosmetic: the server re-validates everything.

---

## Client Refresh Rules

**Deferral:** Refreshes are **deferred** (re-armed every 1 second) while the user is actively editing:
- Map editor: drawing, dragging, or pending debounced save.
- Inspector: inline-edit mode (W.inspEdit).
- Input focus: any focused input/textarea/select (except #exp-search).

**Scroll preservation:** App.renderAll() preserves scroll positions of:
- `.doc-view` and `.gm-main` (inside #view)
- `#exp-body`
- `#insp-body`

Scrolls are re-applied after a re-render to the same view, so users stay where they were while the world refreshes around them.

---

## INVARIANTS

Future changes to the sync layer must not break these:

1. **Every cloud mutation goes through begin() → handler → commit()** — handlers must never write to Supabase directly; all writes are buffered and committed atomically.

2. **Response must not be flushed before commit() succeeds** — this is the read-your-writes guarantee; a client must see the effect of its own request before receiving the response.

3. **commit() must write the world doc via CAS on version** — never an unconditional UPDATE. This is how conflicts are detected and retries are triggered.

4. **Handlers must be safe to re-run against fresh state** — no external side effects before commit, body read from req.body only. Retries will silently re-execute; idempotence is required.

5. **Timeline/transaction inserts happen only after the CAS succeeds** — if the CAS fails (conflict), no log rows are inserted. This prevents duplicate audit entries.

6. **Client: never re-render while the user is typing/dragging; never re-render when v is unchanged** — preserve scroll, avoid interrupting edits, and batch refreshes to avoid visual jank and lost keystrokes.

7. **Client: never apply an /api/state response that is older than what is already rendered** — `refreshState()` in core.js carries a request sequence counter (only the newest issued request may apply) AND rejects any response whose `v` is ≤ the last rendered `v`. Overlapping refreshes (realtime ping + poll + post-write refetch) resolve out of order; without this guard the UI visibly travels back in time (turns "reversing", fresh edits vanishing).

8. **Server: requests are serialized per instance** — api/index.js wraps every invocation in a promise-chain mutex because Vercel's fluid compute can run multiple requests concurrently in one instance, and the store's world cache/version/pending buffers are shared module state. Cross-instance safety is the CAS commit's job; in-instance safety is the mutex's. Never remove one because the other exists.

9. **`broadcast('sync')` means "other clients must refetch NOW"; `store.save()` alone means "persist silently"** — the Realtime ping (and the `world_version` upsert that IS a ping via postgres_changes) fires only on `broadcastPending`, never on mere `dirty`. High-frequency churn (war ticks, war orders/bombs) saves silently and is pulled by its consumers' heartbeat; pinging every client per tick is what made wars lag the whole app. Any mutation OTHER players must see promptly still requires the explicit `broadcast('sync')`.

10. **Response-sync v must be post-commit accurate** — a payload embedding `v` composed before `commit()` must be rewritten by api/index.js (X-World-V marker) after the CAS lands. A client that trusts a pre-commit `v` will poison its `?ifv=`/monotonic guards.

11. **Client: an optimistic guess is settled before its response's sync payload applies** — the payload already contains the write's real effect; re-applying the guess on top would double-count it. And a guess must never survive its request: error or network failure → settle + forced refetch.

---

## Debugging Checklist

### "Signups don't save / edits vanish"

**Check Vercel logs:**
```
vercel logs <app-name> --follow
```
Search for "world version conflict" or WORLD_CONFLICT. Some conflicts are normal (two players mutating at the same time), but an endless storm of conflicts suggests a handler is broken (throwing mid-mutation, calling store.invalidate() too often, or not idempotent to retries).

**Check environment variables:**
- If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are missing, the engine runs in **ephemeral file mode** on Vercel: every cold start resets the world. The logs print a loud "NO DATABASE CONFIGURED" banner. Set both vars in .env.local or Vercel project settings.

**Confirm supabase-setup.sql was re-run:**
- In Supabase project → SQL Editor, paste and run the current `supabase-setup.sql`. This creates/verifies the tables, RLS policy, and publication membership.

### "Changes aren't live for other users"

**Browser console (client side):**
- Open DevTools → Console.
- Look for the Supabase channel status: `Supabase channel status: SUBSCRIBED` (good) or any ERROR/TIMED_OUT/CLOSED (bad).
- If channel is dead, the 20s poll should still converge — if even a manual refresh doesn't show changes, it's a **commit problem**, not a realtime problem.

**Database check:**
```sql
-- Verify world_version row exists and is being updated
SELECT id, version, updated_at FROM world_version;

-- Verify world_version is in the supabase_realtime publication
SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
-- Should include (schemaname='public', tablename='world_version')
```

If world_version is missing from the publication, the Realtime signal won't fire. Re-run `supabase-setup.sql`.

### "Page jumps to top / typing interrupted / scroll resets"

**Verify /api/state returns v and it's stable:**
- Open DevTools → Network tab.
- Trigger a refresh or look at the idle 20s-poll requests.
- GET /api/state should return `{..., v: <number>}`.
- If v changes every poll while idle, the world is being mutated by something other than the player (e.g., event fires, auto-advance). Check server logs and Event Engine config.

**Check editingBusy() in core.js:**
- If editingBusy() returns false when it should return true, refreshes won't be deferred. Verify:
  - Map editor state is tracked correctly (drawing/dragging flags).
  - Inspector inline-edit mode (W.inspEdit) is set/cleared.
  - Input focus is detected (focus event listeners on all inputs/textareas/selects).

**Check scroll preservation in app.js:**
- After a re-render, scroll positions should be restored. If not, debug App.renderAll() to see if the scroll containers are being found correctly.

---

## Manual Testing Checklist

After any change to the sync layer, test with two browsers side by side:

- [ ] **Persistence:** Register a new account in browser A while browser B is idle. Log out of A, close all tabs, wait 10s. Log back into B with the same credentials. The account must survive (not ephemeral).

- [ ] **Realtime:** In browser A, advance a turn in GM Studio. Browser B must update the turn counter within ~2 seconds (realtime) or within 20 seconds worst-case (poll fallback).

- [ ] **Map drawing:** Draw a road or edit a province in A while watching B. The change must appear in B within ~2s.

- [ ] **Typing during mutation:** While a turn advances in A, type in an inspector field (e.g., rename a province) in B. Keystrokes must not be lost; the edit must save correctly.

- [ ] **Scroll preservation:** In B, scroll a long view (e.g., timeline) to the bottom. Let the page idle through two poll cycles (~40 seconds). Scroll position must not move; the page must not jump to the top.

---

## How to Run tools/diagnose-sync.js

A zero-dependency diagnostic script to verify the sync layer is working:

```bash
node tools/diagnose-sync.js https://your-app.vercel.app
```

The script will:
1. Check that Supabase is configured (ephemeral flag = false).
2. Register a test user and verify it survives a full login cycle.
3. Fire 5 concurrent signups to test CAS conflict handling.
4. Verify read-your-writes: a mutation on one session is visible to another before the response.
5. Print a PASS/FAIL summary and exit code 0/1.

Run before deployment to any production environment.
