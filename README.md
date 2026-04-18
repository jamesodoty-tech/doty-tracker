# DOTY Project Tracker

A mobile-first, single-file construction project tracker. Built for a Toronto-based construction manager juggling multiple job sites at once.

## Features

- **Today view** (default) — every scheduled item dated today across every project, plus overdue and items awaiting confirmation.
- **Week view** — next 7 days, grouped by date, across all projects.
- **Projects** — cards with live counts (today / upcoming / to-do / to-buy / needs-confirm). Tap a card to open its full page with schedule, to-do, to-buy, and notes.
- **Quick-add parser** — one input at the bottom of the screen. Understands:
  - `9 Jerome: wallpaper guy Thu 9am`
  - `Newkid: meet HVAC tomorrow 2pm`
  - `Delaware: rent compactor Apr 24`
  - `Jerome todo: order tile spacers`
  - `Jerome buy: 2 boxes screws`
  - `leaving for work` → launches the punchlist
- **Punchlist** — button top-right (or type "leaving for work"). Clean, readable screen of today + next 2 days, overdue items, and anything awaiting confirmation, grouped by date and project.
- **Needs-confirmation** flag (amber tag) stays visible until you mark it confirmed.
- **Checkbox → strikethrough → auto-archive** after 24 hours.
- **Persistent storage** — localStorage (`doty.tracker.v1`). Data survives refreshes and restarts. Same-device only.
- Big tap targets (48px minimum), high-contrast, no cute styling.

## Run locally

Just open `index.html` in a browser. No build step.

## Deploy to GitHub Pages

1. Create a new repo (public or private with Pages enabled), e.g. `doty-tracker`.
2. Copy `index.html` and this `README.md` into it.
3. Push to GitHub:
   ```
   git init
   git add .
   git commit -m "DOTY Project Tracker"
   git branch -M main
   git remote add origin https://github.com/<YOUR-USERNAME>/doty-tracker.git
   git push -u origin main
   ```
4. On GitHub → **Settings → Pages** → Source: `Deploy from a branch` → Branch: `main` / `(root)` → Save.
5. Wait ~1 minute. Your app is live at `https://<YOUR-USERNAME>.github.io/doty-tracker/`.
6. On your phone, open the URL in Safari/Chrome → **Add to Home Screen** for a full-screen app icon.

## Data

All data lives in `localStorage` on each device. The first time the page loads, it seeds the three preloaded projects:

- **9 Jerome** — deadline Apr 30, 2026. Painters on site, door/kitchen/hardware Mon 20th, electricians Tue 21st, countertops Wed 22nd, wallpaper Thu 23rd 9am, cleaners Tue 28th (needs confirm), photos Wed 29th. To-buy: 2× chrome glass shower door kits.
- **Newkid** — 1pm meeting Fri Apr 17 (arrive by noon, bring iPad), electricians Wed Apr 22. To-do: talk to HVAC, hook up WC.
- **Delaware** (238 Delaware Ave) — slab-on-grade build, forming stage. Crew: Hayes, Ray, Moses, Dave, Tyler. Deadline mid-July. monday.com board IDs saved to project notes. Mon Apr 20 site check-in.

To reset to the seed data: open browser devtools → Application → Local Storage → delete the `doty.tracker.v1` key, then refresh.

## Shortcuts

- Type `leaving for work` in quick-add → opens the punchlist.
- Type `Project: item Thu 9am` → schedule item.
- Add the word `todo` / `buy` / `note` after the project to force that type, e.g. `Jerome buy: trim screws`.
- Add `?`, `tbc`, `unconfirmed`, or `needs confirm` anywhere → the item gets the amber "needs confirmation" tag.
