// Cross-instance Pub/Sub & Key Watching implementation (docs/SPEC.md §24)
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { KVDB } from "../core/kvdb.js";
import type { Table } from "../core/table.js";
import type {
  PubSubMessage,
  PubSubOptions,
  Subscription,
  MessageHandler,
} from "./types.js";

const DEFAULT_PUBSUB_TABLE = "_kvdb_pubsub_events";
const DEFAULT_POLL_INTERVAL_MS = 50;
const MESSAGE_TTL_MS = 60_000; // 60 seconds event retention

export class PubSubManager {
  private readonly db: KVDB;
  private readonly eventTable: Table<PubSubMessage>;
  private readonly localBus = new EventEmitter();
  private readonly channelSubscribers = new Map<string, Set<MessageHandler<any>>>();
  private readonly instanceId = randomUUID();
  private pollTimer?: NodeJS.Timeout;
  private lastProcessedTimestamp = Date.now();
  private readonly pollIntervalMs: number;
  private isClosed = false;

  constructor(db: KVDB, options: PubSubOptions = {}) {
    this.db = db;
    this.eventTable = db.table<PubSubMessage>(
      options.tableName ?? DEFAULT_PUBSUB_TABLE,
      { autoBatch: false, internal: true },
    );
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.localBus.setMaxListeners(100);
  }

  /**
   * Publish a message to a channel.
   * Immediately delivers to in-process subscribers, and broadcasts to cross-instance subscribers.
   */
  async publish<T = unknown>(channel: string, payload: T): Promise<number> {
    if (this.isClosed) return 0;
    const now = Date.now();
    const id = `${now}_${randomUUID().slice(0, 8)}`;

    const message: PubSubMessage<T> & { _sender?: string } = {
      channel,
      payload,
      timestamp: now,
      id,
      _sender: this.instanceId,
    };

    // 1. Instant in-process delivery
    this.localBus.emit(`channel:${channel}`, payload, message);

    // 2. Persist to shared event stream with TTL for cross-instance delivery
    await this.eventTable
      .set(id, message as any, { ttlMs: MESSAGE_TTL_MS })
      .catch(() => {});

    const localCount = this.channelSubscribers.get(channel)?.size ?? 0;
    return localCount;
  }

  /**
   * Subscribe to messages on a given channel.
   */
  async subscribe<T = unknown>(
    channel: string,
    handler: MessageHandler<T>,
  ): Promise<Subscription> {
    if (this.isClosed) {
      throw new Error("PubSubManager has been closed");
    }

    let subs = this.channelSubscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.channelSubscribers.set(channel, subs);
    }
    subs.add(handler);

    const busListener = (payload: T, msg: PubSubMessage<T>) => {
      try {
        void handler(payload, msg);
      } catch {}
    };

    this.localBus.on(`channel:${channel}`, busListener);

    // Ensure cross-instance polling loop is active
    this.ensurePolling();

    const unsubscribe = async (): Promise<void> => {
      this.localBus.off(`channel:${channel}`, busListener);
      const set = this.channelSubscribers.get(channel);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.channelSubscribers.delete(channel);
        }
      }
      if (this.channelSubscribers.size === 0) {
        this.stopPolling();
      }
    };

    return {
      channel,
      unsubscribe,
    };
  }

  /**
   * Close the PubSub manager and stop polling timers.
   */
  async close(): Promise<void> {
    this.isClosed = true;
    this.stopPolling();
    this.localBus.removeAllListeners();
    this.channelSubscribers.clear();
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.isClosed) return;
    this.pollTimer = setInterval(() => {
      this.pollEvents().catch(() => {});
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private async pollEvents(): Promise<void> {
    if (this.isClosed || this.channelSubscribers.size === 0) return;

    try {
      const records = await this.eventTable.find({
        where: {
          timestamp: { $gt: this.lastProcessedTimestamp },
        },
        limit: 100,
        sort: [{ path: "timestamp", direction: "asc" }],
      });

      if (!records || records.length === 0) return;

      for (const rec of records) {
        const msg = rec.value as (PubSubMessage<any> & { _sender?: string }) | undefined;
        if (!msg) continue;
        if (msg.timestamp > this.lastProcessedTimestamp) {
          this.lastProcessedTimestamp = msg.timestamp;
          if (msg._sender === this.instanceId) {
            continue; // Skip messages published by this instance
          }
          const handlers = this.channelSubscribers.get(msg.channel);
          if (handlers && handlers.size > 0) {
            for (const h of handlers) {
              try {
                void h(msg.payload, msg);
              } catch {}
            }
          }
        }
      }
    } catch {
      // Best-effort polling
    }
  }
}
