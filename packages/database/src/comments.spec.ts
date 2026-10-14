import { describe, expect, it } from 'vitest';

import {
  CommentRuleError,
  assertAuthor,
  assertBody,
  assertEntityType,
  assertReplyParent,
  extractUuidMentions,
  resolveOpenComment,
  suggestMentions,
  threadComments,
} from './comments.js';

describe('document comments and mentions', () => {
  it('extracts a saved user id and ignores a bare name', () => {
    const body = 'راجع @[11111111-1111-4111-8111-111111111111] يا أحمد';
    expect(extractUuidMentions(body)).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('suggests أحمد and skips an unrelated colleague', () => {
    const users = [
      { id: 'a', name: 'أحمد العلي' },
      { id: 'b', name: 'سارة' },
    ];
    expect(suggestMentions(users, 'أحمد').map((user) => user.id)).toEqual(['a']);
  });

  it('rejects an empty comment', () => {
    expect(() => assertBody('   ')).toThrow(CommentRuleError);
  });

  it('rejects an unknown document type', () => {
    expect(() => assertEntityType('invoice_line')).toThrow(CommentRuleError);
    expect(assertEntityType('sales_invoice')).toBe('sales_invoice');
  });

  it('nests a reply under its parent', () => {
    const threaded = threadComments([
      { id: 'root', parentId: null, body: 'سؤال' },
      { id: 'reply', parentId: 'root', body: 'جواب' },
    ]);
    expect(threaded).toHaveLength(1);
    expect(threaded[0]?.replies.map((reply) => reply.id)).toEqual(['reply']);
  });

  it('refuses a reply to a reply', () => {
    expect(() => assertReplyParent({ parentId: 'root', isResolved: false })).toThrow(CommentRuleError);
  });

  it('marks an open comment resolved and refuses a second resolve', () => {
    const resolved = resolveOpenComment({ id: 'c', isResolved: false });
    expect(resolved.isResolved).toBe(true);
    expect(() => resolveOpenComment(resolved)).toThrow(CommentRuleError);
  });

  it('lets only the author edit', () => {
    expect(() => assertAuthor('author', 'other')).toThrow(CommentRuleError);
    expect(() => assertAuthor('author', 'author')).not.toThrow();
  });
});
