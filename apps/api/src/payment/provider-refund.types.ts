export type ProviderRefundState =
  | 'SUCCEEDED'
  | 'PENDING'
  | 'FAILED'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export type ProviderRefundOutcome = {
  state: ProviderRefundState;
  providerStatus: string;
  refundId?: string;
  error?: string;
};
