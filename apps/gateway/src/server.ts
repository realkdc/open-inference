import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { config, type AccessMode } from './config.js';
import { PresenceRegistry, PRESENCE_REGIONS } from './presence.js';
import { communityProvider, privateProvider, ProviderUnavailableError, providerFor, UpstreamError } from './providers.js';
import { FairQueue, QueueFullError, QueueWaitTimeoutError } from './queue.js';
import { Store, type Workspace } from './store.js';

const dashboardHtml = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const operatorHtml = readFileSync(fileURLToPath(new URL('../public/operator.html', import.meta.url)), 'utf8');
const contributorDownloads = {
  'macos-arm64': 'https://github.com/realkdc/open-inference/releases/download/v0.1.6-beta.1/Open-Inference-Host-0.1.6-arm64-mac.zip',
  'windows-x64': 'https://github.com/realkdc/open-inference/releases/download/v0.1.6-beta.1/Open-Inference-Host-0.1.6-x64-win.zip',
  'linux-x64': 'https://github.com/realkdc/open-inference/releases/download/v0.1.6-beta.1/Open-Inference-Host-0.1.6-x64-linux.tar.gz'
} as const;
const store = new Store(config.DATABASE_PATH);
const privateQueue = new FairQueue(config.PRIVATE_MAX_CONCURRENT, config.MAX_QUEUED_REQUESTS, config.QUEUE_TIMEOUT_MS);
const communityQueue = new FairQueue(config.COMMUNITY_MAX_CONCURRENT, config.MAX_QUEUED_REQUESTS, config.QUEUE_TIMEOUT_MS);
const modelCache = new Map<AccessMode, { expiresAt: number; models: Awaited<ReturnType<typeof privateProvider.listModels>> }>();
const MODEL_CACHE_MS = 10_000;
type CommunityAvailability = {
  ready: boolean;
  connected: boolean;
  modelCount: number;
  reason: 'join_code_missing' | 'admission_unverified' | 'owner_allowlist_missing' | 'gateway_identity_unavailable' | 'mesh_disconnected' | 'no_serving_model' | null;
  blockers: Array<'join_code_missing' | 'admission_unverified' | 'owner_allowlist_missing' | 'gateway_identity_unavailable' | 'mesh_disconnected' | 'no_serving_model'>;
};
let cachedCommunityAvailability: { expiresAt: number; result: CommunityAvailability } | undefined;
const COMMUNITY_AVAILABILITY_CACHE_MS = 5_000;
const ipRateLimits = new Map<string, { resetAt: number; count: number }>();
const presence = new PresenceRegistry();

const claimSchema = z.object({
  inviteToken: z.string().min(12).max(256),
  workspaceName: z.string().trim().min(2).max(64)
});
const inviteSchema = z.object({ expiresInHours: z.number().int().min(1).max(24 * 30).default(72) });
const workspacePlanSchema = z.object({ planId: z.enum(['free', 'contributor', 'sustainer']) });
const keySchema = z.object({
  mode: z.enum(['private', 'community']),
  label: z.string().trim().min(1).max(48)
});
const hostTokenSchema = z.object({ label: z.string().trim().min(1).max(48) });
const meshOwnerSchema = z.object({
  ownerId: z.string().trim().regex(/^[a-fA-F0-9]{64}$/),
  label: z.string().trim().min(1).max(48)
});
const meshAdmissionVerifySchema = z.object({ confirmAllNodesUpdated: z.literal(true) });
const presenceSchema = z.object({
  region: z.enum(PRESENCE_REGIONS),
  state: z.enum(['online', 'offline'])
});

function jsonError(reply: FastifyReply, statusCode: number, message: string, code: string) {
  return reply.code(statusCode).send({
    error: {
      message,
      type: statusCode >= 500 ? 'server_error' : 'invalid_request_error',
      code
    }
  });
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function isRateLimited(request: FastifyRequest, bucket: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const ipDigest = createHash('sha256').update(request.ip).digest('hex').slice(0, 24);
  const key = `${bucket}:${ipDigest}`;
  let entry = ipRateLimits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { resetAt: now + windowMs, count: 0 };
    ipRateLimits.set(key, entry);
  }
  if (ipRateLimits.size > 10_000) {
    for (const [candidate, value] of ipRateLimits) {
      if (value.resetAt <= now) ipRateLimits.delete(candidate);
      if (ipRateLimits.size <= 8_000) break;
    }
  }
  if (entry.count >= limit) return true;
  entry.count += 1;
  return false;
}

function dashboardWorkspace(request: FastifyRequest): Workspace | null {
  const token = bearerToken(request);
  return token ? store.authenticateDashboard(token) : null;
}

function isAdmin(request: FastifyRequest): boolean {
  const token = bearerToken(request);
  return Boolean(token && config.OPENINFERENCE_ADMIN_TOKEN && safeEqual(token, config.OPENINFERENCE_ADMIN_TOKEN));
}

async function modelsFor(mode: AccessMode) {
  if (mode === 'community') {
    const availability = await communityAvailability();
    if (!availability.ready) {
      throw new ProviderUnavailableError(communityAvailabilityMessage(availability));
    }
  }
  const cached = modelCache.get(mode);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  const models = await providerFor(mode).listModels();
  modelCache.set(mode, { models, expiresAt: Date.now() + MODEL_CACHE_MS });
  return models;
}

function modeFromPath(value: string): AccessMode | null {
  return value === 'private' || value === 'community' ? value : null;
}

