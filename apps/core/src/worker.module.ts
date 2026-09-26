import { fileURLToPath } from 'node:url';
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
  APPROVAL_TASK_QUEUE,
  ApprovalActivities,
  ApprovalOrchestrator,
  PlatformModule,
  approvalActivityFunctions,
  approvalWorkflowsPath,
} from '@manuling/platform/module';
import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { LoggerModule } from 'nestjs-pino';
import type pg from 'pg';
import { APP_CONFIG, type AppConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { loggerOptions } from './logger.js';

export const EVENT_CONSUMERS = Symbol('EVENT_CONSUMERS');

/**
 * core-worker runtime (ADR-0002, ADR-0007, ADR-0010):
 * - outbox relay (leader-elected, so any number of worker replicas is safe);
 * - event consumers of every module, incl. the approval orchestrator (outbox → Temporal);
 * - the Temporal worker executing approval workflows and their activities.
 */
@Injectable()
class WorkerRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private relayPool: pg.Pool | undefined;
  private relay: OutboxRelay | undefined;
  private publisher: EventPublisher | undefined;
  private subscriber: EventSubscriber | undefined;
  private temporalWorker: Worker | undefined;
  private temporalRun: Promise<void> | undefined;
  private readonly temporalConnections: { close(): Promise<void> }[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    private readonly approvalActivities: ApprovalActivities,
    @Inject(EVENT_CONSUMERS) private readonly consumers: readonly EventConsumer[],
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const { bus, kafkaBrokers, relayDatabaseUrl } = this.config.events;
    if (!relayDatabaseUrl) {
      throw new Error('Invalid configuration: DATABASE_RELAY_URL is required for core-worker');
    }

    // Temporal: a client for the orchestrator consumer and a worker for workflows/activities.
    const { address, namespace } = this.config.temporal;
    const clientConnection = await Connection.connect({ address });
    const client = new Client({ connection: clientConnection, namespace });
    const workerConnection = await NativeConnection.connect({ address });
    this.temporalConnections.push(clientConnection, workerConnection);
    this.temporalWorker = await Worker.create({
      connection: workerConnection,
      namespace,
      taskQueue: APPROVAL_TASK_QUEUE,
      workflowsPath: fileURLToPath(approvalWorkflowsPath),
      activities: approvalActivityFunctions(this.approvalActivities),
    });
    this.temporalRun = this.temporalWorker.run();

    if (bus === 'kafka') {
      const options = {
        brokers: kafkaBrokers,
        clientId: 'manuling-core-worker',
        autoCreateTopics: this.config.events.kafkaAutoCreateTopics,
        topicPartitions: this.config.events.kafkaTopicPartitions,
        replicationFactor: this.config.events.kafkaReplicationFactor,
      };
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

    const consumers = [new ApprovalOrchestrator(client), ...this.consumers];
    await new ConsumerRunner(this.uow, this.subscriber, {}, this.pinoAdapter()).start(consumers);

    this.relayPool = createPool({
      connectionString: relayDatabaseUrl,
      max: 3,
      applicationName: 'manuling-outbox-relay',
    });
    this.relay = new OutboxRelay(this.relayPool, this.publisher, {}, this.pinoAdapter());
    this.relay.start();
    this.logger.log(
      `core-worker started: relay on ${bus}, ${consumers.length} consumer(s), Temporal ${address}/${namespace}`,
    );
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`core-worker stopping${signal ? ` on ${signal}` : ''}`);
    await this.relay?.stop();
    await this.subscriber?.close();
    await this.publisher?.close();
    this.temporalWorker?.shutdown();
    await this.temporalRun?.catch(() => undefined);
    await Promise.all(this.temporalConnections.map((c) => c.close()));
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
        PlatformModule.forRoot({
          oidc: { issuer: config.auth.issuer, audience: config.auth.audience },
          tenantBaseDomain: config.auth.tenantBaseDomain,
          supportedLocales: config.i18n.supportedLocales,
        }),
      ],
      providers: [{ provide: EVENT_CONSUMERS, useValue: consumers }, WorkerRuntime],
    };
  }
}
