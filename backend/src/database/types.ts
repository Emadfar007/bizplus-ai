import type { CommerceOrder, Incident, IncidentList, LiveRun, Run } from '@bizplus/shared';

export type Awaitable<T> = T | Promise<T>;
export type PaymentRow = { order_id: string; transaction_id: string; amount_minor: number };
export type SandboxOrder = { orderId: string; transactionId: string; amountMinor: number; confirmed: boolean; workerState: string };
export type MetricsAggregate = { totalRuns: number; passedRuns: number; failedRuns: number; averageDurationMs: number; openIncidents: number; verifiedRecoveries: number; averageRecoveryMs: number };
export type StoredLog = { id: string; timestamp: string; message: string };

export interface DataStore {
  readonly driver: 'sqlite' | 'postgres';
  initialize(): Awaitable<void>;
  saveRun(session: string, run: Run): Awaitable<void>;
  getRun(id: string, session?: string): Awaitable<Run | null>;
  sessionForRun(id: string): Awaitable<string | null>;
  listRuns(session: string): Awaitable<Run[]>;
  metricsAggregates(session: string): Awaitable<MetricsAggregate>;
  unfinishedRuns(): Awaitable<{ session: string; run: Run }[]>;
  saveIncident(session: string, incident: Incident): Awaitable<void>;
  getIncident(id: string, session: string): Awaitable<Incident | null>;
  listIncidents(session: string): Awaitable<IncidentList>;
  recoverInterruptedIncidents(): Awaitable<void>;
  log(runId: string, message: string): Awaitable<void>;
  logs(runId: string): Awaitable<StoredLog[]>;
  checkout(runId: string, paused: boolean): Awaitable<PaymentRow>;
  order(orderId: string, runId: string): Awaitable<SandboxOrder | null>;
  resumeWorker(orderId: string, runId: string): Awaitable<void>;
  paymentCount(runId: string): Awaitable<number>;
  prune(before: string): Awaitable<void>;
  saveCommerceOrder(session: string, order: CommerceOrder): Awaitable<void>;
  getCommerceOrder(id: string, session: string): Awaitable<CommerceOrder | null>;
  getCommerceOrderByCheckoutKey(session: string, key: string): Awaitable<CommerceOrder | null>;
  getCommerceOrderByProviderId(id: string): Awaitable<{ session: string; order: CommerceOrder } | null>;
  listCommerceOrders(session: string): Awaitable<CommerceOrder[]>;
  saveLiveRun(session: string, run: LiveRun): Awaitable<void>;
  getLiveRun(id: string, session: string): Awaitable<LiveRun | null>;
  listLiveRuns(session: string): Awaitable<LiveRun[]>;
  close(): Awaitable<void>;
}