function trustedMeshOwnerIds(): string[] {
  const gatewayOwnerId = communityProvider.gatewayOwnerId();
  return [...new Set([
    ...config.meshllmTrustedOwnerIds,
    ...store.listTrustedMeshOwnerIds(),
    ...(gatewayOwnerId ? [gatewayOwnerId] : [])
  ])].sort();
}

async function communityAvailability(): Promise<CommunityAvailability> {
  if (cachedCommunityAvailability && cachedCommunityAvailability.expiresAt > Date.now()) {
    return cachedCommunityAvailability.result;
  }
  let result: CommunityAvailability;
  if (!config.MESHLLM_INVITE_TOKEN) {
    result = { ready: false, connected: false, modelCount: 0, reason: 'join_code_missing', blockers: ['join_code_missing'] };
  } else {
    const gatewayOwnerId = communityProvider.gatewayOwnerId();
    const status = await communityProvider.operatorStatus();
    const ownerIds = trustedMeshOwnerIds();
    const admission = store.meshAdmissionSnapshot(ownerIds);
    const blockers: CommunityAvailability['blockers'] = [];
    if (!config.meshllmAdmissionPolicyVerified || !admission.verified) blockers.push('admission_unverified');
    if (ownerIds.length === 0 || (gatewayOwnerId && !ownerIds.some(id => id !== gatewayOwnerId))) {
      blockers.push('owner_allowlist_missing');
    }
    if (!gatewayOwnerId) blockers.push('gateway_identity_unavailable');
    if (!status.connected) blockers.push('mesh_disconnected');
    else if (status.models.length === 0) blockers.push('no_serving_model');
    result = {
      ready: blockers.length === 0,
      connected: status.connected,
      modelCount: status.models.length,
      reason: blockers[0] ?? null,
      blockers
    };
  }
  cachedCommunityAvailability = { expiresAt: Date.now() + COMMUNITY_AVAILABILITY_CACHE_MS, result };
  return result;
}

function communityAvailabilityMessage(status: CommunityAvailability): string {
  if (status.ready) return 'The community API is ready.';
  if (status.blockers.includes('join_code_missing')) return 'The shared pool is not configured yet.';
  const reasons = status.blockers.flatMap(blocker => {
    switch (blocker) {
      case 'admission_unverified': return ['membership controls have not been verified'];
      case 'owner_allowlist_missing': return ['the approved MeshLLM owner allowlist has not been configured'];
      case 'gateway_identity_unavailable': return ['the gateway MeshLLM identity is unavailable'];
      case 'mesh_disconnected': return ['the MeshLLM network is disconnected'];
      case 'no_serving_model': return ['no contributor computer is serving a ready model'];
      default: return [];
    }
  });
  return reasons.length
    ? `The community API is not ready because ${reasons.join(' and ')}.`
    : 'The community API is not ready.';
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

async function operatorMeshStatus() {
  const gateway = await communityProvider.operatorStatus();
  if (!config.meshllmManagementUrl) {
    return {
      managementConfigured: false,
      managementReachable: false,
      gateway,
      remoteComputers: 0,
      servingComputers: 0,
      reportedUsableMemoryGb: 0,
      models: [],
      status: 'management_not_configured'
    };
  }

  try {
    const response = await fetch(`${config.meshllmManagementUrl}/api/status`, {
      signal: AbortSignal.timeout(2_000),
      redirect: 'error',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Mesh management endpoint unavailable.');
    const root = asRecord(await response.json());
    if (!root) throw new Error('Mesh status payload unavailable.');
    const peers = Array.isArray(root.peers) ? root.peers.map(asRecord).filter((peer): peer is JsonRecord => Boolean(peer)) : [];
    const hosts = peers.filter(peer => peer.role !== 'client');
    const models = new Map<string, { availableComputers: number; assignedComputers: number; servingComputers: number }>();
    let reportedUsableBytes = 0;
    if (root.is_host === true) {
      const ownMemory = asRecord(root.my_memory);
      reportedUsableBytes += nonNegativeNumber(ownMemory?.usable_bytes);
    }
    let servingComputers = root.is_host === true && root.node_state === 'serving' ? 1 : 0;

    for (const peer of hosts) {
      const state = typeof peer.state === 'string' ? peer.state.toLowerCase() : '';
      const available = stringList(peer.available_models);
      const assigned = stringList(peer.hosted_models);
      const serving = stringList(peer.serving_models);
      const memory = asRecord(peer.memory);
      reportedUsableBytes += nonNegativeNumber(memory?.usable_bytes);
      if (state === 'serving') servingComputers += 1;
      for (const model of new Set([...available, ...assigned, ...serving])) {
        const counts = models.get(model) ?? { availableComputers: 0, assignedComputers: 0, servingComputers: 0 };
        if (available.includes(model)) counts.availableComputers += 1;
        if (assigned.includes(model)) counts.assignedComputers += 1;
        if (serving.includes(model)) counts.servingComputers += 1;
        models.set(model, counts);
      }
    }

    return {
      managementConfigured: true,
      managementReachable: true,
      gateway,
      remoteComputers: hosts.length,
      servingComputers,
      reportedUsableMemoryGb: Number((reportedUsableBytes / 1_000_000_000).toFixed(2)),
      localNodeState: typeof root.node_state === 'string' ? root.node_state : 'unknown',
      models: [...models].map(([id, counts]) => ({ id, ...counts })).sort((a, b) => a.id.localeCompare(b.id)),
      apiModels: gateway.models,
      status: 'online'
    };
  } catch {
    return {
      managementConfigured: true,
      managementReachable: false,
      gateway,
      remoteComputers: 0,
      servingComputers: 0,
      reportedUsableMemoryGb: 0,
      models: [],
      apiModels: gateway.models,
      status: 'management_unreachable'
    };
  }
}

function estimateTokens(value: unknown): number {
  const serialized = JSON.stringify(value ?? '');
  return Math.max(1, Math.ceil(serialized.length / 4));
}

function estimateInputTokens(body: Record<string, unknown>): number {
  const promptFields = ['messages', 'tools', 'functions', 'tool_choice', 'function_call', 'response_format'];
  const prompt = Object.fromEntries(promptFields
    .filter(field => body[field] !== undefined)
    .map(field => [field, body[field]]));
  return estimateTokens(prompt);
}

function estimateOutputTokens(textCharacters: number): number {
  return Math.max(0, Math.ceil(textCharacters / 4));
}

function completionLimit(body: Record<string, unknown>): number {
  const requested = body.max_completion_tokens ?? body.max_tokens;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return config.DEFAULT_MAX_COMPLETION_TOKENS;
  return Math.min(Math.max(1, Math.ceil(requested)), config.HARD_MAX_COMPLETION_TOKENS);
}

function cleanRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...body };
  // These values belong to the caller's workspace and are not needed to generate a response.
  for (const key of ['user', 'metadata', 'session_id', 'conversation_id', 'workspace_id', 'request_id']) {
    delete clean[key];
  }
  return clean;
}

function readUsage(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null || !('usage' in response)) return undefined;
  const usage = response.usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  if ('total_tokens' in usage && typeof usage.total_tokens === 'number') return usage.total_tokens;
  if (
    'prompt_tokens' in usage && typeof usage.prompt_tokens === 'number' &&
    'completion_tokens' in usage && typeof usage.completion_tokens === 'number'
  ) return usage.prompt_tokens + usage.completion_tokens;
  return undefined;
}

