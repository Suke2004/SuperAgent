# AgentRouter Mobile

An offline-first Expo Android chat client for AgentRouter and other compatible gateways. Conversations, model flags, usage data, and diagnostics stay on the device; API keys are stored only in Android Keystore via `expo-secure-store`.

## Setup

```bash
npm install
npx expo start
```

Open Settings → Providers. AgentRouter is the default setup: choose Anthropic or OpenAI, paste the gateway token, and save. For another compatible gateway choose Custom URL and enter its origin and token. The selected transport normalises `/v1` automatically.

The two AgentRouter endpoints are intentionally different:

- Anthropic: `https://agentrouter.org` → `POST /v1/messages`
- OpenAI: `https://agentrouter.org/v1` → `POST /v1/chat/completions` and `GET /v1/models`

## Architecture

`app/` contains Expo Router screens. `src/stores/` owns persisted UI state, while `src/db/` owns SQLite conversation data. `src/transports/` adapts the Anthropic and OpenAI wire formats behind one streaming interface. The key never enters Zustand or AsyncStorage.

Build a preview APK with:

```bash
npm run build:apk
```

## Adding a provider

Use Settings → Providers → Custom URL. Pick the wire format, enter the provider origin, save the key, then run Test connection. Model discovery is runtime-driven; capability flags, context limits, and pricing can be corrected under Settings → Models.
