import type { FastifyReply } from 'fastify';
import type { CanvasEvent } from '../../core/src/schema.js';

type EventInput = Omit<CanvasEvent, 'instanceId' | 'sequence'>;

type Subscriber = {
  reply: FastifyReply;
  heartbeat: NodeJS.Timeout;
};

export class CanvasEvents {
  private readonly subscribers = new Set<Subscriber>();
  private sequence = 0;

  constructor(private readonly instanceId: string) {}

  subscribe(reply: FastifyReply): void {
    reply.hijack();
    reply.raw.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const subscriber: Subscriber = {
      reply,
      heartbeat: setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n');
      }, 15_000),
    };
    this.subscribers.add(subscriber);
    reply.raw.once('close', () => this.remove(subscriber));
  }

  publish(input: EventInput): CanvasEvent {
    const event: CanvasEvent = { ...input, instanceId: this.instanceId, sequence: ++this.sequence };
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const subscriber of this.subscribers) {
      if (subscriber.reply.raw.destroyed || !subscriber.reply.raw.write(frame)) this.remove(subscriber);
    }
    return event;
  }

  close(): void {
    for (const subscriber of this.subscribers) {
      subscriber.reply.raw.end();
      this.remove(subscriber);
    }
  }

  private remove(subscriber: Subscriber): void {
    clearInterval(subscriber.heartbeat);
    this.subscribers.delete(subscriber);
  }
}
