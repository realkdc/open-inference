import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleChatCompletion } from '../dist/completion.js';
import { MeshLLMCommunityProvider } from '../dist/providers.js';

const chunk = data => ({
  type: 'sse',
  requestId: 'request-test',
  data: JSON.stringify(data),
  raw: 'data: ' + JSON.stringify(data) + '\n\n',
  done: false,
  json: () => data
});

function attachFakeClient(provider, inference) {
  provider.client = { inference };
}

test('reassembles content and metadata from stream chunks', () => {
  const result = assembleChatCompletion([
    { id: 'chat-1', created: 42, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'there.' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
  ]);

  assert.equal(result.object, 'chat.completion');
  assert.equal(result.id, 'chat-1');
  assert.equal(result.choices[0].message.content, 'Hello there.');
  assert.equal(result.choices[0].finish_reason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('reassembles fragmented tool calls into an OpenAI non-stream response', async () => {
  const provider = new MeshLLMCommunityProvider();
  attachFakeClient(provider, {
    streamChatCompletions: async function* (body) {
      assert.equal(body.stream, true);
      yield { type: 'started', requestId: 'request-test', statusCode: 200 };
      yield chunk({
        id: 'chat-tools', model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_', type: 'function', function: { name: 'lookup', arguments: '{"city":' } }] }, finish_reason: null }]
      });
      yield chunk({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '123', function: { arguments: '"Oslo"}' } }] }, finish_reason: 'tool_calls' }]
      });
      yield { type: 'sse', requestId: 'request-test', data: '[DONE]', raw: 'data: [DONE]\n\n', done: true, json: () => null };
    },
    cancel: async () => undefined
  });

  const result = await provider.complete({ model: 'test-model', messages: [{ role: 'user', content: 'Weather in Oslo?' }] }, new AbortController().signal);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.choices[0].message.tool_calls, [{
    id: 'call_123',
    type: 'function',
    function: { name: 'lookup', arguments: '{"city":"Oslo"}' }
  }]);
});

test('streaming preserves fragmented tool-call deltas as OpenAI SSE chunks', async () => {
  const provider = new MeshLLMCommunityProvider();
  const first = chunk({
    id: 'chat-tools-stream', model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"city":' } }] }, finish_reason: null }]
  });
  const second = chunk({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }, finish_reason: null }]
  });
  attachFakeClient(provider, {
    streamChatCompletions: async function* (body) {
      assert.equal(body.stream, true);
      yield { type: 'started', requestId: 'request-tools-stream', statusCode: 200 };
      yield first;
      yield second;
      yield { type: 'sse', requestId: 'request-tools-stream', data: '[DONE]', raw: 'data: [DONE]\n\n', done: true, json: () => null };
    },
    cancel: async () => undefined
  });

  const output = [];
  for await (const raw of provider.stream({ model: 'test-model', messages: [], stream: true }, new AbortController().signal)) {
    output.push(raw);
  }
  assert.deepEqual(output, [first.raw, second.raw, 'data: [DONE]\n\n']);
  assert.match(output[0], /"tool_calls"/);
  assert.match(output[1], /Oslo/);
});

test('cancelling a client stream cancels its Mesh request ID', async () => {
  const provider = new MeshLLMCommunityProvider();
  const controller = new AbortController();
  const cancelled = [];
  let releasePending;
  attachFakeClient(provider, {
    streamChatCompletions: async function* () {
      yield { type: 'started', requestId: 'request-cancel', statusCode: 200 };
      await new Promise(resolve => { releasePending = resolve; });
      yield chunk({ choices: [{ index: 0, delta: { content: 'late' }, finish_reason: null }] });
    },
    cancel: async requestId => {
      cancelled.push(requestId);
      releasePending?.();
    }
  });

  const iterator = provider.stream({ model: 'test-model', messages: [], stream: true }, controller.signal)[Symbol.asyncIterator]();
  const pending = iterator.next();
  for (let attempt = 0; attempt < 100 && !releasePending; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(typeof releasePending, 'function');
  controller.abort();
  const result = await pending;
  assert.equal(result.done, true);
  assert.deepEqual(cancelled, ['request-cancel']);
});

test('cancelling a non-stream completion cancels Mesh generation too', async () => {
  const provider = new MeshLLMCommunityProvider();
  const controller = new AbortController();
  const cancelled = [];
  let releasePending;
  attachFakeClient(provider, {
    streamChatCompletions: async function* () {
      yield { type: 'started', requestId: 'request-json-cancel', statusCode: 200 };
      await new Promise(resolve => { releasePending = resolve; });
      yield chunk({ choices: [{ index: 0, delta: { content: 'late' }, finish_reason: null }] });
    },
    cancel: async requestId => {
      cancelled.push(requestId);
      releasePending?.();
    }
  });

  const pending = provider.complete({ model: 'test-model', messages: [] }, controller.signal);
  for (let attempt = 0; attempt < 100 && !releasePending; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(typeof releasePending, 'function');
  controller.abort();
  await assert.rejects(pending, /cancelled/i);
  assert.deepEqual(cancelled, ['request-json-cancel']);
});
