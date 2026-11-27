import type { ObservationReceipt } from './accountManager';
import { isIP } from 'node:net';
import { createHmac, randomUUID } from 'crypto';

export type NavigationFailure = 'http_403' | 'http_407' | 'http_429' | 'http_error' | 'http_5xx' | 'proxy' | 'tunnel'
  | 'tls' | 'dns' | 'timeout' | 'cancelled' | 'connection' | 'browser_error' | 'protocol' | 'target_closed' | 'busy' | 'different_page'
  | 'ownership_unconfirmed' | 'business_target_mismatch';

export class KernelNavigationError extends Error {
  constructor(readonly code: NavigationFailure, readonly until = 0) {
    super(`navigation:${code}`);
    this.name = 'KernelNavigationError';
  }
}

export function navigationFailure(value: unknown): NavigationFailure {
  const code = typeof value === 'string' ? /^net::(ERR_[A-Z0-9_]+)$/.exec(value)?.[1] || '' : '';
  if (/^(ERR_(?:INVALID_AUTH_CREDENTIALS|PROXY_AUTH_.*|UNEXPECTED_PROXY_AUTH))$/.test(code)) return 'proxy';
  if (code === 'ERR_TUNNEL_CONNECTION_FAILED') return 'tunnel';
  if (code.startsWith('ERR_PROXY_') || code.startsWith('ERR_SOCKS_')) return 'proxy';
  if (/^ERR_(?:CERT_|SSL_|TLS_|ALPN_)/.test(code)) return 'tls';
  if (/^ERR_(?:DNS_|NAME_(?:NOT_RESOLVED|RESOLUTION_FAILED))/.test(code)) return 'dns';
  if (code.includes('TIMED_OUT')) return 'timeout';
  if (code === 'ERR_ABORTED') return 'cancelled';
  if (/^ERR_(?:CONNECTION_|INTERNET_|NETWORK_|ADDRESS_)/.test(code)) return 'connection';
  return 'browser_error';
}

