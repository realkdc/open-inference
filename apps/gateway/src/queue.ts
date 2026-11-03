export class QueueFullError extends Error {
  constructor() {
    super('The inference queue is full. Try again shortly.');
    this.name = 'QueueFullError';
  }
}

export class QueueWaitTimeoutError extends Error {
  constructor() {
    super('The request waited too long for an inference slot.');
    this.name = 'QueueWaitTimeoutError';
  }
}

type Release = () => void;
type Waiter = {
  workspaceId: string;
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

/** FIFO between workspaces; one request from a workspace is served per turn. */
export class FairQueue {
  private active = 0;
  private waiting = 0;
  private readonly workspaceOrder: string[] = [];
  private readonly waitersByWorkspace = new Map<string, Waiter[]>();

  constructor(
    private readonly concurrency: number,
    private readonly maxWaiting: number,
    private readonly waitTimeoutMs: number
  ) {}

  get stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting };
  }

  async run<T>(workspaceId: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(workspaceId, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(workspaceId: string, signal: AbortSignal): Promise<Release> {
    if (signal.aborted) return Promise.reject(new Error('Request cancelled.'));
    if (this.active < this.concurrency && this.waiting === 0) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiting >= this.maxWaiting) return Promise.reject(new QueueFullError());

    return new Promise<Release>((resolve, reject) => {
      const queue = this.waitersByWorkspace.get(workspaceId) ?? [];
      if (queue.length === 0) this.workspaceOrder.push(workspaceId);
      const waiter: Waiter = { workspaceId, resolve, reject, signal };
      waiter.abortHandler = () => this.removeWaiter(waiter, new Error('Request cancelled.'));
      waiter.timer = setTimeout(
        () => this.removeWaiter(waiter, new QueueWaitTimeoutError()),
        this.waitTimeoutMs
      );
      signal.addEventListener('abort', waiter.abortHandler, { once: true });
      queue.push(waiter);
      this.waitersByWorkspace.set(workspaceId, queue);
      this.waiting += 1;
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.active < this.concurrency && this.workspaceOrder.length > 0) {
      const workspaceId = this.workspaceOrder.shift();
      if (!workspaceId) continue;
      const queue = this.waitersByWorkspace.get(workspaceId);
      const waiter = queue?.shift();
      if (!waiter) {
        this.waitersByWorkspace.delete(workspaceId);
        continue;
      }

      if (queue && queue.length > 0) this.workspaceOrder.push(workspaceId);
      else this.waitersByWorkspace.delete(workspaceId);

      this.waiting -= 1;
      this.cleanupWaiter(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error('Request cancelled.'));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.makeRelease());
    }
  }

  private removeWaiter(waiter: Waiter, error: Error): void {
    const queue = this.waitersByWorkspace.get(waiter.workspaceId);
    if (!queue) return;
    const index = queue.indexOf(waiter);
    if (index < 0) return;
    queue.splice(index, 1);
    this.waiting -= 1;
    if (queue.length === 0) {
      this.waitersByWorkspace.delete(waiter.workspaceId);
      const orderIndex = this.workspaceOrder.indexOf(waiter.workspaceId);
      if (orderIndex >= 0) this.workspaceOrder.splice(orderIndex, 1);
    }
    this.cleanupWaiter(waiter);
    waiter.reject(error);
    this.dispatch();
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.abortHandler) waiter.signal?.removeEventListener('abort', waiter.abortHandler);
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.dispatch();
    };
  }
}
