import { UnitOfWork, createPool } from '@manuling/db';
import {
  ConsumerRunner,
  type EventConsumer,
  type EventPublisher,
  type EventSubscriber,
  InMemoryEventBus,
  KafkaEventPublisher,
  KafkaEventSubscriber,
  OutboxRelay,
} from '@manuling/events';
import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type pg from 'pg';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { loggerOptions } from './logger.js';

export const EVENT_CONSUMERS = Symbol('EVENT_CONSUMERS');

/**
 * core-worker runtime (ADR-0002, ADR-0007): the outbox relay (leader-elected, so any number
 * of worker replicas is safe) and the event consumers of every module.
 * TODO(phase0-step0.8): Temporal workers.
 */
@Injectable()
class WorkerRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private relayPool: pg.Pool | undefined;
  private relay: OutboxRelay | undefined;
  private publisher: EventPublisher | undefined;
  private subscriber: EventSubscriber | undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    @Inject(EVENT_CONSUMERS) private readonly consumers: readonly EventConsumer[],
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { bus, kafkaBrokers, relayDatabaseUrl } = this.config.events;
    if (!relayDatabaseUrl) {
      throw new Error('Invalid configuration: DATABASE_RELAY_URL is required for core-worker');
    }
    if (bus === 'kafka') {
      const options = { brokers: kafkaBrokers, clientId: 'manuling-core-worker' };
      this.publisher = new KafkaEventPublisher(options);
      this.subscriber = new KafkaEventSubscriber(options);
    } else {
      const memory = new InMemoryEventBus();
      this.publisher = memory;
      this.subscriber = memory;
      this.logger.warn(
        'EVENT_BUS=memory: events reach only consumers in this process (development only)',
      );
    }

    await new ConsumerRunner(this.uow, this.subscriber, {}, this.pinoAdapter()).start(
      this.consumers,
    );

    this.relayPool = createPool({
      connectionString: relayDatabaseUrl,
      max: 3,
      applicationName: 'manuling-outbox-relay',
    });
    this.relay = new OutboxRelay(this.relayPool, this.publisher, {}, this.pinoAdapter());
    this.relay.start();
    this.logger.log(
      `core-worker started: outbox relay on ${bus}, ${this.consumers.length} consumer(s)`,
    );
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`core-worker stopping${signal ? ` on ${signal}` : ''}`);
    await this.relay?.stop();
    await this.subscriber?.close();
    await this.publisher?.close();
    await this.relayPool?.end();
  }

  private pinoAdapter() {
    return {
      info: (obj: object, msg: string) => this.logger.log({ ...obj, msg }),
      warn: (obj: object, msg: string) => this.logger.warn({ ...obj, msg }),
      error: (obj: object, msg: string) => this.logger.error({ ...obj, msg }),
    };
  }
}

@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig, consumers: readonly EventConsumer[] = []): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(loggerOptions(config)),
        DatabaseModule,
      ],
      providers: [{ provide: EVENT_CONSUMERS, useValue: consumers }, WorkerRuntime],
    };
  }
}
