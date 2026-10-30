// Pub/Sub & Key Watching types (docs/SPEC.md §24)

export interface PubSubMessage<T = unknown> {
  channel: string;
  payload: T;
  timestamp: number;
  id: string;
}

export interface Subscription {
  readonly channel: string;
  unsubscribe(): Promise<void>;
}

export interface PubSubOptions {
  /**
   * Internal table name used for cross-process durable event broadcasting.
   * Default: "_kvdb_pubsub_events".
   */
  tableName?: string;

  /**
   * Polling interval in milliseconds for cross-instance event detection.
   * Default: 50ms.
   */
  pollIntervalMs?: number;
}

export type MessageHandler<T = unknown> = (payload: T, message: PubSubMessage<T>) => void | Promise<void>;

export interface TableWatchEvent<Value = unknown> {
  key: string;
  value?: Value;
  type: "set" | "delete";
  timestamp: number;
}
