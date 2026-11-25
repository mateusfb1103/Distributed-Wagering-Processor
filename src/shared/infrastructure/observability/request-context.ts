import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContextStore {
  correlationId?: string;
  messageId?: string;
  walletId?: string;
  transactionId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

export const requestContext = {
  run<T>(initial: RequestContextStore, fn: () => T): T {
    return storage.run({ ...initial }, fn);
  },

  get(): RequestContextStore {
    return storage.getStore() ?? {};
  },

  set(partial: Partial<RequestContextStore>): void {
    const current = storage.getStore();
    if (!current) {
      return;
    }
    Object.assign(current, partial);
  },
};
