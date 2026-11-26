import { BadRequestException } from '@nestjs/common';
import { encrypt } from '../common/utils/crypto';
import { decryptCodingPlanProviderUpstreamCredential } from './coding-plan-provider-upstream-credential';

const ENCRYPTION_KEY = 'a'.repeat(64);

describe('decryptCodingPlanProviderUpstreamCredential', () => {
  it('decrypts provider entitlement api key and secret into the upstream credential format', () => {
    expect(decryptCodingPlanProviderUpstreamCredential({
      upstreamApiKeyEncrypted: encrypt('api-key-1', ENCRYPTION_KEY),
      upstreamSecretKeyEncrypted: encrypt('secret-key-1', ENCRYPTION_KEY),
    }, ENCRYPTION_KEY)).toBe('api-key-1.secret-key-1');
  });

  it('rejects incomplete provider entitlement credentials', () => {
    expect(() => decryptCodingPlanProviderUpstreamCredential({
      upstreamApiKeyEncrypted: encrypt('api-key-1', ENCRYPTION_KEY),
      upstreamSecretKeyEncrypted: null,
    }, ENCRYPTION_KEY)).toThrow(BadRequestException);
  });
});
