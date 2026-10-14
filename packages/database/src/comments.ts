/**
 * Comment rules that do not touch the database.
 * A mention is either `@[uuid]` chosen from the list, or a unique `@name` in the same tenant.
 * Replies are one level deep. A resolved thread is closed.
 */

export const COMMENT_ENTITY_TYPES = ['sales_invoice', 'purchase_invoice', 'party', 'employee', 'project', 'project_task'] as const;
export type CommentEntityType = (typeof COMMENT_ENTITY_TYPES)[number];

export class CommentRuleError extends Error {
  constructor(readonly rule: 'BODY' | 'ENTITY' | 'PARENT' | 'DEPTH' | 'RESOLVED' | 'AUTHOR') {
    super(rule);
    this.name = 'CommentRuleError';
  }
}

const UUID_MENTION = /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

export function assertBody(body: string): string {
  const text = body.trim();
  if (text.length < 1 || text.length > 4000) throw new CommentRuleError('BODY');
  return text;
}

export function assertEntityType(value: string): CommentEntityType {
  if (!(COMMENT_ENTITY_TYPES as readonly string[]).includes(value)) throw new CommentRuleError('ENTITY');
  return value as CommentEntityType;
}

export function extractUuidMentions(body: string): string[] {
  return [...new Set([...body.matchAll(UUID_MENTION)].map((match) => match[1]?.toLowerCase() ?? '').filter(Boolean))];
}

export function extractNameMentions(body: string): string[] {
  const plain = body.replace(UUID_MENTION, ' ');
  return [...new Set([...plain.matchAll(/@([\p{L}\p{N}_.-]{2,40})/gu)].map((match) => match[1] ?? '').filter(Boolean))];
}

export type MentionCandidate = { id: string; name: string };

export function suggestMentions(users: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return users.filter((user) => user.name.toLowerCase().includes(needle)).slice(0, 8);
}

export function resolveNameMentions(users: readonly MentionCandidate[], names: readonly string[]): string[] {
  const ids: string[] = [];
  for (const name of names) {
    const matches = suggestMentions(users, name);
    if (matches.length === 1 && matches[0]) ids.push(matches[0].id);
  }
  return [...new Set(ids)];
}

export function threadComments<T extends { id: string; parentId: string | null }>(
  rows: readonly T[],
): Array<T & { replies: T[] }> {
  return rows
    .filter((row) => !row.parentId)
    .map((root) => ({ ...root, replies: rows.filter((row) => row.parentId === root.id) }));
}

export function assertReplyParent(parent: { parentId: string | null; isResolved: boolean } | null): void {
  if (!parent) throw new CommentRuleError('PARENT');
  if (parent.parentId) throw new CommentRuleError('DEPTH');
  if (parent.isResolved) throw new CommentRuleError('RESOLVED');
}

export function resolveOpenComment<T extends { isResolved: boolean }>(comment: T): T & { isResolved: true } {
  if (comment.isResolved) throw new CommentRuleError('RESOLVED');
  return { ...comment, isResolved: true };
}

export function assertAuthor(authorId: string, actorId: string): void {
  if (authorId !== actorId) throw new CommentRuleError('AUTHOR');
}
