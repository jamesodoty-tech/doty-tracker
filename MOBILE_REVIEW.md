# V8.0 phone layout review

Five navigation tabs: Calendar, Projects, Labour, Contacts, Settings. Day/Week/Month sit inside Calendar; Punch stays at the top. Contacts has one entry point; complete backup/import is in Settings only. New money forms have no visible currency field.

Existing paper/green style, rounded 48px controls, 16px input text, safe-area padding, measured sticky navigation, one-column forms, bounded tables/calendar and visualViewport-aware overlays/keyboard quick-bar behavior remain.

Actual isolated Chromium desktop simulations passed at 393×852 and 430×932, with document widths 378/415 and no horizontal overflow across all five tabs, all calendar modes and new Contacts/expense forms. UI tests also exercised archive/restore, pricing and complete backup recovery.

![Compact expense entry with explicit purchase/client tax](preview-v8-mobile.jpg)

![Single complete backup preview](preview-v8-backup.jpg)

This is not a physical iPhone/Safari/WebKit/standalone test. Home-screen installation, notch/landscape, native date/select controls, keyboard focus/scroll and auth persistence still require device QA. The preview stays loopback only; no LAN exposure or startup service was added.
