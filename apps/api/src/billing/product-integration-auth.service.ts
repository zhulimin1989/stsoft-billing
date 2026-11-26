import { Injectable } from '@nestjs/common';
import { ProductBillingMode } from '@prisma/client';
import { createHash } from 'crypto';
import { normalizeProductPaymentCallbackOrigins } from '../payment/payment-callback-url-policy';
import { PrismaService } from '../prisma/prisma.service';

type HeaderValue = string | string[] | undefined;

export type ProductIntegrationContext = {
  id: string;
  slug: string;
  name: string;
  billingMode: ProductBillingMode;
  allowedPaymentCallbackOrigins: string[] | null;
};

function allHeaders(value: HeaderValue): string[] {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function normalizeToken(value: string | null): string | null {
  const token = value?.trim();
  if (!token) return null;
  const bearer = token.match(/^Bearer\s+(.+)$/i);
  return (bearer ? bearer[1] : token).trim() || null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class ProductIntegrationAuthService {
  constructor(private readonly prisma: PrismaService) {}

  extractToken(headers: Record<string, HeaderValue>): string | null {
    const tokens = [
      ...allHeaders(headers['x-product-token']),
      ...allHeaders(headers['x-billing-product-token']),
      ...allHeaders(headers.authorization),
    ]
      .map((value) => normalizeToken(value))
      .filter((value): value is string => Boolean(value));
    if (new Set(tokens).size > 1) {
      // Multiple authentication alternatives with different credentials are
      // ambiguous and can otherwise let proxies and applications disagree on
      // the authenticated product.
      return null;
    }
    return tokens[0] ?? null;
  }

  async resolveFromHeaders(
    headers: Record<string, HeaderValue>,
  ): Promise<ProductIntegrationContext | null> {
    const token = this.extractToken(headers);
    if (!token) return null;
    return this.resolveToken(token);
  }

  async resolveToken(token: string): Promise<ProductIntegrationContext | null> {
    const product = await this.prisma.product.findFirst({
      where: {
        integrationTokenHash: hashToken(token),
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        billingMode: true,
        allowedPaymentCallbackOrigins: true,
      },
    });
    if (!product) return null;

    return {
      ...product,
      allowedPaymentCallbackOrigins: normalizeProductPaymentCallbackOrigins(
        product.allowedPaymentCallbackOrigins,
      ),
    };
  }

}
