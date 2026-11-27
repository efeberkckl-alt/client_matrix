export type StoreStamp = { storeId: string; storeRevision: string };
type AccountStamp = StoreStamp & { id: string; incarnation: string; epoch: string; stateRevision: string; attemptId?: string };
type AccountUpdate = Partial<AccountStamp> & { scanId?: string; loginVerified?: boolean; scanEnded?: boolean; error?: unknown };
const counter = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v) && BigInt(v) <= 0xffff_ffff_ffff_ffffn;
const stamp = (v: Partial<StoreStamp> | undefined): v is StoreStamp => !!v && typeof v.storeId === 'string'
  && v.storeId.length > 0 && counter(v.storeRevision);
const accountStamp = <T extends Partial<AccountStamp>>(v: T): v is T & AccountStamp =>
  typeof v.id === 'string' && typeof v.incarnation === 'string' && counter(v.epoch) && counter(v.stateRevision) && stamp(v);

/** The observed cursor is separate from the last complete snapshot. */
export class MatrixAccountVersions {
  private current?: StoreStamp;
  private cursor = 0n;
  private retired = new Set<string>();
  private accounts = new Map<string, Pick<AccountStamp, 'incarnation' | 'epoch' | 'stateRevision'>>();
  private terminals = new Map<string, string>();

  installSnapshot(version: Partial<StoreStamp> | undefined, rows: Partial<AccountStamp>[], allowNewStore: boolean): 'accepted' | 'replaced' | 'ignored' {
    if (!stamp(version) || this.retired.has(version.storeId)) return 'ignored';
    const replaced = !!this.current && this.current.storeId !== version.storeId;
    if (replaced && !allowNewStore) return 'ignored';
    const revision = BigInt(version.storeRevision);
    if (!replaced && revision < this.cursor) return 'ignored';
    if (replaced) {
      this.retired.add(this.current!.storeId);
      this.terminals.clear();
    }
    this.current = { ...version };
    this.cursor = revision;
    this.accounts = new Map(rows.filter(accountStamp).filter(row => row.storeId === version.storeId)
      .map(row => [row.id, row]));
    return replaced ? 'replaced' : 'accepted';
  }

  inspect(p: AccountUpdate): 'apply' | 'reload' | 'ignore' {
    if (!accountStamp(p)) return 'reload';
    if (this.retired.has(p.storeId)) return 'ignore';
    if (!this.current || this.current.storeId !== p.storeId) return 'reload';
    const revision = BigInt(p.storeRevision);
    const previous = this.accounts.get(p.id);
    if (revision < this.cursor || BigInt(p.stateRevision) > revision) return 'ignore';
    if (!previous || previous.incarnation !== p.incarnation) return 'reload';
    if (BigInt(p.stateRevision) < BigInt(previous.stateRevision) || BigInt(p.epoch) < BigInt(previous.epoch)) return 'ignore';
    const terminal = p.scanId && (p.loginVerified || p.scanEnded || p.error);
    if (terminal) {
      const id = [p.incarnation, p.epoch, p.attemptId || '', p.scanId].join('/');
      if (this.terminals.get(p.id) === id) return 'ignore';
      this.terminals.set(p.id, id);
    }
    this.cursor = revision;
    this.accounts.set(p.id, p);
    return 'apply';
  }
}

export type LocalScan = { id: string; platform: string; displayName: string; accepted?: StoreStamp };
type ScanSnapshotRow = { id: string; activeScanId?: string; lastScanId?: string };

/** A snapshot older than the IPC acceptance cannot prove that a just-starting scan vanished. */
export function endedScans(scans: ReadonlyMap<string, LocalScan>, version: Partial<StoreStamp>, rows: ScanSnapshotRow[]): string[] {
  if (!stamp(version)) return [];
  const byId = new Map(rows.map(row => [row.id, row]));
  return [...scans.entries()].flatMap(([id, scan]) => {
    const row = byId.get(id);
    if (row?.activeScanId === scan.id) return [];
    if (row?.lastScanId === scan.id) return [id];
    const accepted = scan.accepted;
    if (!accepted || accepted.storeId !== version.storeId || BigInt(version.storeRevision) < BigInt(accepted.storeRevision)) return [];
    return [id];
  });
}

export function rememberScanAcceptance(scan: LocalScan, version: Partial<StoreStamp> | undefined): void {
  if (stamp(version)) scan.accepted = { storeId: version.storeId, storeRevision: version.storeRevision };
}
