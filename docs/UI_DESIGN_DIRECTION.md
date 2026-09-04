# SuperAgent UI Design Direction

This is a focused Jarvis foundation design, not a visual rebrand. It extends the
existing warm paper / warm charcoal theme, dense settings rows, and bottom-sheet
actions already used throughout the app.

## Design principles

- The chat transcript remains the primary screen and primary action.
- Jarvis surfaces expose useful state, not product explanation.
- One active heavyweight preview or graph surface at a time.
- Every async surface has loading, empty, error, and retry states.
- Use existing `Screen`, `Section`, `Row`, `Badge`, `Button`, `Sheet`, and `Note`
  primitives before adding new components.
- Keep touch targets at least 48dp, even when the visual control is compact.

## 1. Jarvis command center

Entry point: a small `Jarvis` icon button in the conversation list header. It opens
an operational dashboard, not a landing page.

```text
┌──────────────────────────────────────┐
│ Jarvis                         ⋯      │
│ Ready · memory updated today          │
├──────────────────────────────────────┤
│ Ask Jarvis                            │
│ What should I focus on today?     →   │
├──────────────────────────────────────┤
│ TODAY                                 │
│ 3 open tasks                 See all  │
│ ┌──────────────────────────────────┐ │
│ │ Review SuperAgent PR       10:00 │ │
│ │ Prepare Android test build       │ │
│ └──────────────────────────────────┘ │
├──────────────────────────────────────┤
│ CONTEXT                               │
│ 24 approved memories    1,240 chars  │
│ 4 active projects        Manage      │
├──────────────────────────────────────┤
│ RECENT DECISIONS                      │
│ Keep Android as primary platform  ›  │
│ Avoid cloud conversation sync     ›  │
└──────────────────────────────────────┘
```

Behavior:

- The prompt field opens the normal chat composer with a `jarvis` launch context;
  it does not create a second chat engine.
- “Today” is a bounded query of open tasks due today or overdue, limited to five.
- Context shows counts from SQLite and never mounts the full graph.
- Recent decisions are compact rows; tapping one opens evidence and edit actions.
- If the database is still loading, show skeleton rows. If maintenance failed, show
  a single warning row with retry rather than a blank dashboard.

## 2. Memory graph review

Entry point: Settings → Memory → `Graph` tab.

```text
┌──────────────────────────────────────┐
│ Memory                    + Add      │
│ [Notes] [Graph] [Activity]           │
├──────────────────────────────────────┤
│ 24 approved · 3 awaiting review      │
│ Search memory                         │
├──────────────────────────────────────┤
│ USER                                 │
│   ├─ prefers → concise answers       │
│   ├─ works_on → SuperAgent           │
│   │              └─ depends_on → ... │
│   └─ avoids → cloud sync              │
├──────────────────────────────────────┤
│ Selected: SuperAgent                 │
│ project · confidence 0.86            │
│ 2 connected notes                    │
│ [View evidence] [Edit] [Forget]      │
└──────────────────────────────────────┘
```

Behavior:

- `Graph` is a lazy native/Web canvas only while visible; the default tab remains
  the existing virtualized memory list.
- On web or low-memory devices, use a relationship list fallback instead of a graph
  canvas.
- Nodes are rendered as accessible rows with relation labels; the visual graph is
  supplementary and never the only way to understand a relationship.
- Sensitive, expired, and unapproved nodes are excluded from the visible graph by
  default, with a filter to inspect pending items.
- Selecting a node opens a sheet containing confidence, expiry, source conversation,
  evidence excerpt, and delete controls.

## 3. Tasks and reminders

Entry point: Jarvis command center → `See all`, plus a `Tasks` row in Settings.

```text
┌──────────────────────────────────────┐
│ Tasks                         + Add   │
│ [Open 3] [Done 12]                    │
├──────────────────────────────────────┤
│ OVERDUE                              │
│ ○ Send provider allowlist request    │
│   Yesterday                    ⋯     │
├──────────────────────────────────────┤
│ TODAY                                │
│ ○ Review PDF viewer build       09:30│
│ ○ Test long-context continuation     │
├──────────────────────────────────────┤
│ UPCOMING                             │
│ ○ Add memory evidence UI       Sep 08│
└──────────────────────────────────────┘
```

Behavior:

- Completing a task is a single row action with undo in a transient `Note`.
- Long-press or overflow opens edit, move due date, duplicate, and delete actions.
- Empty state offers “Ask Jarvis to create one” and a direct add action.
- Invalid or missing dates render as “No due date”, never a broken timestamp.
- Notifications are a later opt-in layer; the task list remains useful with no
  background service.

## Shared states

| State | Treatment |
|---|---|
| Loading | Two to five skeleton rows with stable heights |
| Empty | One concise `Empty` component plus one primary action |
| Saving | Disable only the affected action; show `Spinner` inline |
| Error | Preserve the last known data and show a retry `Note` |
| Offline | Keep local actions available; defer provider actions |
| Stale | Show “Updated earlier” metadata, never silently overwrite |

## Tokens and component mapping

- Page background: `colors.bg`
- Row surfaces: `colors.surface`
- Secondary panels and search fields: `colors.surfaceAlt`
- Primary action: `colors.accentFill` with `colors.accentText`
- Pending review: `colors.warningSoft` / `colors.warning`
- Destructive memory actions: `colors.dangerSoft` / `colors.danger`
- Success and undo feedback: `colors.successSoft` / `colors.success`
- Spacing: `spacing.sm`, `spacing.md`, `spacing.lg`, `spacing.xl`
- Radius: `radius.lg` for existing grouped sections; no new decorative cards

## Performance budget

- Do not mount the graph renderer until the Graph tab is active.
- Render at most 40 graph nodes in one viewport; retrieve more through search.
- Keep dashboard queries to indexed counts and `LIMIT 5` lists.
- Never put evidence excerpts or task history into the chat Zustand store.
- Use the existing FlashList for long memory and task lists.
