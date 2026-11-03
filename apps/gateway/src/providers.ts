import {
  Client,
  generateOwnerKeypairHex,
  type OpenAIStreamEvent,
  type OpenAIRequestBody
} from '@mesh-llm/sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config, type AccessMode } from './config.js';
import { assembleChatCompletion } from './completion.js';
import { meshOwnerIdFromKeypairHex } from './mesh-identity.js';

export type ListedModel = {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
};

export interface InferenceProvider {
  readonly mode: AccessMode;
  listModels(): Promise<ListedModel[]>;
  complete(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  stream(body: Record<string, unknown>, signal: AbortSignal): AsyncIterable<string>;
}

export class ProviderUnavailableError extends Error {
  constructor(message = 'This inference pool is not available right now.') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

function toModelList(value: unknown, provider: string): ListedModel[] {
  if (typeof value !== 'object' || value === null || !('data' in value) || !Array.isArray(value.data)) {
    return [];
  }
  return value.data.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('id' in item) || typeof item.id !== 'string') return [];
    return [{
      id: item.id,
      object: 'model' as const,
      created: Date.now() / 1000 | 0,
      owned_by: provider
    }];
  });
}

export class OpenAICompatibleProvider implements InferenceProvider {
  readonly mode: AccessMode = 'private';

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly apiKey: string | undefined
  ) {}

  private assertReady(): string {
    if (!this.baseUrl) {
      throw new ProviderUnavailableError('Private inference is not configured yet.');
    }
    return this.baseUrl;
  }

  async listModels(): Promise<ListedModel[]> {
    const baseUrl = this.assertReady();
    const response = await fetch(`${baseUrl}/models`, {
      headers: this.headers(),
      redirect: 'error'
    });
    if (!response.ok) throw new UpstreamError('The private model service could not list models.', response.status);
    return toModelList(await response.json(), 'private');
  }

  async complete(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.assertReady()}/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error'
    });
    if (!response.ok) {
      throw new UpstreamError('The private model service rejected the request.', response.status);
    }
    return response.json();
  }

  async *stream(body: Record<string, unknown>, signal: AbortSignal): AsyncIterable<string> {
    const response = await fetch(`${this.assertReady()}/chat/completions`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error'
    });
    if (!response.ok || !response.body) {
      throw new UpstreamError('The private model service could not start the response.', response.status);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      reader.releaseLock();
    }
  }

  private headers(): Record<string, string> {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      accept: 'application/json'
    };
  }
}

export class MeshLLMCommunityProvider implements InferenceProvider {
  readonly mode: AccessMode = 'community';
  private client?: Client;
  private startupError?: string;
  private startPromise?: Promise<void>;
  private retryAfter = 0;

  get connected(): boolean {
    return Boolean(this.client);
  }

  gatewayOwnerId(): string | undefined {
    if (!config.MESHLLM_INVITE_TOKEN) return undefined;
    try {
      return meshOwnerIdFromKeypairHex(this.ownerKeypair());
    } catch {
      return undefined;
    }
  }

  async operatorStatus(): Promise<{ clientStarted: boolean; connecting: boolean; connected: boolean; peerCount: number; models: string[]; gatewayOwnerId?: string }> {
    if (!this.client) return {
      clientStarted: false,
      connecting: Boolean(this.startPromise),
      connected: false,
      peerCount: 0,
      models: [],
      gatewayOwnerId: this.gatewayOwnerId()
    };
    const client = this.client;
    const status = await client.status().catch(() => ({ connected: false, peerCount: 0 }));
    let models: string[] = [];
    if (status.connected) {
      try { models = (await client.inference.listModels()).map(model => model.id); }
      catch { /* The operator view reports no models until the SDK can confirm them. */ }
    }
    return {
      clientStarted: true,
      connecting: false,
      connected: status.connected,
      peerCount: status.peerCount,
      models,
      gatewayOwnerId: this.gatewayOwnerId()
    };
  }

