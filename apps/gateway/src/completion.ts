type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function append(target: JsonRecord, key: string, value: unknown): void {
  const current = target[key];
  if (typeof value === 'string' && typeof current === 'string') {
    target[key] = current + value;
  } else if (Array.isArray(value) && Array.isArray(current)) {
    target[key] = [...current, ...value];
  } else if (value !== undefined) {
    target[key] = value;
  }
}

function mergeFunctionCall(target: JsonRecord, value: unknown): void {
  const part = record(value);
  if (!part) return;
  const current = record(target.function_call) ?? {};
  for (const [key, item] of Object.entries(part)) append(current, key, item);
  target.function_call = current;
}

function mergeToolCalls(target: JsonRecord, value: unknown): void {
  if (!Array.isArray(value)) return;
  const calls = Array.isArray(target.tool_calls) ? target.tool_calls as JsonRecord[] : [];
  for (const item of value) {
    const part = record(item);
    if (!part) continue;
    const index = typeof part.index === 'number' && Number.isInteger(part.index) ? part.index : calls.length;
    if (index < 0 || index > 128) continue;
    const call = calls[index] ?? { index };
    for (const key of ['id', 'type']) append(call, key, part[key]);
    const functionPart = record(part.function);
    if (functionPart) {
      const fn = record(call.function) ?? {};
      for (const [key, field] of Object.entries(functionPart)) append(fn, key, field);
      call.function = fn;
    }
    calls[index] = call;
  }
  target.tool_calls = calls;
}

function mergeMessage(target: JsonRecord, value: unknown): void {
  const delta = record(value);
  if (!delta) return;
  for (const [key, item] of Object.entries(delta)) {
    if (key === 'tool_calls') mergeToolCalls(target, item);
    else if (key === 'function_call') mergeFunctionCall(target, item);
    else append(target, key, item);
  }
}

/** Reconstruct the OpenAI chat-completion JSON shape from streamed JSON chunks. */
export function assembleChatCompletion(chunks: unknown[]): JsonRecord {
  let id: string | undefined;
  let created: number | undefined;
  let model: string | undefined;
  let usage: unknown;
  let systemFingerprint: unknown;
  const choices = new Map<number, { index: number; message: JsonRecord; finishReason: unknown; logprobs?: unknown }>();

  for (const rawChunk of chunks) {
    const chunk = record(rawChunk);
    if (!chunk) continue;
    if (typeof chunk.id === 'string') id = chunk.id;
    if (typeof chunk.created === 'number') created = chunk.created;
    if (typeof chunk.model === 'string') model = chunk.model;
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    if (chunk.system_fingerprint !== undefined) systemFingerprint = chunk.system_fingerprint;
    if (!Array.isArray(chunk.choices)) continue;

    for (const rawChoice of chunk.choices) {
      const choice = record(rawChoice);
      if (!choice) continue;
      const index = typeof choice.index === 'number' && Number.isInteger(choice.index) ? choice.index : 0;
      if (index < 0 || index > 128) continue;
      const current = choices.get(index) ?? { index, message: {}, finishReason: null };
      mergeMessage(current.message, choice.delta);
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) current.finishReason = choice.finish_reason;
      if (choice.logprobs !== undefined) current.logprobs = choice.logprobs;
      choices.set(index, current);
    }
  }

  if (choices.size === 0) throw new Error('The model returned no completion choices.');
  const result: JsonRecord = {
    object: 'chat.completion',
    ...(id ? { id } : {}),
    ...(created !== undefined ? { created } : {}),
    ...(model ? { model } : {}),
    choices: [...choices.values()].sort((left, right) => left.index - right.index).map(choice => {
      const message = { ...choice.message };
      if (Array.isArray(message.tool_calls)) {
        message.tool_calls = message.tool_calls
          .filter((call): call is JsonRecord => record(call) !== undefined)
          .map(({ index: _index, ...call }) => call);
      }
      return {
        index: choice.index,
        message,
        finish_reason: choice.finishReason,
        ...(choice.logprobs !== undefined ? { logprobs: choice.logprobs } : {})
      };
    }),
    ...(usage !== undefined ? { usage } : {}),
    ...(systemFingerprint !== undefined ? { system_fingerprint: systemFingerprint } : {})
  };
  return result;
}
