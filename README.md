# Open Inference

Open Inference is an invite-only, free beta for an OpenAI-compatible model API backed by shared community compute. Apps such as Hermes can use the community route, and people can contribute computer capacity when they choose. The gateway handles accounts, API keys, fair queues, and usage limits; [MeshLLM](https://github.com/Mesh-LLM/mesh-llm) handles peer discovery, encrypted transport, model routing, and supported split-model execution.

## How requests work

```text
Hermes → Open Inference API → MeshLLM pool → one model host or a split model pipeline
```

MeshLLM may route a request to one computer that can run the complete model. For a supported layer package, it can instead pass the request through computers running consecutive parts of the model. The pieces are not combined into one physical server. Each stage must be online, and network delays between stages affect response speed. A model needs a compatible layer package before it can be split.

The community route is the main shared route. The separate private route goes only to the service-controlled OpenAI-compatible endpoint configured by the operator. If that endpoint is down or does not offer the model, private requests fail; they never fall back to volunteers.

Beta users can create a community API key and prepare their Hermes configuration before a community model is online. Key creation does not enable inference: `/v1/models` and chat requests return an unavailable error until the operator-approved pool reports a ready model. Community requests never fall back to the private route.

## Privacy and security limits

- The gateway does not store prompt bodies or chat history. It stores workspace records, hashed credentials, and aggregate model-aware usage totals. Request logging is disabled in the gateway.
- Mesh peer traffic is encrypted in transit. The computer running the first model stage still receives the prompt, and later stages receive intermediate model data. A computer's owner may inspect what that computer is processing. Encryption does not hide live data from a worker.
- The contributor app configures MeshLLM's local request history for metadata only and disables its telemetry and anonymous analytics. Metadata can still include operational details such as model and request outcomes; prompt text is not part of the default local log record. This does not prevent live inspection by a computer owner.
- The contributor app creates a stable local MeshLLM identity and checks that its public Owner ID is approved before sharing. Operators approve host IDs in `/operator`; new approvals automatically pause community requests until every mesh node uses the new list and an operator confirms it. `MESHLLM_TRUSTED_OWNER_IDS` is for the gateway and bootstrap IDs needed for initial setup.
- Community inference is not private enough for passwords, private business data, or other sensitive prompts. Use the private route for those prompts only when the configured service-controlled provider is trusted.
- The contributor worker uses the host's normal internet connection for mesh traffic. It does not install a whole-device VPN or make the network link faster. This build does not include an exact bandwidth cap.

See [SECURITY.md](SECURITY.md) for the beta threat model and reporting guidance.

## Free plans and usage limits

This beta uses named plans with daily, token-like limits: **Free** (5,000 community units), **Contributor** (15,000), and **Sustainer** (50,000). These example limits can be tuned by the operator and are not dollar prices or performance guarantees. Everyone starts on Free. An admin can assign a higher plan to a verified contributor; automatic rewards are not ready because the service cannot yet measure useful work per computer. There are no credits, balances, coins, or paid plans. See [USAGE_PLANS.md](USAGE_PLANS.md).

## Beta model choices and hardware

The contributor app offers two curated split-model pools: **Qwen3-8B Q4_K_M** (about 5.0 GB across 36 layers) as the starter pool, and **Qwen3-30B-A3B Thinking 2507 UD-Q4_K_XL** (about 17.7 GB across 48 layers) as a larger reasoning option. The app lets each computer choose one model pool; contributors working on the same model must select the same option. These use MeshLLM's current multi-machine model reference and a published layer package, respectively; older Qwen3-30B-A3B Q4_K_M was single-machine only and is not offered. The gateway lists a model in `/v1/models` only after MeshLLM reports it available, and a real completion is still needed to prove the pool works end to end. The bigger model needs more connected capacity and may be slower. An 8 GB Apple Silicon Mac can offer a small slice; its GPU shares the same 8 GB as macOS. The packaged host app automatically caps that Mac at about 1.5 GB. See [BETA_RUNBOOK.md](BETA_RUNBOOK.md) before choosing which pool to bring online first.

Larger MeshLLM layer packages also exist for models such as [GLM-5.3-Flash](https://huggingface.co/meshllm/GLM-5.3-Flash-UD-Q4_K_XL-layers) and [DeepSeek-V4-Flash](https://huggingface.co/meshllm/DeepSeek-V4-Flash-UD-Q4_K_XL-layers), but their Q4 weights are about 199.7 GB and 155.1 GB. They are research candidates, not beta host-app options; they need a much larger nearby pool and speed testing first. The Mesh package is V4-Flash, and we have not verified it is the same weights as DeepSeek-V4.1-Flash.

## Requirements

- Node.js 24 or newer (`.nvmrc` is set to 24)
- A service-controlled OpenAI-compatible endpoint for the private pool (optional until private inference is offered)
- A MeshLLM mesh configured by the beta operator for community compute

## Run the gateway

```sh
nvm use
npm install
cp .env.example .env
```

Set a random `OPENINFERENCE_ADMIN_TOKEN` with at least 32 characters. Set `PRIVATE_UPSTREAM_URL` to the private provider's OpenAI-compatible base URL, including `/v1`; remote private providers must use HTTPS. Set `MESHLLM_INVITE_TOKEN` for the community mesh and `MESHLLM_MANAGEMENT_URL` to its loopback-only management endpoint. Optional service-node Owner IDs, such as a dedicated bootstrap host, go in `MESHLLM_TRUSTED_OWNER_IDS`; contributor IDs are managed in `/operator`, and the gateway ID is included automatically. Keep `MESHLLM_ADMISSION_POLICY_VERIFIED=false` until every mesh host enforces owner allowlisting. The join token alone is not admission control.

Run locally:

```sh
npm run dev:gateway
```

By default, it listens at `http://127.0.0.1:8787`. The beta workspace page is at `/`, the admin-only operator dashboard is at `/operator`, and `/healthz` reports pool and queue status. The operator page reads aggregated MeshLLM status from the loopback-only management API configured by `MESHLLM_MANAGEMENT_URL`; it never returns raw peer IDs or hostnames.

Create a beta invite with the admin token:

```sh
export OPENINFERENCE_ADMIN_TOKEN='the-value-from-your-.env-file'
curl -X POST http://127.0.0.1:8787/admin/invites \
  -H "Authorization: Bearer $OPENINFERENCE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expiresInHours":72}'
```

Give the one-use invite code to an API beta user. They claim it in the dashboard to create an isolated workspace and a dashboard key. The dashboard key is shown once. It can create and revoke that workspace's API keys; a community key can be prepared before the community model is online, but inference remains unavailable until it is ready.

Workspace invites (`oi_inv_…`) and MeshLLM join tokens are different credentials. A website invite creates an API workspace; it is not needed to donate compute and does not install software or start sharing a computer. A contributor separately installs the host app, sends their public Owner ID to the operator for approval, receives the mesh join token, chooses a model, and presses **Start sharing**. Never treat a MeshLLM join token as proof that a peer is trusted. Keep the admin token, join tokens, and private provider key out of source control.

## OpenAI-compatible API

Each API key is scoped to one pool:

| Base path | Pool |
| --- | --- |
| `/v1` | Shared community pool (default) |
| `/community/v1` | Shared community alias |
| `/private/v1` | Service-controlled private pool |

Use the matching base URL, API key, and model ID in Hermes or another OpenAI-compatible client. The gateway supports streaming and passes through tool-call payloads. It removes caller session and workspace metadata before forwarding. Community keys cannot call private routes, and private keys cannot call community routes.

The gateway caps completion length, queues requests fairly across workspaces, limits concurrent work, applies each workspace's daily plan limits, and weights usage by model. Usage units are token-like fairness limits, not billing or precise GPU accounting. A workspace can keep up to 20 active API keys; keys can be revoked from the dashboard. Admins can review workspaces and assign plans in the dashboard.

## Run the contributor app

For development, install MeshLLM using its [official instructions](https://meshllm.cloud/docs/pages/installing-mesh/) and run:

```sh
npm run dev:contributor
```

The host app bundles the pinned MeshLLM 0.78.1 executable and a platform runtime. Mac Apple Silicon includes Metal; Windows and Linux include a CPU fallback and MeshLLM automatically downloads a matching GPU runtime when one is available. Contributors do not install a separate CLI. The app offers the two reviewed model packages above, checks system and GPU memory, applies a conservative automatic model-memory cap, and keeps a 2,048-token context. Runtime and model pieces are prepared automatically after the contributor clicks Start sharing. It still requires the operator's mesh join token and explicit sharing consent.

The app creates a stable private owner identity. Before starting, contributors copy their public Owner ID to the operator, enter the beta server address, and wait for approval. The app fetches the current list and launches MeshLLM with `--owner-required --trust-policy allowlist` and every approved owner ID. An approved host may join while the community API is paused; unapproved hosts cannot join. When the owner list changes, the operator restarts the bootstrap and asks every active contributor to pause and start sharing again; the API remains paused until the operator enables admission and confirms the whole mesh uses the updated list. Each model needs one coordinator; the other contributors for that model select worker mode and the same model option. The coordinator starts with `--split`; workers do not force another coordinator. Disconnect clears the join token from app memory. A real request through each model pool is still required to confirm end-to-end split health.

Split execution needs reachable stage connections, in addition to normal mesh connectivity. A host may appear connected while its firewall blocks stage traffic. On macOS, allow incoming connections for MeshLLM and turn off firewall stealth mode. Read the [MeshLLM split troubleshooting guide](https://github.com/Mesh-LLM/mesh-llm/blob/main/install.md) before diagnosing a worker that never receives an assignment.

Build one beta package (these targets must be built one at a time because the verified MeshLLM bundle is staged in `.data`):

```sh
npm run package:contributor:mac
npm run package:contributor:windows
npm run package:contributor:linux
```

Packaging downloads the official platform archive and verifies its pinned SHA-256 before bundling it. Current targets are Apple Silicon Mac, Windows x64, and Linux x64. These beta packages are unsigned; macOS may require a right-click/Open confirmation, and Windows may show a SmartScreen warning. The community API remains disabled until owner allowlisting is verified.

## Configuration

See [.env.example](.env.example) for gateway settings. Important controls include:

- `PRIVATE_DAILY_LIMIT_UNITS`, `COMMUNITY_DAILY_LIMIT_UNITS`, `CONTRIBUTOR_COMMUNITY_DAILY_LIMIT_UNITS`, and `SUSTAINER_COMMUNITY_DAILY_LIMIT_UNITS`
- `PRIVATE_MAX_CONCURRENT`, `COMMUNITY_MAX_CONCURRENT`, queue depth, queue timeout, `MAX_CONTEXT_TOKENS`, and `MAX_INPUT_TOKENS`
- `MODEL_COMPUTE_WEIGHTS` for higher or lower usage weight by model
- `DASHBOARD_ORIGIN` for an explicitly allowed dashboard origin
- `PUBLIC_BASE_URL` when a trusted TLS reverse proxy provides the public API address
- `MESHLLM_MANAGEMENT_URL` for the local MeshLLM operator status API; it accepts loopback HTTP only and must never be exposed publicly

For an internet-facing deployment, run behind a trusted TLS reverse proxy, set `HOST=0.0.0.0`, restrict dashboard access, use strong secrets, and keep the SQLite data directory private. The current gateway is a single-process beta service; it is not a production multi-region or horizontally scaled control plane.

The repository includes a Docker/Caddy deployment for an always-on Linux host with a DNS name. Set `DOMAIN` and secrets in `.env`, then run `docker compose up -d --build`. Keep community inference disabled until MeshLLM admission controls are actually configured and checked. Read [BETA_RUNBOOK.md](BETA_RUNBOOK.md) before inviting external contributors. Download the current unsigned Mac, Windows, and Linux contributor apps from the [beta releases page](https://github.com/realkdc/open-inference/releases).

## Build

```sh
npm run build
```

## Open source

Open Inference is licensed under the MIT License. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
