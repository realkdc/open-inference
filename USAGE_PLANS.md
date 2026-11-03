# Free plans and shared-compute limits

Open Inference has **plans with usage limits**, not credits, balances, coins, or payouts. There is no payment system in this beta.

## How the limit works

Each workspace gets a daily allowance for each route. A request uses roughly:

```text
usage units ≈ input tokens + output tokens, multiplied by the model's weight
```

With a 1× model, one unit is about one token. A model configured at 3× uses about three units per token. The gateway uses token counts reported by the model when available and a text-size estimate otherwise. The allowance resets at 00:00 UTC.

This is similar to a token quota, but it is **not a dollar price**. Open models have different compute costs depending on model size, quantization, context length, hardware, and worker speed. We can tune model weights after measuring real workloads. Frontier API prices can be a reference point, but copying their dollar rate would not tell us what this donated hardware can actually support.

## Beta plans

These are starting limits, configurable by the service operator:

| Plan | Community allowance | Who it is for |
| --- | ---: | --- |
| Free | 5,000 units/day | Everyone starts here |
| Contributor | 15,000 units/day | People verified to provide useful, reliable compute |
| Sustainer | 50,000 units/day | People verified to provide more useful, reliable compute |

The example values are provisional, not performance promises. Set them to match the pool's actual capacity. The private route has the same separately configured daily limit on every plan; contributing to community compute does not increase private capacity.

## How contributors get a higher limit

During the invite-only beta, an admin can assign a plan from the dashboard. The system does not yet verify how much useful work each computer completes, so it cannot safely automate contribution rewards. Being online by itself is not enough: we need to measure assigned model work, completed stages, and reliability first.

## Operator settings

The defaults are in `.env.example`:

- `COMMUNITY_DAILY_LIMIT_UNITS` sets the Free community allowance.
- `CONTRIBUTOR_COMMUNITY_DAILY_LIMIT_UNITS` sets the Contributor allowance.
- `SUSTAINER_COMMUNITY_DAILY_LIMIT_UNITS` sets the Sustainer allowance.
- `PRIVATE_DAILY_LIMIT_UNITS` sets the same private allowance for all plans.
- `MODEL_COMPUTE_WEIGHTS` sets per-model multipliers, for example `{"small-model":1,"large-model":3}`.

These numbers should be revisited when the pool's real throughput, model mix, and demand are known.
