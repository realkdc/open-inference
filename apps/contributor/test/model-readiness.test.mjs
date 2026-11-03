import assert from 'node:assert/strict';
import test from 'node:test';
import { modelReadiness } from '../dist/model-readiness.js';

test('a worker is ready only when MeshLLM reports its assigned model stage', () => {
  assert.deepEqual(modelReadiness({ mode: 'worker', worker: { models: ['Qwen3-8B-Q4_K_M'] } }, 'Qwen3-8B-Q4_K_M'), {
    ready: true,
    splitStage: true
  });
  assert.deepEqual(modelReadiness({ mode: 'worker', worker: { models: ['unsloth/Qwen3-8B-GGUF:Q4_K_M'] } }, ['unsloth/Qwen3-8B-GGUF:Q4_K_M']), {
    ready: true,
    splitStage: true
  });
  assert.deepEqual(modelReadiness({ mode: 'worker', worker: { models: [] }, serving: { status: 'healthy', models: ['Qwen3-8B-Q4_K_M'] } }, 'Qwen3-8B-Q4_K_M'), {
    ready: false,
    splitStage: false
  });
  assert.deepEqual(modelReadiness({ mode: 'worker', worker: { models: ['unsloth/Qwen3-30B-A3B-Thinking-2507-GGUF:UD-Q4_K_XL'] } }, [
    'meshllm/Qwen3-30B-A3B-Thinking-2507-UD-Q4_K_XL-layers',
    'unsloth/Qwen3-30B-A3B-Thinking-2507-GGUF:UD-Q4_K_XL'
  ]), {
    ready: true,
    splitStage: true
  });
});

test('a serving node needs a healthy exact model match', () => {
  assert.deepEqual(modelReadiness({ mode: 'serving', serving: { status: 'healthy', models: ['other'] } }, 'Qwen3-8B-Q4_K_M'), {
    ready: false,
    splitStage: false
  });
  assert.deepEqual(modelReadiness({ mode: 'serving', serving: { status: 'healthy', models: ['Qwen3-8B-Q4_K_M'] } }, 'Qwen3-8B-Q4_K_M'), {
    ready: true,
    splitStage: false
  });
});
