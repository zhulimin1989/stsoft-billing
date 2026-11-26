import { Prisma } from '@prisma/client';

/**
 * Prisma maps PostgreSQL TIMESTAMP columns to UTC JavaScript Date values.
 * Always remove the database session offset explicitly before writing or
 * comparing one of those columns; a plain timestamptz::timestamp cast would
 * otherwise depend on the connection's TimeZone setting.
 */
export const POSTGRES_UTC_FINANCIAL_CLOCK = Prisma.sql`
  (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3)
`;
