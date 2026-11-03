# Contributing

Thanks for helping build an open, community-run inference service. Changes to authentication, request routing, logging, contributor software, and model sharing can affect user privacy, so please explain the threat or user problem a change addresses.

## Before opening an issue or pull request

- Never include API keys, admin tokens, MeshLLM join tokens, real prompts, or private user data.
- For security issues, follow [SECURITY.md](SECURITY.md) and report them privately.
- Keep community and private routes separate. A private request must never be sent to a community worker as fallback.
- Do not claim that transport encryption hides data from a computer processing that data.
- Keep prompt bodies and session identifiers out of logs and service storage.

## Local setup

Requirements: Node.js 24 or newer. To run the gateway and dashboard:

```sh
npm install
cp .env.example .env
npm run dev:gateway
```

To run the contributor app, install the official MeshLLM runtime and finish its setup first. Then run `npm run dev:contributor`.

## Project layout

- `apps/gateway`: OpenAI-compatible API, account dashboard, key management, limits, and queues.
- `apps/contributor`: Electron desktop app that starts and monitors the MeshLLM split-capable runtime.
- `apps/gateway/public`: dashboard UI served by the gateway.

## Pull requests

- Keep changes focused and describe the behavior they add or change.
- Document new configuration in `.env.example` and `README.md`.
- Include manual reproduction steps for user-facing or routing changes.
- Run `npm run build` before submitting when possible.
- Do not commit `.env`, `.data`, installer outputs, generated credentials, or downloaded model files.

Contributions are licensed under the project's MIT License.
