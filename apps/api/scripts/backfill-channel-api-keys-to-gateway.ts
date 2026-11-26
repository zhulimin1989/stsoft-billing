import { PrismaClient } from '@prisma/client';
import { decrypt } from '../src/common/utils/crypto';
import {
  decryptGatewayLocalSecret,
  encryptGatewayLocalSecret,
  isGatewayLocalSecret,
  isLegacyAesGcmSecret,
  resolveGatewayLocalSecretFromEnv,
} from '../src/common/utils/gateway-secret';

const prisma = new PrismaClient();

async function main() {
  const encryptionKey = process.env.ENCRYPTION_KEY?.trim();
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required');
  }
  const gatewaySecret = resolveGatewayLocalSecretFromEnv();
  if (!gatewaySecret) {
    throw new Error('KMS_HMAC_SECRET or ENCRYPTION_KEY is required');
  }

  const dryRun = process.env.DRY_RUN === 'true';
  const channels = await prisma.channel.findMany({
    select: { id: true, name: true, apiKey: true },
    orderBy: { createdAt: 'asc' },
  });

  const result = {
    scanned: channels.length,
    migrated: 0,
    alreadyGateway: 0,
    rewrappedGatewayLocal: 0,
    skippedPlaintext: 0,
    failed: 0,
  };

  for (const channel of channels) {
    const apiKey = channel.apiKey.trim();
    if (isGatewayLocalSecret(apiKey)) {
      if (canDecryptGatewayLocal(apiKey, gatewaySecret)) {
        result.alreadyGateway++;
        continue;
      }
      try {
        const plaintext = decryptGatewayLocalSecret(apiKey, encryptionKey);
        const nextApiKey = encryptGatewayLocalSecret(plaintext, gatewaySecret);
        if (!dryRun) {
          await prisma.channel.update({
            where: { id: channel.id },
            data: { apiKey: nextApiKey },
          });
        }
        result.rewrappedGatewayLocal++;
        continue;
      } catch (err) {
        result.failed++;
        console.error(`failed gateway-local channel=${channel.id} name=${channel.name}: ${(err as Error).message}`);
        continue;
      }
    }
    if (apiKey.startsWith('enc:')) {
      result.alreadyGateway++;
      continue;
    }
    if (!isLegacyAesGcmSecret(apiKey)) {
      result.skippedPlaintext++;
      continue;
    }

    try {
      const plaintext = decrypt(apiKey, encryptionKey);
      const nextApiKey = encryptGatewayLocalSecret(plaintext, gatewaySecret);
      if (!dryRun) {
        await prisma.channel.update({
          where: { id: channel.id },
          data: { apiKey: nextApiKey },
        });
      }
      result.migrated++;
    } catch (err) {
      result.failed++;
      console.error(`failed channel=${channel.id} name=${channel.name}: ${(err as Error).message}`);
    }
  }

  console.log(JSON.stringify({ dryRun, ...result }, null, 2));
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });

function canDecryptGatewayLocal(ciphertext: string, secret: string): boolean {
  try {
    decryptGatewayLocalSecret(ciphertext, secret);
    return true;
  } catch {
    return false;
  }
}
