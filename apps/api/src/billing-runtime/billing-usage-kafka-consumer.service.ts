import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CompressionCodecs,
  CompressionTypes,
  Consumer,
  Kafka,
  KafkaConfig,
  KafkaMessage,
  Producer,
  logLevel,
} from 'kafkajs';
import { isUtf8 } from 'node:buffer';
import { GatewayRequestEventBillingService } from '../billing/gateway-request-event-billing.service';
import { RedisService } from '../redis/redis.service';
import { isProductionConfig } from '../common/runtime/is-production';
import {
  attributedMs,
  createStageTimings,
  formatStageTimings,
  runWithStageTimings,
  timed,
  unattributedMs,
} from '../common/runtime/usage-stage-timings';
import { billingKafkaUsageCacheKey } from '../common/utils/redis-key.util';
import {
  billingUsageKafkaHmacVerificationsTotal,
  billingUsageKafkaMessagesTotal,
  gatewayUsageEvidenceContractTotal,
} from '../metrics/metrics.registry';
import {
  GatewayProvisionalExposureInvariantError,
} from '../billing/gateway-provisional-exposure.errors';
import {
  parseGatewayEvidenceContractMode,
} from '../billing/gateway-usage-evidence-contract-policy';
import {
  BillingUsageKafkaHmacMode,
  BillingUsageKafkaHmacOutcome,
  isBillingUsageKafkaHmacKeyId,
  verifyBillingUsageKafkaHmacV1,
} from './billing-usage-kafka-hmac';

const snappyCodec = require('kafkajs-snappy');

const IMMUTABLE_PRODUCER_BUILD_SHA = /^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;
const MAX_USAGE_HMAC_KEYS = 16;
const MIN_USAGE_HMAC_SECRET_BYTES = 32;
const MAX_USAGE_HMAC_SECRET_BYTES = 4096;

const AUTHENTICATION_HEADER_NAMES = new Set([
  'x-billing-key-id',
  'x-billing-timestamp',
  'x-billing-signature',
  'x-webhook-timestamp',
  'x-webhook-signature',
]);

type KafkaUsagePoisonReason =
  | 'empty_message_value'
  | 'invalid_json'
  | 'missing_hmac_headers'
  | 'invalid_hmac_headers'
  | 'unknown_hmac_key_id'
  | 'invalid_hmac_signature'
  | 'invalid_event_contract';

class KafkaUsagePoisonMessageError extends Error {
  constructor(
    readonly reason: KafkaUsagePoisonReason,
    message: string,
  ) {
    super(message);
    this.name = 'KafkaUsagePoisonMessageError';
  }
}

