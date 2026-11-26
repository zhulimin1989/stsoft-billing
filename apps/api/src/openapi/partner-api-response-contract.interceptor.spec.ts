import {
  CallHandler,
  ExecutionContext,
} from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { PartnerApiResponseContractInterceptor } from './partner-api-response-contract.interceptor';
import { PARTNER_OPERATION_METADATA } from './partner-api-route.decorator';

function contextFor(operationKey?: string): ExecutionContext {
  const handler = () => undefined;
  if (operationKey) {
    Reflect.defineMetadata(PARTNER_OPERATION_METADATA, operationKey, handler);
  }
  return {
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

describe('PartnerApiResponseContractInterceptor', () => {
  const interceptor = new PartnerApiResponseContractInterceptor();

  it('accepts a JSON-equivalent response matching the registered operation schema', async () => {
    const next: CallHandler = {
      handle: () => of({
        code: 0,
        message: 'ok',
        data: {
          methods: [{
            channel: 'STRIPE',
            label: '银行卡',
            currency: 'usd',
            mode: 'redirect',
          }],
        },
      }),
    };

    await expect(lastValueFrom(
      interceptor.intercept(contextFor('getPaymentMethods'), next),
    )).resolves.toMatchObject({ code: 0 });
  });

  it('fails closed without logging or returning the invalid response payload', async () => {
    const next: CallHandler = {
      handle: () => of({
        code: 0,
        message: 'ok',
        data: {
          methods: [{
            channel: 'UNSUPPORTED',
            label: 'leak-me',
            currency: 'usd',
            mode: 'redirect',
          }],
        },
      }),
    };

    await expect(lastValueFrom(
      interceptor.intercept(contextFor('getPaymentMethods'), next),
    )).rejects.toThrow('Partner API response contract violation');
  });

  it('fails closed when a controller route lacks operation metadata', () => {
    const next: CallHandler = { handle: () => of({}) };

    expect(() => interceptor.intercept(contextFor(), next))
      .toThrow('Partner operation metadata is missing');
  });
});
