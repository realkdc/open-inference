const BYTES_PER_GB = 1024 ** 3;

export type GpuMemory = {
  unifiedMemory?: boolean;
  allocatableVramBytes?: number;
  vramBytes?: number;
  ratedVramGb?: number;
};

export type ResourceBudget = {
  systemMemoryGb: number;
  recommendedModelMemoryGb: number;
  deviceMemoryLimited: boolean;
};

/**
 * A cautious ceiling for inference memory: never offer more than 20% of RAM
 * and leave at least 6 GB for the OS and other apps.
 * On machines with dedicated GPUs, also leave half of that GPU's memory free.
 */
export function recommendModelMemoryGb(input: {
  totalMemoryBytes: number;
  gpus?: GpuMemory[];
}): ResourceBudget {
  const totalGb = Math.max(0, input.totalMemoryBytes / BYTES_PER_GB);
  const ramLimitGb = Math.min(totalGb * 0.2, Math.max(0, totalGb - 6));

  const dedicatedGpuSizes = (input.gpus ?? [])
    .filter(gpu => gpu.unifiedMemory !== true)
    .map(gpu => {
      if (typeof gpu.allocatableVramBytes === 'number' && gpu.allocatableVramBytes > 0) return gpu.allocatableVramBytes / BYTES_PER_GB;
      if (typeof gpu.vramBytes === 'number' && gpu.vramBytes > 0) return gpu.vramBytes / BYTES_PER_GB;
      if (typeof gpu.ratedVramGb === 'number' && gpu.ratedVramGb > 0) return gpu.ratedVramGb;
      return 0;
    })
    .filter(size => size > 0);

  const deviceMemoryLimited = dedicatedGpuSizes.length > 0;
  const gpuLimitGb = deviceMemoryLimited ? Math.max(...dedicatedGpuSizes) * 0.5 : Number.POSITIVE_INFINITY;
  const rawRecommendation = Math.min(ramLimitGb, gpuLimitGb);
  const recommendedModelMemoryGb = Math.floor((rawRecommendation + Number.EPSILON) * 2) / 2;

  return {
    systemMemoryGb: Math.round(totalGb * 10) / 10,
    recommendedModelMemoryGb,
    deviceMemoryLimited
  };
}
