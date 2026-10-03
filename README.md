# DOTY Project Tracker — V8.0

A construction tracker with **Calendar, Projects, Labour, Contacts and Settings**, plus Punch at the top. Calendar has Day/Week/Month views. Archive inactive projects without losing notes or financial history.

Project accounts separate actual expense cost, explicit markup/client tax, labour billing, worker pay, client payments and worker payouts. Dollar amounts are CAD. People have private effective-dated wages. Supplier/subtrade contacts live in Contacts.

**Settings → Backup & restore** covers the complete account. Imports start with validation and a replacement preview; v7 tracker-only files are clearly identified. No automatic notes-to-money migration.

Run `node local-preview.mjs`, then open **http://localhost:8766/?demo&sync**. No build/install step. The preview is synthetic and loopback only. See [REVIEW.md](REVIEW.md) for backup recovery, privacy, pricing and deployment prerequisites, [TEST_RESULTS.md](TEST_RESULTS.md) for validation and [MOBILE_REVIEW.md](MOBILE_REVIEW.md) for screenshots/device limits.

The V8 backend was released after explicit approval and a private source review. Existing authentication, KV source records and sharing grants are preserved. Pending source proposals keep balances visibly provisional; they require review before acceptance. Private source files and recovery copies are excluded from this repository.

Fresh production V8 has a reviewable owner coordinator in `backend/owner-account.mjs`: complete transactional export/restore within the review’s FINANCE_ACCOUNTS Durable Object binding. The Settings import/export screen uses its authenticated API. See REVIEW.md for per-owner activation, recovery and old-storage preservation.
