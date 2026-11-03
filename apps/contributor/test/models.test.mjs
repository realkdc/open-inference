import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRIBUTOR_MODELS,
  DEFAULT_CONTRIBUTOR_MODEL_ID,
  contributorModelById,
  contributorModelByRef
} from '../dist/models.js';

test('the beta offers only the two reviewed split-model packages', () => {
  assert.deepEqual(CONTRIBUTOR_MODELS.map(model => model.id), ['qwen3-8b', 'qwen3-30b-a3b-thinking-2507']);
  assert.equal(contributorModelById(DEFAULT_CONTRIBUTOR_MODEL_ID).modelRef, 'unsloth/Qwen3-8B-GGUF:Q4_K_M');
  assert.equal(contributorModelById('qwen3-30b-a3b-thinking-2507').apiModelId, 'unsloth/Qwen3-30B-A3B-Thinking-2507-GGUF:UD-Q4_K_XL');
  assert.equal(contributorModelById('arbitrary-huggingface-model'), undefined);
  assert.equal(contributorModelByRef('meshllm/Qwen3-30B-A3B-Thinking-2507-UD-Q4_K_XL-layers').id, 'qwen3-30b-a3b-thinking-2507');
});
