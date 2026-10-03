# V8.0 review validation

Synthetic only · Node v24.21.0 · existing installed Chromium · 2026-10-03.

Ten Node suites:

- `ledger.test.js`: exact cents/rounding, half-days/hours, unknown pay, totals/overflow, source warnings, permissions, sync CAS and script syntax.
- `backend.test.cjs`: original authenticated Worker and 37-tool MCP, shared private store, owner/role/view-as isolation, CAS/retry/rollback, corrections/reimport identity, snapshots/distinct undated days, original notes/time unchanged.
- `ui-review.test.cjs`: actual source acceptance handlers, replay/snapshot refusal, sourced correction/history, full evidence and retained staged source warnings, unsupported non-CAD acceptance refusal and exclusion, readable worker names.
- `phase.test.cjs`: stable IDs/rename, original metadata/history, no default, normalized duplicates, scoped evidence/legacy assignment and MCP parity.
- `people.test.cjs`: account-wide names/IDs, duplicates/CAS/retry/privacy, day/hour snapshots, legacy-hour separation, explicit legacy assignments, retained foreign evidence and CAD-only new records.
- `wages-contacts.test.cjs`: effective history/future/backdated/unknown/zero, immutable rows/proposals, archived new-booking refusal/verified history/Restore, Contacts validation/search/owned links/archive/CAS/lost-response.
- `backup.test.cjs`: full inventory/checksum/schema/secret exclusion; valid-checksum malformed phases/schema/timestamps, audit/receipt values and null tracker records rejected before writes; archive/orphan discovery; all-store content roundtrip; advancing revision fences/stale-write conflict; uncertain-response replay; partial failure rollback and startup crash recovery; v7 tracker-only preservation without inferred money/people/dates; owner/role protection.
- `markup.test.cjs`: approved purchase/client HST split and $1,299.50 / 0% $1,130 / nonchargeable $0; exact rounding/bounds; explicit unknown-tax refusal; taxable/no-tax/manual modes; new-project 15% versus historical at-cost; snapshots/default changes/manual override/MCP parity and real Worker add_project new-project default; CAD schemas and archived project refusal.

- `owner-backup.test.cjs`: real Worker MCP/Basic-auth REST routing plus actual remote backup UI handlers, explicit preview and lost-response reload recovery; authoritative fresh-owner inventory; Unicode chunking and >1,000-entry paging; complete all-store atomic replacement/recovery; durable prepare/apply replay, stale writes and pre-restore generation fencing; injected interrupted transaction and restart; export/edit race; V7 orphan preservation; role/owner and credential isolation; original KV unchanged; 22 checksum-valid malformed stored-record cases leave account, existing proposal and recovery unchanged, and historical minimal audits remain readable.

- `activation.test.cjs`: original KV visible until owner approval, other users untouched, pending-write fence/cancel, late legacy-write detection, atomic activation and preserved recovery.

`redesign-ui.test.cjs` exercises the **actual UI** in its own synthetic server/temp Chrome profile: five navigation tabs, Day/Week/Month, Toronto DST stepping; project Add/Archive/Active/Archived/Restore and entry pickers; Contacts; new-project pricing defaults, receipt inputs and saved $1,299.50 billing breakdown; one full backup download, unchecked preview, reviewed restore, deliberately lost apply response and reload recovery; v7 restore/reload with private/orphan history preserved. No runtime errors on the final run.

Actual browser dimensions: Calendar/Projects/Labour/Contacts/Settings, all calendar modes and new Contacts/expense forms passed at **393×852** (document width 378) and **430×932** (width 415), without horizontal overflow. Latest results are in UI_REDESIGN_RESULTS.json. Saved screenshots contain only synthetic UI data. Viewport/profile are isolated from the user's Chrome.

Run from the repo using Node (bundled path `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node` if needed). The browser suite starts/stops its own ephemeral server and requires the existing `/Applications/Google Chrome.app`.

Production runtime export/prepare/apply and independent complete read-back passed during the explicitly approved release. Current tracker matched the private source before migration; original notes/time/items and existing grants survived read-back. Pending source proposals remain unaccepted and totals remain provisional. Distributed load/capacity and actual iPhone Safari/home-screen/keyboard remain unverified. Whitespace checks and the original captured Worker checksum are verified separately.

2026-10-03 correction regression: `legacy-correction.test.cjs` verifies an audited historical correction retains its original unassigned phase, dates, fractional day quantity, client billing and source identity. New unassigned bookings, fabricated phase names and removal of a known phase reject without partial writes. Backend and owner-backup suites also pass.

An owner-confirmed worker payout can be recorded through the authenticated financial API with an unknown date and no phase allocation. Such an account settlement does not create a bank transfer, infer a payment method or assign payment to a work phase. Replay-safe operation receipts prevent duplicate settlements; invalid provided phases still reject. Synthetic regression coverage verifies the undated, unallocated payout and unchanged client billing.
