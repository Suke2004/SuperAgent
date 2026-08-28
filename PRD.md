# AgentRouter Mobile Product Requirements Document

## 1. Product Summary

AgentRouter Mobile is a personal Android chat client for an AgentRouter gateway that exposes Anthropic-compatible and OpenAI-compatible APIs. It provides a fast, local-first conversation experience while exposing model and reasoning controls that are often hidden by hosted clients.

The product is for one technically capable owner. It is not intended for Play Store distribution, multi-user accounts, or a hosted backend.

## 2. Goals

- Make streaming conversations reliable and responsive on Android.
- Support both gateway wire formats without leaking transport differences into the UI.
- Keep API keys and user data on-device.
- Provide explicit control over model, reasoning, sampling, context, and message history.
- Make gateway failures diagnosable by preserving the gateway's own error text.
- Remain usable on mobile networks with retry, failover, and efficient rendering.

## 3. Non-Goals

- Play Store publication or account-based synchronization.
- Server-side storage, telemetry, analytics, or third-party crash reporting.
- Local stdio MCP servers. Android cannot spawn those processes; MCP is network-only.
- Spoofing an approved client to bypass gateway allowlists.

## 4. Target User and Primary Flows

The target user owns an AgentRouter token and wants a controllable personal client.

1. Configure AgentRouter by selecting Anthropic or OpenAI and pasting a token.
2. Optionally add a custom compatible provider with a base URL and token.
3. Test the connection and discover models.
4. Start a conversation, choose a model, adjust generation controls, and stream a reply.
5. Search, organize, edit, regenerate, fork, export, and inspect conversations.
6. Add multimodal input, skills, MCP servers, and power features as later phases mature.

## 5. Functional Requirements

### Provider and model management

- Ship AgentRouter as the default setup option.
- Use `https://agentrouter.org` for Anthropic and `https://agentrouter.org/v1` for OpenAI.
- Permit custom named provider profiles with transport, base URL, fallback origin, headers, default model, and connection test.
- Store only key presence and a safe fingerprint in application state.
- Discover models at runtime; allow manual capability and pricing corrections.

### Chat

- Create, open, rename, tag, pin, archive/delete, and fork conversations.
- Stream replies incrementally with an actual abort action.
- Support edit-in-place, edit-and-resend, regenerate, delete, copy, and context exclusion.
- Persist system prompts, model selection, sampling parameters, reasoning configuration, and context strategy per conversation.
- Render Markdown, code highlighting, LaTeX, tables, thinking blocks, usage, cost, errors, and stop reasons.

### Reliability and diagnostics

- Retry 429 and 5xx responses with capped exponential backoff and jitter.
- Fail over only on a network failure before the first stream event.
- Never retry ordinary 4xx responses.
- Surface gateway error messages verbatim and distinguish authentication from client rejection.
- Redact secrets at the log boundary.

### Planned capabilities

- Phase 3: images, documents, speech, text-to-speech, sharing, and image-generation detection.
- Phase 4: reusable `SKILL.md` instruction bundles with progressive disclosure.
- Phase 5: network MCP with OAuth/PKCE, discovery, approvals, and agentic tool loops.
- Phase 6: prompt library, exports, backup/restore, usage dashboard, failover indicator, and offline queue.

## 6. UX Requirements

- Android-first, portrait-oriented, light/dark/system themes.
- Dense but readable settings and conversation screens.
- Every unavailable control explains why it is disabled.
- Streaming must not jump the transcript or re-render once per token.
- Search clearly distinguishes local filtering from message-content search.
- Destructive operations require confirmation.
- The app must remain useful when a model registry is stale or a gateway is unreachable.

## 7. Security and Privacy Requirements

- Android API keys live only in `expo-secure-store`/Android Keystore and an in-memory cache.
- Keys must not enter Zustand persistence, AsyncStorage, logs, exports, or source control.
- No telemetry or external crash reporting.
- Network requests use the honest static user agent `AgentRouterMobile/1.0 (Android)`.

## 8. Success Criteria

- TypeScript, ESLint, and the complete Jest suite remain green after every phase.
- Streaming, abort, search, context handling, and transport adapters pass automated tests.
- The app builds as a preview APK through EAS.
- A physical Android verification pass confirms keyboard insets, stream anchoring, Markdown geometry, and incremental rendering.
