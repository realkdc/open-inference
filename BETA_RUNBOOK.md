# First Open Inference beta

This is a small, measured beta. Do not promise 50–100 tokens per second or unlimited usage before real computers are connected and benchmarked.

## First model

Use **Qwen3-8B Q4_K_M** as the first shared, split-model trial. MeshLLM's current catalog lists `unsloth/Qwen3-8B-GGUF:Q4_K_M` as a 36-layer multi-machine model; that is the exact reference the host app uses. Use the model ID returned by Open Inference `/v1/models` in Hermes after the mesh reports the model available. [MeshLLM model catalog](https://meshllm.cloud/), [MeshLLM split guide](https://github.com/Mesh-LLM/mesh-llm/blob/main/docs/SKIPPY_SPLITS.md)

The second option is **Qwen3-30B-A3B Thinking 2507 UD-Q4_K_XL**. The layer package `meshllm/Qwen3-30B-A3B-Thinking-2507-UD-Q4_K_XL-layers` is 48 layers and about 17.7 GB; its API model ID is `unsloth/Qwen3-30B-A3B-Thinking-2507-GGUF:UD-Q4_K_XL`. It is a different, published split package from the plain Qwen3-30B-A3B Q4_K_M model, which MeshLLM currently lists as single-machine only. This beta has not yet proved a full end-to-end 30B request. A larger package needs substantially more connected capacity and does not guarantee faster replies. [Qwen3-30B-A3B Thinking 2507 layer package](https://huggingface.co/meshllm/Qwen3-30B-A3B-Thinking-2507-UD-Q4_K_XL-layers)

MeshLLM also has a **GLM-5.3-Flash** layer package, but its Q4 weights total about 199.7 GB across 46 layers. The available **DeepSeek-V4-Flash** package is about 155.1 GB across 43 layers; this is not confirmed to be the newer V4.1 weights. These are future large-pool experiments, not current app options. At 1.5 GB per 8 GB Mac, the weights alone imply roughly 134 Macs for GLM or 104 for DeepSeek, before context memory, runtime overhead, and disconnected machines. [GLM-5.3-Flash layer package](https://huggingface.co/meshllm/GLM-5.3-Flash-UD-Q4_K_XL-layers), [DeepSeek-V4-Flash layer package](https://huggingface.co/meshllm/DeepSeek-V4-Flash-UD-Q4_K_XL-layers)

Use **Qwen3-4B Q4_K_M** for a quick one-computer smoke test: its listed package is about 2.5 GB, but the catalog does not list it as a split package. That checks install, serving, and API behavior; it does not prove distributed model splitting. [MeshLLM model catalog](https://meshllm.cloud/)

We verified that smoke path on the 8 GB Apple M1 used for this build. Qwen3-4B loaded with a 3.0 GB model-memory cap and a 2,048-token context; the private API and an unpublished one-node community mesh both listed the model and returned streamed replies, and the community route returned a tool call. One warm 64-token reply reported about 12 tokens/second. Treat that as a single-machine sanity check, not a network benchmark.

## What an 8 GB Mac can contribute

On Apple Silicon, the GPU uses the Mac's unified memory. An 8 GB Mac does **not** have 8 GB of GPU memory plus another 8 GB for the system. macOS and other apps use that same 8 GB.

The contributor app checks memory automatically. It offers no more than 20% of system RAM and keeps at least 6 GB for the operating system and other apps. On dedicated-GPU computers it also keeps half the GPU memory free. An 8 GB Mac gets a cap around **1.5 GB**. This is a cautious estimate, not a guarantee; contributors can pause sharing at any time.

The app fixes the first beta context at **2,048 tokens**. More context uses more memory, so keep the first test simple.

## Host scenarios

The Qwen3-8B file is about 5 GB, before context cache and runtime overhead. Splitting divides its layers across hosts; it does not add their memory into a literal shared RAM pool. MeshLLM assigns layer stages according to available capacity, and every stage must stay online. [MeshLLM architecture](https://meshllm.cloud/docs/pages/architecture/), [large-model guide](https://meshllm.cloud/docs/pages/running-large-models/)

| Starter pool | What it is good for | Initial beta setting |
| --- | --- | --- |
| One 8 GB Mac | Local Qwen3-4B smoke test; or a small slice of a split model | Keep the 8B trial at about 1.5 GB on this Mac |
| 4–6 nearby 8 GB laptops, each offering about 1.5–2 GB | A first 8B split experiment with some headroom for stage overhead | One generation at a time; low context; measure speed and memory |
| 2–4 nearby machines with 8–16 GB of usable GPU/unified memory each | A more comfortable 8B experiment; maybe multiple model placements later | Start with one generation; increase concurrency only after benchmarks |
| One fast GPU machine with roughly 8–12 GB or more available to the model | A useful speed baseline; serves the whole model on one host | Compare against the split pool so we can see the network penalty |
| At least 12 8 GB Macs for the 30B-A3B Thinking pool | 17.7 GB of model weights divided by the app's 1.5 GB cap is about 12 computers before context and runtime overhead | Treat 12 as a weight-only floor; expect to recruit more hosts and benchmark separately |
| About 104 8 GB Macs for DeepSeek-V4-Flash | 155.1 GB of Q4 weights divided by 1.5 GB per Mac, before context and runtime overhead | Future research pool; not offered in the host app |
| About 134 8 GB Macs for GLM-5.3-Flash | 199.7 GB of Q4 weights divided by 1.5 GB per Mac, before context and runtime overhead | Future research pool; not offered in the host app |

These are trial ranges, not hard minimums. RAM amount alone does not predict speed. GPU type, memory bandwidth, model quantization, context length, cooling, and network latency all matter. Mesh's model planner still has to confirm that each stage fits.

## Invite users and computer hosts

A website invite creates an API user's workspace; it does not make their computer join the pool. Users can create a community API key and prepare their Hermes setup before any model is online, but inference returns unavailable until the approved model is ready. Contributors do not need a website workspace invite to donate compute. They download the Open Inference Host app for Apple Silicon Mac, Windows x64, or Linux x64, send the public Owner ID shown in the app to the operator, then enter the beta server address and approved contributor join code. They choose a model, select **Coordinator** on the one chosen computer for that model or **Worker** on the others, confirm the disclosures, and click **Start sharing**. MeshLLM is included. The Mac app includes its Metal runtime; Windows/Linux start with a CPU fallback and automatically fetch a matching GPU runtime when MeshLLM detects one. Model pieces download automatically the first time. Memory is detected and capped automatically. They can pause or disconnect at any time.

The operator page separates three things: a computer can be connected to the mesh, assigned a model stage, and ready to serve the model. Only the final state means the shared model can answer requests. Community API access remains off until the operator verifies admission; a connected computer alone does not turn it on.

## How many testers and how fast

Start by inviting **5–10 people**, but configure the community pool for **one active generation at a time**. Other requests wait in the fair queue. That is an account count, not a promise that all 10 can generate at once. The gateway defaults to one community request at a time, a 2,048-token total context cap, about 1,536 estimated input tokens, and a 512-token reply. It trims a requested reply to fit the remaining context.

For the first 8B split test, recruit **4–6 computers near each other** if possible. Designate one as that model's coordinator and set the app to **Start this model pool** there. Everyone else selects **Join an existing model pool** and chooses the same model. The coordinator uses MeshLLM's split planner and auto-balancing; workers join without starting a second coordinator. The 30B option needs a separate group and end-to-end test before being advertised as ready. [MeshLLM split setup](https://github.com/Mesh-LLM/mesh-llm/blob/main/install.md)

Nearby hosts reduce the network delay between model stages. A split model sends intermediate data from one machine to the next for every generated token. More machines can make a model fit, but can also make each reply slower. More full-model hosts can improve how many separate chats run at once; splitting is not automatically a speed boost. 50–100 tokens/second for every user is not a realistic launch promise for a volunteer WAN pool; benchmark it before advertising a speed.

For each Mac contributor, allow incoming connections for `mesh-llm` in macOS Firewall settings and turn off stealth mode. Mesh docs warn that a worker may join and show healthy peer connectivity while still blocking the inbound stage-control traffic required for split execution. Require `mesh-llm doctor split --model-ref '<exact-layer-package-ref>' --port 19338 --json` on the coordinator, then make a real chat-completion request through the Open Inference gateway. A ready local model alone does not prove the full stage pipeline works. [MeshLLM split troubleshooting](https://github.com/Mesh-LLM/mesh-llm/blob/main/install.md)

Record only operational measurements during the test: model ID, time to first token, tokens per second, request duration, queue wait, and whether the model stage stayed available. Do not capture chat content to do the benchmark.

## Launch sequence

1. Run one local test on the 8 GB Mac with Qwen3-4B so the API and Hermes setup are known to work.
2. Open `/operator` on the gateway and sign in with the private admin token. The page reports connected contributor computers, model stages and memory, API model availability, invites, and workspaces. A mesh connection by itself does not mean a model is ready.
3. Create the MeshLLM bootstrap node on a trusted, always-on computer. The current beta keeps the private Qwen3-4B API on port 9337, so use separate MeshLLM ports. Create its identity first and add its Owner ID and the gateway Owner ID to the initial allowlist:

   ```sh
   mesh-llm auth init --owner-key "$HOME/.mesh-llm/open-inference-owner-key.json" --no-passphrase
   mesh-llm auth status --owner-key "$HOME/.mesh-llm/open-inference-owner-key.json"
   MESH_LLM_RUNTIME_ROOT="$HOME/.mesh-llm/open-inference-runtime" \
   mesh-llm serve --headless --port 10337 --console 10338 --bind-port 10339 \
     --owner-key "$HOME/.mesh-llm/open-inference-owner-key.json" \
     --owner-required --trust-policy allowlist \
     --trust-owner <gateway-owner-id> --trust-owner <bootstrap-owner-id>
   ```

   Set `MESHLLM_MANAGEMENT_URL=http://127.0.0.1:10338` and copy the mesh token into `.env` with file permissions `600`. Add any separate bootstrap node ID to `MESHLLM_TRUSTED_OWNER_IDS`; the gateway ID is included automatically and contributors are managed in `/operator`. Keep the join token and owner key private. The contributor app fetches approved host IDs from the gateway.
4. Invite one or two trusted testers. They open the host app, copy their public Owner ID, and send it to you. In `/operator`, approve the ID and reveal the join token. They enter the beta server address and join token, choose the same model option, and explicitly click **Start sharing**. Approved hosts may join while community API requests remain paused. One host is enough to test a model that fits; a split model may need multiple workers to fit or serve well.
5. Once all mesh computers are using the current approved-owner list, set `MESHLLM_ADMISSION_POLICY_VERIFIED=true` and restart the gateway. Then click **Confirm all computers use this list** in `/operator`. This is a manual operator acknowledgement, not remote verification. MeshLLM distinguishes owner allowlisting from `require-owned`, which only checks that peers have signed identities. Its [private mesh guide](https://meshllm.cloud/docs/pages/private-meshes/) documents the difference. Community inference stays paused until this confirmation and a model is serving.
6. When adding or removing a host, update the bootstrap's `--trust-owner` arguments to match the dashboard's full list and restart it. Ask every active contributor to pause and start sharing again so the app fetches the current list. Then repeat step 5.
8. Confirm stage readiness with MeshLLM's split doctor and complete a real gateway request. Then confirm it streams through Hermes. Repeat with a short tool call.
9. Keep concurrency at one and invite 5–10 API testers. Adjust the free daily plan from actual demand and measured pool capacity.
10. Only then increase concurrency, invite more people, or advertise speed.

Community prompts are visible to computers running model stages. The private route is separate and is not usable until service-controlled compute is configured.

## Public map and privacy

The map uses a broad region chosen by the contributor. It does not ask for GPS and does not infer location from IP. Public clusters appear only at three or more active host tokens and show a count band, not names or exact counts. The map is opt-in. The service can associate a host token with its workspace; the map hides that relationship from the public. A map dot means the app reported a model stage ready, not that the worker passed an independent speed or quality test.

## Deploying the gateway

For an internet-facing invite beta, use a small always-on Linux host with Docker, a DNS name, HTTPS, and a persistent volume. Copy `.env.example` to `.env`, set a long random admin token, set `DOMAIN`, and add any separate bootstrap Owner ID to `MESHLLM_TRUSTED_OWNER_IDS`. Approved contributor IDs are maintained in `/operator`, and the gateway Owner ID is included automatically. Keep `MESHLLM_ADMISSION_POLICY_VERIFIED=false` until the mesh is configured to enforce owner allowlisting. The gateway cannot remotely verify that the bootstrap and hosts were restarted with the displayed list. Then:

```sh
docker compose up -d --build
```

The gateway fails closed while community inference is disabled. A shared join token still lets anyone holding it try to connect unless the nodes enforce a stronger admission policy. Keep the beta to people you trust and rotate the token if it leaks. See [SECURITY.md](SECURITY.md).
