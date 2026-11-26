import { RequestMethod } from '@nestjs/common';
import {
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  buildPartnerApiEndpoints,
  PARTNER_API_BASE_PATH,
  PARTNER_API_ENDPOINT_KEYS,
} from '../common/openapi/partner-api-endpoints';
import {
  assertPartnerSuccessResponse,
  assertPartnerOpenApiDocument,
  buildPartnerOpenApiDocument,
  PARTNER_API_OPERATION_COUNT,
  PARTNER_API_OPERATIONS,
  partnerCreateOrderSchema,
  partnerDailySummaryQuerySchema,
  partnerMonthlySummaryQuerySchema,
  partnerPaymentMethodsQuerySchema,
  partnerProvisionRequestSchema,
  partnerUserScopeSchema,
} from './partner-api.contract';
import { PartnerApiController } from './partner-api.controller';
import { PARTNER_OPERATION_METADATA } from './partner-api-route.decorator';

describe('Partner OpenAPI contract', () => {
  it('publishes 22 complete, uniquely identified Partner operations', () => {
    const document = buildPartnerOpenApiDocument();

    expect(() => assertPartnerOpenApiDocument(document)).not.toThrow();

    const operations = Object.values(document.paths).flatMap((pathItem) =>
      ['get', 'post']
        .map((method) => pathItem?.[method as 'get' | 'post'])
        .filter(Boolean),
    );
    expect(operations).toHaveLength(PARTNER_API_OPERATION_COUNT);
    expect(new Set(operations.map((operation) => operation!.operationId)).size)
      .toBe(PARTNER_API_OPERATION_COUNT);
    expect(Object.keys(document.components?.schemas ?? {}).length).toBeGreaterThan(25);
  });

  it('keeps every controller route sourced from the operation registry', () => {
    const controllerMethods = Object.getOwnPropertyNames(PartnerApiController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => ({
        name,
        handler: PartnerApiController.prototype[
          name as keyof PartnerApiController
        ] as unknown,
      }))
      .filter((entry): entry is { name: string; handler: Function } =>
        typeof entry.handler === 'function'
        && Reflect.hasMetadata(PARTNER_OPERATION_METADATA, entry.handler),
      );

    expect(controllerMethods).toHaveLength(PARTNER_API_OPERATION_COUNT);
    const implementedOperationKeys = new Set<string>();
    for (const { handler } of controllerMethods) {
      const operationKey = Reflect.getMetadata(
        PARTNER_OPERATION_METADATA,
        handler,
      ) as keyof typeof PARTNER_API_OPERATIONS;
      const operation = PARTNER_API_OPERATIONS[operationKey];
      implementedOperationKeys.add(operationKey);

      const expectedRelativePath = operation.path
        .slice(PARTNER_API_BASE_PATH.length)
        .replace(/^\//, '')
        .replace(/\{([^}]+)\}/g, ':$1');
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(expectedRelativePath);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        operation.method === 'get' ? RequestMethod.GET : RequestMethod.POST,
      );
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(operation.success.status);
    }
    expect(implementedOperationKeys).toEqual(
      new Set(Object.keys(PARTNER_API_OPERATIONS)),
    );
  });

  it('publishes a closed endpoint map that exactly covers the 22 operations', () => {
    const publicBaseUrl = 'https://partner.example.com';
    const endpoints = buildPartnerApiEndpoints(publicBaseUrl);
    const operationUrls = Object.values(PARTNER_API_OPERATIONS)
      .map((operation) => `${publicBaseUrl}${operation.path}`);

    expect(Object.keys(endpoints)).toEqual([...PARTNER_API_ENDPOINT_KEYS]);
    expect(PARTNER_API_ENDPOINT_KEYS).toHaveLength(
      PARTNER_API_OPERATION_COUNT + 1,
    );
    expect(new Set(Object.values(endpoints))).toEqual(new Set([
      `${publicBaseUrl}${PARTNER_API_BASE_PATH}`,
      ...operationUrls,
    ]));

    const document = buildPartnerOpenApiDocument();
    const endpointSchema = document.components?.schemas?.PartnerApiEndpoints as unknown as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(endpointSchema.properties)).toEqual([
      ...PARTNER_API_ENDPOINT_KEYS,
    ]);
    expect(endpointSchema.required).toEqual([
      ...PARTNER_API_ENDPOINT_KEYS,
    ]);
    expect(endpointSchema.additionalProperties).toBe(false);
  });

  it('rejects undeclared current-product endpoints and billing modes', () => {
    const validResponse = {
      code: 0,
      message: 'ok',
      data: {
        productId: 'prod-123',
        productSlug: 'example-product',
        name: 'Example Product',
        billingMode: 'SUBSCRIPTION',
        isActive: true,
        defaultPlanId: 'plan-pro',
        hasWebhookUrl: true,
        endpoints: buildPartnerApiEndpoints(),
      },
    };

    expect(() => assertPartnerSuccessResponse(
      'getCurrentProduct',
      validResponse,
    )).not.toThrow();
    expect(() => assertPartnerSuccessResponse('getCurrentProduct', {
      ...validResponse,
      data: {
        ...validResponse.data,
        endpoints: {
          ...validResponse.data.endpoints,
          internalAdmin: '/admin/products',
        },
      },
    })).toThrow('Partner response contract violation');
    expect(() => assertPartnerSuccessResponse('getCurrentProduct', {
      ...validResponse,
      data: {
        ...validResponse.data,
        billingMode: 'INTERNAL_EXPERIMENT',
      },
    })).toThrow('Partner response contract violation');
  });

  it('documents every applicable query, path, body, success, error, and auth contract', () => {
    const document = buildPartnerOpenApiDocument();

    for (const operation of Object.values(PARTNER_API_OPERATIONS)) {
      const generated = document.paths[operation.path]?.[operation.method];
      const request = ('request' in operation ? operation.request : undefined) as
        | { params?: unknown; query?: unknown; body?: unknown }
        | undefined;
      expect(generated).toBeDefined();
      expect(generated!.summary).toBeTruthy();
      expect(generated!.description).toBeTruthy();
      expect(generated!.security).toEqual([
        { partnerBearer: [] },
        { productToken: [] },
        { billingProductToken: [] },
      ]);

      const parameters = generated!.parameters ?? [];
      if (request?.params) {
        expect(parameters.some((parameter) =>
          !('$ref' in parameter) && parameter.in === 'path')).toBe(true);
      }
      if (request?.query) {
        expect(parameters.some((parameter) =>
          !('$ref' in parameter) && parameter.in === 'query')).toBe(true);
      }
      if (request?.body) {
        expect(generated!.requestBody).toBeDefined();
      }
      expect(generated!.responses[operation.success.status]).toBeDefined();
      expect(Object.keys(generated!.responses).some((status) => Number(status) >= 400))
        .toBe(true);
    }
  });

  it('rejects unknown fields and values that the runtime cannot honor', () => {
    expect(partnerUserScopeSchema.safeParse({
      userId: 'user-123',
      userID: 'typo',
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      userId: 'user-123',
      tenantId: 'tenant-123',
      planId: 'plan-pro',
      channel: 'BALANCE',
      idempotencyKey: 'order-channel-10001',
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      userId: 'user-123',
      tenantId: 'tenant-123',
      planId: 'plan-pro',
      channel: 'STRIPE',
      idempotencyKey: '   ',
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      userId: 'user-123',
      tenantId: 'tenant-123',
      planId: 'plan-pro',
      channel: 'STRIPE',
    }).success).toBe(false);
    expect(partnerProvisionRequestSchema.safeParse({
      idempotencyKey: 'provision:user-123',
      user: { id: 'user-123', unexpected: true },
    }).success).toBe(false);
    expect(partnerProvisionRequestSchema.safeParse({
      idempotencyKey: 'provision:user-123',
      user: { id: 'user-123', isActive: false },
    }).success).toBe(false);
    expect(partnerProvisionRequestSchema.safeParse({
      user: { id: 'user-123' },
    }).success).toBe(false);
    expect(partnerProvisionRequestSchema.safeParse({
      idempotencyKey: 'short',
      user: { id: 'user-123' },
    }).success).toBe(false);
    expect(partnerProvisionRequestSchema.safeParse({
      idempotencyKey: 'provision key with spaces',
      user: { id: 'user-123' },
    }).success).toBe(false);
    expect(partnerProvisionRequestSchema.safeParse({
      idempotencyKey: 'provision:user-123',
      user: { id: 'user-123' },
      tenant: { id: 'tenant-123', type: 'enterprise' },
    }).success).toBe(false);
    expect(partnerProvisionRequestSchema.safeParse({
      idempotencyKey: 'provision:user-123',
      user: { id: 'user-123' },
      key: { allowedModels: [] },
    }).success).toBe(false);
    expect(partnerProvisionRequestSchema.safeParse({
      idempotencyKey: ' provision:user-123 ',
      user: { id: 'user-123' },
    })).toMatchObject({
      success: true,
      data: { idempotencyKey: 'provision:user-123' },
    });
    expect(partnerDailySummaryQuerySchema.safeParse({
      userId: 'user-123',
      startDate: '07/01/2026',
      endDate: '2026-07-31',
    }).success).toBe(false);
    expect(partnerMonthlySummaryQuerySchema.safeParse({
      userId: 'user-123',
      year: '2026garbage',
    }).success).toBe(false);
    expect(partnerUserScopeSchema.safeParse({
      userId: 'user\u0000log-injection',
    }).success).toBe(false);
  });

  it('enforces exclusive order targets and hardened payment scalar formats', () => {
    const base = {
      userId: 'user-123',
      tenantId: 'tenant-123',
      channel: 'STRIPE' as const,
      idempotencyKey: 'order:payment-10001',
    };
    const bundleSkuId = '799a4d5f-2b8e-4a4e-889b-26ca83383176';
    const boosterPackId = '6ff92714-a7e3-4554-b0d0-a9eae3e9a39e';

    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-pro',
      boosterPackId,
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'BOOSTER_PACK',
      boosterPackId,
      planId: 'plan-pro',
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'BUNDLE',
      bundleSkuId,
      amountCents: 1000,
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'RECHARGE',
      amountCents: 1000,
      bundleSkuId,
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'RECHARGE',
      amountCents: 1000,
      billingPeriod: 'monthly',
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'RECHARGE',
      amountCents: 2_147_483_600,
    }).success).toBe(true);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'RECHARGE',
      amountCents: 2_147_483_700,
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-pro',
      channel: 'WECHAT',
      successUrl: 'https://app.saas.example/success',
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-pro',
      channel: 'ALIPAY',
      successUrl: 'https://app.saas.example/success',
      cancelUrl: 'https://app.saas.example/cancel',
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-pro',
      channel: 'ALIPAY',
      successUrl: 'https://app.saas.example/success',
    }).success).toBe(true);

    for (const invalidKey of ['short', 'payment key with spaces', 'payment\nkey']) {
      expect(partnerCreateOrderSchema.safeParse({
        ...base,
        orderType: 'SUBSCRIPTION',
        planId: 'plan-pro',
        idempotencyKey: invalidKey,
      }).success).toBe(false);
    }
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-pro',
      currency: '$$$',
    }).success).toBe(false);
    expect(partnerPaymentMethodsQuerySchema.safeParse({
      currency: '12$',
    }).success).toBe(false);
    expect(partnerPaymentMethodsQuerySchema.safeParse({
      currency: 'USD',
    })).toMatchObject({ success: true, data: { currency: 'usd' } });
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-pro',
      successUrl: 'ftp://app.saas.example/success',
    }).success).toBe(false);
    expect(partnerCreateOrderSchema.safeParse({
      ...base,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-pro',
      cancelUrl: 'javascript:alert(1)',
    }).success).toBe(false);
  });

  it('publishes only sanitized catalog channel and model-access surfaces', () => {
    const document = buildPartnerOpenApiDocument();
    const channel = document.components?.schemas?.PartnerChannel as unknown as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    const modelAccess = document.components?.schemas?.PartnerModelAccess as unknown as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    const plan = document.components?.schemas?.PartnerPlan as unknown as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };

    expect(channel.required).toEqual(expect.arrayContaining([
      'id',
      'name',
      'provider',
      'runtime',
      'models',
      'isDefault',
    ]));
    expect(channel.additionalProperties).toBe(false);
    expect(Object.keys(channel.properties)).not.toEqual(expect.arrayContaining([
      'apiKey',
      'baseUrl',
      'modelsRaw',
      'modelConfigs',
      'priority',
      'weight',
      'maxRpm',
      'maxTpm',
      'remark',
    ]));

    expect(document.components?.schemas).not.toHaveProperty('PartnerModelPricing');
    expect(modelAccess.required).toContain('creditMultiplier');
    expect(modelAccess.properties).toHaveProperty('creditMultiplier');
    expect(modelAccess.properties).not.toHaveProperty('dailyLimit');
    expect(modelAccess.additionalProperties).toBe(false);
    expect(plan.required).toContain('currency');
    expect(plan.properties).toHaveProperty('currency');

    for (const schemaName of [
      'PartnerProduct',
      'PartnerPlan',
      'PartnerBoosterPack',
      'PartnerCurrentSubscription',
    ]) {
      expect(document.components?.schemas?.[schemaName]).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    }
  });

  it('allows an unavailable external actor mapping to be returned as null', () => {
    const document = buildPartnerOpenApiDocument();
    for (const schemaName of ['PartnerCreditTransaction', 'PartnerBalanceTransaction']) {
      const schema = document.components?.schemas?.[schemaName] as unknown as {
        properties: { userId: { type: string; nullable?: boolean } };
      };
      expect(schema.properties.userId).toMatchObject({
        type: 'string',
        nullable: true,
      });
    }
  });

  it('documents the recharge database bound and fulfillment-specific provision semantics', () => {
    const document = buildPartnerOpenApiDocument();
    const createSchema = (
      document.paths['/partner/v1/payment/create']
        ?.post?.requestBody as {
          content: {
            'application/json': {
              schema: {
                allOf: Array<{
                  properties?: Record<string, Record<string, unknown>>;
                  oneOf?: Array<Record<string, unknown>>;
                }>;
              };
            };
          };
        }
    ).content['application/json'].schema;
    expect(createSchema.allOf[0].properties?.amountCents.maximum).toBe(2_147_483_600);

    const targetVariants = createSchema.allOf[1].oneOf ?? [];
    expect(targetVariants).toHaveLength(3);
    expect(targetVariants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        required: ['orderType', 'amountCents'],
        properties: expect.objectContaining({
          orderType: expect.objectContaining({ enum: ['RECHARGE'] }),
          amountCents: expect.objectContaining({ multipleOf: 100 }),
        }),
      }),
    ]));

    const channelVariants = createSchema.allOf[2].oneOf ?? [];
    expect(channelVariants).toHaveLength(3);
    expect(channelVariants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          channel: expect.objectContaining({ enum: ['WECHAT'] }),
        }),
        not: {
          anyOf: [
            { required: ['successUrl'] },
            { required: ['cancelUrl'] },
          ],
        },
      }),
      expect.objectContaining({
        properties: expect.objectContaining({
          channel: expect.objectContaining({ enum: ['ALIPAY'] }),
        }),
        not: { anyOf: [{ required: ['cancelUrl'] }] },
      }),
    ]));

    const provisionSchema = (
      document.paths['/partner/v1/tenants/provision']
        ?.post?.requestBody as {
          content: {
            'application/json': {
              schema: { properties: Record<string, Record<string, unknown>> };
            };
          };
        }
    ).content['application/json'].schema;
    const description = String(provisionSchema.properties.ensureFreePlan.description);
    expect(description).toContain('self-operated CODING_PLAN');
    expect(description).toContain('provider_resale CODING_PLAN');
    expect(description).toContain('true is rejected with HTTP 400');
    expect(description).toContain('fail closed');
  });

  it('does not advertise provider cancellation until a durable close saga exists', () => {
    const document = buildPartnerOpenApiDocument();

    expect(document.paths['/partner/v1/payment/orders/{id}/cancel']).toBeUndefined();
    expect(PARTNER_API_OPERATIONS).not.toHaveProperty('cancelPaymentOrder');
  });

  it('does not publish list pricing until product-effective quotes are available', () => {
    const document = buildPartnerOpenApiDocument();

    expect(document.paths['/partner/v1/catalog/model-pricing']).toBeUndefined();
    expect(PARTNER_API_OPERATIONS).not.toHaveProperty('getModelPricing');
  });

  it('does not publish bundles while every reversible Partner channel is unavailable', () => {
    const document = buildPartnerOpenApiDocument();

    expect(document.paths['/partner/v1/catalog/bundles']).toBeUndefined();
    expect(PARTNER_API_OPERATIONS).not.toHaveProperty('getBundles');
    expect(document.components?.schemas).not.toHaveProperty('PartnerBundle');
  });

  it('documents stable upstream-provider failures for Partner writes', () => {
    const document = buildPartnerOpenApiDocument();
    const response = document.paths['/partner/v1/payment/create']
      ?.post?.responses?.[502] as { $ref?: string };
    const component = document.components?.responses?.PartnerUpstreamError as {
      content?: {
        'application/json'?: {
          examples?: {
            error?: {
              value?: { code?: string };
            };
          };
        };
      };
    };

    expect(response?.$ref).toBe('#/components/responses/PartnerUpstreamError');
    expect(component.content?.['application/json']?.examples?.error?.value?.code)
      .toBe('UPSTREAM_ERROR');
  });

  it('keeps every public object schema closed except explicit dictionaries', () => {
    const document = buildPartnerOpenApiDocument();
    const dictionaryPaths = new Set([
      'PartnerChannel.models',
    ]);
    const openObjects: string[] = [];

    const visitSchema = (
      value: unknown,
      path: string,
      insideDictionary = false,
    ): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const schema = value as Record<string, unknown>;
      if (typeof schema.$ref === 'string') return;

      const dictionary = insideDictionary || dictionaryPaths.has(path);
      if (schema.type === 'object') {
        if (!dictionary && schema.additionalProperties !== false) {
          openObjects.push(path);
        }
        if (dictionary && schema.additionalProperties === undefined) {
          openObjects.push(`${path} (dictionary is not explicit)`);
        }
        const properties = schema.properties as Record<string, unknown> | undefined;
        for (const [name, property] of Object.entries(properties ?? {})) {
          visitSchema(property, `${path}.${name}`, dictionary);
        }
        if (
          schema.additionalProperties
          && typeof schema.additionalProperties === 'object'
        ) {
          visitSchema(
            schema.additionalProperties,
            `${path}.*`,
            dictionary,
          );
        }
      }

      for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
        const alternatives = schema[keyword];
        if (Array.isArray(alternatives)) {
          alternatives.forEach((alternative, index) => {
            visitSchema(alternative, `${path}.${keyword}[${index}]`, dictionary);
          });
        }
      }
      if (schema.items) {
        visitSchema(schema.items, `${path}[]`, dictionary);
      }
    };

    for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
      visitSchema(schema, name);
    }
    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const method of ['get', 'post'] as const) {
        const operation = pathItem?.[method];
        if (!operation) continue;
        const requestBody = operation.requestBody;
        if (requestBody && !('$ref' in requestBody)) {
          visitSchema(
            requestBody.content?.['application/json']?.schema,
            `${method.toUpperCase()} ${path} request`,
          );
        }
      }
    }

    expect(openObjects).toEqual([]);
  });
});
