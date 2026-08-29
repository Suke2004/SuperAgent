# Agent 3 — JORDAN, The Researcher

**Persona.** Runs many parallel threads and treats the app as a knowledge base, not a chat window. Judges it on retrieval: can I find the thing I asked three weeks ago, and can I keep the list from becoming unusable at fifty conversations?

**Session.** Five conversations created and populated with real replies from `claude-opus-5` — *Machine Learning Basics*, *Python Tips*, *AI Ethics*, *Database Design*, *DevOps Guide* — then tagged, filtered, searched and, where the app allowed it, archived. Seven conversations total by the end of the session.

**Scenarios run.** 3.1 Conversation Creation · 3.2 Tagging & Filtering · 3.3 Search · 3.4 Archive & Delete (blocked — see JORDAN-01).

---

## 3.1 Conversation Creation

*New conversation* is a one-tap button on Home. Each of the five conversations was created, given a substantive question, and answered. Auto-titling meant I never had to name one: the title derives from the first message, so *"give me one short tip about list comprehensions"* became **Python Tips** on its own. Home groups by recency with a `TODAY · 7` header and shows, per row, a two-line initials avatar, the title, a timestamp, a preview of the last message, the model id, the message count and the tag chips. That is a dense, genuinely scannable row.

Pinning is available from the row's long-press menu (*Pin to the top*), which is the right primitive for a researcher with three live threads among fifty dormant ones.

One defect, which shows up here and gets worse as failures accumulate.

### JORDAN-01 · A row can report "No messages yet" and "6 messages" simultaneously

- **Severity:** Medium
- **Frequency:** Often — whenever the most recent message in a conversation is an empty failed turn
- **Impact:** Home is the researcher's index, and the preview line is how they identify a conversation without opening it. The preview is taken from the *last* message's text, and a failed turn stores an assistant message with no content, so the preview falls back to "No messages yet" while the count on the same row says "6 messages". The row is self-contradictory, and the conversation Jordan is looking for becomes indistinguishable from an empty one at exactly the moment it is most likely to be the one he wants — the one that just failed.
- **Reproduction:**
  1. Open a conversation with several real turns.
  2. Make the gateway unreachable and send a message; let it fail.
  3. Return to Home and read that conversation's row.
  4. **Expected:** the preview shows the last message that has text.
  5. **Actual:** the preview reads *"No messages yet"* while the same row reads *"6 messages"*.
