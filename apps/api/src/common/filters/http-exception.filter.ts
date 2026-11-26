import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ErrorCode } from '@ruidong/shared';

const HTTP_TO_ERROR_CODE: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.AUTH_UNAUTHORIZED,
  403: ErrorCode.AUTH_FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.VALIDATION_ERROR,
  415: ErrorCode.VALIDATION_ERROR,
  429: ErrorCode.RATE_LIMIT_EXCEEDED,
  502: ErrorCode.UPSTREAM_ERROR,
  503: ErrorCode.SERVICE_UNAVAILABLE,
};

/**
 * Fastify rejects an oversized body or unsupported Content-Type before Nest
 * creates controller arguments, so these are not HttpException instances.
 * Recognize only the documented Fastify parser errors (and their exact HTTP
 * statuses); all other unknown errors still take the internal-error path.
 */
const FASTIFY_TRANSPORT_ERRORS: Record<string, {
  status: 413 | 415;
  message: string;
}> = {
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    message: '请求体过大',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    message: '不支持的 Content-Type',
  },
};

const STABLE_TRANSPORT_MESSAGES: Record<413 | 415, string> = {
  413: '请求体过大',
  415: '不支持的 Content-Type',
};

function knownFastifyTransportError(exception: unknown): {
  status: 413 | 415;
  message: string;
} | null {
  if (!exception || typeof exception !== 'object') return null;
  const record = exception as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const known = FASTIFY_TRANSPORT_ERRORS[code];
  return known && record.statusCode === known.status ? known : null;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();

      // 支持自定义 code：throw new HttpException({ code: 'BILLING_...', message }, 4xx)
      let code: string | number = HTTP_TO_ERROR_CODE[status] ?? ErrorCode.INTERNAL_ERROR;
      let message: string = exception.message;
      let retryAfter: number | undefined;

      if (typeof response === 'object' && response !== null) {
        const res = response as Record<string, unknown>;
        if (typeof res.code === 'string' || typeof res.code === 'number') code = res.code;
        if (typeof res.message === 'string') message = res.message;

        // 429 限流：设置 Retry-After header
        if (
          status === 429
          && typeof res.retryAfter === 'number'
          && Number.isInteger(res.retryAfter)
          && res.retryAfter > 0
        ) {
          retryAfter = res.retryAfter;
          reply.header('Retry-After', String(retryAfter));
        }
      }

      // Nest can normalize Fastify parser failures into HttpExceptions before
      // this filter sees them. Keep their public messages stable too.
      if (status === 413 || status === 415) {
        message = STABLE_TRANSPORT_MESSAGES[status];
      }

      reply.code(status).send({
        code,
        message,
        data: null,
        ...(status === 429 ? { statusCode: status } : {}),
        ...(retryAfter ? { retryAfter } : {}),
      });
      return;
    }

    const transportError = knownFastifyTransportError(exception);
    if (transportError) {
      reply.code(transportError.status).send({
        code: HTTP_TO_ERROR_CODE[transportError.status],
        message: STABLE_TRANSPORT_MESSAGES[transportError.status],
        data: null,
      });
      return;
    }

    // 未知异常
    this.logger.error('Unhandled exception', exception instanceof Error ? exception.stack : exception);
    reply.code(500).send({
      code: ErrorCode.INTERNAL_ERROR,
      message: '服务器内部错误',
      data: null,
    });
  }
}