export function navigationPage(value: unknown): 'blank' | 'home' | 'video' | 'login' | 'platform' | 'other' | 'error' {
  if (typeof value !== 'string') return 'other';
  if (value === 'about:blank' || /^chrome(?:-search)?:\/\/(?:newtab|new-tab-page)\/?$/.test(value)) return 'blank';
  if (value.startsWith('chrome-error:')) return 'error';
  try {
    const url = new URL(value);
    if (!/(^|\.)tiktok\.com$/i.test(url.hostname)) return 'other';
    if (/^\/(?:login|signup|passport)(?:\/|$)/i.test(url.pathname)) return 'login';
    if (/\/(?:video|photo)\//i.test(url.pathname)) return 'video';
    return /^\/(?:foryou\/?)?$/.test(url.pathname) ? 'home' : 'platform';
  } catch { return 'other'; }
}

const aliasKey = randomUUID();
export function diagnosticAccountAlias(accountId: string): string {
  return createHmac('sha256', aliasKey).update(accountId).digest('hex').slice(0, 16);
}

const responseHeaderKeys = ['server', 'via', 'cf-ray', 'x-tt-logid', 'content-type'] as const;
function credentialRepresentations(secrets: readonly string[]): Set<string> {
  const candidates = new Set(secrets.filter(Boolean));
  const [user, password] = secrets;
  if (user || password) candidates.add((user || '') + ':' + (password || ''));
  const encoded = (value: string): string => {
    try { return encodeURIComponent(value); } catch { return value; }
  };
  const representations = new Set<string>();
  for (const value of candidates) {
    for (const plain of [value, encoded(value)]) {
      const base64 = Buffer.from(plain, 'utf8').toString('base64');
      const unpadded = base64.replace(/=+$/, '');
      for (const variant of [plain, base64, unpadded]) {
        representations.add(variant);
        representations.add(encoded(variant));
      }
    }
  }
  return representations;
}

function responseMetadata(headers: unknown, knownSecrets: readonly string[]): DiagnosticFields {
  const out: DiagnosticFields = {};
  if (!headers || typeof headers !== 'object') return out;
  const secrets = [...credentialRepresentations(knownSecrets)];
  for (const [key, raw] of Object.entries(headers)) {
    const name = responseHeaderKeys.find(allowed => allowed === key.toLowerCase());
    if (!name || typeof raw !== 'string') continue;
    // Redact before truncation. Encodings and auth schemes are not valid diagnostic values.
    const clean = raw.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim();
    const candidate = clean.replace(/%[\da-f]{2}/gi, escape => escape.toUpperCase());
    let decoded = candidate;
    try { decoded = decodeURIComponent(candidate); } catch { /* Compare the original spelling below. */ }
    const unsafe = /\b(?:basic|bearer|digest|negotiate|ntlm)\b|(?:authorization|cookie|password|passwd|token|secret|api[-_]?key)\b|:\/\/|@/i;
    if (unsafe.test(candidate) || unsafe.test(decoded) ||
        secrets.some(secret => raw.includes(secret) || candidate.includes(secret) || decoded.includes(secret))) continue;
    const value = (name === 'content-type' ? clean.split(';')[0].trim() : clean).slice(0, 96);
    const valid = name === 'content-type' ? /^[\w.+-]+\/[\w.+-]+$/.test(value)
      : name === 'cf-ray' ? /^[a-f\d]{8,32}(?:-[A-Z]{3})?$/i.test(value)
      : name === 'x-tt-logid' ? /^[a-f\d]{8,96}$/i.test(value)
      : name === 'via' ? /^[\w .:/,-]+$/.test(value)
      : /^[\w ./+-]+$/.test(value);
    if (valid) out[name] = value;
  }
  return out;
}

type RequestKind = 'document' | 'write' | 'resource';
type RequestInfo = { frame: string; loader: string; kind: RequestKind; at: number };
type ResponseObserver = (params: any, mainDocument: boolean, criticalWrite: boolean, observation?: ObservationReceipt) => number | undefined;
type NavigationEvent = { loader?: string; method: string; params: any; root: boolean };
type DiagnosticFields = Record<string, string | number | boolean>;
type RootDocument = {
  generation: number;
  responseStatus?: number;
  responseGeneration?: number;
  responseCached?: boolean;
  observation?: ObservationReceipt;
  reportedReplacement?: boolean;
  loader?: string;
  url?: string;
  evidence: boolean;
  committed: boolean;
  parsed: boolean;
  request?: { id: string; at: number };
  hop: number;
  failure?: NavigationFailure;
  httpFailure?: NavigationFailure;
  until: number;
};
type NavigationAttempt = {
  id: number; url: string; acknowledged: boolean; events: NavigationEvent[]; output: number;
  earlyRoots: Map<string, RequestInfo>;
  previous?: RootDocument; failure?: NavigationFailure; until?: number;
  expectedLoader?: string;
  command?: 'accepted' | 'superseded' | 'aborted' | 'failed';
};

export class NavigationTrace {
  private readonly target = randomUUID();
  private readonly account: string;
  private readonly requests = new Map<string, RequestInfo>();
  private readonly retired = new Set<string>();
  private readonly pending = new Map<string, RootDocument>();
  private readonly connectionEpoch = randomUUID();
  private documentGeneration = 0;
  private reviewFailure?: { sequence: number; code: NavigationFailure };
  private reviewSequence = 0;
  private observationUnconfirmed = false;
  private replaying = false;
  private commandedUrl?: string;
  private protocolSeq = 0;
  private active?: NavigationAttempt;
  private document?: RootDocument;
  private wake?: () => void;
  private sequence = 0;
  private lastNavigationLoader?: string;
  private lastRootRequestAt = -Infinity;
  private output = 0;
  private burstStart = Date.now();
  frame?: string;
  private restoredGeneration?: number;

  get url(): string | undefined { return this.document?.url; }
  get lastHttpFailure(): NavigationFailure | undefined { return this.document?.httpFailure; }
  get httpUntil(): number { return this.active?.until || this.document?.until || 0; }

  snapshot() {
    const root = this.document;
    return { target: this.target, connectionEpoch: this.connectionEpoch, generation: root?.generation,
      sequence: this.protocolSeq, command: this.active?.command,
      state: this.observationUnconfirmed || !root ? 'unknown' : this.pending.size || !root.parsed ? 'transitioning'
        : root.failure || root.httpFailure ? 'denied' : 'confirmed' } as const;
  }

  // Keep failed root hops visible to the manual reviewer even if a later hop succeeds.
  reviewDocument() {
    const root = this.document;
    return { ...this.snapshot(), url: root?.url,
      status: root?.responseGeneration === root?.generation && !root?.responseCached ? root?.responseStatus : undefined,
      reviewSequence: this.reviewSequence, failure: this.reviewFailure };
  }

  private noteReviewFailure(code: NavigationFailure): void {
    this.reviewFailure = { sequence: ++this.reviewSequence, code };
  }

  needsRootProof(): boolean {
    return this.observationUnconfirmed || (this.restoredGeneration !== undefined &&
      this.document?.generation === this.restoredGeneration && !this.document.parsed);
  }

  proveRoot(sequence: number, root: any, href: unknown, readyState: unknown, restriction: unknown): boolean {
    if (sequence !== this.protocolSeq || this.pending.size || !root || root.parentId || !root.id
      || root.id !== this.frame || typeof root.loaderId !== 'string' || this.retired.has(root.loaderId)
      || root.unreachableUrl || navigationPage(root.url) === 'error'
      || typeof href !== 'string' || href !== root.url || !['interactive', 'complete'].includes(String(readyState))
      || restriction !== '') return false;
    if (this.document?.loader !== root.loaderId) {
      this.commit(this.documentCandidate(root.loaderId, root.url, true));
    }
    const confirmed = this.document!;
    if (confirmed.failure || confirmed.httpFailure) return false;
    confirmed.url = root.url;
    confirmed.parsed = true;
    this.observationUnconfirmed = false;
    this.restoredGeneration = undefined;
    this.wake?.();
    return true;
  }

  assertBusinessReady(checkTarget = false): void {
    if (this.snapshot().state !== 'confirmed') throw new KernelNavigationError(this.lastHttpFailure || 'ownership_unconfirmed', this.httpUntil);
    if (!checkTarget || !this.commandedUrl || !this.url) return;
    const expected = new URL(this.commandedUrl);
    const actual = new URL(this.url);
    const target = (url: URL) => /\/(?:video|photo)\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
    if (expected.host.toLowerCase() !== actual.host.toLowerCase() &&
        expected.host.toLowerCase().replace(/^www\./, '') !== actual.host.toLowerCase().replace(/^www\./, '')) {
      throw new KernelNavigationError('business_target_mismatch');
    }
    const currentPath = (url: URL) => url.pathname.replace(/\/+$/, '') || '/';
    const expectedPath = currentPath(expected);
    const actualPath = currentPath(actual);
    if (target(expected)) {
      if (target(actual) !== target(expected)) throw new KernelNavigationError('business_target_mismatch');
    } else if (expectedPath !== '/' && expectedPath !== actualPath) {
      const knownTikTokUpload = /(^|\.)tiktok\.com$/i.test(expected.hostname)
        && ['/upload', '/tiktokstudio/upload'].includes(expectedPath) && ['/upload', '/tiktokstudio/upload'].includes(actualPath);
      if (!knownTikTokUpload) throw new KernelNavigationError('business_target_mismatch');
    } else if (expectedPath === '/' && /^\/(login|signin)(?:\/|$)/i.test(actualPath)) {
      throw new KernelNavigationError('business_target_mismatch');
    }
  }

  constructor(accountId: string, private readonly session: string, private readonly write: (fields: DiagnosticFields) => void,
    private readonly response: ResponseObserver, private readonly startObservation?: (connection: string, generation: number) => ObservationReceipt | undefined,
    private readonly responseContext?: () => { exitIp?: string; secrets: readonly string[] }) {
    this.account = diagnosticAccountAlias(accountId);
  }

  seed(frame: any): void {
    this.frame = frame?.id;
    if (!this.frame || typeof frame?.url !== 'string') { this.observationUnconfirmed = true; return; }
    const initial = this.documentCandidate(frame?.loaderId, frame?.url, true);
    initial.parsed = true;
    this.commit(initial);
  }

  private commit(document: RootDocument): void {
    const previous = this.document?.loader;
    if (previous && previous !== document.loader) {
      if (this.retired.size >= 64) this.retired.delete(this.retired.values().next().value!);
      this.retired.add(previous);
    }
    if (this.active?.acknowledged && this.document && previous !== document.loader && !document.reportedReplacement &&
        document.loader !== this.active.expectedLoader) {
      document.reportedReplacement = true;
      this.record('document_replaced', { page: navigationPage(document.url), ...this.refs(this.frame, document.loader) });
    }
    document.committed = true;
    if (document.loader) {
      for (const [loader, candidate] of this.pending) {
        if (candidate === document || candidate.generation < document.generation) this.pending.delete(loader);
      }
    }
    this.document = document;
    this.wake?.();
  }

  private documentCandidate(loader: string | undefined, url: string | undefined, observed = false): RootDocument {
    return { loader, url, evidence: observed, committed: false, parsed: false, hop: 0, until: 0, generation: ++this.documentGeneration };
  }

  begin(url: string): void {
    this.commandedUrl = url;
    this.active = { id: ++this.sequence, url, events: [], earlyRoots: new Map(), output: 0, acknowledged: false, previous: this.document };
    this.record('navigate_start', { page: navigationPage(url) });
  }

  acknowledge(result: any): void {
    const attempt = this.active;
    if (!attempt) return;
    attempt.acknowledged = true;
    if (!result?.frameId || (this.frame && result.frameId !== this.frame) || result.isDownload) {
      attempt.command = 'failed';
      attempt.failure ||= 'protocol';
      return;
    }
    this.frame = result.frameId;
    const loader = result.loaderId;
    attempt.expectedLoader = loader;
    const successorCommitted = this.document && this.document !== attempt.previous && this.document.loader !== loader;
    if (successorCommitted && this.document && !this.document.reportedReplacement) {
      this.document.reportedReplacement = true;
      this.record('document_replaced', { page: navigationPage(this.document.url), ...this.refs(this.frame, this.document.loader) });
    }
    if (loader && !successorCommitted && this.document?.loader !== loader && !this.pending.has(loader)) {
      this.pending.set(loader, this.documentCandidate(loader, attempt.url));
    }
    const early = attempt.events;
    attempt.events = [];
    attempt.earlyRoots.clear();
    this.replaying = true;
    try { for (const event of early) this.observe(event.method, event.params); }
    finally { this.replaying = false; }
    if (result.errorText) {
      const reason = (this.document !== attempt.previous ? this.lastHttpFailure : undefined) || navigationFailure(result.errorText);
      // Chrome can report the original command aborted after a proved successor took over.
      if (navigationFailure(result.errorText) === 'cancelled' && successorCommitted) {
        attempt.command = 'superseded';
      } else {
        attempt.command = reason === 'cancelled' ? 'aborted' : 'failed';
        attempt.failure ||= reason;
        this.record('navigate_error', { reason });
      }
    } else {
      attempt.command = 'accepted';
      if (!loader && this.document && this.document === attempt.previous && !this.pending.size) {
        this.document = { ...this.document, url: attempt.url, generation: ++this.documentGeneration };
        this.record('same_document');
      }
    }
  }

  async waitForDocument(signal: AbortSignal): Promise<NavigationFailure | 'ready'> {
    for (;;) {
      const attempt = this.active;
      if (!attempt) return 'connection';
      if (attempt.failure) return attempt.failure;
      const document = this.document;
      if (this.needsRootProof()) return 'ownership_unconfirmed';
      if (attempt.acknowledged && document && !this.pending.size) {
        if (document.failure) return document.failure;
        if (document.committed && document.parsed) return document.httpFailure || 'ready';
      }
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const notify = () => { clear(); resolve(); };
        const abort = () => { clear(); reject(signal.reason); };
        const clear = () => { if (this.wake === notify) this.wake = undefined; signal.removeEventListener('abort', abort); };
        this.wake = notify;
        signal.addEventListener('abort', abort, { once: true });
      });
    }
  }

  timeout(): NavigationFailure {
    return this.active?.failure || this.document?.httpFailure
      || (this.observationUnconfirmed || this.pending.size > 0 || !this.active?.acknowledged ? 'ownership_unconfirmed' : 'timeout');
  }

  finish(reason: string): void {
    if (!this.active) return;
    this.record('navigate_end', { reason }, true);
    this.lastNavigationLoader = this.document?.loader;
    this.active = undefined;
    this.wake?.();
  }

  disconnect(reason: NavigationFailure): void {
    this.finish(reason);
    this.requests.clear();
    this.retired.clear();
    this.pending.clear();
    this.document = undefined;
  }

  recordLogin(result: string, reason: string): void {
    this.record('login_check', { navigation: this.lastNavigationLoader === this.document?.loader ? this.sequence : 0, result, reason });
  }

  refs(frame?: string, loader?: string, request?: string): DiagnosticFields {
    const ref = (value: string) => createHmac('sha256', aliasKey).update(this.target).update(value).digest('hex').slice(0, 12);
    return {
      ...(typeof frame === 'string' ? { frameRef: ref(frame) } : {}),
      ...(typeof loader === 'string' ? { loaderRef: ref(loader) } : {}),
      ...(typeof request === 'string' ? { requestRef: ref(request) } : {}),
    };
  }

  record(event: string, fields: DiagnosticFields = {}, terminal = false): void {
    const now = Date.now();
    if (now - this.burstStart >= 60_000) { this.burstStart = now; this.output = 0; }
    const active = this.active;
    if (this.output >= (terminal ? 72 : 64) || (active && !terminal && active.output >= 24)) return;
    this.output++;
    if (active) active.output++;
    try { this.write({ version: 1, account: this.account, session: this.session, target: this.target, navigation: active?.id || 0, event, ...fields }); }
    catch { /* Diagnostic output is best effort. */ }
  }

  observe(method: string, p: any): void {
    if (!p) return;
    if (method === 'Fetch.authRequired' && p.authChallenge?.source === 'Proxy' && p.frameId === this.frame
        && (!p.resourceType || p.resourceType === 'Document')) this.noteReviewFailure('http_407');
    this.protocolSeq++;
    const attempt = this.active;
    const buffering = !!attempt && !attempt.acknowledged && !this.replaying;
    const request = (buffering && attempt.earlyRoots.get(p.requestId)) || this.requests.get(p.requestId);
    const continued = method === 'Network.responseReceived' || method === 'Network.loadingFailed' || method === 'Network.loadingFinished'
      || method === 'Network.requestServedFromCache';
    const frame = method === 'Page.frameNavigated' ? p.frame?.id : p.frameId || (continued ? request?.frame : undefined);
    const loader = method === 'Page.frameNavigated' ? p.frame?.loaderId : p.loaderId || (continued ? request?.loader : undefined);
    const root = !!this.frame && frame === this.frame;
    if (continued && request && ((p.frameId && p.frameId !== request.frame) || (p.loaderId && p.loaderId !== request.loader))) return;
    const restored = root && method === 'Page.frameNavigated' && p.type === 'BackForwardCacheRestore';
    if (typeof loader === 'string' && this.retired.has(loader) && !restored) return;

    const rootEvent = (root && (p.type === 'Document' || method === 'Page.frameNavigated' ||
      (method === 'Page.lifecycleEvent' && p.name === 'DOMContentLoaded') || method === 'Page.navigatedWithinDocument')) || request?.kind === 'document'
      || (method === 'Network.loadingFailed' && !request && p.type === 'Document');
    const resource = method === 'Network.responseReceived' && ['XHR', 'Fetch'].includes(p.type) && [403, 407, 429].includes(p.response?.status);
    if (attempt && buffering && (rootEvent || resource)) {
      if (root && method === 'Page.frameNavigated' && !p.frame?.parentId && typeof loader === 'string') {
        const matching = attempt.events.filter(event => event.loader === loader);
        attempt.events = attempt.events.filter(event => event.loader !== loader);
        for (const [id, recorded] of attempt.earlyRoots) {
          if (recorded.loader === loader) attempt.earlyRoots.delete(id);
        }
        this.replaying = true;
        try {
          if (loader !== this.document?.loader && !this.pending.has(loader)) this.pending.set(loader, this.documentCandidate(loader, p.frame.url));
          for (const event of matching) this.observe(event.method, event.params);
          this.observe(method, p);
        } finally { this.replaying = false; }
        return;
      }
      const priority = !!rootEvent;
      if (attempt.events.filter(event => event.root === priority).length < (priority ? 64 : 16)) {
        if (method === 'Network.requestWillBeSent' && root && p.type === 'Document' &&
            typeof loader === 'string' && loader && typeof p.requestId === 'string' && p.requestId &&
            Number.isFinite(p.timestamp) && p.timestamp >= this.lastRootRequestAt &&
            (!request || p.timestamp >= request.at) && typeof p.request?.url === 'string') {
          attempt.earlyRoots.set(p.requestId, { frame, loader, kind: 'document', at: p.timestamp });
        }
        attempt.events.push({ method, params: p, root: priority, loader });
        if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') attempt.earlyRoots.delete(p.requestId);
      } else if (priority) { this.observationUnconfirmed = true; this.wake?.(); }
      return;
    }

    const document = loader ? (this.pending.get(loader) || (loader === this.document?.loader ? this.document : undefined)) : undefined;
    const current = !!document;
    switch (method) {
      case 'Network.requestWillBeSent':
        this.requestStarted(p, frame, loader, root, request);
        break;
      case 'Network.requestServedFromCache':
        if (root && document && document.request?.id === p.requestId) document.responseCached = true;
        break;
      case 'Network.responseReceived':
        if (root && loader && (!current || (this.pending.size && document === this.document && request?.kind !== 'document'))) return;
        if (request && (p.timestamp < request.at || (loader && request.loader !== loader))) return;
        this.responseReceived(p, frame, loader, root && (p.type === 'Document' || (p.type === undefined && request?.kind === 'document')) ? document : undefined, request);
        break;
      case 'Page.frameNavigated':
        if (p.frame.parentId) return;
        if (!root) { this.observationUnconfirmed = true; this.wake?.(); return; }
        if (restored) {
          this.retired.delete(loader);
          const recovered = this.documentCandidate(loader, p.frame.url, true);
          this.commit(recovered);
          this.restoredGeneration = recovered.generation;
        } else if (document) {
          document.evidence = document.committed = true;
          document.url = p.frame.url;
          if (p.frame.unreachableUrl || navigationPage(document.url) === 'error') {
            document.failure = document.httpFailure || document.failure || 'browser_error';
            this.noteReviewFailure(document.failure);
          }
          this.commit(document);
        } else { this.observationUnconfirmed = true; }
        this.wake?.();
        break;
      case 'Page.navigatedWithinDocument':
        if (root && this.document && typeof p.url === 'string') {
          this.document = { ...this.document, url: p.url, generation: ++this.documentGeneration };
          this.record('same_document');
          this.wake?.();
        }
        break;
      case 'Page.lifecycleEvent':
        if (root && current && document && p.name === 'DOMContentLoaded') {
          document.evidence = document.parsed = true;
          this.wake?.();
        }
        break;
      case 'Network.loadingFailed':
      case 'Network.loadingFinished': {
        if (request && p.timestamp < request.at) return;
        this.requests.delete(p.requestId);
        if (method !== 'Network.loadingFailed') return;
        const main = current && document?.request?.id === p.requestId && request?.kind === 'document';
        const reason = p.canceled ? 'cancelled' : navigationFailure(p.errorText);
        if (main || (request && (!loader || current) && !p.canceled)) {
          this.record('loading_failed', { kind: main ? 'document' : request?.kind || 'resource', reason, ...this.refs(frame, loader, p.requestId) });
        }
        if (main && document) {
          this.noteReviewFailure(reason);
          document.failure ||= document.httpFailure || reason;
          if (loader && this.pending.delete(loader)) {
            if (this.active && !this.pending.size) this.active.failure ||= document.failure;
            if (this.retired.size >= 64) this.retired.delete(this.retired.values().next().value!);
            this.retired.add(loader);
          }
          this.wake?.();
        }
        break;
      }
    }
  }

  private requestStarted(p: any, frame: string, loader: string, root: boolean, previous?: RequestInfo): void {
    if (typeof p.requestId !== 'string' || (previous && p.timestamp < previous.at)) return;
    const kind: RequestKind = root && p.type === 'Document' ? 'document' : this.isWrite(p.request) ? 'write' : 'resource';
    if (kind === 'document' && p.timestamp < this.lastRootRequestAt) return;
    if (this.requests.size >= 2048) this.requests.delete(this.requests.keys().next().value!);
    this.requests.set(p.requestId, { frame, loader, kind, at: p.timestamp });
    if (kind === 'write') this.record('request_start', { kind, page: navigationPage(p.request?.url), ...this.refs(frame, loader, p.requestId) });
    if (kind !== 'document' || !loader || typeof p.request?.url !== 'string' || !Number.isFinite(p.timestamp)) return;

    let document = this.pending.get(loader) || (loader === this.document?.loader ? this.document : undefined);
    if (!document) {
      const predecessor = [...this.pending.values()].at(-1) || this.document;
      if ((this.replaying && this.active && !predecessor?.evidence) || p.timestamp <= this.lastRootRequestAt) return;
      if (this.pending.size >= 64) { this.observationUnconfirmed = true; this.wake?.(); return; }
      const replacing = !!this.document;
      document = this.documentCandidate(loader, p.request.url);
      this.pending.set(loader, document);
      if (replacing) {
        document.reportedReplacement = true;
        this.record('document_replaced', { page: navigationPage(p.request.url), ...this.refs(frame, loader, p.requestId) });
      }
    }
    this.lastRootRequestAt = p.timestamp;
    document.evidence = true;
    if (!document.request || p.redirectResponse) {
      document.responseStatus = undefined;
      document.responseCached = false;
      const redirectStatus = p.redirectResponse?.status;
      if (redirectStatus >= 400) this.noteReviewFailure(redirectStatus === 403 ? 'http_403' : redirectStatus === 407 ? 'http_407'
        : redirectStatus === 429 ? 'http_429' : redirectStatus >= 500 ? 'http_5xx' : 'http_error');
    }
    document.request = { id: p.requestId, at: p.timestamp };
    document.observation ||= this.startObservation?.(this.connectionEpoch, document.generation);
    document.url = p.request.url;
    const status = p.redirectResponse?.status;
    this.record(p.redirectResponse ? 'redirect' : 'request_start', {
      kind, hop: ++document.hop, page: navigationPage(p.request.url), ...this.refs(frame, loader, p.requestId),
      ...(Number.isInteger(status) && status >= 300 && status <= 399 ? { status } : {}),
    });
  }

  private responseReceived(p: any, frame: string, loader: string, document?: RootDocument, request?: RequestInfo): void {
    const status = p.response?.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) return;
    if (document && status >= 400) this.noteReviewFailure(status === 403 ? 'http_403' : status === 407 ? 'http_407'
      : status === 429 ? 'http_429' : status >= 500 ? 'http_5xx' : 'http_error');
    if (document?.responseStatus !== undefined && document.responseStatus !== 407) return;
    if (document) {
      document.responseStatus = status;
      document.responseGeneration = document.generation;
      document.responseCached ||= p.response?.fromDiskCache === true || p.response?.fromServiceWorker === true
        || p.response?.fromPrefetchCache === true;
    }
    const main = !!document;
    const kind = main ? 'document' : request?.kind === 'write' ? 'write' : 'resource';
    const denial = (status === 403 || status === 429) && (main || kind === 'write');
    let details: DiagnosticFields = {};
    if (denial) {
      try {
        const context = this.responseContext?.();
        details = responseMetadata(p.response.headers, context?.secrets || []);
        if (context?.exitIp && !context.exitIp.includes('%') && isIP(context.exitIp)) details.exitIp = context.exitIp;
      } catch { /* Logging must never prevent response protection. */ }
    }
    if (document || [403, 407, 429].includes(status)) {
      this.record('response', {
        ...details, kind, status, page: navigationPage(p.response.url), ...(document?.hop ? { hop: document.hop } : {}),
        ...this.refs(frame, loader, p.requestId),
        source: p.response.fromServiceWorker === true ? 'service_worker' : p.response.fromDiskCache === true ? 'cache' : 'unknown',
      }, main && [403, 407, 429].includes(status));
    }
    const cooldown = this.response(p, main, kind === 'write', document?.observation);
    if (!document) return;
    document.evidence = true;
    document.url = p.response.url || document.url;
    document.httpFailure = status === 403 ? 'http_403' : status === 407 ? 'http_407' : status === 429 ? 'http_429'
      : status >= 500 ? 'http_5xx' : status >= 400 ? 'http_error' : undefined;
    document.until = cooldown || 0;
    const attempt = this.active;
    if (attempt && !attempt.failure && (document.httpFailure === 'http_403' || document.httpFailure === 'http_429')) {
      attempt.failure = document.httpFailure;
      attempt.until = document.until;
    }
    // A proxy can challenge before producing the final document response.
    if (document.httpFailure && document.httpFailure !== 'http_407') {
      document.failure ||= document.httpFailure;
      if (attempt && this.pending.size === 1 && this.pending.has(loader)) attempt.failure ||= document.failure;
    }
    this.wake?.();
  }

  private isWrite(request: any): boolean {
    if (!/^(POST|PUT|PATCH|DELETE)$/i.test(request?.method)) return false;
    try {
      return /\/(?:comment\/(?:publish|reply)|commit\/(?:item\/digg|follow\/user)|(?:post|reply)\/(?:create|publish)|statuses\/update|friendships\/create)(?:\/|$)/i.test(new URL(request.url).pathname);
    } catch { return false; }
  }
}
