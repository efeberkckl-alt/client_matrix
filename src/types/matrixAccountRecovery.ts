export function isUnboundLoginWait(account: {
  status: string; boundUid?: string; manualDisconnect?: boolean; bindingConflict?: boolean;
  chargeUncertain?: unknown; recovery?: { reason: string }; statusReason?: string;
  authority?: { verified: boolean }; availability?: { reasons: string[] };
}): boolean {
  const reasons = account.availability?.reasons;
  const exactLoginWait = account.recovery
    ? account.recovery.reason === 'login_unknown'
    : account.statusReason === '等待自动复查：login_unknown';
  return account.status === 'limited' && !account.boundUid && account.authority?.verified === false
    && !account.manualDisconnect && !account.bindingConflict && !account.chargeUncertain && exactLoginWait
    && reasons?.length === 1 && reasons[0] === 'technical';
}
