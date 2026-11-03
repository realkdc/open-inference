import { z } from 'zod';

const optionalString = z.preprocess(value => value === '' ? undefined : value, z.string().optional());
const ownerIdList = z.string().default('').transform((value, context) => {
  const ids = value.split(',').map(id => id.trim()).filter(Boolean).map(id => id.toLowerCase());
  if (ids.length > 256 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) {
    context.addIssue({ code: 'custom', message: 'Use at most 256 comma-separated MeshLLM owner IDs, each 64 hexadecimal characters.' });
    return [];
  }
  return [...new Set(ids)];
});
const isLoopbackHostname = (hostname: string) => hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
const httpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname))) && !url.username && !url.password;
  } catch {
    return false;
  }
};
const optionalHttpUrl = z.preprocess(
  value => value === '' ? undefined : value,
  z.string().url().refine(httpUrl, 'Use HTTPS, or HTTP on loopback only.').optional()
);
const optionalLoopbackHttpUrl = z.preprocess(
  value => value === '' ? undefined : value,
  z.string().url().refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' && isLoopbackHostname(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use HTTP on loopback only for the MeshLLM management API.').optional()
);
const privateUpstreamUrl = z.preprocess(
  value => value === '' ? undefined : value,
  z.string().url().refine(httpUrl, 'The private upstream must use HTTPS, or HTTP on loopback only.').optional()
);

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_PATH: z.string().default('./.data/open-inference.sqlite'),
  OPENINFERENCE_ADMIN_TOKEN: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  PRIVATE_UPSTREAM_URL: privateUpstreamUrl,
  PRIVATE_UPSTREAM_API_KEY: optionalString,
  PRIVATE_DAILY_LIMIT_UNITS: z.coerce.number().int().positive().default(5000),
  COMMUNITY_DAILY_LIMIT_UNITS: z.coerce.number().int().positive().default(5000),
  CONTRIBUTOR_COMMUNITY_DAILY_LIMIT_UNITS: z.coerce.number().int().positive().default(15000),
  SUSTAINER_COMMUNITY_DAILY_LIMIT_UNITS: z.coerce.number().int().positive().default(50000),
  PRIVATE_MAX_CONCURRENT: z.coerce.number().int().positive().default(1),
  COMMUNITY_MAX_CONCURRENT: z.coerce.number().int().positive().default(1),
  MAX_QUEUED_REQUESTS: z.coerce.number().int().nonnegative().default(20),
  QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MAX_CONTEXT_TOKENS: z.coerce.number().int().min(512).default(2048),
  MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(1536),
  DEFAULT_MAX_COMPLETION_TOKENS: z.coerce.number().int().positive().default(512),
  HARD_MAX_COMPLETION_TOKENS: z.coerce.number().int().positive().default(1024),
  MODEL_COMPUTE_WEIGHTS: z.string().default('{}'),
  MESHLLM_INVITE_TOKEN: optionalString,
  // MeshLLM join tokens are connection information, not access control. Keep
  // community serving disabled until the operator has verified peer admission.
  MESHLLM_ADMISSION_POLICY_VERIFIED: z.enum(['false', 'true']).default('false'),
  // Optional static service owners (for example, a dedicated bootstrap node).
  // Contributor hosts are approved dynamically from the operator dashboard.
  MESHLLM_TRUSTED_OWNER_IDS: ownerIdList,
  MESHLLM_OWNER_KEYPAIR_HEX: optionalString,
  MESHLLM_OWNER_KEY_PATH: z.string().default('./.data/community-mesh-owner-key'),
  MESHLLM_MANAGEMENT_URL: optionalLoopbackHttpUrl,
  DASHBOARD_ORIGIN: optionalHttpUrl,
  PUBLIC_BASE_URL: optionalHttpUrl
}).refine(
  values => values.MAX_INPUT_TOKENS < values.MAX_CONTEXT_TOKENS,
  { message: 'MAX_INPUT_TOKENS must be smaller than MAX_CONTEXT_TOKENS.' }
);

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

let weights: Record<string, number>;
try {
  const candidate: unknown = JSON.parse(parsed.data.MODEL_COMPUTE_WEIGHTS);
  if (candidate === null || Array.isArray(candidate) || typeof candidate !== 'object') {
    throw new Error('MODEL_COMPUTE_WEIGHTS must be a JSON object.');
  }
  weights = Object.fromEntries(
    Object.entries(candidate).map(([model, value]) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`Compute weight for ${model} must be a positive number.`);
      }
      return [model, value];
    })
  );
} catch (error) {
  throw new Error(`Invalid MODEL_COMPUTE_WEIGHTS: ${error instanceof Error ? error.message : 'invalid JSON'}`);
}

export const config = {
  ...parsed.data,
  modelComputeWeights: weights,
  meshllmTrustedOwnerIds: parsed.data.MESHLLM_TRUSTED_OWNER_IDS,
  usagePlans: {
    free: {
      id: 'free',
      name: 'Free',
      description: 'The same daily shared-pool allowance for everyone.',
      privateDailyUnits: parsed.data.PRIVATE_DAILY_LIMIT_UNITS,
      communityDailyUnits: parsed.data.COMMUNITY_DAILY_LIMIT_UNITS
    },
    contributor: {
      id: 'contributor',
      name: 'Contributor',
      description: 'A larger shared-pool limit for people who reliably contribute useful compute.',
      privateDailyUnits: parsed.data.PRIVATE_DAILY_LIMIT_UNITS,
      communityDailyUnits: parsed.data.CONTRIBUTOR_COMMUNITY_DAILY_LIMIT_UNITS
    },
    sustainer: {
      id: 'sustainer',
      name: 'Sustainer',
      description: 'The largest shared-pool limit for people who reliably contribute more useful compute.',
      privateDailyUnits: parsed.data.PRIVATE_DAILY_LIMIT_UNITS,
      communityDailyUnits: parsed.data.SUSTAINER_COMMUNITY_DAILY_LIMIT_UNITS
    }
  },
  meshllmAdmissionPolicyVerified: parsed.data.MESHLLM_ADMISSION_POLICY_VERIFIED === 'true',
  meshllmManagementUrl: parsed.data.MESHLLM_MANAGEMENT_URL?.replace(/\/+$/, ''),
  privateBaseUrl: parsed.data.PRIVATE_UPSTREAM_URL?.replace(/\/+$/, ''),
  dashboardOrigin: parsed.data.DASHBOARD_ORIGIN ? new URL(parsed.data.DASHBOARD_ORIGIN).origin : undefined,
  publicBaseUrl: parsed.data.PUBLIC_BASE_URL?.replace(/\/+$/, '')
};

export type AccessMode = 'private' | 'community';
export type UsagePlanId = keyof typeof config.usagePlans;
