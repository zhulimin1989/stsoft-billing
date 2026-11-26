import { BadRequestException } from '@nestjs/common';
import { decrypt } from '../common/utils/crypto';

type CodingPlanProviderCredentialSecretFields = {
  upstreamApiKeyEncrypted?: string | null;
  upstreamSecretKeyEncrypted?: string | null;
};

export function decryptCodingPlanProviderUpstreamCredential(
  providerEntitlement: CodingPlanProviderCredentialSecretFields,
  encryptionKey: string,
): string {
  const { apiKey, secretKey } = decryptCodingPlanProviderUpstreamCredentialParts(providerEntitlement, encryptionKey);
  return `${apiKey}.${secretKey}`;
}

export function decryptCodingPlanProviderUpstreamCredentialParts(
  providerEntitlement: CodingPlanProviderCredentialSecretFields,
  encryptionKey: string,
): { apiKey: string; secretKey: string } {
  if (
    !providerEntitlement.upstreamApiKeyEncrypted
    || !providerEntitlement.upstreamSecretKeyEncrypted
  ) {
    throw new BadRequestException('CodingPlan 上游权益缺少供应商 key');
  }
  const apiKey = decrypt(providerEntitlement.upstreamApiKeyEncrypted, encryptionKey);
  const secretKey = decrypt(providerEntitlement.upstreamSecretKeyEncrypted, encryptionKey);
  return { apiKey, secretKey };
}
