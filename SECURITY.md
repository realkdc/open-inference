# Security

Open Inference is an early beta. Do not use the community route for confidential prompts. The gateway and contributor app include basic security protections, but the full service has not had an independent security review.

## Trust boundaries

### Gateway

The gateway receives every request body sent to it. It authenticates scoped API keys, applies workspace usage limits and fair queues, strips caller session/workspace metadata, and does not log request bodies or store chat history. Its SQLite database stores workspace records, hashed credentials, and usage totals.

The private pool is a separate upstream URL operated by the service. Code never falls back from private to community inference. The private route is only as private as that configured upstream.

### Community workers

MeshLLM encrypts peer traffic while it travels. A worker still has to process its portion of a request. The first model stage receives the prompt; later stages receive intermediate model data. A worker owner may inspect live data in memory. This project does not use confidential-computing hardware or a cryptographic method that hides prompts from the machines doing inference.

The contributor app asks MeshLLM to use metadata-only local request logging and disables telemetry and anonymous analytics. This reduces routine persistence and export; it cannot stop a worker owner or modified host software from examining live data.

MeshLLM join tokens locate a mesh; they do not decide who may join. The contributor app creates a stable local owner keystore and starts MeshLLM with `--owner-required --trust-policy allowlist` plus the server's approved owner IDs. The operator approves contributor IDs in `/operator`; the gateway adds them to the list it returns to host apps. The gateway Owner ID is included automatically. Any separately operated bootstrap node must use the same list. When the list changes, restart every active node; community inference is paused until the operator confirms the updated list.

The gateway refuses community inference unless `MESHLLM_ADMISSION_POLICY_VERIFIED=true`, at least one serving owner is approved, and the current list generation has been confirmed in `/operator`. Approved hosts can join while inference is paused, which lets the operator set up and check the pool first. The confirmation remains manual because the gateway cannot inspect remote node trust policy. The operator must restart the bootstrap and each active host with the matching allowlist before confirming. The gateway serves approved public IDs to contributor apps; these IDs are not secrets. A modified host can bypass the app's startup checks, and MeshLLM does not remotely attest that a host is running unmodified code. This is an invite-only beta control, not a guarantee against a malicious contributor or compromised computer.

## Current controls

- API keys are random, stored as hashes, scoped to private or community routes, and revocable.
- Dashboard keys and invite codes are random and stored as hashes. Invite claims and admin invite creation are rate-limited.
- The browser keeps the workspace dashboard key in local storage so the dashboard survives a refresh. Use it only in a browser profile you control and sign out by clearing that profile's site data.
- Workspace data and usage are isolated by workspace ID. Active API keys are capped per workspace.
- Inference requests are bounded in size and completion length, queued fairly by workspace, and subject to model-weighted daily limits.
- The gateway disables request logging and returns no-store and browser security headers. Dashboard scripts use a per-response nonce and a restrictive content security policy.
- `/operator` requires the admin bearer token for status and management actions. It keeps that token in page memory, aggregates MeshLLM status, and does not expose raw peer identifiers or hostnames. The management endpoint must be loopback-only.
- The contributor app uses Electron context isolation, sandboxing, disabled Node integration in the renderer, strict content security policy, and no shell when starting MeshLLM.
- The contributor app keeps the join token out of process arguments, writes it to a private file for bootstrap, removes that file after the worker stops, and removes stale token files on next launch.
- The contributor app checks for MeshLLM 0.78.1 or later, creates a stable host owner keystore in its private app-data directory, and starts the worker with owner-required mode. The key is stored locally without a passphrase so unattended serving works; protect access to the OS user account and app data.
- Telemetry, anonymous analytics, and artifact-content logging are disabled or limited to metadata-only in the contributor runtime configuration.
- Optional map check-ins use a separate host token, broad region selected by the contributor, and online/offline state. No GPS or IP-based geolocation is collected. Live check-ins are held in memory for up to three minutes and are not persisted. The public map shows only region groups with at least three active host tokens and returns count ranges. The service can associate a host token with its workspace; the map hides that relationship from the public. A map dot reports app readiness, not independently verified compute or performance.

## Deployment requirements

- Put an internet-facing gateway behind HTTPS. Do not expose the SQLite data directory or admin token.
- Use long, unique admin and upstream API secrets. Store them in the deployment secret manager, not in source control.
- Check that every MeshLLM node uses owner-required mode. Do not set `MESHLLM_ADMISSION_POLICY_VERIFIED=true` just because the app enforces it on contributors or a join token is secret; the gateway cannot verify remote nodes.
- Treat any prompt sent to the community route as visible to the computers participating in that request.
- The gateway is a single-process beta. SQLite and in-memory queues are not a horizontally scaled production control plane.
- Contributor binaries are not yet signed or notarized. Verify release provenance before asking people to run packaged builds.
- The admin dashboard reveals the MeshLLM join code only to an authenticated admin and warns that it is not access control. Contributor bundles for Apple Silicon Mac, Windows x64, and Linux x64 are unsigned beta packages; use them only with people you trust.

## Reporting a vulnerability

Please do not post credentials, join tokens, private prompts, or an unpatched exploit in a public issue. Once this repository is hosted, use its private GitHub Security Advisory flow. Until then, contact the project maintainers privately and include the affected version, impact, and a safe reproduction. Allow time for a fix before public disclosure.
