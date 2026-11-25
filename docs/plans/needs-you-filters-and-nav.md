# Plan: Needs you filters and item navigation

Spec: [needs-you-filters-and-nav.md](../specs/needs-you-filters-and-nav.md). Two PRs. Tests are `node --test` under `test/` (see `test/needs-controls.test.ts`).

## PR A: back link (R1)

1. `web/src/lib/links.ts`: add a `From` type (`{ url: string }`, extended with `queue` in B3), `fromState(url, d?, rows?)` and `readFrom(state: unknown): From | null`, which takes only a `/needs` URL (history state is untrusted).
2. Entry points pass `{ state: { from } }` with `url = location.pathname + location.search`:
   - `web/src/modules/decisions/review.ts` `reviewDecision`: add a `from` argument and pass it to `navigate`.
   - `web/src/modules/decisions/DecisionBrowse.tsx:123` `openItem`.
   - `web/src/modules/decisions/InboxList.tsx:185` (navigate) and `:330` (title `Link state`).
3. Back link reads `readFrom(useLocation().state)`:
   - `web/src/modules/item/page/ItemPage.tsx:128`
   - `web/src/modules/maintain/item/views.tsx:102`
   - Extract one `BackLink` component used by both, so the rule lives in one place.
4. Test `test/item-back-link.test.ts`: `readFrom` accepts a valid value and rejects junk, missing fields and a non-relative url; label and target with and without state.
5. Manual: open from Needs you, back returns with filters and selection; open a shared item link, back shows Items.

## PR B: scope panel, saved scope, previous / next

### B1 Scope panel layout (R2)

1. `web/src/modules/decisions/Toolbar.tsx` `NeedsControls`: replace the `row` and `control` classes with stacked label plus full-width control; swap the Repo `Select` for `RepoFilter` (`web/src/ui/molecules/RepoFilter.tsx`), value `scope.repo`, writing CSV or null; replace the All questions pill with `Switch`; shorten the note.
2. Drop the "a + b" `withCurrent` option for Repo (the checklist shows several); keep it for Kind.
3. `web/src/modules/decisions/InboxList.tsx:293`: let the matches line wrap.
4. `RepoFilter` title "Repositories" fits; check its `max-h-52` against about five rows and adjust only if needed.
5. Manual at 300, 340 px and phone width, light and dark.

### B2 Saved scope (R3)

1. New `web/src/modules/decisions/savedScope.ts`: `scopeOf(search, pick)`, `restorePatch(search, saved, pick)` (null when any View or scope key is in the URL; a pick's `repo` neither blocks nor is restored), `loadScope` and `saveScope` (try/catch like `shell/layoutStorage.ts`; an empty scope removes the key).
2. `useSavedScope` in `Toolbar.tsx`: a change made with the controls is saved; any other URL change (first open, nav link, Back) restores with `replace`. With a pick it waits for the shell's `repo`. Clear scope needs nothing extra: saving its result keeps only the View.
3. Test `test/needs-saved-scope.test.ts`.

### B3 Previous / next (R4)

1. Extend `From` with `queue: { id: string; path: string }[]`. `InboxList` and `DecisionBrowse` build it from loaded rows where `number != null`.
2. Pure helper in `links.ts`: `stepFrom(from, currentId, dir)` returns `{ path, from }`, with `url`'s `decision=` set to the target id, or null at the ends or when the current id is absent.
3. New `web/src/modules/item/QueueNav.tsx` (`‹ i of n ›`, disabled ends, 44 px on phones), rendered by `BackLink` from PR A. Register `[` and `]` with `useShortcutHelp`.
4. The current decision id comes from the `#decision-<id>` hash.
5. Test `test/queue-nav.test.ts`: `stepFrom` in the middle, at both ends, with the id absent, the `decision=` rewrite, and other query params kept.
6. Manual: step through five decisions, answer one (no auto-advance), go back and the last viewed is selected.

### B4 Docs

- `docs/ui-design.md`: the "Needs you" and "Item page" sections.
- Commit the new `GLOSSARY.md` with PR B.

## Risks

- Restoring on mount must not fight `useProjectInUrl`, which also writes `?repo=` with replace. Apply the restore after it, or skip repo when a pick is set (R3.5 already covers this).
- History state survives reload but not a new tab; that is accepted (R1.3).