- **% of users affected:** ~70% — anyone who experiences a failed turn, which on mobile is nearly everyone.
- **Suggested fix:** derive the preview from the most recent message with non-empty text rather than the most recent message, and never render the "No messages yet" string for a conversation whose count is greater than zero. Fixing [Maya's MAYA-06](01-maya-new-user.md) — not persisting contentless failed turns at all — removes the cause; this is the defence in depth.
- **Related section:** 3.1 Conversation Creation

---

## 3.2 Tagging & Filtering

All five conversations were tagged as specified — `#learning #ai`, `#coding`, `#philosophy #ethics`, `#coding #database`, `#operations #coding`. Tagging is `⋯` → *Tags* → a single comma-separated field, hinted "Comma separated." with a `work, drafts` placeholder. Three taps and one text entry per conversation, and the field pre-fills with the current tags so adding a second tag does not mean retyping the first.

Filtering works from a horizontal chip row at the top of Home, and the chips carry live counts derived from the actual data: `All`, `coding · 3`, `ai · 1`, `database · 1`, `ethics · 1`, `learning · 1`, `operations · 1`, `philosophy · 1`. Tapping `coding · 3` narrowed the list to exactly the three coding conversations. The counts are the detail that makes this better than a plain filter — Jordan can see the shape of his own corpus without applying a filter at all.

The chips are too small to hit reliably (19dp — see [Casey 4.1](04-casey-mobile-first.md)), and one of them has an accessibility defect ([Morgan 5.2](05-morgan-accessibility.md)). The functional bug appears when a filter and a search are combined.

---

## 3.3 Search

Search is a permanently visible field on Home — no tap needed to find it — and it runs in two passes: an immediate pass over conversation titles, then a debounced pass over message bodies. Results are grouped under an `IN MESSAGES · N` header with an ellipsis-trimmed context snippet around the match, and each hit carries a provenance badge reading either `index` (FTS) or `scan` (LIKE fallback).

Every query was comfortably inside the 1s target:

| Query | Title pass | Message hits |
|---|---|---|
| `database` | 109 ms | — |
| `python` | 94 ms | 278 ms |
| `ai ethics` | 96 ms | 349 ms |
| `Berkeley` (offline, cold) | 77 ms | 324 ms |

Relevance was correct in each case. `database` matched *Database Design* by title. `ai ethics` matched *AI Ethics* by title and returned message hits from the body. `Berkeley` — a word appearing once, deep inside a long generated essay — returned the right conversation with the snippet `…n, durability. Meanwhile at Berkeley, Michael Stonebraker and Eugene W`, which is enough context to recognise the passage.

Search also works with **no network at all**, over the local SQLite copy, at the same speed. That is the payoff of the local-first architecture and it is worth stating explicitly.

### JORDAN-02 · The active tag filter is ignored by the message-search pass

- **Severity:** High
- **Frequency:** Always, when a tag filter and a search term are combined
- **Impact:** The two organisational tools in the app contradict each other. With the `ethics` chip visibly selected, searching `python` returned `IN MESSAGES · 2` hits from *Python Tips* — a conversation that is not tagged `ethics` and that the filter had just removed from the list above. The filter chip stays highlighted throughout, so the screen simultaneously asserts "showing only ethics" and shows non-ethics results. For a researcher this is the worst class of search bug: it does not fail loudly, it quietly returns the wrong set, and the natural interpretation is that the tag was applied to the wrong conversation.
- **Reproduction:**
  1. On Home, tap the `ethics · 1` chip. The list narrows to *AI Ethics*.
  2. Type `python` into the search field.
  3. **Expected:** no results, or results restricted to conversations tagged `ethics`.
  4. **Actual:** `IN MESSAGES · 2` hits from *Python Tips*, while the `ethics` chip remains selected.
- **Root cause:** the title/preview pass at [index.tsx:230](app/index.tsx:230) correctly passes the tag — `filterConversations(conversations, { query, ...(tag ? { tag } : {}) })` — but the message pass at [index.tsx:237](app/index.tsx:237) calls `searchMessages(trimmed)` with no `tag` argument at all, so it queries the whole database.
- **% of users affected:** ~40% — everyone who uses both features, which is the population tagging exists for.
- **Suggested fix:** thread `tag` into `searchMessages` and filter the message hits by the tagged conversation-id set (the store already has it, since the title pass computed it). One argument. Until then, clearing the tag when a search begins would at least stop the screen from lying.
- **Related section:** 3.3 Search

### JORDAN-03 · "Nothing matched" appears for ~250ms before results arrive

- **Severity:** Medium
- **Frequency:** Always, for any query whose only matches are in message bodies
- **Impact:** Because the title pass finishes in ~80ms and the message pass in ~330ms, there is a measured **247ms window** in which the screen renders the empty state *"Nothing matched"* and then replaces it with hits. A qualifier — *"Still searching the messages…"* — is shown alongside, which is honest, but it is below a heading that has already said no. On a phone, a quarter-second of "nothing matched" is enough to make a user stop typing or start rephrasing a query that was about to work.
- **Reproduction:**
  1. On Home, type a word that appears only inside a message body (e.g. `Berkeley`).
  2. Watch the results area from the first keystroke.
  3. **Expected:** a loading state until both passes have reported, then either results or an empty state.
  4. **Actual:** at 77ms, *"Nothing matched"* plus *"Still searching the messages…"*. At 324ms, `IN MESSAGES · 1` with the correct hit. Measured false-negative window: 247ms.
- **% of users affected:** ~60% — most searches for content rather than titles.
- **Suggested fix:** suppress the empty state until the message pass has resolved. Show the title results (if any) plus a slim "Searching messages…" row, and render *"Nothing matched"* only when both passes are complete and both are empty. The state to gate on already exists — it is what produces the "Still searching" line.
- **Related section:** 3.3 Search

---

## 3.4 Archive & Delete

**This scenario could not be completed.** Steps 1–3 (archive conversations 2 and 4, view the archive, restore 4) have no user interface to exercise.

### JORDAN-04 · Archive and restore are fully implemented in the database and entirely absent from the app

- **Severity:** High
- **Frequency:** Always
- **Impact:** The database has an `archived INTEGER NOT NULL DEFAULT 0` column at [schema.ts:154](src/db/schema.ts:154); `listConversations` in [conversations.ts](src/db/conversations.ts) builds `where = ['c.archived = ?']` and takes an `archived` option; and the update path accepts `patch.archived`. Nothing ever calls any of it. `useChat` exposes no archive or restore action, no screen offers one, and the long-press menu on a Home row lists only *Open*, *Rename*, *Tags*, *Pin to the top* and *Delete conversation*. So the only way to get a finished conversation out of the list is to delete it — permanently, with a confirmation but no undo and no intermediate state. For a researcher accumulating dozens of threads, "keep everything, hide what's done" is the core organisational move, and the app's only answer is destruction. The half-built state is also a maintenance hazard: every list query already pays for a filter on a column that can never be anything but 0.
- **Reproduction:**
  1. On Home, long-press any conversation row.
  2. **Expected:** *Archive* among the options.
  3. **Actual:** *Open*, *Rename*, *Tags*, *Pin to the top*, *Delete conversation* — no archive.
  4. Search Settings and Home for an archive view.
  5. **Expected:** an "Archived" filter or section.
  6. **Actual:** none. The `archived` column is unreachable from the UI.
  7. Delete a conversation and look for an undo.
  8. **Expected:** a snackbar with *Undo*, or a recoverable state.
  9. **Actual:** a confirmation dialog, then permanent removal with no undo.
- **% of users affected:** ~50% — every user who accumulates more conversations than fit on one screen.
- **Suggested fix:** wire up what exists. Add `archive(id)` / `unarchive(id)` to `useChat` calling the update path that already supports `patch.archived`, add *Archive* to the row menu, and add an `Archived` chip to the existing tag-chip row so the archive view reuses the filter UI rather than needing a new screen. Then make *Delete* archive-first: a snackbar with *Undo* after deletion, and *Delete* in the archive view for the permanent case. This is the highest ratio of user-visible value to remaining work anywhere in the app — the schema, the query and the mutation are all done.
- **Related section:** 3.4 Archive & Delete

Step 4 of the scenario — permanent deletion — was reviewed in source but not exercised: the confirmation runs through `Alert.alert`, which is a no-op on the web build used as this test harness. It is reported as unverified rather than working or broken.

---

## What works well

**1. Search is fast, and it tells you how it found each result.** Every query landed between 77ms and 349ms against a 1s target, including over a long generated essay and including with no network at all. Each hit carries an `index` or `scan` badge saying whether it came from the full-text index or a linear scan. That badge is unusual and genuinely useful: when FTS5 turned out to be unavailable in this build, the app degraded to `LIKE`, logged the reason, kept working, and *said so on every result row* rather than pretending nothing changed. Silent degradation is the norm in search implementations; labelled degradation is much better.

**2. Two-pass search with real context snippets.** Titles resolve instantly so the list never freezes while typing, and message hits arrive under their own `IN MESSAGES · N` header with an ellipsis-trimmed window around the match. Seeing `…n, durability. Meanwhile at Berkeley, Michael Stonebraker and Eugene W` is enough to decide whether to open a result — which is the entire job of a search result, and something most mobile chat clients do not attempt.

**3. Tag chips carry live counts, and organisation costs almost nothing.** `coding · 3`, `ai · 1`, `philosophy · 1` — the counts come from the data, so the chip row doubles as a map of the corpus. Combined with auto-titling (no conversation ever needs naming) and *Pin to the top*, a researcher gets a usable index for the price of one comma-separated field per conversation. Tags are also per conversation rather than a global taxonomy that must be declared up front, which is the right call for a corpus that grows by accident.

---

## Summary

| ID | Severity | Issue |
|---|---|---|
| JORDAN-04 | High | Archive/restore built in the DB, absent from the UI; delete has no undo |
| JORDAN-02 | High | Tag filter ignored by the message-search pass |
| JORDAN-01 | Medium | Row shows "No messages yet" alongside "6 messages" |
| JORDAN-03 | Medium | "Nothing matched" flashes for ~250ms before hits arrive |

Retrieval is the strongest thing this app does — it is fast, honest about its own methods, and works offline. Organisation is where it stops: the two features that are supposed to compose (tags and search) contradict each other, and the one feature that would make a large corpus manageable is finished everywhere except the screen.

