import {
  ArgumentsHost,
  BadGatewayException,
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ErrorCode } from '@ruidong/shared';
import { HttpExceptionFilter } from './http-exception.filter';

function host() {
  const reply = {
    code: jest.fn(),
    send: jest.fn(),
    header: jest.fn(),
  };
  reply.code.mockReturnValue(reply);
  return {
    reply,
    value: {
      switchToHttp: () => ({
        getResponse: () => reply,
      }),
    } as unknown as ArgumentsHost,
  };
}

describe('HttpExceptionFilter', () => {
  it.each([
    [new ConflictException('request conflict'), 409, ErrorCode.CONFLICT],
    [new BadGatewayException('upstream failed'), 502, ErrorCode.UPSTREAM_ERROR],
    [
      new ServiceUnavailableException('provider unavailable'),
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
    ],
  ])('maps %s to a stable external code', (exception, status, code) => {
    const filter = new HttpExceptionFilter();
    const response = host();

    filter.catch(exception, response.value);

    expect(response.reply.code).toHaveBeenCalledWith(status);
    expect(response.reply.send).toHaveBeenCalledWith({
      code,
      message: exception.message,
      data: null,
    });
  });

  it('preserves stable numeric codes and retry metadata for rate-limit responses', () => {
    const filter = new HttpExceptionFilter();
    const response = host();

    filter.catch(
      new HttpException(
        {
          code: 10_042,
          message: 'rate limited',
          retryAfter: 9,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      response.value,
    );

    expect(response.reply.header).toHaveBeenCalledWith('Retry-After', '9');
    expect(response.reply.code).toHaveBeenCalledWith(429);
    expect(response.reply.send).toHaveBeenCalledWith({
      code: 10_042,
      message: 'rate limited',
      data: null,
      statusCode: 429,
      retryAfter: 9,
    });
  });

  it.each([
    ['FST_ERR_CTP_BODY_TOO_LARGE', 413, '请求体过大'],
    ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 415, '不支持的 Content-Type'],
  ])('maps known raw Fastify %s parser errors without exposing their messages', (
    fastifyCode,
    status,
    message,
  ) => {
    const filter = new HttpExceptionFilter();
    const response = host();

    filter.catch({ code: fastifyCode, statusCode: status }, response.value);

    expect(response.reply.code).toHaveBeenCalledWith(status);
    expect(response.reply.send).toHaveBeenCalledWith({
      code: ErrorCode.VALIDATION_ERROR,
      message,
      data: null,
    });
  });
});
