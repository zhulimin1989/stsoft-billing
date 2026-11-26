export function isBillingRuntime(): boolean {
  const role = process.env.RUIDONG_SERVICE;
  return !role || role === 'billing';
}
