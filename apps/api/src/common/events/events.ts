export class UserStatusChangedEvent {
  constructor(
    public readonly userId: string,
    public readonly isActive: boolean,
    public readonly performedBy: string,
    public readonly targetUserId?: string,
    public readonly resourceId?: string,
  ) {}
}

export class BalanceAdjustedEvent {
  constructor(
    public readonly userId: string,
    public readonly amountCents: number,
    public readonly description: string,
    public readonly performedBy: string,
    public readonly targetUserId?: string,
    public readonly resourceId?: string,
  ) {}
}

export class OrderPaidEvent {
  constructor(
    public readonly orderId: string,
    public readonly userId: string,
    public readonly amountCents: number,
    public readonly channel: string,
    public readonly targetUserId?: string,
    public readonly resourceId?: string,
  ) {}
}

export class ChannelUpdatedEvent {
  constructor(
    public readonly channelId: string,
    public readonly action: 'created' | 'updated' | 'deleted',
    public readonly performedBy: string,
    public readonly targetUserId?: string,
    public readonly resourceId?: string,
  ) {}
}

export const AppEvents = {
  USER_STATUS_CHANGED: 'user.status.changed',
  BALANCE_ADJUSTED: 'billing.balance.adjusted',
  ORDER_PAID: 'payment.order.paid',
  CHANNEL_UPDATED: 'channel.updated',
} as const;
