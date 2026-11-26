export interface WebhookJobData {
  url: string;
  body: string;         // serialized JSON
  timestamp: string;    // unix seconds
  signature: string;    // hex hmac-sha256
  label: string;        // "notifyProductSaas:plans_changed" etc.
  syncToken: string;
  // no mutable state here; queue must be crash-safe
}
