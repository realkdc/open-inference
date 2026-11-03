import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('hostApi', {
  status: () => ipcRenderer.invoke('host:status'),
  resourceBudget: () => ipcRenderer.invoke('host:resource-budget'),
  ownerId: () => ipcRenderer.invoke('host:owner-id'),
  startSharing: (input: {
    inviteToken: string;
    serviceUrl: string;
    modelId: string;
    poolRole: 'coordinator' | 'worker';
    acknowledged: boolean;
    inviteAcknowledged: boolean;
    presence?: { optIn: boolean; serviceUrl: string; hostToken: string; region: string };
  }) => ipcRenderer.invoke('host:start-sharing', input),
  pause: () => ipcRenderer.invoke('host:pause'),
  resume: () => ipcRenderer.invoke('host:resume'),
  disconnect: () => ipcRenderer.invoke('host:disconnect'),
  onStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on('host:status', listener);
    return () => ipcRenderer.removeListener('host:status', listener);
  }
});
