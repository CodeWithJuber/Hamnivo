# ADR 0006 — Jev (TypeSafe) as an advisory DecisionProvider

- Status: accepted (2026-09-26)
- Blueprint: §12 "Jev TypeSafe integration design", J01–J08

## Decision

- Use the official `@typesafe-ai/sdk` behind a provider-neutral `DecisionProvider` port returning
  `decided | abstained | unavailable | invalid`. Jev never generates reply text.
- Pin the model version (never `jev-latest`). Enforce a total deadline (1.5 s default) with
  `AbortSignal` because the SDK timeout is per attempt; no synchronous retries; circuit breaker.
- Never synthesize a confidence for `noul` answers. Do not treat `unavailable` as false, safe or approved.
- Deterministic rules run first; explicit human requests bypass Jev entirely.
- Start in shadow mode per task and language; activation requires passing the evaluation gate.
- SDK logging is off; request bodies are never logged.
