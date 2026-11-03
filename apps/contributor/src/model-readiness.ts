type HealthRecord = {
  mode?: string;
  worker?: { models?: string[] };
  serving?: { status?: string; models?: string[] };
  models?: string[];
};

export type ModelReadiness = { ready: boolean; splitStage: boolean };

export function modelReadiness(value: unknown, modelsToMatch: string | string[]): ModelReadiness {
  if (typeof value !== 'object' || value === null) return { ready: false, splitStage: false };
  const health = value as HealthRecord;
  const expected = new Set(Array.isArray(modelsToMatch) ? modelsToMatch : [modelsToMatch]);
  if (health.mode === 'worker') {
    const models = health.worker?.models ?? health.models ?? [];
    const ready = models.some(model => expected.has(model));
    return { ready, splitStage: ready };
  }
  const ready = health.serving?.status === 'healthy' && health.serving.models?.some(model => expected.has(model)) === true;
  return { ready, splitStage: false };
}
