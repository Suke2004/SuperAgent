# Mobile Feature Gap Report

This is a product-level comparison for SuperAgent, based on the common capabilities exposed by the ChatGPT, Claude, and Gemini mobile apps. It is intentionally scoped to features that fit SuperAgent's local-first Android purpose.

## Current parity

SuperAgent already has streaming chat, model/provider switching, reasoning controls, conversation history, search, attachments, image input, PDF/document input, generated files, HTML/SVG artifacts, tools, MCP, projects, memory, voice input/output, offline queueing, export, app lock, and accessibility foundations.

## Feasible without meaningful performance impact

| Feature | Status | Implementation shape |
| --- | --- | --- |
| Edit and resend a message | Missing | Reuse existing message insert/regenerate path |
| Continue a stopped response | Partial | Add a continuation action keyed by turn and stop reason |
| Compare regenerated answers | Partial | Extend existing variants UI |
| Archive, restore, undo delete | Partial | Existing schema/store support; finish UI wiring |
| Search by project/tag/model/date | Partial | Extend existing SQLite filters |
| Copy/share one message | Partial | Reuse export/share helpers |
| Export selected messages | Missing | Reuse Markdown/JSON export with a selection projection |
| Pin/bookmark messages | Missing | Local metadata only; no request impact |
| Response style presets | Partial | Reuse prompts/system prompt model |
| Inline artifact cards | Partial | Lazy card plus existing sandbox preview |
| Better attachment thumbnails | Partial | Existing attachment blocks and cache files |
| Tool timeline and retry | Partial | Existing tool blocks and turn metadata |
| Per-conversation model/reasoning presets | Present/partial | Extend existing conversation config |
| Offline draft persistence | Partial | Persist only drafts, never secrets |
| Accessibility labels, focus, keyboard actions | Partial | Shared primitive changes |

## Feasible with bounded native/background work

- Native in-app PDF viewing with paging and zoom.
- OCR for photographed documents.
- PDF thumbnails and local text search.
- Local semantic search over SQLite content.
- Foreground-service continuation while Android backgrounds the app.
- Image crop, rotation, and annotation before sending.
- Optional provider-side research mode.

These should be lazy, opt-in, and isolated from the chat hot path.

## Defer or avoid

- Always-on assistant behavior.
- Mandatory cloud sync or hosted file storage.
- Full Office round-trip editing.
- Realtime collaboration.
- Multiple simultaneously mounted WebViews.
- Autonomous background agents.
- Video generation/editing.
- Cloud TTS/STT that uploads private conversation text by default.
- A broad connector marketplace.

## Performance rules

New features must keep heavy engines lazy-mounted, keep large files on disk, avoid base64 copies where a URI works, preserve FlashList virtualization, and keep all request/context calculations in pure modules. Any feature that adds a native dependency requires a physical-device memory and frame-rate check before release.