class StreamMeter {
  private pending = '';
  private completionCharacters = 0;
  private tokenTotal?: number;

  push(chunk: string): void {
    this.pending += chunk;
    const lines = this.pending.split(/\r?\n/);
    this.pending = lines.pop() ?? '';
    for (const line of lines) this.readLine(line);
  }

  finish(inputTokens: number): number {
    if (this.pending) this.readLine(this.pending);
    return this.tokenTotal ?? inputTokens + estimateOutputTokens(this.completionCharacters);
  }

  private readLine(line: string): void {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const value: unknown = JSON.parse(payload);
      if (typeof value !== 'object' || value === null) return;
      if ('usage' in value) {
        const total = readUsage(value);
        if (total !== undefined) this.tokenTotal = total;
      }
      if (!('choices' in value) || !Array.isArray(value.choices)) return;
      for (const choice of value.choices) {
        if (typeof choice !== 'object' || choice === null || !('delta' in choice)) continue;
        const delta = choice.delta;
        if (typeof delta !== 'object' || delta === null) continue;
        if ('content' in delta && typeof delta.content === 'string') this.completionCharacters += delta.content.length;
        if ('tool_calls' in delta && Array.isArray(delta.tool_calls)) {
          this.completionCharacters += JSON.stringify(delta.tool_calls).length;
        }
      }
    } catch {
      // Chunk boundaries and non-JSON SSE metadata are expected; metering falls back to a size estimate.
    }
  }
}

