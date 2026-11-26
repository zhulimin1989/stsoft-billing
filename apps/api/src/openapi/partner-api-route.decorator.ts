import { applyDecorators, Get, HttpCode, Post, SetMetadata } from '@nestjs/common';
import { PARTNER_API_BASE_PATH } from '../common/openapi/partner-api-endpoints';
import {
  PARTNER_API_OPERATIONS,
  PartnerOperationKey,
} from './partner-api.contract';

export const PARTNER_OPERATION_METADATA = 'partner:operation';

/**
 * Keeps the Nest route and the generated OpenAPI path/status sourced from the
 * same operation registry. This prevents controller and machine-contract drift.
 */
export function PartnerOperation(operationKey: PartnerOperationKey): MethodDecorator {
  const operation = PARTNER_API_OPERATIONS[operationKey];
  const relativePath = operation.path
    .slice(PARTNER_API_BASE_PATH.length)
    .replace(/^\//, '')
    .replace(/\{([^}]+)\}/g, ':$1');
  const routeDecorator = operation.method === 'get'
    ? Get(relativePath)
    : Post(relativePath);

  return applyDecorators(
    routeDecorator,
    HttpCode(operation.success.status),
    SetMetadata(PARTNER_OPERATION_METADATA, operationKey),
  );
}
