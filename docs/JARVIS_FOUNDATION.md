# Jarvis Foundation

SuperAgent remains a private, offline-first chat client. The Jarvis foundation is
implemented as bounded personalization rather than autonomous self-modifying code.

## Current capabilities

- Review-gated long-term memories with secret filtering.
- Graph nodes for facts, preferences, projects, styles, goals, tasks, habits,
  skills, tools, constraints, decisions, and events.
- Indexed graph edges and evidence tables for future relationship and provenance UI.
- Lexical relevance ranking that returns only approved, non-sensitive, non-expired
  nodes. Embeddings are intentionally deferred until full-text retrieval is proven
  insufficient.
- Daily, idempotent maintenance on app open: expire stale nodes and prune the graph
  to a maximum of 500 nodes.
- Existing prompt budget remains the hard limit; the graph is not copied into
  Zustand or serialized into every conversation.

## Safety and performance rules

Memory extraction remains asynchronous and review-gated. Credentials and secret-like
values are rejected. The app never uploads the complete graph, runs unrestricted
background agents, or changes its own code or model weights. Heavy retrieval and
maintenance work is bounded and runs outside the streaming hot path.

## Next milestones

1. Add graph evidence and relationship review screens.
2. Retrieve a relevant graph subgraph for each request while preserving the current
   memory character budget.
3. Promote tasks, goals, reminders, and decisions to first-class local workflows.
4. Add explicit user-approved automations after foreground tool flows are reliable.
