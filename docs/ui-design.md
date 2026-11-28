# Triage dashboard: UI design

The design for the new dashboard frontend in `web/`. The data model, routes and access rules stay as in [dashboard-spec.md](dashboard-spec.md); this document covers what the reader sees and how features plug in.

## 1. Look: ArtCraft brand, developer-tool conventions

The dashboard is a working tool for issue and code review, so it follows the conventions of GitHub's PR and issue pages and Linear's issue view: a normal UI sans, compact rows, real tables, 28–32 px controls, hierarchy through weight and colour rather than size. ArtCraft supplies the brand cues, applied quietly.

### From ArtCraft branding (getartcraft.com and the ArtCraft app)

| Cue | Source | Use here |
|---|---|---|
| Logo mark | `frontend/apps/artcraft/app/public/artcraft-icon.svg` (`#4e7bfb`) | Top-left of the sidebar and phone header |
| Body face | getartcraft.com body text is Inter | Inter (bundled with `@fontsource-variable/inter`) for all UI text |
| Mono face | ArtCraft's Geist Mono | Only for code-like values: `repo#number`, diff stats, file paths, SHAs |
| Surfaces | App `--st-bg #121316`, `--st-panel #101014`, controls `#1e1f22`; site paper `#f2f1ee`, ink `#101014` | Dark: chrome `#101014`, content `#141518`, menus `#1e1f22`. Light: chrome `#f2f1ee`, content `#fbfaf8`, menus white |
| Accent | Primary `#2d81ff`, accent ink `#74aaff` | Primary buttons, the recommended option, links, focus ring, selected row |
| Corners | 3 px on pressable controls | 3 px controls, 4–6 px on boxes and menus |
| Icons | Lucide-style line icons, sized 1.15 em by a global rule | Phosphor (`@phosphor-icons/react`), sized the same way |
| Motion | `--ease-out`, short durations, reduced-motion collapse | Same, 120–180 ms |
| Chart hues | Timeline track colours (character, camera, object, audio, keyframe) | Categorical chart slots, re-stepped to pass colour-vision checks on both themes |

Not taken: Archivo display headings, uppercase letter-spaced mono labels, registration marks, dot grids, white filled buttons. Those belong to the marketing site and slow down reading in a dense tool.

### From developer tools

- Sentence-case section headings (12–13 px semibold), no all-caps labels.
- Body 13 px on desktop, titles 15–20 px semibold; one title per screen.
- List rows of two lines (title; `repo#n` · recommendation) at about 52 px, tables with 32–36 px rows, sortable headers with arrows.
- Badges are small rounded pills with a tinted fill for state (Whitelisted, write / no write, role).
- Controls 28–32 px on desktop, at least 44 px on phones.
- Key-value property lists (GitHub's PR sidebar, Linear's properties) for facts and item metadata.

## 2. Tokens

