import { validatedCommentPosts, type CommentPost } from './matrixCommentPosts';

export function commentVideoId(post: CommentPost): string {
  return post.url.slice(post.url.lastIndexOf('/') + 1);
}

export function commentPostKey(post: CommentPost): string {
  return JSON.stringify([commentVideoId(post), post.text]);
}

export function commentWorkbookContent(input: unknown): string {
  return JSON.stringify(validatedCommentPosts(input).map(commentPostKey).sort());
}

export interface CommentAssignmentPlan {
  assignments: Map<string, CommentPost[]>;
  owners: Map<string, string>;
  unassigned: CommentPost[];
}

export interface SavedCommentAssignmentPlan {
  version: 2;
  owners: Partial<Record<string, string>>;
}

export interface CommentAssignmentPreview {
  seed: string;
  plan: SavedCommentAssignmentPlan;
  availableAccountIds: string[];
  ledger: Partial<Record<string, { status: 'pending' | 'confirmed'; accountId: string | null }>>;
}

/** Reproduce the same draft at save time so a stale preview can be detected. */
export function commentAssignmentRandom(seed: string): () => number {
  let state = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    state = Math.imul(state ^ seed.charCodeAt(index), 16777619);
  }
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let end = items.length - 1; end > 0; end--) {
    const index = Math.floor(random() * (end + 1));
    [items[end], items[index]] = [items[index], items[end]];
  }
  return items;
}

export function planCommentAssignments({
  posts, accountIds, previousOwners = new Map(), recordedOwners = new Map(), retainedAccountIds = [], random = Math.random,
}: {
  posts: readonly CommentPost[];
  accountIds: readonly string[];
  previousOwners?: ReadonlyMap<string, string>;
  recordedOwners?: ReadonlyMap<string, string | null>;
  retainedAccountIds?: readonly string[];
  random?: () => number;
}): CommentAssignmentPlan {
  const available = [...new Set(accountIds)].sort();
  const assignments = new Map(available.map(id => [id, [] as CommentPost[]]));
  const retained = new Set([...available, ...retainedAccountIds]);
  const owners = new Map<string, string>();
  const loads = new Map(available.map(id => [id, 0]));
  const videoLoads = new Map<string, Map<string, number>>();
  const remaining = new Map<string, string[]>();
  const add = (video: string, key: string, account: string) => {
    owners.set(key, account);
    if (!assignments.has(account)) return;
    let perAccount = videoLoads.get(video);
    if (!perAccount) videoLoads.set(video, perAccount = new Map());
    perAccount.set(account, (perAccount.get(account) ?? 0) + 1);
    loads.set(account, (loads.get(account) ?? 0) + 1);
  };
  for (const post of posts) {
    const video = commentVideoId(post);
    const key = commentPostKey(post);
    if (recordedOwners.has(key)) {
      const account = recordedOwners.get(key);
      if (account && previousOwners.get(key) === account) add(video, key, account);
      else if (account) owners.set(key, account);
      continue;
    }
    const previous = previousOwners.get(key);
    if (previous && (retained.has(previous) || !available.length)) {
      add(video, key, previous);
      continue;
    }
    const group = remaining.get(video);
    if (group) group.push(key);
    else remaining.set(video, [key]);
  }
  if (available.length) {
    for (const [video, group] of shuffle([...remaining].sort(([a], [b]) => a.localeCompare(b)), random)) {
      for (const key of shuffle(group.sort(), random)) {
        const perAccount = videoLoads.get(video);
        // Per-video counts come first. Only choose more work for lighter accounts when those counts tie.
        const ranked = shuffle([...available], random);
        ranked.sort((a, b) => (perAccount?.get(a) ?? 0) - (perAccount?.get(b) ?? 0)
          || (loads.get(a) ?? 0) - (loads.get(b) ?? 0));
        add(video, key, ranked[0]);
      }
    }
  }
  const unassigned: CommentPost[] = [];
  for (const post of posts) {
    const key = commentPostKey(post);
    if (recordedOwners.has(key)) continue;
    const owner = owners.get(key);
    const assigned = owner === undefined ? undefined : assignments.get(owner);
    if (assigned) assigned.push(post);
    else if (!owner) unassigned.push(post);
  }
  return { assignments, owners, unassigned };
}