  async start(): Promise<void> {
    if (!config.MESHLLM_INVITE_TOKEN) {
      this.startupError = 'MESHLLM_INVITE_TOKEN is not configured.';
      return;
    }
    if (this.client) return;
    if (this.startPromise) return this.startPromise;
    if (Date.now() < this.retryAfter) return;
    this.startPromise = this.connect();
    await this.startPromise;
  }

  private async connect(): Promise<void> {
    try {
      const ownerKeypairHex = this.ownerKeypair();
      const client = Client.create({ ownerKeypairHex, inviteToken: config.MESHLLM_INVITE_TOKEN! });
      await client.start();
      this.client = client;
      this.startupError = undefined;
      this.retryAfter = 0;
    } catch {
      // SDK errors may contain peer addresses or request details; keep them out of logs.
      this.startupError = 'The community mesh could not be reached.';
      this.retryAfter = Date.now() + 5_000;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    await this.client.stop();
    this.client = undefined;
  }

  async listModels(): Promise<ListedModel[]> {
    if (!this.client) await this.start();
    const client = this.requireClient();
    const status = await client.status().catch(() => ({ connected: false, peerCount: 0 }));
    if (!status.connected) await client.reconnect().catch(() => undefined);
    const models = await client.inference.listModels();
    return models.map(model => ({
      id: model.id,
      object: 'model',
      created: Date.now() / 1000 | 0,
      owned_by: 'community'
    }));
  }

  async complete(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const chunks: unknown[] = [];
    for await (const event of this.requestStream({ ...body, stream: true }, signal)) {
      if (event.type === 'started') {
        if (event.statusCode >= 400) {
          throw new UpstreamError('The community mesh could not start the request.', event.statusCode);
        }
        continue;
      }
      if (event.data === '[DONE]') continue;
      const chunk = event.json();
      if (chunk !== null) chunks.push(chunk);
    }
    if (signal.aborted) throw new Error('The inference request was cancelled.');
    return assembleChatCompletion(chunks);
  }

  async *stream(body: Record<string, unknown>, _signal: AbortSignal): AsyncIterable<string> {
    for await (const event of this.requestStream({ ...body, stream: true }, _signal)) {
      if (event.type === 'started') {
        if (event.statusCode >= 400) {
          throw new UpstreamError('The community mesh could not start the request.', event.statusCode);
        }
        continue;
      }
      if (event.raw) yield event.raw;
    }
  }

  private async *requestStream(body: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<OpenAIStreamEvent> {
    const client = this.requireClient();
    const iterator = client.inference.streamChatCompletions(body as OpenAIRequestBody)[Symbol.asyncIterator]();
    let requestId: string | undefined;
    let cancellation: Promise<void> | undefined;
    const cancelRequest = () => {
      if (!requestId || cancellation) return;
      cancellation = client.inference.cancel(requestId).catch(() => undefined);
    };
    const onAbort = () => cancelRequest();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!signal.aborted) {
        const result = await iterator.next();
        if (result.done) return;
        if (result.value.type === 'started') {
          requestId = result.value.requestId;
          if (signal.aborted) {
            cancelRequest();
            await cancellation;
            return;
          }
        }
        if (signal.aborted) return;
        yield result.value;
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        cancelRequest();
        await cancellation;
      }
      await iterator.return?.();
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new ProviderUnavailableError('Community inference is not connected.');
    }
    return this.client;
  }

  private ownerKeypair(): string {
    if (config.MESHLLM_OWNER_KEYPAIR_HEX) return config.MESHLLM_OWNER_KEYPAIR_HEX;
    const keyPath = resolve(config.MESHLLM_OWNER_KEY_PATH);
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    if (existsSync(keyPath)) return readFileSync(keyPath, 'utf8').trim();
    const key = generateOwnerKeypairHex();
    writeFileSync(keyPath, key, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return key;
  }
}

export const privateProvider = new OpenAICompatibleProvider(config.privateBaseUrl, config.PRIVATE_UPSTREAM_API_KEY);
export const communityProvider = new MeshLLMCommunityProvider();
export const providerFor = (mode: AccessMode): InferenceProvider =>
  mode === 'private' ? privateProvider : communityProvider;