| Group | Tokens (Tailwind name → CSS variable in `web/src/styles/tokens.css`) |
|---|---|
| Surface | `bg` (sidebar, top bar), `panel` (content), `raised` (menus, buttons), `sunken` (inputs) |
| Ink | `ink` with alpha steps: 100 text, 85–90 body, 60 secondary, 45–50 hints; `inv` for text on accent |
| Lines | `line` (8 % dark, 10 % light), `line-strong` (16 % / 20 %) |
| State | `accent` / `accent-ink`, `ok`, `warn`, `bad`, `merged` (purple, GitHub's merged colour) |
| Charts | `c1`–`c5`, validated per theme (lightness band, chroma floor, CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, 3:1 contrast) |
| Type | `2xs` 11, `xs` 12, `sm` 13 (body), `base` 14, `md` 15, `lg` 17 (recommendation), `xl` 20 (page and item titles), `2xl` 24 (stat values) |
| Radius | 3 px controls, 4 px boxes, 6 px menus and dialogs, full for pills and avatars |
| Shadow | menus and dialogs only |

## 3. Component rules

- **Buttons**: primary (accent fill) for the one main action; secondary (raised, hairline) for the rest; ghost for icon and toolbar actions. Sentence-case labels.
- **Refs** (`photocraft#4127`) are mono. A ref is only ever shown as part of an item (see Items below) or as a mention inside prose.
- **Items**: every issue or PR is drawn by `ItemRef` (`web/src/ui/molecules/ItemRef.tsx`): the kind and state icon, `repo#number` in mono, then the full title. The title wraps; it is never truncated or clamped. The icon (`ItemIcon`) is a plain icon, one text line tall (`1lh`), so it sits with the text also on wrapped titles. Icon, `repo#number` and title together are one link to the item page; with `stretch` the whole row or card is. Every `ItemRef` ends with a GitHub button (`GithubButton`, Phosphor `GithubLogoIcon`, label "Open repo#number on GitHub") that opens the item on GitHub in a new tab. It is a sibling of the item link, never inside it, and sets `relative z-10` itself. Its visible size is small; an invisible hit area makes it 32 px on desktop and 44 px on touch screens without making rows taller. `github={false}` leaves it out. A row that is an item uses `stretch`, so the row is a `relative` container, and the other controls inside it (queue badge, menu, buttons, selects) sit above the link with `relative z-10`. Elements with a tooltip (`title`) or text people copy, such as dates, hints and error messages, count as controls and get `relative z-10` too. A row with no target of its own, such as a GitHub activity row (an action on an item), stretches to its item. A row that is something else, such as an agent run, keeps its own target and shows its items as `ItemRef` without `stretch`. A decision row in the Needs queue has two parts: its `ItemRef`, stretched over its own `relative` title block, and below it a separate Details button that selects the decision. Prose mentions such as `#123` in a summary stay inline: `Refs` links the number to the item page and adds a `GithubButton`. Nothing outside `web/src/ui/` builds an item link by hand; `githubItemUrl` in `web/src/lib/links.ts` is the one URL builder. Icon colours follow GitHub: open green, draft grey, merged purple, closed PR red, closed issue purple. The icon is drawn bold at 1.2× the text size. Sticky headers sit above it (`z-20`).
- **Filter chips** are 28 px outlined chips with counts; active chips take an accent tint.
- **Items rows** show the item as `ItemRef` and, below it, a Details button with classification, security, stage and age. Details opens the row's read-only details inline: classifier reasoning, classification, queue place, the latest three events oldest first, links and metadata, in columns where they fit and stacked on phones.
- **Tabs** are segmented text buttons with count pills.
- **Lists** are rows with hairlines, no cards. The selected row gets an accent tint and a 2 px accent bar.
- **Disclosures** are chevron rows with a sentence-case title and a count pill.
- **Empty states** use a muted icon and one line of text.

### Component folders

Shared components in `web/src/ui/` are grouped by size:

- `atoms/`: one element, no data fetching, no app domain types, styled only with tokens. ActionTag, Avatar, Badge, Button, Card, Chip, EmptyState, ErrorLine, GithubButton, Heading, Input, ItemIcon, Kbd, LabelPill, Logo, Pending, PriorityBadge, ResizeHandle, Select, Textarea, TextLink, Th, TimeAgo, Tooltip.
- `molecules/`: a few atoms doing one job, props only (no queries, no routing except `Link`; `ItemPeek` and `AuthorName` read their hover card's data when it opens). AuthorName, Block, CheckRow, ConfirmButton, Dialog, DisclosurePanel, ExpandableText, FilterOption, FilterSection, ItemRef, LabelledSelect, Markdown, MessageSample, OpusWorking, OverflowMenu, Pager, QueueBadge, QuickSelect, RadioRow, RateBar, RepoFilter, RepoSelect, SearchField, Segmented, Stat, StepDraft, StepFlow.
- `ActionTag` is a muted pill (Phosphor icon and a word) for one GitHub write. It is never interactive: no border emphasis, no hover. `RadioRow` and `CheckRow` are the rows of a pick-one and a tick list (title, optional tag, content under the title, `CheckRow` also an action at the right edge). The item page's decision answer (`modules/item/ChoiceGroup.tsx`) shows each core action as a bordered card (an accordion that behaves as a radio group: `role=radio`, `aria-checked`, `aria-expanded`); the open card holds the parameters, the extras as `CheckRow`s, the note and the card's own button. Each card has a "GitHub" line (`ActionTag` pills) and an "AutoCraft" line (plain text, from the server's `ChoiceCore.autocraft`). `RadioRow` serves the plain answer of decisions without choices.
- `organisms/`: a self-contained block with layout and behaviour (sorting, the phone switch). It may take domain-shaped props and never fetches. BrowseLayout, ChannelMock, CommentThreadMock, GithubSide, ItemChatPane, ItemConversation, ItemHolds, ItemPreview, Page, PreapprovalRow, QueuedCallRow, TutorialStep. The item page and the Items page's item panel share the chat organisms; their data hooks (`useItemChat`, `useItemPage`) live in `web/src/lib/hooks.ts`.
- `ChannelMock` and `CommentThreadMock` draw a chat channel and an issue thread in our own neutral look, for help pages; they are figures with a caption and hold no controls. `TutorialStep` is one numbered step with an optional Done / Not done yet mark and its links into Help.
- `ui/` itself holds helpers that are not components (`cn.ts`, `markdownHtml.ts`).
- `modules/<m>/`: anything bound to one feature's data or wording. Pages compose the folders above and own their queries.

Rules:

- The second module that needs a component moves it to `ui/` in the same change. Modules never import from another module's files.
- Buttons, inputs, selects, textareas, links, pills, cards, table header cells and empty states are not styled by hand outside `ui/`. A class string of more than about six utilities that appears twice becomes a component.
- Phone touch heights (44 px, `max-md:h-11`) are built into the atoms. Callers do not append them.
- Names: the component name is the file name, with one exported component per file. Controlled inputs take `{value, onChange}`; `tone` sets colour, `size` is `sm | md | lg`, `label` is accessible text. Status label and tone maps live in `lib/status.ts`, not in components.
- Items are always drawn with `ItemRef` (or `ItemIcon` plus text in the header of the item page and of the Items page's item panel) (see Items above).
- Check `ui/` before writing a component. New shared components are added to the lists above with their folder.
- Hooks shared by modules (`useWrite`, `useUrlState`) live in `web/src/lib/hooks.ts`.

## 4. Layout model

- **Shell**: sidebar, 44 px top bar (breadcrumb, global search, live counters, role badge, theme toggle, user menu), workspace. Under the top bar, maintainers and operators with setup left see the setup bar (dashboard-spec.md, Help).
- **Sidebar** (220 px, collapses to 52 px with `[`): ArtCraft logo, then Home, Items, Work queue, Agents and Stats, Runner, Help, and the Reference (Prompts, Environments, Repos, Scans, Audit log) and Admin groups for those who may open them. A page the reader cannot open is left out.
- **Workspace**: each view is a row of panels in a `PanelGroup`. Panels are resizable; panels marked `collapsible` fold to a narrow strip with a vertical label. Layouts are saved per user and view (`autocraft:<login>:layout:<view>` in localStorage; the storage adapter is two calls the server can implement later).
- **Phones** (< 768 px): one column. A view either supplies its own phone component (Work queue) or its panels stack top to bottom, skipping those marked `hideOnPhone`. The bottom tab bar holds the first four entries (Home, Items, Work queue, Agents). A hamburger button left of the logo opens the sidebar as a left drawer: the same rail component (groups, icons, permission filtering, active state), scrolling on its own, with a scrim; it closes on scrim tap, Escape, close button and route change, traps focus and locks body scroll. Search opens full screen.

### Project scope

- The sidebar and the phone drawer hold the project picker.
- A single `repo` in a list URL wins over the saved pick; a URL with several repositories picks no project. Item and settings pages are not scoped.
- Picking a project replaces the list URL; it adds no history entry. While a project is picked, lists hide their own repository control.

### Items

- `/items` is one browser: the search box with qualifiers, the "Match: Words | Meaning" toggle (in the Filters panel on phones) and the Filters button on one row; the active filters as removable chips; the Filters panel, closed by default; then the views as chips. Grammar and views: dashboard-spec.md, Items.
- Each filter in the panel is a select over one qualifier with its label above it; the empty option is "Any". A value typed in the box that a list lacks still shows as picked. The Filters button counts the active filters. Qualifiers the server did not apply are listed as not applied, in warning text.
- Every change of the query adds one history entry; the query and the page offset are the URL (`?q=is:open+label:bug&offset=50`).
- Desktop rows have two lines: `ItemRef` without its GitHub button (kind icon, `repo#number`, title), then AutoCraft's state and the markers, size (`S`, `M`, `L`, `XL`), CI, counts, the linked item and the labels as `LabelPill`s. A right column holds the GitHub button over the author, a team icon for authors on the team, and the time. A row click opens the item in the side panel, which shows only while an item is open, and the row is marked selected.
- Phone rows have three lines, the last two starting under the title text: the item link at full width (no GitHub button; it covers the row); one strip that never wraps with the state, priority, size, CI, comments and linked item, each in a fixed-width slot so they line up from row to row (a missing value takes no slot); then "Asks you", Duplicate and two labels with "+n", and the author, team icon and time at the right.
- The views wrap to at most two lines; the rest go into a More menu. The search row wraps the Match toggle and the Filters button under the box when it is narrow.

### Home

- One Task Runner line first ("0 Task Runners connected", "3 others available"), then problems (Needs attention: each row links to what it names and carries its action, such as Resume or Release, at its right), then the reader's own items: those they started, approved, held, resumed, answered or wrote about, newest conversation entry first. Show more opens `/items?filter=mine`. Viewers see the recently updated items of the repos they can see instead.
- Each row has its item link and GitHub button and the conversation's last message. A row whose open question is addressed to the reader is marked, and the Home entry in the sidebar counts those questions.
- Editable fields use 16 px text on phones, so the page does not zoom on focus.

### Items

- The Items page is one paged list with a search box that takes qualifiers, a row of views, a Filters panel, and a command bar pinned under the list while rows are ticked, which runs a command on the ticked rows, each on its own (dashboard-spec.md, Items).

### Item page

- A header with the status, the next step and badges (weight, duplicates, outside hold, security findings for staff), over the chat with AutoCraft: people's messages from every surface, AutoCraft's replies and recommendations, its work rows, and folded GitHub and Discord lines. Holds and paused steps show as a notice with their button above the composer.
- The side dock holds the GitHub and Events tabs beside the chat, resizable, with a width remembered per viewer and tab. Phones show Chat, GitHub and Events as tabs under the header.
- `?tab=github|events&event=<id>` opens a tab, and an event in Events; a work row opens its event.

## 5. Extensibility

One file lists the feature modules: `web/src/registry/index.ts`. The shell builds nav, routes, panel layouts, permission checks and the shortcut sheet from their declarations. Adding a feature means adding a module there; the shell does not change.

```ts
interface FeatureModule {
  id: string;
  permission: "viewer" | "operator" | `write:${string}`;
  nav?: { label; icon; to; group: "work" | "insight" | "operator"; order; phoneTab?; useBadge? };
  routes: { path; view: { id; title; panels: PanelDef[]; phone?; toolbar? }; permission? }[];
  commands?: { id; keys; label; group }[];   // listed in the "?" sheet
  slots?: { slot: string; order; component }[]; // fill a named place in another view
  prefetch?: (api) => void;
}
```

- **Panels** declare `defaultSize`, `minSize`, `maxSize`, `collapsible`, `startCollapsed`, `hideOnPhone`. Panels of one view share state through the URL (selection, filters) or a small view-local store.
- **Slots** let a module add to another module's screen without editing it. The item page renders the `item.side` slot under its own side panel (for example, a future "audit entries" or "cost for this item" block).
- **Data hooks**: `useQuery(key, api => …)` over the typed `Api` interface (`web/src/api/client.ts`). It refetches after any write. `createHttpApi()` (`web/src/api/http.ts`) implements it over the server's JSON API; `createMockApi()` implements it over deterministic fixtures for the mockup build (`VITE_MOCK=1`).
- **Keyboard**: views register the keys they handle (`useShortcutHelp`), so the `?` sheet lists exactly what works on the current screen.

## 6. Screens

### Item status and chat

- The status names the entry the item runs from (review, fix-up, implement or merge queue), the step it is at, and who started or approved it ("approved by mira", "held by david").
- A recommendation is AutoCraft's message in the chat: the findings and changes as a numbered list, then one plain sentence of what AutoCraft does next and whether it then merges or comes back. `drop 2` removes a part by number or by words of its title.
- The composer takes the same text as every other surface (`yes`, `fix 1 and 2, then merge`, `hold`). Text that is not fully understood runs nothing; AutoCraft replies with what it read. Every accepted answer gets one confirmation line.
- Weight shows as a word next to the item when it is not normal.

Description rendering is for untrusted input: raw HTML is dropped, only `http(s)`, `mailto`, relative and anchor links survive, links open in a new tab with `rel="noopener noreferrer nofollow"`, and only GitHub-hosted images load inline. The CSP allows only same-origin images, so the renderer sends images on the hosts the server allows through the image proxy; others show as a link.

### Who may answer

| Reader | May |
|---|---|
| Operator or maintainer with write access on the repo | start, answer, approve the merge, hold and resume any item of that repo; the name is kept with the action |
| Operator | also the instance settings (access, accounts, global pipeline switch, limits, prompts) |
| Viewer | read only |

The top bar shows the reader's role badge (Operator / Maintainer / Viewer).

### Item detail

Two panels: the item (68 %) and a collapsible side panel (32 %).

- Header as on GitHub: title with `#number`, a state pill (Open / Merged / Closed), author with avatar, age and repo. The header shows the item's `ItemIcon` with `repo#number`, and a "See in GitHub" button (GitHub icon and text, new tab, 44 px high on phones) among the header actions beside the menu.
- Properties as a key-value list: author with whitelist tier badge and merged / closed-unmerged counts; size (+/−, file count, S/M/L/XL); checks; mergeable; labels; updated.
- Classifier verdicts as a table, one column per classifier (type, want, reference, topics, reason). Values that disagree with the majority get an amber highlight; the heading says "2 of 3 agree on type". On phones, one block per classifier.
- Timeline with an icon per stage in plain words ("Waiting for an answer", "Merged by the pipeline"), actor and age; the current stage is highlighted.
- Files changed as a table with mono paths, +/− and a proportional bar.
- The description below the properties, rendered as described above.
- Side: the workflow (status, recommendation, answers), linked and duplicate items, CI checks, then the `item.side` slot.

### Item timeline icons

One icon per meaning (Phosphor, regular weight), chosen by `timelineIcon` in `web/src/ui/molecules/timelineIcon.ts`; each icon has an `aria-label` naming its kind. Events AutoCraft produced (pipeline steps, planner, model calls, its checks, its GitHub writes) draw the icon in the accent ink colour; people's events stay neutral. The events read oldest first.

| Meaning | Icon |
| --- | --- |
| GitHub event by a person (opened, pushed, comment, merge) | `GithubLogo` |
| Model call, grouped calls | `Sparkle` |
| Review verdict (Opus, pre-merge, post-merge) | `MagnifyingGlass` |
| Verification | `ShieldCheck` |
| Build, test or lint check, sandbox task | `Wrench` |
| Push by AutoCraft (fix-up, conflict merge, CI fix) | `GitCommit` |
| Merge by AutoCraft | `GitMerge` |
| Comment or review posted by AutoCraft | `ChatText` |
| Label change | `Tag` |
| Assigned, unassigned | `UserPlus`, `UserMinus` |
| Planner state change | `Signpost` |
| Job, other step action | `Gear` |
| Recommendation made, answered | `Question`, `CheckCircle` |
| Conversation turn | `ChatsCircle` |

### Progress (part of Stats)

- Title with run start, day and repo count.
- Four stat cards: open now (and at run start), done since start (share done by the pipeline), throughput per hour (24 h total), items waiting for an answer (answered today, links to Home).
- Funnel for open items: open → classified → reviewed as bars, then a stacked "routed" bar (taken, held, to close, in a batch, waiting for an answer) with a legend and counts.
- Done since run start: stacked bar (merged by pipeline, closed by pipeline, closed by others) and a small table with counts and shares.
- Throughput: 24 hourly columns in one hue with a dashed average line and a hover readout, drawn at the container's pixel width so labels stay at type size.
- By repo: table with sortable headers (repo, open, classified / reviewed, done, waiting) plus routed mix and a 7-day open-items sparkline. Repo names link to Items filtered to that repo. On phones, one compact row per repo.

Charts are hand-written SVG and HTML (no chart library): every bar has a 2 px surface gap, series are identified by legend and direct labels, never colour alone, and hover shows exact values.

## 7. Keyboard

| Key | Action |
|---|---|
| `/` or `Ctrl K` | Search (`repo#123`, `#123`, title or author; arrows and Enter) |
| `?` | Shortcut sheet for the current screen |
| `[` | Collapse or expand the sidebar |
| `g h`, `g i`, `g q`, `g s` | Go to Home, Items, Work queue, Stats |
| `j` / `k`, arrows, Home / End | Move through the queue, replacing the current selection history entry |
| Enter / Space | Activate the selected row, pushing a history entry |
| Escape | Close the preview, pushing a history entry |
| `p`, `o` | Open the preview, the item page |
| `Ctrl Enter` | Send the command box |

Keys are ignored while typing, except `Esc` and `Ctrl Enter`.

## 8. Accessibility

- Contrast: body text ≥ 4.5:1 on both themes; amber, red and green have separate light-theme steps for that reason. Chart marks ≥ 3:1 against the surface.
- Focus: a 2 px accent-ink outline on every focusable element; all actions reachable by keyboard; Radix handles focus in menus and dialogs.
- Semantics: the queue is a `listbox` with `aria-selected`; tabs, radio groups and toggles carry their ARIA roles and states; each chart has an `aria-label` and its numbers appear as text beside it.
- State is never colour alone: disagreeing verdicts have a marker and amber text, chart series have legends.
- Phones: targets ≥ 44 px (option buttons 52 px), no horizontal page scroll at 360–390 px.
- `prefers-reduced-motion` collapses all durations.

## 9. Open points

- Layout persistence is localStorage only; a `PUT /api/me/layout/:key` endpoint would make layouts follow the user.