function createAbortController(request: FastifyRequest, reply: FastifyReply): AbortController {
  const controller = new AbortController();
  request.raw.once('aborted', () => controller.abort());
  reply.raw.once('close', () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  return controller;
}

function authenticateKey(request: FastifyRequest, mode: AccessMode) {
  const token = bearerToken(request);
  if (!token) return { ok: false as const, error: 'An API key is required.', status: 401, code: 'missing_api_key' };
  const credential = store.authenticateApiKey(token);
  if (!credential) return { ok: false as const, error: 'The API key is invalid or has been revoked.', status: 401, code: 'invalid_api_key' };
  if (credential.mode !== mode) {
    return { ok: false as const, error: `This API key can only be used with the ${credential.mode} endpoint.`, status: 403, code: 'key_scope_mismatch' };
  }
  return { ok: true as const, credential };
}

function queueFor(mode: AccessMode): FairQueue {
  return mode === 'private' ? privateQueue : communityQueue;
}

function dailyLimitFor(mode: AccessMode, planId: keyof typeof config.usagePlans): number {
  const plan = config.usagePlans[planId] ?? config.usagePlans.free;
  return mode === 'private' ? plan.privateDailyUnits : plan.communityDailyUnits;
}

function modelWeight(model: string): number {
  return config.modelComputeWeights[model] ?? 1;
}

async function sendChatCompletion(
  request: FastifyRequest,
  reply: FastifyReply,
  mode: AccessMode,
  model: string,
  body: Record<string, unknown>,
  inputTokens: number,
  reservedUnits: number,
  workspaceId: string,
  usageDay: string
): Promise<unknown> {
  const provider = providerFor(mode);
  const queue = queueFor(mode);
  const controller = createAbortController(request, reply);
  let actualTokens = 0;
  let providerStarted = false;
  let reservationSettled = false;
  const settle = (tokenCount: number) => {
    if (reservationSettled) return;
    reservationSettled = true;
    store.settleUsage({
      workspaceId,
      mode,
      model,
      day: usageDay,
      reservedUnits,
      actualUnits: providerStarted
        ? Math.ceil(Math.max(inputTokens, tokenCount) * modelWeight(model))
        : 0
    });
  };

  try {
    if (body.stream === true) {
      await queue.run(workspaceId, controller.signal, async () => {
        reply.hijack();
        reply.raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          ...(config.dashboardOrigin && request.headers.origin === config.dashboardOrigin
            ? { 'access-control-allow-origin': config.dashboardOrigin, vary: 'Origin' }
            : {})
        });
        const meter = new StreamMeter();
        let receivedOutput = false;
        try {
          providerStarted = true;
          for await (const chunk of provider.stream(body, controller.signal)) {
            if (controller.signal.aborted) break;
            receivedOutput = receivedOutput || chunk.length > 0;
            meter.push(chunk);
            reply.raw.write(chunk);
          }
          actualTokens = meter.finish(inputTokens);
          reply.raw.end();
        } catch {
          actualTokens = receivedOutput ? meter.finish(inputTokens) : 0;
          reply.raw.write('event: error\ndata: {"error":{"message":"The inference host interrupted the response.","type":"server_error"}}\n\n');
          reply.raw.end();
          throw new Error('Inference stream failed.');
        }
      });
      return undefined;
    }

    const response = await queue.run(workspaceId, controller.signal, () => {
      providerStarted = true;
      return provider.complete(body, controller.signal);
    });
    const reportedTokens = readUsage(response);
    let textSize = 0;
    if (typeof response === 'object' && response !== null && 'choices' in response && Array.isArray(response.choices)) {
      textSize = response.choices.reduce((sum: number, choice: unknown) => {
        if (typeof choice !== 'object' || choice === null || !('message' in choice)) return sum;
        const message = choice.message;
        if (typeof message !== 'object' || message === null) return sum;
        const contentSize = 'content' in message && typeof message.content === 'string' ? message.content.length : 0;
        const toolSize = 'tool_calls' in message && Array.isArray(message.tool_calls) ? JSON.stringify(message.tool_calls).length : 0;
        return sum + contentSize + toolSize;
      }, 0);
    }
    actualTokens = reportedTokens ?? inputTokens + estimateOutputTokens(textSize);
    return reply.send(response);
  } finally {
    settle(actualTokens);
  }
}

function registerModelRoute(app: FastifyInstance, mode: AccessMode, path: string): void {
  app.get(path, async (request, reply) => {
    const auth = authenticateKey(request, mode);
    if (!auth.ok) return jsonError(reply, auth.status, auth.error, auth.code);
    try {
      return { object: 'list', data: await modelsFor(mode) };
    } catch (error) {
      if (error instanceof ProviderUnavailableError) return jsonError(reply, 503, error.message, 'pool_unavailable');
      return jsonError(reply, 502, 'The model catalog is temporarily unavailable.', 'upstream_unavailable');
    }
  });
}

function registerChatRoute(app: FastifyInstance, mode: AccessMode, path: string): void {
  app.post(path, async (request, reply) => {
    const auth = authenticateKey(request, mode);
    if (!auth.ok) return jsonError(reply, auth.status, auth.error, auth.code);
    if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
      return jsonError(reply, 400, 'The request body must be a JSON object.', 'invalid_request');
    }
    const input = request.body as Record<string, unknown>;
    if (typeof input.model !== 'string' || !input.model.trim()) {
      return jsonError(reply, 400, 'A model name is required.', 'model_required');
    }
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      return jsonError(reply, 400, 'At least one chat message is required.', 'messages_required');
    }
    if (input.stream !== undefined && typeof input.stream !== 'boolean') {
      return jsonError(reply, 400, 'The stream field must be a boolean.', 'invalid_stream_option');
    }
    const tokenLimit = input.max_completion_tokens ?? input.max_tokens;
    if (tokenLimit !== undefined && (typeof tokenLimit !== 'number' || tokenLimit < 1)) {
      return jsonError(reply, 400, 'The completion token limit must be a positive number.', 'invalid_token_limit');
    }
    if (typeof tokenLimit === 'number' && tokenLimit > config.HARD_MAX_COMPLETION_TOKENS) {
      return jsonError(reply, 400, `The maximum completion size is ${config.HARD_MAX_COMPLETION_TOKENS} tokens.`, 'completion_limit_too_high');
    }

    const model = input.model;
    let models;
    try {
      models = await modelsFor(mode);
    } catch (error) {
      const message = error instanceof ProviderUnavailableError ? error.message : 'The model catalog is temporarily unavailable.';
      return jsonError(reply, 503, message, 'pool_unavailable');
    }
    if (!models.some(candidate => candidate.id === model)) {
      return jsonError(reply, 404, `Model '${model}' is not currently available in the ${mode} pool.`, 'model_unavailable');
    }

    const cleanBody = cleanRequestBody(input);
    if (cleanBody.max_tokens === undefined && cleanBody.max_completion_tokens === undefined) {
      cleanBody.max_completion_tokens = config.DEFAULT_MAX_COMPLETION_TOKENS;
    }
    const inputTokens = estimateInputTokens(cleanBody);
    if (inputTokens > config.MAX_INPUT_TOKENS) {
      return jsonError(reply, 400, `This beta currently accepts about ${config.MAX_INPUT_TOKENS} input tokens per request.`, 'input_limit_exceeded');
    }
    const remainingContext = config.MAX_CONTEXT_TOKENS - inputTokens;
    if (remainingContext < 1) {
      return jsonError(reply, 400, 'This request leaves no room for a response within the beta context limit.', 'context_window_exceeded');
    }
    const outputReserve = Math.min(completionLimit(cleanBody), remainingContext);
    if (cleanBody.max_completion_tokens !== undefined) {
      cleanBody.max_completion_tokens = outputReserve;
      delete cleanBody.max_tokens;
    } else if (cleanBody.max_tokens !== undefined) {
      cleanBody.max_tokens = outputReserve;
    } else {
      cleanBody.max_completion_tokens = outputReserve;
    }
    const reservedUnits = Math.ceil((inputTokens + outputReserve) * modelWeight(model));
    const usageDay = new Date().toISOString().slice(0, 10);
    const dailyLimit = dailyLimitFor(mode, auth.credential.planId);
    if (!store.reserveUsage({
      workspaceId: auth.credential.workspaceId,
      mode,
      model,
      day: usageDay,
      units: reservedUnits,
      dailyLimit
    })) {
      return jsonError(reply, 429, 'This workspace reached its daily compute limit for this pool.', 'compute_limit_reached');
    }

    try {
      return await sendChatCompletion(
        request,
        reply,
        mode,
        model,
        cleanBody,
        inputTokens,
        reservedUnits,
        auth.credential.workspaceId,
        usageDay
      );
    } catch (error) {
      if (reply.sent || reply.raw.headersSent) return undefined;
      if (error instanceof QueueFullError) return jsonError(reply, 429, error.message, 'queue_full');
      if (error instanceof QueueWaitTimeoutError) return jsonError(reply, 503, error.message, 'queue_timeout');
      if (error instanceof ProviderUnavailableError) return jsonError(reply, 503, error.message, 'pool_unavailable');
      if (error instanceof UpstreamError) return jsonError(reply, 502, error.message, 'upstream_error');
      if (request.raw.aborted) return undefined;
      return jsonError(reply, 502, 'The inference request failed. Try again shortly.', 'inference_failed');
    }
  });
}

