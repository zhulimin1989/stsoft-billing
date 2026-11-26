import { Injectable } from '@nestjs/common';
import { Channel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ChannelRecord = Omit<Channel, 'apiKeyEncrypted'> & {
  apiKey: string;
};

type ChannelCreateData = {
  name: string;
  provider: string;
  providerAccountIdentityId?: string | null;
  baseUrl: string;
  apiKey: string;
  models?: string;
  modelConfigs?: string | null;
  sdkType?: string;
  providerProfile?: string | null;
  clientCompatibility?: string | null;
  servedInboundProtocols?: string | null;
  protocolPaths?: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  tokenCountStrategy?: string | null;
  ownedBy?: string | null;
  dedicatedClientProtocol?: string | null;
  dedicatedProtocolStrategy?: string | null;
  priority?: number;
  weight?: number;
  maxRpm?: number;
  maxTpm?: number;
  remark?: string;
};

function toChannelRecord(channel: Channel): ChannelRecord {
  const { apiKeyEncrypted, ...rest } = channel;
  return {
    ...rest,
    apiKey: apiKeyEncrypted,
  };
}

function mapCreatePayload(data: ChannelCreateData): Prisma.ChannelUncheckedCreateInput {
  const { apiKey, ...rest } = data;
  return {
    ...rest,
    apiKeyEncrypted: apiKey,
  };
}

function mapUpdatePayload(data: Record<string, unknown>): Prisma.ChannelUncheckedUpdateInput {
  if (!Object.prototype.hasOwnProperty.call(data, 'apiKey')) {
    return data as Prisma.ChannelUncheckedUpdateInput;
  }
  const { apiKey, ...rest } = data;
  return {
    ...rest,
    ...(typeof apiKey === 'string' ? { apiKeyEncrypted: apiKey } : {}),
  } as Prisma.ChannelUncheckedUpdateInput;
}

@Injectable()
export class ChannelRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(skip: number, take: number) {
    const rows = await this.prisma.channel.findMany({
      where: { deletedAt: null },
      orderBy: { priority: 'asc' },
      skip,
      take,
    });
    return rows.map(toChannelRecord);
  }

  async count() {
    return this.prisma.channel.count({ where: { deletedAt: null } });
  }

  async countByProvider(provider: string) {
    return this.prisma.channel.count({ where: { provider, deletedAt: null } });
  }

  async countByProviders(providers: string[]) {
    return this.prisma.channel.count({
      where: { provider: { in: providers }, deletedAt: null },
    });
  }

  async findById(id: string) {
    const row = await this.prisma.channel.findFirst({ where: { id, deletedAt: null } });
    return row ? toChannelRecord(row) : null;
  }

  async findDuplicate(data: { name: string; provider: string; baseUrl: string }) {
    return this.prisma.channel.findFirst({
      where: {
        name: data.name,
        provider: data.provider,
        baseUrl: data.baseUrl,
        deletedAt: null,
      },
      select: { id: true },
    });
  }

  async findProductChannelBindings(channelId: string) {
    return this.prisma.productChannel.findMany({
      where: { channelId, deletedAt: null },
      select: { id: true, metadata: true },
      orderBy: { id: 'asc' },
    });
  }

  async create(data: ChannelCreateData): Promise<ChannelRecord> {
    const row = await this.prisma.channel.create({ data: mapCreatePayload(data) });
    return toChannelRecord(row);
  }

  async update(id: string, data: Record<string, unknown>): Promise<ChannelRecord> {
    const row = await this.prisma.channel.update({ where: { id }, data: mapUpdatePayload(data) });
    return toChannelRecord(row);
  }

  async deleteById(id: string) {
    const row = await this.prisma.channel.update({
      where: { id },
      data: {
        isActive: false,
        status: 'inactive',
        deletedAt: new Date(),
      },
    });
    return toChannelRecord(row);
  }

  async findActiveChannels() {
    const rows = await this.prisma.channel.findMany({
      where: { isActive: true, status: 'active' },
      orderBy: [{ priority: 'asc' }, { weight: 'desc' }],
    });
    return rows.map(toChannelRecord);
  }

  async resetStats(id: string) {
    const row = await this.prisma.channel.update({
      where: { id },
      data: { totalReqs: 0, totalErrs: 0, successRate: 1.0, avgLatencyMs: null },
    });
    return toChannelRecord(row);
  }

  async updateStats(id: string, data: {
    totalReqs: number;
    totalErrs: number;
    successRate: number;
    avgLatencyMs: number;
  }) {
    const row = await this.prisma.channel.update({ where: { id }, data });
    return toChannelRecord(row);
  }
}
