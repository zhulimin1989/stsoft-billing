import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import {
  assertPartnerSuccessResponse,
  PartnerOperationKey,
} from './partner-api.contract';
import { PARTNER_OPERATION_METADATA } from './partner-api-route.decorator';

@Injectable()
export class PartnerApiResponseContractInterceptor implements NestInterceptor {
  private readonly logger = new Logger(
    PartnerApiResponseContractInterceptor.name,
  );

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const operationKey = Reflect.getMetadata(
      PARTNER_OPERATION_METADATA,
      context.getHandler(),
    ) as PartnerOperationKey | undefined;
    if (!operationKey) {
      throw new InternalServerErrorException(
        'Partner operation metadata is missing',
      );
    }

    return next.handle().pipe(
      map((response) => {
        try {
          // Validate the JSON representation, matching what Fastify actually
          // emits (Date -> ISO string, Decimal -> string).
          assertPartnerSuccessResponse(operationKey, response);
          return response;
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : 'unknown response contract violation';
          // The validator reports only operation/schema paths and issue codes;
          // never log the response payload or Partner subject data.
          this.logger.error(message);
          throw new InternalServerErrorException(
            'Partner API response contract violation',
          );
        }
      }),
    );
  }
}
