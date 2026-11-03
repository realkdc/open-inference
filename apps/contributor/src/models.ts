export type ContributorModel = {
  id: string;
  name: string;
  modelRef: string;
  apiModelId: string;
  packageSizeGb: number;
  layers: number;
  description: string;
};

export const CONTRIBUTOR_MODELS: readonly ContributorModel[] = [
  {
    id: 'qwen3-8b',
    name: 'Qwen3 8B · starter pool',
    modelRef: 'unsloth/Qwen3-8B-GGUF:Q4_K_M',
    apiModelId: 'unsloth/Qwen3-8B-GGUF:Q4_K_M',
    packageSizeGb: 5.0,
    layers: 36,
    description: 'The smaller shared model. A good first pool for gathering enough computers to serve reliably.'
  },
  {
    id: 'qwen3-30b-a3b-thinking-2507',
    name: 'Qwen3 30B-A3B Thinking · larger pool',
    modelRef: 'meshllm/Qwen3-30B-A3B-Thinking-2507-UD-Q4_K_XL-layers',
    apiModelId: 'unsloth/Qwen3-30B-A3B-Thinking-2507-GGUF:UD-Q4_K_XL',
    packageSizeGb: 17.7,
    layers: 48,
    description: 'A larger reasoning model with a separate split pool. It needs substantially more connected capacity and may respond more slowly.'
  }
];

export const DEFAULT_CONTRIBUTOR_MODEL_ID = CONTRIBUTOR_MODELS[0].id;

export function contributorModelById(id: unknown): ContributorModel | undefined {
  return typeof id === 'string' ? CONTRIBUTOR_MODELS.find(model => model.id === id) : undefined;
}

export function contributorModelByRef(modelRef: string): ContributorModel | undefined {
  return CONTRIBUTOR_MODELS.find(model => model.modelRef === modelRef);
}
