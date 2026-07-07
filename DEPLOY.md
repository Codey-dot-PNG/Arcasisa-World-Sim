# Deploying Arcasia free & 24/7 (Vercel + Supabase)

The engine runs in two modes and picks automatically:

- **No env vars** → local file mode (`node server.js`, world in `data/world.json`) — unchanged.
- **`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set** → cloud mode: the world lives in
  Supabase Postgres, live updates go over Supabase Realtime, and the whole app runs as
  Vercel serverless functions. Both are on free tiers with no credit card.

Total setup time: about 15 minutes.

---

## 1. Create the Supabase project (the database)

1. Sign up at **supabase.com** → **New project** (free plan). Pick any name/region/password.
2. When it finishes provisioning, open **SQL Editor** (left sidebar) → **New query**.
3. Paste the entire contents of [`supabase-setup.sql`](supabase-setup.sql) and click **Run**.
   You should see "Success. No rows returned."
4. Go to **Project Settings → API** and copy three values:
   - **Project URL** (like `https://abcdefgh.supabase.co`)
   - **anon / public** key
   - **service_role** key (keep this one secret — it has full database access)

## 2. Put the project on GitHub

Vercel deploys from a Git repository. In this folder:

```
git init
git add .
git commit -m "Arcasia Simulation Engine"
```

Then create a **private** repository on github.com and push to it (GitHub shows you the
two commands after you create the repo). The `.gitignore`/`.vercelignore` already exclude
your world data and the raw resource PSDs.

> Note: `public/assets/` (logos, flags, seal) **is** included on purpose — the app needs it.

## 3. Deploy on Vercel

1. Sign up at **vercel.com** with your GitHub account (free "Hobby" plan).
2. **Add New → Project** → import your repository. Framework preset: **Other**. Leave
   build settings empty (there is no build step).
3. Before clicking Deploy, open **Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |
   | `SUPABASE_ANON_KEY` | the anon key |
   | `CRON_SECRET` | any long random string (e.g. from a password generator) |

4. Click **Deploy**. When it finishes, open the app URL — the first request seeds the
   1962 world automatically. Sign in as `gm` / `arcasia` and **change the seed passphrases**
   (GM Studio → Roles & Operators) since the site is now public.

## 4. Automatic turns (optional)

There is no resident process in serverless hosting, so scheduled ticks come from outside:

- **Included:** a Vercel Cron job (see `vercel.json`) calls `/api/cron` **once a day at
  06:00 UTC** — the most the free Hobby plan allows. Each call advances however many turns
  have become due (capped at 30). If "1 turn = 1 day" is your pace, this is all you need,
  and it doubles as a keep-alive so your Supabase project never pauses for inactivity.
- **Faster ticks:** use any free pinger (e.g. cron-job.org, UptimeRobot) to hit
  `https://YOUR-APP.vercel.app/api/cron?key=YOUR_CRON_SECRET` hourly or every 15 minutes.
  Turns only advance when auto-advance is enabled in **GM Studio → World & Time**, at the
  cadence you set there — the pinger just gives the engine chances to catch up.
- Manual advancing from the GM Studio always works regardless.

## 5. Things worth knowing

- **Free-tier fit:** Supabase free gives 500 MB database and 5 GB egress/month; Vercel Hobby
  gives 100 GB bandwidth. A small RP community fits comfortably — the engine keeps the world
  document compact by capping the timeline (8,000 entries), ledger (12,000), news (400) and
  snapshots (20), and warm serverless instances skip re-downloading the world when nothing
  changed.
- **Supabase pausing:** free projects pause after ~7 days with zero activity. The daily cron
  ping prevents this; if it ever happens anyway, un-pause with one click in the Supabase
  dashboard — nothing is lost.
- **Simultaneous writes:** if two people submit changes in the exact same instant, the later
  write wins. With one GM and a small player group this is a non-issue, but know it exists.
- **Backups:** GM Studio → Archive & Danger → **Export World** works exactly as before.
  Download one whenever a big arc concludes.
- **Rollback:** in cloud mode one snapshot is kept per turn-advance action (the state it
  started from), up to 20 — listed in GM Studio → World & Time as always.
- **Local dev:** `node server.js` with no env vars still runs the file-backed version.
  Set the three Supabase vars in your shell and it runs against your cloud database —
  handy for testing before you push.
- **Updating the app:** edit code → `git commit` → `git push`. Vercel redeploys
  automatically; your world is untouched because it lives in Supabase.