export async function createServer() {
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    logger: { level: 'warn' }
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('cache-control', 'no-store');
    return payload;
  });
  await app.register(cors, {
    // The dashboard is same-origin. Cross-origin access is opt-in and exact-origin only.
    origin: config.dashboardOrigin ? [config.dashboardOrigin] : false,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type']
  });

  app.get('/', async (_request, reply) => {
    const nonce = randomBytes(18).toString('base64');
    const html = dashboardHtml.replace('<script>', `<script nonce="${nonce}">`);
    reply.header(
      'content-security-policy',
      `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
    );
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/operator', async (_request, reply) => {
    const nonce = randomBytes(18).toString('base64');
    const html = operatorHtml.replace('<script>', `<script nonce="${nonce}">`);
    reply.header(
      'content-security-policy',
      `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
    );
    return reply.type('text/html; charset=utf-8').send(html);
  });
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
  for (const [platform, assetUrl] of Object.entries(contributorDownloads)) {
    app.get(`/download/contributor/${platform}`, async (_request, reply) => {
      return reply.redirect(assetUrl, 302);
    });
  }
  app.get('/healthz', async () => ({
    status: 'ok',
    pools: {
      private: { configured: Boolean(config.privateBaseUrl), queue: privateQueue.stats },
      community: { connected: communityProvider.connected, queue: communityQueue.stats }
    }
  }));

  app.get('/api/community/status', async (request, reply) => {
    if (isRateLimited(request, 'community-status', 120, 60 * 1000)) {
      reply.header('retry-after', '60');
      return jsonError(reply, 429, 'Status refresh limit reached. Try again shortly.', 'rate_limit_exceeded');
    }
    const availability = await communityAvailability();
    return {
      available: availability.ready,
      connected: availability.connected,
      reason: availability.reason,
      blockers: availability.blockers,
      message: communityAvailabilityMessage(availability)
    };
  });

  app.get('/api/community/admission', async (request, reply) => {
    if (isRateLimited(request, 'community-admission', 60, 60 * 1000)) {
      reply.header('retry-after', '60');
      return jsonError(reply, 429, 'Admission information refresh limit reached. Try again shortly.', 'rate_limit_exceeded');
    }
    const gatewayOwnerId = communityProvider.gatewayOwnerId();
    const trustedOwnerIds = trustedMeshOwnerIds();
    return {
      admissionPolicyEnabled: config.meshllmAdmissionPolicyVerified,
      admissionVerified: config.meshllmAdmissionPolicyVerified && store.meshAdmissionSnapshot(trustedOwnerIds).verified,
      trustedOwnerIds,
      gatewayOwnerId: gatewayOwnerId ?? null,
      message: 'Send this computer’s Owner ID to the beta operator. Approved computers may join with the current owner list while community inference remains disabled until the operator confirms the mesh.'
    };
  });

  app.get('/api/network/map', async (request, reply) => {
    if (isRateLimited(request, 'network-map', 120, 60 * 1000)) {
      reply.header('retry-after', '60');
      return jsonError(reply, 429, 'Map refresh limit reached. Try again shortly.', 'rate_limit_exceeded');
    }
    return {
      clusters: presence.publicClusters(),
      minimumClusterSize: 3,
      refreshedEverySeconds: 45
    };
  });

  app.post('/api/community/presence', async (request, reply) => {
    if (isRateLimited(request, 'community-presence', 120, 60 * 1000)) {
      reply.header('retry-after', '60');
      return jsonError(reply, 429, 'Presence update limit reached. Try again shortly.', 'rate_limit_exceeded');
    }
    const token = bearerToken(request);
    const credential = token ? store.authenticateHostToken(token) : null;
    if (!credential) return jsonError(reply, 401, 'A valid host presence token is required.', 'invalid_host_token');
    const parsed = presenceSchema.safeParse(request.body);
    if (!parsed.success) return jsonError(reply, 400, 'Choose a broad region and online or offline state.', 'invalid_presence');
    if (parsed.data.state === 'online') presence.heartbeat(credential.id, parsed.data.region);
    else presence.disconnect(credential.id);
    return { ok: true };
  });

  app.post('/admin/invites', async (request, reply) => {
    if (isRateLimited(request, 'admin-invites', 10, 60 * 60 * 1000)) {
      reply.header('retry-after', '3600');
      return jsonError(reply, 429, 'Too many invite requests. Try again later.', 'rate_limit_exceeded');
    }
    if (!config.OPENINFERENCE_ADMIN_TOKEN) return jsonError(reply, 503, 'Invite creation is disabled until an admin token is configured.', 'admin_not_configured');
    if (!isAdmin(request)) return jsonError(reply, 401, 'A valid admin token is required.', 'invalid_admin_token');
    const parsed = inviteSchema.safeParse(request.body ?? {});
    if (!parsed.success) return jsonError(reply, 400, 'The invite expiry must be between 1 and 720 hours.', 'invalid_invite_options');
    return reply.code(201).send(store.createInvite(parsed.data.expiresInHours));
  });

  app.get('/admin/mesh/status', async (request, reply) => {
    if (isRateLimited(request, 'admin-mesh-status', 120, 60 * 1000)) {
      reply.header('retry-after', '60');
      return jsonError(reply, 429, 'Too many status refreshes. Try again shortly.', 'rate_limit_exceeded');
    }
    if (!config.OPENINFERENCE_ADMIN_TOKEN) return jsonError(reply, 503, 'Operator access is disabled until an admin token is configured.', 'admin_not_configured');
    if (!isAdmin(request)) return jsonError(reply, 401, 'A valid admin token is required.', 'invalid_admin_token');
    const [management, availability] = await Promise.all([operatorMeshStatus(), communityAvailability()]);
    const ownerIds = trustedMeshOwnerIds();
    const admission = store.meshAdmissionSnapshot(ownerIds);
    return {
      admissionPolicyEnabled: config.meshllmAdmissionPolicyVerified,
      admissionVerified: config.meshllmAdmissionPolicyVerified && admission.verified,
      admissionGeneration: admission.generation,
      verifiedAdmissionGeneration: admission.verifiedGeneration,
      trustedOwnerIds: ownerIds,
      meshOwners: store.listTrustedMeshOwners(),
      gatewayOwnerId: communityProvider.gatewayOwnerId() ?? null,
      communityRoutingEnabled: availability.ready,
      availabilityReason: availability.reason,
      availabilityReasons: availability.blockers,
      availabilityMessage: communityAvailabilityMessage(availability),
      joinTokenConfigured: Boolean(config.MESHLLM_INVITE_TOKEN),
      management
    };
  });

  app.post('/admin/mesh/owners', async (request, reply) => {
    if (isRateLimited(request, 'admin-mesh-owner-add', 30, 60 * 60 * 1000)) {
      reply.header('retry-after', '3600');
      return jsonError(reply, 429, 'Too many owner changes. Try again later.', 'rate_limit_exceeded');
    }
    if (!config.OPENINFERENCE_ADMIN_TOKEN) return jsonError(reply, 503, 'Operator access is disabled until an admin token is configured.', 'admin_not_configured');
    if (!isAdmin(request)) return jsonError(reply, 401, 'A valid admin token is required.', 'invalid_admin_token');
    const parsed = meshOwnerSchema.safeParse(request.body);
    if (!parsed.success) return jsonError(reply, 400, 'Enter a valid 64-character MeshLLM Owner ID and a short label.', 'invalid_mesh_owner');
    const owner = store.addTrustedMeshOwner(parsed.data.ownerId, parsed.data.label);
    if (!owner) return jsonError(reply, 409, 'This Owner ID is already approved.', 'mesh_owner_already_approved');
    cachedCommunityAvailability = undefined;
    return reply.code(201).send({ owner, admissionVerified: false, message: 'Owner approved. Restart mesh nodes with the updated owner list, then confirm below before community inference resumes.' });
  });

  app.delete('/admin/mesh/owners/:ownerId', async (request, reply) => {
    if (isRateLimited(request, 'admin-mesh-owner-remove', 30, 60 * 60 * 1000)) {
      reply.header('retry-after', '3600');
      return jsonError(reply, 429, 'Too many owner changes. Try again later.', 'rate_limit_exceeded');
    }
    if (!config.OPENINFERENCE_ADMIN_TOKEN) return jsonError(reply, 503, 'Operator access is disabled until an admin token is configured.', 'admin_not_configured');
    if (!isAdmin(request)) return jsonError(reply, 401, 'A valid admin token is required.', 'invalid_admin_token');
    const ownerId = (request.params as { ownerId: string }).ownerId;
    if (!/^[a-fA-F0-9]{64}$/.test(ownerId)) return jsonError(reply, 400, 'The MeshLLM Owner ID is invalid.', 'invalid_mesh_owner');
    if (!store.revokeTrustedMeshOwner(ownerId)) return jsonError(reply, 404, 'That approved host was not found.', 'mesh_owner_not_found');
    cachedCommunityAvailability = undefined;
    return reply.code(204).send();
  });

  app.post('/admin/mesh/admission/verify', async (request, reply) => {
    if (isRateLimited(request, 'admin-mesh-admission-verify', 20, 60 * 60 * 1000)) {
      reply.header('retry-after', '3600');
      return jsonError(reply, 429, 'Too many admission confirmations. Try again later.', 'rate_limit_exceeded');
    }
    if (!config.OPENINFERENCE_ADMIN_TOKEN) return jsonError(reply, 503, 'Operator access is disabled until an admin token is configured.', 'admin_not_configured');
    if (!isAdmin(request)) return jsonError(reply, 401, 'A valid admin token is required.', 'invalid_admin_token');
    const parsed = meshAdmissionVerifySchema.safeParse(request.body);
    if (!parsed.success) return jsonError(reply, 400, 'Confirm that every mesh computer has been restarted with the current approved-owner list.', 'mesh_admission_confirmation_required');
    const ownerIds = trustedMeshOwnerIds();
    const gatewayOwnerId = communityProvider.gatewayOwnerId();
    if (!gatewayOwnerId || !ownerIds.includes(gatewayOwnerId) || !ownerIds.some(ownerId => ownerId !== gatewayOwnerId)) {
      return jsonError(reply, 409, 'Add the gateway and at least one other trusted mesh owner before confirming admission.', 'mesh_owner_allowlist_incomplete');
    }
    const admission = store.verifyMeshAdmission(ownerIds);
    cachedCommunityAvailability = undefined;
    return {
      admissionVerified: config.meshllmAdmissionPolicyVerified && admission.verified,
      admissionPolicyEnabled: config.meshllmAdmissionPolicyVerified,
      generation: admission.generation,
      message: config.meshllmAdmissionPolicyVerified
        ? 'Owner list confirmed. Community inference can resume when a model is serving.'
        : 'Owner list recorded, but admission remains disabled until the operator enables the allowlist policy in server configuration.'
    };
  });

  app.get('/admin/mesh/join-info', async (request, reply) => {
    if (isRateLimited(request, 'admin-mesh-join-info', 20, 60 * 1000)) {
      reply.header('retry-after', '60');
      return jsonError(reply, 429, 'Too many join-code requests. Try again shortly.', 'rate_limit_exceeded');
    }
    if (!config.OPENINFERENCE_ADMIN_TOKEN) return jsonError(reply, 503, 'Operator access is disabled until an admin token is configured.', 'admin_not_configured');
    if (!isAdmin(request)) return jsonError(reply, 401, 'A valid admin token is required.', 'invalid_admin_token');
    if (!config.MESHLLM_INVITE_TOKEN) return jsonError(reply, 503, 'The MeshLLM join code is not configured.', 'mesh_join_code_missing');
    const availability = await communityAvailability();
    return {
      joinToken: config.MESHLLM_INVITE_TOKEN,
      communityRoutingEnabled: availability.ready,
      warning: availability.ready
        ? 'This is connection information, not an access-control credential. Share it only with contributors you have approved.'
        : `${communityAvailabilityMessage(availability)} This join code is not an access-control credential; share it only with people you trust.`
    };
  });

  app.get('/admin/workspaces', async (request, reply) => {
    if (isRateLimited(request, 'admin-workspaces', 60, 60 * 1000)) {
      reply.header('retry-after', '60');
      return jsonError(reply, 429, 'Too many admin requests. Try again shortly.', 'rate_limit_exceeded');
    }
    if (!config.OPENINFERENCE_ADMIN_TOKEN) return jsonError(reply, 503, 'Workspace management is disabled until an admin token is configured.', 'admin_not_configured');
    if (!isAdmin(request)) return jsonError(reply, 401, 'A valid admin token is required.', 'invalid_admin_token');
    return {
      data: store.listWorkspaces().map(workspace => ({
        ...workspace,
        plan: config.usagePlans[workspace.planId] ?? config.usagePlans.free
      }))
    };
  });

  app.post<{ Params: { id: string } }>('/admin/workspaces/:id/plan', async (request, reply) => {
    if (isRateLimited(request, 'admin-plan-change', 30, 60 * 60 * 1000)) {
      reply.header('retry-after', '3600');
      return jsonError(reply, 429, 'Too many plan changes. Try again later.', 'rate_limit_exceeded');
    }
    if (!config.OPENINFERENCE_ADMIN_TOKEN) return jsonError(reply, 503, 'Plan management is disabled until an admin token is configured.', 'admin_not_configured');
    if (!isAdmin(request)) return jsonError(reply, 401, 'A valid admin token is required.', 'invalid_admin_token');
    const parsed = workspacePlanSchema.safeParse(request.body);
    if (!parsed.success) return jsonError(reply, 400, 'Choose Free, Contributor, or Sustainer.', 'invalid_plan');
    if (!store.setWorkspacePlan(request.params.id, parsed.data.planId)) {
      return jsonError(reply, 404, 'Workspace not found.', 'workspace_not_found');
    }
    return {
      workspaceId: request.params.id,
      plan: config.usagePlans[parsed.data.planId]
    };
  });

  app.post('/api/invites/claim', async (request, reply) => {
    if (isRateLimited(request, 'invite-claims', 20, 10 * 60 * 1000)) {
      reply.header('retry-after', '600');
      return jsonError(reply, 429, 'Too many invite attempts. Try again later.', 'rate_limit_exceeded');
    }
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) return jsonError(reply, 400, 'Enter a valid invite code and workspace name.', 'invalid_invite_claim');
    const claimed = store.claimInvite(parsed.data.inviteToken, parsed.data.workspaceName);
    if (!claimed) return jsonError(reply, 400, 'This invite is invalid, expired, or already used.', 'invite_unavailable');
    return reply.code(201).send({
      workspace: claimed.workspace,
      dashboardToken: claimed.dashboardToken,
      warning: 'Save this dashboard key now. It is only shown once.'
    });
  });

  app.get('/api/dashboard', async (request, reply) => {
    const workspace = dashboardWorkspace(request);
    if (!workspace) return jsonError(reply, 401, 'A valid workspace dashboard key is required.', 'invalid_dashboard_key');
    const plan = config.usagePlans[workspace.planId] ?? config.usagePlans.free;
    const availability = await communityAvailability();
    return {
      workspace,
      plan,
      plans: Object.values(config.usagePlans),
      apiKeys: store.listApiKeys(workspace.id),
      hostTokens: store.listHostTokens(workspace.id),
      usage: store.usageForWorkspace(workspace.id),
      limits: {
        private: plan.privateDailyUnits,
        community: plan.communityDailyUnits
      },
      pools: {
        privateConfigured: Boolean(config.privateBaseUrl),
        communityEnabled: availability.ready,
        communityConnected: availability.connected,
        communityAvailabilityReason: availability.reason,
        communityStatusMessage: communityAvailabilityMessage(availability)
      },
      api: {
          privateBaseUrl: `${config.publicBaseUrl ?? `${request.protocol}://${request.headers.host}`}/private/v1`,
          communityBaseUrl: `${config.publicBaseUrl ?? `${request.protocol}://${request.headers.host}`}/v1`
      }
    };
  });

  app.get('/api/dashboard/models', async (request, reply) => {
    const workspace = dashboardWorkspace(request);
    if (!workspace) return jsonError(reply, 401, 'A valid workspace dashboard key is required.', 'invalid_dashboard_key');
    const mode = modeFromPath(String((request.query as { mode?: string }).mode ?? 'private'));
    if (!mode) return jsonError(reply, 400, 'Choose private or community.', 'invalid_pool');
    try {
      return { data: await modelsFor(mode) };
    } catch (error) {
      const message = error instanceof ProviderUnavailableError ? error.message : 'The model catalog is temporarily unavailable.';
      return jsonError(reply, 503, message, 'pool_unavailable');
    }
  });

  app.post('/api/keys', async (request, reply) => {
    const workspace = dashboardWorkspace(request);
    if (!workspace) return jsonError(reply, 401, 'A valid workspace dashboard key is required.', 'invalid_dashboard_key');
    const parsed = keySchema.safeParse(request.body);
    if (!parsed.success) return jsonError(reply, 400, 'Choose a pool and provide a short key label.', 'invalid_api_key');
    if (store.activeApiKeyCount(workspace.id) >= 20) {
      return jsonError(reply, 429, 'A workspace can have up to 20 active API keys. Revoke an unused key first.', 'api_key_limit_reached');
    }
    const created = store.createApiKey(workspace.id, parsed.data.mode, parsed.data.label);
    return reply.code(201).send({ ...created.view, secret: created.secret });
  });

  app.delete<{ Params: { id: string } }>('/api/keys/:id', async (request, reply) => {
    const workspace = dashboardWorkspace(request);
    if (!workspace) return jsonError(reply, 401, 'A valid workspace dashboard key is required.', 'invalid_dashboard_key');
    if (!store.revokeApiKey(workspace.id, request.params.id)) return jsonError(reply, 404, 'API key not found.', 'key_not_found');
    return reply.code(204).send();
  });

  app.post('/api/host-tokens', async (request, reply) => {
    const workspace = dashboardWorkspace(request);
    if (!workspace) return jsonError(reply, 401, 'A valid workspace dashboard key is required.', 'invalid_dashboard_key');
    const parsed = hostTokenSchema.safeParse(request.body);
    if (!parsed.success) return jsonError(reply, 400, 'Give this computer a short label.', 'invalid_host_token');
    if (store.activeHostTokenCount(workspace.id) >= 10) {
      return jsonError(reply, 429, 'A workspace can have up to 10 active host tokens. Revoke an unused one first.', 'host_token_limit_reached');
    }
    const created = store.createHostToken(workspace.id, parsed.data.label);
    return reply.code(201).send({ ...created.view, secret: created.secret });
  });

  app.delete<{ Params: { id: string } }>('/api/host-tokens/:id', async (request, reply) => {
    const workspace = dashboardWorkspace(request);
    if (!workspace) return jsonError(reply, 401, 'A valid workspace dashboard key is required.', 'invalid_dashboard_key');
    if (!store.revokeHostToken(workspace.id, request.params.id)) return jsonError(reply, 404, 'Host token not found.', 'host_token_not_found');
    presence.removeToken(request.params.id);
    return reply.code(204).send();
  });

  registerModelRoute(app, 'private', '/private/v1/models');
  registerChatRoute(app, 'private', '/private/v1/chat/completions');
  registerModelRoute(app, 'community', '/community/v1/models');
  registerChatRoute(app, 'community', '/community/v1/chat/completions');
  // The plain OpenAI-compatible path is the shared community pool. Private
  // requests must use the explicit /private/v1 route and a private-scoped key.
  registerModelRoute(app, 'community', '/v1/models');
  registerChatRoute(app, 'community', '/v1/chat/completions');

  return app;
}

export async function closeServer(): Promise<void> {
  await communityProvider.stop().catch(() => undefined);
  store.close();
}
