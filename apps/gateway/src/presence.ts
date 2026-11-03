export const PRESENCE_REGIONS = [
  'na-west', 'na-central', 'na-east', 'south-america',
  'europe-west', 'europe-central', 'europe-east', 'africa',
  'middle-east', 'south-asia', 'east-asia', 'southeast-asia', 'oceania'
] as const;

export type PresenceRegion = typeof PRESENCE_REGIONS[number];
type ActiveHost = { region: PresenceRegion; lastSeenAt: number };

const PRESENCE_TTL_MS = 3 * 60 * 1000;
const MIN_PUBLIC_CLUSTER_SIZE = 3;

export class PresenceRegistry {
  private readonly hosts = new Map<string, ActiveHost>();

  heartbeat(hostTokenId: string, region: PresenceRegion): void {
    this.prune();
    this.hosts.set(hostTokenId, { region, lastSeenAt: Date.now() });
  }

  disconnect(hostTokenId: string): void {
    this.hosts.delete(hostTokenId);
  }

  removeToken(hostTokenId: string): void {
    this.disconnect(hostTokenId);
  }

  publicClusters(): Array<{ region: PresenceRegion; countBand: '3–5' | '6–10' | '11–25' | '26+' }> {
    this.prune();
    const counts = new Map<PresenceRegion, number>();
    for (const host of this.hosts.values()) counts.set(host.region, (counts.get(host.region) ?? 0) + 1);
    return [...counts.entries()]
      .filter(([, count]) => count >= MIN_PUBLIC_CLUSTER_SIZE)
      .map(([region, count]) => ({
        region,
        countBand: count < 6 ? '3–5' : count < 11 ? '6–10' : count < 26 ? '11–25' : '26+'
      }));
  }

  private prune(): void {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [id, host] of this.hosts) {
      if (host.lastSeenAt <= cutoff) this.hosts.delete(id);
    }
  }
}