@Injectable()
export class BillingUsageKafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingUsageKafkaConsumerService.name);
  private consumer: Consumer | null = null;
  private producer: Producer | null = null;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private usageHmacMode: BillingUsageKafkaHmacMode = 'off';
  private usageHmacKeyring: ReadonlyMap<string, string> = new Map();

  constructor(
    private readonly config: ConfigService,
    private readonly gatewayRequestEventBilling: GatewayRequestEventBillingService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (isProductionConfig(this.config)) {
      if (
        this.config.get<string>('BILLING_GATEWAY_SETTLEMENT_PROTOCOL')?.trim().toLowerCase()
        !== 'v1'
      ) {
        throw new Error(
          'BILLING_GATEWAY_SETTLEMENT_PROTOCOL=v1 is required in production',
        );
      }
      const platformCurrency = this.config.get<string>(
        'BILLING_PLATFORM_CURRENCY',
      )?.trim().toLowerCase();
      if (!platformCurrency || !/^[a-z]{3}$/.test(platformCurrency)) {
        throw new Error(
          'BILLING_PLATFORM_CURRENCY must be an explicit ISO-4217 code in production',
        );
      }
      const rawPendingRequestLimit = this.config.get<string | number>(
        'BILLING_USAGE_PENDING_MAX_REQUESTS',
      );
      const pendingRequestLimit = Number(rawPendingRequestLimit);
      if (
        rawPendingRequestLimit === undefined
        || rawPendingRequestLimit === null
        || String(rawPendingRequestLimit).trim() === ''
        || !Number.isSafeInteger(pendingRequestLimit)
        || pendingRequestLimit <= 0
      ) {
        throw new Error(
          'BILLING_USAGE_PENDING_MAX_REQUESTS must be a positive integer in production',
        );
      }
      if (this.bool('BILLING_ALLOW_DEFAULT_PAYG_FALLBACK', false)) {
        throw new Error(
          'BILLING_ALLOW_DEFAULT_PAYG_FALLBACK=false is required in production',
        );
      }
      const evidenceContractMode = parseGatewayEvidenceContractMode(
        this.config.get<string>('BILLING_USAGE_EVIDENCE_CONTRACT_MODE'),
      );
      if (!evidenceContractMode) {
        gatewayUsageEvidenceContractTotal.inc({
          mode: 'shadow',
          outcome: 'preflight_drift',
          issue: 'evidence_mode_missing_or_invalid',
        });
        this.logger.warn(
          'BILLING_USAGE_EVIDENCE_CONTRACT_MODE is missing or invalid; '
          + 'continuing customer settlement with safe shadow evidence semantics',
        );
      }
      const rawVerifiedBuilds = this.config.get<string>(
        'BILLING_USAGE_VERIFIED_PRODUCER_BUILDS',
      );
      const configuredBuilds = typeof rawVerifiedBuilds === 'string'
        && rawVerifiedBuilds.trim()
        ? rawVerifiedBuilds.split(',').map((build) => build.trim().toLowerCase())
        : [];
      const buildAuthorityConfigInvalid = configuredBuilds.some(
        (build) => !build || !IMMUTABLE_PRODUCER_BUILD_SHA.test(build),
      ) || new Set(configuredBuilds).size !== configuredBuilds.length;
      const enforceAuthorityEmpty = evidenceContractMode === 'enforce'
        && configuredBuilds.length === 0;
      if (buildAuthorityConfigInvalid || enforceAuthorityEmpty) {
        gatewayUsageEvidenceContractTotal.inc({
          mode: evidenceContractMode ?? 'shadow',
          outcome: 'preflight_drift',
          issue: buildAuthorityConfigInvalid
            ? 'build_allowlist_invalid_or_duplicate'
            : 'build_allowlist_empty',
        });
        this.logger.warn(
          'BILLING_USAGE_VERIFIED_PRODUCER_BUILDS is empty, invalid, or duplicated; '
          + 'continuing customer settlement while affected builds remain internal evidence issues',
        );
      }
    }
    if (!this.enabled()) {
      if (isProductionConfig(this.config)) {
        throw new Error('BILLING_USAGE_KAFKA_ENABLED=true is required in production; HTTP usage fallback has been removed');
      }
      this.logger.log('Kafka usage consumer disabled');
      return;
    }

    // Currency compatibility is a financial ingestion invariant, not a
    // production-only tuning guard. Assert it in every Kafka-enabled
    // environment before constructing a client or opening a connection.
    await this.gatewayRequestEventBilling
      .assertReachableGatewayBillingAccountCurrencies();

    if (isProductionConfig(this.config)) {
      const rawClockSkew = this.config.get<string | number>(
        'BILLING_GATEWAY_CLOCK_MAX_SKEW_MS',
      );
      const clockSkewMs = Number(rawClockSkew);
      if (
        rawClockSkew === undefined || rawClockSkew === null ||
        String(rawClockSkew).trim() === '' ||
        !Number.isSafeInteger(clockSkewMs) || clockSkewMs <= 0
      ) {
        throw new Error(
          'BILLING_GATEWAY_CLOCK_MAX_SKEW_MS must be a measured positive integer in production',
        );
      }
      await this.gatewayRequestEventBilling.assertProductionSettlementPreflight({
        reachableCurrencyAlreadyAsserted: true,
      });
    }

    const brokers = this.list('BILLING_USAGE_KAFKA_BROKERS', 'KAFKA_BROKERS');
    if (brokers.length === 0) {
      throw new Error('BILLING_USAGE_KAFKA_ENABLED=true requires BILLING_USAGE_KAFKA_BROKERS or KAFKA_BROKERS');
    }

    const topics = this.topics();
    this.usageHmacMode = this.resolveUsageHmacMode();
    this.usageHmacKeyring = this.loadUsageHmacKeyring(this.usageHmacMode);
    if (this.usageHmacMode === 'shadow') {
      this.logger.warn(
        'Kafka usage HMAC is in explicit shadow migration mode; authentication outcomes are measured but do not block billing',
      );
    } else if (this.usageHmacMode === 'off') {
      this.logger.warn('Kafka usage HMAC verification is disabled outside production');
    }
    this.registerCompressionCodecs();
    const kafka = new Kafka(this.kafkaConfig(brokers));

    const dlqTopic = this.dlqTopic();
    if (!dlqTopic && isProductionConfig(this.config)) {
      throw new Error('BILLING_USAGE_KAFKA_DLQ_TOPIC is required in production');
    }

    this.consumer = kafka.consumer({
      groupId: this.groupId(),
    });
    if (dlqTopic) {
      this.producer = kafka.producer();
      await this.producer.connect();
    } else {
      // Production fails fast above. Non-production may start without a DLQ,
      // but failed messages remain uncommitted and are redelivered.
      this.logger.error(
        'BILLING_USAGE_KAFKA_DLQ_TOPIC 未配置：失败用量事件会保留源 offset 并重投；生产环境必须配置 DLQ',
      );
    }

    const consumer = this.consumer;

    await consumer.connect();
    for (const topic of topics) {
      await consumer.subscribe({ topic, fromBeginning: false });
    }

    await consumer.run({
      autoCommit: false,
      partitionsConsumedConcurrently: this.positiveInt(
        'BILLING_USAGE_KAFKA_CONCURRENCY',
        3,
      ),
      eachMessage: async ({ topic, partition, message }) => {
        await this.withInFlightLimit(() =>
          this.handleMessage(consumer, topic, partition, message),
        );
      },
    });

    this.logger.log(
      `Kafka usage consumer started topics=${topics.join(',')} brokers=${brokers.length} group=${this.groupId()}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.producer) {
      await this.producer.disconnect();
      this.producer = null;
    }
    if (!this.consumer) return;
    await this.consumer.disconnect();
    this.consumer = null;
  }

  private async handleMessage(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    const sourceKeyForLog = message.key?.toString('base64') || message.offset;
    const authenticationError = this.authenticateMessage(message);
    if (authenticationError) {
      // Authentication failures are deterministic for the immutable Kafka
      // record. Send them to DLQ once instead of occupying an in-flight slot
      // with the ordinary application retry loop.
      await this.deadLetterPoisonOrThrow(
        consumer,
        topic,
        partition,
        message,
        authenticationError,
      );
      return;
    }
    const attempts = this.positiveInt('BILLING_USAGE_KAFKA_MESSAGE_RETRIES', 3);
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.processMessageOnce(consumer, topic, partition, message);
        return;
      } catch (err) {
        // ⚠️ 必须位于 `lastError = err` 与 sleep **之前**，让两种 disposition 都在
        // **第一次捕获时**就退出普通三次重试。
        //
        // 不这样做会有一个很隐蔽的洞：第一次 invariant 已把父状态写成 QUARANTINED 后，
        // 第二次尝试会命中 service 的 QUARANTINED 快速返回，consumer 随后把
        // `action: 'quarantined'` 当作可提交结果 ⇒ **既不 DLQ 也照样 commit**，
        // 而设计里的重放路径根本走不通。
        //
        // ⇒ 由此保证 invariant 情形下 process() 在每个 eachMessage 内最多被调用一次。
        if (err instanceof GatewayProvisionalExposureInvariantError) {
          this.logger.error(
            `Gateway provisional exposure invariant topic=${topic} partition=${partition}`
            + ` key_b64=${sourceKeyForLog} code=${err.code}`
            + ` disposition=${err.disposition} attempt=${attempt}/${attempts}:`
            + ` ${this.errorMessage(err)}`,
            err.stack,
          );
          if (err.disposition === 'QUARANTINE_AND_DLQ') {
            await this.deadLetterInvariantOrThrow(
              consumer,
              topic,
              partition,
              message,
              err,
            );
            return;
          }
          // BLOCK_PARTITION：不 DLQ、不 commit，直接抛出 ⇒ partition 停在这条消息上。
          // 这是系统性缺陷的 fail-closed 出口，放行等于连续永久漏记。
          billingUsageKafkaMessagesTotal.labels('provisional_exposure_blocked').inc();
          throw err;
        }
        lastError = err;
        const classification = err instanceof KafkaUsagePoisonMessageError
          ? 'poison'
          : 'transient';
        const errorMessage = this.errorMessage(err);
        this.logger.error(
          `Gateway usage Kafka message failed topic=${topic} partition=${partition} key_b64=${sourceKeyForLog} classification=${classification} attempt=${attempt}/${attempts}: ${errorMessage}`,
          err instanceof Error ? err.stack : undefined,
        );
        if (attempt < attempts) {
          await this.sleep(this.positiveInt('BILLING_USAGE_KAFKA_MESSAGE_RETRY_DELAY_MS', 250));
        }
      }
    }

    if (lastError instanceof KafkaUsagePoisonMessageError) {
      await this.deadLetterPoisonOrThrow(
        consumer,
        topic,
        partition,
        message,
        lastError,
      );
      return;
    }

    // Database, Publisher projection and any unknown runtime failures are not
    // properties of the source record. Reject eachMessage without committing
    // or DLQing so Kafka can redeliver the same immutable evidence after the
    // dependency recovers.
    billingUsageKafkaMessagesTotal.labels('transient_uncommitted').inc();
    throw this.asError(lastError, 'Kafka usage message failed transiently');
  }

  /**
   * Stage-timing wrapper. Diagnostic only: it must not alter the outcome of the
   * message, so the inner call's result and thrown error pass through untouched
   * and the logging lives in `finally`.
   *
   * Emits one line per message at or above BILLING_USAGE_STAGE_TIMING_MIN_MS
   * (default 250ms). Timings reach us through logs rather than Prometheus
   * because this app's /metrics endpoint is not scraped in any environment
   * (no ServiceMonitor/PodMonitor as of 2026-08-26).
   */
  private async processMessageOnce(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    const stages = createStageTimings();
    const startedAt = process.hrtime.bigint();
    let outcome = 'ok';
    try {
      await runWithStageTimings(stages, () =>
        this.processMessageInner(consumer, topic, partition, message),
      );
    } catch (err) {
      outcome = 'error';
      throw err;
    } finally {
      try {
        const totalMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        if (totalMs >= this.stageTimingMinMs()) {
          // Stage figures are self time (span minus nested stages) and sum to
          // `attributed`. That sum is total work, not a share of `total`:
          // concurrent fan-out makes it exceed the message duration (observed
          // ~6x). When `attributed > total`, `unattributed` reads 0 because it
          // clamps, not because everything is instrumented. Read stages as
          // selfMs/count.
          this.logger.log(
            `usage stage timing partition=${partition} offset=${message.offset} outcome=${outcome} `
            + `total=${totalMs.toFixed(0)}ms attributed=${attributedMs(stages).toFixed(0)}ms `
            + `unattributed=${unattributedMs(stages, totalMs).toFixed(0)}ms | `
            + formatStageTimings(stages),
          );
        }
      } catch {
        // Never let diagnostics fail a message.
      }
    }
  }

  private stageTimingMinMs(): number {
    const raw = this.config?.get<string>('BILLING_USAGE_STAGE_TIMING_MIN_MS');
    const parsed = Number.parseInt(raw ?? '', 10);
    // 0 is a meaningful value (log every message), so only fall back when the
    // setting is absent or not a non-negative integer.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 250;
  }

  private async processMessageInner(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    const rawBody = this.messageBody(message.value);
    const event = this.parseEvent(rawBody);
    // Redis may cache a response, but it must never bypass the append-only
    // database evidence inbox. A later signed payload with the same request_id
    // still has to be appended and compared before committing the source offset.
    const result = await timed('billingProcess', () =>
      this.gatewayRequestEventBilling.process(event),
    );
    if (result.action === 'failed') {
      const reason = result.reason ?? 'unknown';
      if (reason === 'invalid_event_contract') {
        throw new KafkaUsagePoisonMessageError(
          'invalid_event_contract',
          result.errorMessage ?? `invalid_event_contract requestId=${result.requestId}`,
        );
      }
      // A failed result outside the immutable-contract bucket can represent a
      // dependency/configuration outage or an older terminal row. It is not
      // safe for the transport layer to declare that source record poison.
      throw new Error(
        result.errorMessage ??
          `Gateway usage billing did not reach a committable state requestId=${result.requestId} reason=${reason}`,
      );
    }
    if (result.action !== 'quarantined') {
      await timed('redisCacheResult', () =>
        this.cacheResult(result.requestId, result),
      );
    }
    await timed('kafkaCommit', () =>
      this.commitMessage(consumer, topic, partition, message),
    );
  }

  /**
   * provisional exposure 不变量破坏的**独立** DLQ 通道。
   *
   * ⚠️ 不复用 poison 通道：poison 的 helper 只接受 `KafkaUsagePoisonMessageError`，
   * 而且 poison 的语义是「源记录本身有问题」，与「我方写敞口时发现不变量矛盾」完全不同；
   * 混用会让两类问题在 DLQ 与指标里无法区分。
   *
   * 顺序是契约的一部分：**producer.send() 成功之后才 commit**；发送失败则抛出且不 commit，
   * 使临时的 DLQ 不可用不会变成永久的财务数据丢失。
   */
  private async deadLetterInvariantOrThrow(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
    err: GatewayProvisionalExposureInvariantError,
  ): Promise<void> {
    let sentDlq = false;
    try {
      sentDlq = await this.sendInvariantDlq(topic, partition, message, err);
    } catch (dlqErr) {
      this.logger.error(
        `Gateway provisional exposure invariant DLQ send failed topic=${topic}`
        + ` partition=${partition} offset=${message.offset}:`
        + ` ${(dlqErr as Error).message}`,
        (dlqErr as Error).stack,
      );
    }

    if (!sentDlq) {
      billingUsageKafkaMessagesTotal
        .labels('provisional_exposure_invariant_dlq_failed').inc();
      this.logger.error(
        `Gateway provisional exposure invariant retained for redelivery because DLQ is`
        + ` unavailable topic=${topic} partition=${partition} offset=${message.offset}`
        + ` code=${err.code}`,
      );
      throw new Error(
        `Gateway provisional exposure invariant DLQ unavailable; source offset retained`
        + ` topic=${topic} partition=${partition} offset=${message.offset}`,
      );
    }
    billingUsageKafkaMessagesTotal
      .labels('provisional_exposure_invariant_dlq').inc();
    await this.commitMessage(consumer, topic, partition, message);
  }

  private async sendInvariantDlq(
    topic: string,
    partition: number,
    message: KafkaMessage,
    err: GatewayProvisionalExposureInvariantError,
  ): Promise<boolean> {
    const dlqTopic = this.dlqTopic();
    if (!dlqTopic || !this.producer) return false;
    await this.producer.send({
      topic: dlqTopic,
      messages: [{
        key: message.key ?? undefined,
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
        value: JSON.stringify({
          sourceTopic: topic,
          partition,
          offset: message.offset,
          sourceKey: this.base64Value(message.key),
          sourceTimestamp: message.timestamp ?? null,
          authenticationHeaders: this.encodedAuthenticationHeaders(message),
          // 这三项是人工定位所必需的：光有 payload 无法直接找到那条父事件。
          invariantCode: err.code,
          requestId: err.context.requestId,
          gatewayBillingEventId: err.context.gatewayBillingEventId,
          errorMessage: err.message,
          payload: message.value?.toString('utf8') ?? null,
          payloadBase64: message.value?.toString('base64') ?? null,
        }),
        headers: {
          'x-billing-dlq-reason': Buffer.from(
            `provisional_exposure_invariant:${err.code}`,
            'utf8',
          ),
        },
      }],
    });
    return true;
  }

  private async deadLetterPoisonOrThrow(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
    err: KafkaUsagePoisonMessageError,
  ): Promise<void> {
    const errorMessage = err.message;
    let sentDlq = false;
    try {
      sentDlq = await this.sendDlq(topic, partition, message, err);
    } catch (dlqErr) {
      this.logger.error(
        `Kafka usage DLQ send failed topic=${topic} partition=${partition} offset=${message.offset}: ${(dlqErr as Error).message}`,
        (dlqErr as Error).stack,
      );
    }

    if (!sentDlq) {
      billingUsageKafkaMessagesTotal.labels('dlq_send_failed').inc();
      this.logger.error(
        `Kafka usage message retained for redelivery because DLQ is unavailable topic=${topic} partition=${partition} offset=${message.offset}: ${errorMessage}`,
      );
      // Fail closed. Rejecting eachMessage leaves the source offset uncommitted,
      // so a temporary DLQ outage cannot turn into permanent financial data loss.
      throw new Error(
        `Kafka usage DLQ unavailable; source offset retained topic=${topic} partition=${partition} offset=${message.offset}`,
      );
    }
    billingUsageKafkaMessagesTotal.labels('poison_dlq').inc();
    await this.commitMessage(consumer, topic, partition, message);
  }

  private async withInFlightLimit<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireSlot();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private acquireSlot(): Promise<() => void> {
    const max = this.positiveInt(
      'BILLING_USAGE_KAFKA_MAX_IN_FLIGHT',
      this.positiveInt('BILLING_USAGE_KAFKA_CONCURRENCY', 3),
    );
    if (this.inFlight < max) {
      this.inFlight += 1;
      return Promise.resolve(() => this.releaseSlot());
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.inFlight += 1;
        resolve(() => this.releaseSlot());
      });
    });
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  private enabled(): boolean {
    const value = this.first('BILLING_USAGE_KAFKA_ENABLED', 'KAFKA_ENABLED');
    return value === 'true' || value === '1';
  }

  private registerCompressionCodecs(): void {
    CompressionCodecs[CompressionTypes.Snappy] = snappyCodec;
  }

  private kafkaConfig(brokers: string[]): KafkaConfig {
    const clientId = this.first(
      'BILLING_USAGE_KAFKA_CLIENT_ID',
      'KAFKA_CLIENT_ID',
    ) ||
      'ruidong-billing';
    const securityProtocol = (
      this.first(
        'BILLING_USAGE_KAFKA_SECURITY_PROTOCOL',
        'KAFKA_SECURITY_PROTOCOL',
      ) ||
      'SASL_SSL'
    ).trim().toUpperCase();
    const username = this.first(
      'BILLING_USAGE_KAFKA_USERNAME',
      'KAFKA_USERNAME',
    );
    const password = this.first(
      'BILLING_USAGE_KAFKA_PASSWORD',
      'KAFKA_PASSWORD',
    );
    const mechanism = this.normalizeSaslMechanism(
      this.first(
        'BILLING_USAGE_KAFKA_SASL_MECHANISM',
        'KAFKA_SASL_MECHANISM',
      ) ||
        'scram-sha-512',
    );
    const useSasl = securityProtocol.startsWith('SASL') || Boolean(username || password);
    const ssl = securityProtocol.endsWith('SSL') ||
      this.bool(['BILLING_USAGE_KAFKA_SSL', 'KAFKA_SSL'], false);

    // 阿里云 ApsaraMQ for Kafka 的 broker 证书 CN 固定为 "AliKafka",不带 broker FQDN
    // 的 SAN,标准 TLS 主机名校验必然失败(ERR_TLS_CERT_ALTNAME_INVALID)。
    // 该开关默认 false:其它环境(AWS MSK 等证书 SAN 规范)行为完全不变,ssl 仍为 true。
    // 仅在阿里云环境的 configmap 显式置 true 时跳过"主机名"校验;CA 链仍校验
    // (经 NODE_EXTRA_CA_CERTS 信任 AliKafka 根),不降级为不验证证书。
    const sslSkipHostnameCheck =
      ssl && this.bool(['BILLING_USAGE_KAFKA_SSL_SKIP_HOSTNAME_CHECK'], false);
    const sslConfig: KafkaConfig['ssl'] = sslSkipHostnameCheck
      ? { checkServerIdentity: () => undefined }
      : ssl;

    if (useSasl && (!username || !password)) {
      throw new Error(
        'SASL Kafka usage consumer requires BILLING_USAGE_KAFKA_USERNAME and BILLING_USAGE_KAFKA_PASSWORD',
      );
    }

    return {
      clientId,
      brokers,
      ssl: sslConfig,
      logLevel: logLevel.INFO,
      connectionTimeout: this.positiveInt('BILLING_USAGE_KAFKA_CONNECTION_TIMEOUT_MS', 10_000),
      requestTimeout: this.positiveInt('BILLING_USAGE_KAFKA_REQUEST_TIMEOUT_MS', 30_000),
      retry: {
        retries: this.positiveInt('BILLING_USAGE_KAFKA_RETRIES', 3),
      },
      ...(useSasl
        ? {
            sasl: {
              mechanism,
              username: username!,
              password: password!,
            } as KafkaConfig['sasl'],
          }
        : {}),
    };
  }

  private topics(): string[] {
    const raw =
      this.config.get<string>('BILLING_USAGE_KAFKA_TOPICS') ||
      this.config.get<string>('BILLING_USAGE_KAFKA_TOPIC') ||
      this.config.get<string>('KAFKA_TOPICS') ||
      this.config.get<string>('KAFKA_TOPIC') ||
      'gateway.usage_events';
    const topics = raw.split(',').map((item) => item.trim()).filter(Boolean);
    const requestEventTopics = topics.filter((topic) => {
      const normalized = topic.toLowerCase();
      return normalized === 'request_event' ||
        normalized === 'request_events' ||
        normalized.endsWith('.request_event') ||
        normalized.endsWith('.request_events');
    });
    if (requestEventTopics.length > 0) {
      throw new Error(
        `Billing usage Kafka consumer must subscribe to UsageEvent v2 topics such as gateway.usage_events; RequestEvent topics are audit-only: ${requestEventTopics.join(',')}`,
      );
    }
    return topics;
  }

  private groupId(): string {
    return this.first(
      'BILLING_USAGE_KAFKA_GROUP_ID',
      'KAFKA_GROUP_ID',
    ) ||
      'billing-ledger-v1';
  }

  private list(...keys: string[]): string[] {
    return (this.first(...keys) || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private first(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.config.get<string>(key);
      if (value && value.trim()) return value.trim();
    }
    return undefined;
  }

  private positiveInt(key: string, fallback: number): number {
    const parsed = parseInt(this.config.get<string>(key) || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private bool(key: string | string[], fallback: boolean): boolean {
    const raw = Array.isArray(key) ? this.first(...key) : this.config.get<string>(key);
    if (raw == null || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private messageBody(value: Buffer | null): string {
    if (!value || value.length === 0) {
      throw new KafkaUsagePoisonMessageError(
        'empty_message_value',
        'Kafka message value is empty',
      );
    }
    if (!isUtf8(value)) {
      throw new KafkaUsagePoisonMessageError(
        'invalid_json',
        'Kafka usage message is not valid UTF-8 JSON',
      );
    }
    return value.toString('utf8');
  }

  private parseEvent(body: string): unknown {
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch {
      throw new KafkaUsagePoisonMessageError(
        'invalid_json',
        'Kafka usage message contains invalid JSON',
      );
    }
    if (isRecord(payload)) {
      if (isRecord(payload.usage_event)) return payload.usage_event;
      if (isRecord(payload.UsageEvent)) return payload.UsageEvent;
      if (isRecord(payload.request_event)) return payload.request_event;
      if (isRecord(payload.RequestEvent)) return payload.RequestEvent;
      if (isRecord(payload.event)) return payload.event;
    }
    return payload;
  }

  private authenticateMessage(message: KafkaMessage): KafkaUsagePoisonMessageError | null {
    if (this.usageHmacMode === 'off') {
      billingUsageKafkaHmacVerificationsTotal.labels('off', 'skipped').inc();
      return null;
    }

    const verification = verifyBillingUsageKafkaHmacV1(
      message.headers,
      message.value ?? Buffer.alloc(0),
      this.usageHmacKeyring,
    );
    billingUsageKafkaHmacVerificationsTotal
      .labels(this.usageHmacMode, verification.outcome)
      .inc();
    if (verification.valid || this.usageHmacMode === 'shadow') return null;

    const reason = this.hmacPoisonReason(verification.outcome);
    return new KafkaUsagePoisonMessageError(
      reason,
      `Kafka usage HMAC authentication failed outcome=${verification.outcome}`,
    );
  }

  private hmacPoisonReason(
    outcome: Exclude<BillingUsageKafkaHmacOutcome, 'valid'>,
  ): KafkaUsagePoisonReason {
    if (outcome === 'missing_headers') return 'missing_hmac_headers';
    if (outcome === 'unknown_key_id') return 'unknown_hmac_key_id';
    if (outcome === 'invalid_signature') return 'invalid_hmac_signature';
    return 'invalid_hmac_headers';
  }

  private resolveUsageHmacMode(): BillingUsageKafkaHmacMode {
    const configured = this.config
      .get<string>('BILLING_USAGE_KAFKA_HMAC_MODE')
      ?.trim()
      .toLowerCase();
    let mode: BillingUsageKafkaHmacMode;
    if (configured) {
      if (configured !== 'off' && configured !== 'shadow' && configured !== 'required') {
        throw new Error(
          'BILLING_USAGE_KAFKA_HMAC_MODE must be one of off, shadow, required',
        );
      }
      mode = configured;
    } else if (isProductionConfig(this.config)) {
      throw new Error(
        'BILLING_USAGE_KAFKA_HMAC_MODE must be explicitly set to shadow or required in production',
      );
    } else {
      // Preserve the old non-production opt-in while keeping the new mode
      // independent from the provider-evidence rollout mode.
      mode = this.bool('BILLING_USAGE_KAFKA_REQUIRE_HMAC', false)
        ? 'required'
        : 'off';
    }
    if (isProductionConfig(this.config) && mode === 'off') {
      throw new Error(
        'BILLING_USAGE_KAFKA_HMAC_MODE=off is forbidden in production; use explicit shadow only for a measured migration',
      );
    }
    return mode;
  }

  private loadUsageHmacKeyring(
    mode: BillingUsageKafkaHmacMode,
  ): ReadonlyMap<string, string> {
    const keyring = new Map<string, string>();
    const addKey = (keyIdValue: string, secretValue: string, source: string): void => {
      const keyId = keyIdValue;
      const secret = secretValue;
      if (!isBillingUsageKafkaHmacKeyId(keyId)) {
        throw new Error(`${source} contains an invalid HMAC key id`);
      }
      if (secret !== secret.trim()) {
        throw new Error(`${source} HMAC secret must not contain surrounding whitespace`);
      }
      const secretBytes = Buffer.byteLength(secret, 'utf8');
      if (
        secretBytes < MIN_USAGE_HMAC_SECRET_BYTES
        || secretBytes > MAX_USAGE_HMAC_SECRET_BYTES
      ) {
        throw new Error(
          `${source} HMAC secret must be ${MIN_USAGE_HMAC_SECRET_BYTES}-${MAX_USAGE_HMAC_SECRET_BYTES} UTF-8 bytes`,
        );
      }
      if (keyring.has(keyId)) {
        throw new Error(`${source} contains a duplicate HMAC key id`);
      }
      if (keyring.size >= MAX_USAGE_HMAC_KEYS) {
        throw new Error(
          `Kafka usage HMAC keyring exceeds the ${MAX_USAGE_HMAC_KEYS}-key limit`,
        );
      }
      keyring.set(keyId, secret);
    };

    const rawKeyring = this.config
      .get<string>('BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON')
      ?.trim();
    if (rawKeyring) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawKeyring) as unknown;
      } catch {
        throw new Error('BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON must be valid JSON');
      }
      if (!isRecord(parsed)) {
        throw new Error('BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON must be a JSON object');
      }
      for (const [keyId, secret] of Object.entries(parsed)) {
        if (typeof secret !== 'string') {
          throw new Error(
            'BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON values must be string secrets',
          );
        }
        addKey(keyId, secret, 'BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON');
      }
    }

    const singleKeyId = this.config.get<string>('BILLING_USAGE_KAFKA_HMAC_KEY_ID');
    const singleSecret = this.config.get<string>('BILLING_USAGE_KAFKA_HMAC_SECRET');
    if (singleKeyId && singleSecret) {
      addKey(singleKeyId, singleSecret, 'BILLING_USAGE_KAFKA_HMAC_KEY_ID');
    } else if (singleKeyId) {
      throw new Error(
        'BILLING_USAGE_KAFKA_HMAC_SECRET is required with BILLING_USAGE_KAFKA_HMAC_KEY_ID',
      );
    } else if (singleSecret && mode !== 'off') {
      throw new Error(
        'BILLING_USAGE_KAFKA_HMAC_KEY_ID is required with BILLING_USAGE_KAFKA_HMAC_SECRET',
      );
    }

    if (mode !== 'off' && keyring.size === 0) {
      throw new Error(
        `BILLING_USAGE_KAFKA_HMAC_MODE=${mode} needs a keyed secret via BILLING_USAGE_KAFKA_HMAC_KEY_ID/BILLING_USAGE_KAFKA_HMAC_SECRET or BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON`,
      );
    }
    return keyring;
  }

  private dlqTopic(): string | undefined {
    const value = this.config.get<string>('BILLING_USAGE_KAFKA_DLQ_TOPIC');
    return value?.trim() || undefined;
  }

  private async cacheResult(
    requestId: string,
    result: unknown,
  ): Promise<void> {
    try {
      await this.redis.set(
        this.cacheKey(requestId),
        JSON.stringify(result),
        'EX',
        this.positiveInt('BILLING_USAGE_KAFKA_IDEMPOTENCY_TTL_SECONDS', 86_400),
      );
    } catch (err) {
      this.logger.warn(
        `Kafka usage idempotency cache write failed requestId=${requestId}: ${(err as Error).message}`,
      );
    }
  }

  private cacheKey(requestId: string): string {
    return billingKafkaUsageCacheKey(requestId);
  }

  private async sendDlq(
    topic: string,
    partition: number,
    message: KafkaMessage,
    err: KafkaUsagePoisonMessageError,
  ): Promise<boolean> {
    const dlqTopic = this.dlqTopic();
    if (!dlqTopic || !this.producer) return false;
    const errorMessage = err.message;
    const authenticationHeaders = this.encodedAuthenticationHeaders(message);
    await this.producer.send({
      topic: dlqTopic,
      messages: [{
        key: message.key ?? undefined,
        ...(message.timestamp ? { timestamp: message.timestamp } : {}),
        value: JSON.stringify({
          sourceTopic: topic,
          partition,
          offset: message.offset,
          sourceKey: this.base64Value(message.key),
          sourceTimestamp: message.timestamp ?? null,
          authenticationHeaders,
          poisonReason: err.reason,
          errorMessage,
          payload: message.value?.toString('utf8') ?? null,
          payloadBase64: message.value?.toString('base64') ?? null,
        }),
        headers: {
          'x-billing-dlq-reason': Buffer.from(err.reason, 'utf8'),
        },
      }],
    });
    return true;
  }

  private encodedAuthenticationHeaders(message: KafkaMessage): Array<{
    name: string;
    values: Array<{ encoding: 'base64'; value: string }>;
  }> {
    return Object.entries(message.headers ?? {})
      .filter(([name]) => AUTHENTICATION_HEADER_NAMES.has(name.toLowerCase()))
      .map(([name, raw]) => ({
        name,
        values: (Array.isArray(raw) ? raw : [raw])
          .map((value) => this.base64Value(value))
          .filter((value): value is { encoding: 'base64'; value: string } => value !== null),
      }))
      .filter((header) => header.values.length > 0);
  }

  private base64Value(value: unknown): { encoding: 'base64'; value: string } | null {
    if (Buffer.isBuffer(value)) {
      return { encoding: 'base64', value: value.toString('base64') };
    }
    if (typeof value === 'string') {
      return { encoding: 'base64', value: Buffer.from(value, 'utf8').toString('base64') };
    }
    return null;
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private asError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(err == null ? fallback : String(err));
  }

  private async commitMessage(
    consumer: Consumer,
    topic: string,
    partition: number,
    message: KafkaMessage,
  ): Promise<void> {
    const nextOffset = (BigInt(message.offset) + 1n).toString();
    await consumer.commitOffsets([{ topic, partition, offset: nextOffset }]);
    billingUsageKafkaMessagesTotal.labels('committed').inc();
  }

  private normalizeSaslMechanism(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'scram-sha-512' || normalized === 'scram_sha_512') {
      return 'scram-sha-512';
    }
    if (normalized === 'scram-sha-256' || normalized === 'scram_sha_256') {
      return 'scram-sha-256';
    }
    if (normalized === 'plain') return 'plain';
    throw new Error(`Unsupported BILLING_USAGE_KAFKA_SASL_MECHANISM: ${value}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
