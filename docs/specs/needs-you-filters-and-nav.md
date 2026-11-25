# Spec: Needs you filters and item navigation

Status: agreed 2026-11-24. Terms as in [GLOSSARY.md](../../GLOSSARY.md).

## Problem

- The Decisions scope panel looks ragged: label-left rows with selects of different widths, a floating All questions pill, a dense note, and a matches line that truncates.
- Scope resets whenever `/needs` is opened without a query string.
- Repo scope takes one repo in the UI, though the server and URL take several.
- An item opened from Needs you offers "Items" as the way back.
- Working through the queue means going back to it after every item.

## Scope

Decisions tab only. Feedback and Stopped are unchanged. `/items` keeps its single Repository select (follow-up).

## Requirements

### R1 Back link (PR A)

1. Opening an item from the decision queue (title link, `o`, Review and answer, the Decision tools item link, the preview's Open full task) navigates with history state `from = { url }`, where `url` is the queue URL at that moment (path and query).
2. The item page back link, classic (`modules/item/page/ItemPage.tsx`) and v2 (`modules/maintain/item/views.tsx`), reads "Needs you" and links to `from.url` when present and `url` is a `/needs` URL (history state is untrusted); otherwise "Items" and `/items`, as today.
3. A shared or typed link has no state and shows "Items".

### R2 Scope panel layout (PR B)

1. Each control stacks its label above it at full width; sections `gap-3`; a divider before the actions row.
2. Repo is the existing `RepoFilter` (checkboxes plus find, scrolling after about five repos), writing `repo=a,b`. It stays hidden while a project pick is set.
3. Kind and Waiting at least are full-width selects.
4. All questions is a `Switch` row "Include all questions" with one-line note "Waiting and With opinions only". The 36500-day cap is not shown.
5. The "N matches · … · oldest" line wraps instead of truncating.
6. The queue column is wider beside the decision panel: 340 px from 861 px, 400 px from 1101 px, 460 px from 1440 px (was 300 / 340).
7. Existing behaviour holds: chips for URL values a control cannot show, Clear scope, a history entry per change, 16 px fields on phones, 44 px targets on phones.

### R3 Saved scope (PR B)

1. Every change of view or scope saves `{ tab, repo, kind, age, all }` to localStorage under `autocraft:<login>:needs-filters`.
2. Opening `/needs` (Decisions tab) with none of those keys in the URL restores the saved values, replacing the history entry.
3. Any of those keys in the URL wins; nothing is restored.
4. Clear scope removes the saved scope (the saved view stays).
5. While a project pick is set, saved repos are not restored.
6. Storage blocked or unreadable: behave as today, no error.

### R4 Previous / next (PR B)

1. `from` (R1) also carries `queue`: the ids of the loaded queue rows, in order, keeping only decisions with an item (`number != null`), plus the `decisionPath` of each.
2. The item page header shows `‹ i of n ›` beside the back link when `from.queue` holds the current decision. Buttons are disabled at either end. Keys `[` and `]` step and are listed in the `?` sheet.
3. A step navigates to that decision's path, carrying `from` with `url`'s `decision=` set to the new id, so going back selects the last viewed decision.
4. No auto-advance after answering.
5. The queue is a snapshot: it does not refetch or change when decisions are answered elsewhere. A decision no longer in the snapshot shows no arrows.
6. Phones: same header row, 44 px targets.

## Non-goals

- Server-side saved filters (upgrade path: a `needsFilters` key in `/api/me/settings`).
- Multi-repo on `/items`, Feedback or Stopped.
- Arrows for batch pages or the decision panel.
- Fetching beyond the loaded rows from the item page.

## Acceptance

- Each R line above has a test or a manual check listed in the plan.
- `pnpm test` and the web typecheck pass; `docs/ui-design.md` describes the new behaviour.
