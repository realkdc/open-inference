export {};

declare global {
  type ContributorStatus = {
    state: 'offline' | 'checking' | 'starting' | 'connected' | 'contributing' | 'paused' | 'error';
    message: string;
    model?: string;
  };

  type ContributorResourceBudget = {
    systemMemoryGb: number;
    recommendedModelMemoryGb: number;
    deviceMemoryLimited: boolean;
  };

  interface Window {
    hostApi: {
      status(): Promise<ContributorStatus>;
      resourceBudget(): Promise<ContributorResourceBudget>;
      ownerId(): Promise<string>;
      startSharing(input: {
        inviteToken: string;
        serviceUrl: string;
        modelId: string;
        splitCoordinator?: boolean;
        acknowledged: boolean;
        inviteAcknowledged: boolean;
        presence?: { optIn: boolean; serviceUrl: string; hostToken: string; region: string };
      }): Promise<ContributorStatus>;
      pause(): Promise<ContributorStatus>;
      resume(): Promise<ContributorStatus>;
      disconnect(): Promise<ContributorStatus>;
      onStatus(callback: (status: ContributorStatus) => void): () => void;
    };
  }
}
