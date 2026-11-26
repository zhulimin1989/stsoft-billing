// BullMQ 5.x rejects queue names containing ":" at runtime
// ("Queue name cannot contain :"). Use a filesystem-like separator.
export const WEBHOOK_QUEUE = 'integration-webhook';
