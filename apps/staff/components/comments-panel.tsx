'use client';

import { useEffect, useState } from 'react';

import { ApiError } from '../lib/api';
import {
  createComment,
  deleteComment,
  listComments,
  resolveComment,
  suggestMentions,
  updateComment,
  type CommentRow,
} from '../lib/comments';
import { useSession } from '../lib/session';

export function CommentsPanel({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { can, me } = useSession();
  const [thread, setThread] = useState<CommentRow[]>([]);
  const [count, setCount] = useState(0);
  const [openOnly, setOpenOnly] = useState(false);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Array<{ id: string; name: string }>>([]);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const canRead = can('comment.view');
  const canWrite = can('comment.manage');
  const userId = me?.user.id;

  async function reload() {
    const next = await listComments(entityType, entityId, openOnly);
    setThread(next.comments);
    setCount(next.count);
  }

  useEffect(() => {
    if (!entityId || !canRead) return;
    void reload().catch((error: unknown) => setNotice(error instanceof ApiError ? error.message : String(error)));
  }, [entityType, entityId, openOnly, canRead]);

  useEffect(() => {
    const match = /@([\p{L}\p{N}_.-]{1,40})$/u.exec(body);
    if (!match?.[1] || !canWrite) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(() => {
      void suggestMentions(match[1] ?? '')
        .then(setSuggestions)
        .catch(() => setSuggestions([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [body, canWrite]);

  function pick(person: { id: string; name: string }) {
    setBody((current) => current.replace(/@([\p{L}\p{N}_.-]{1,40})$/u, `@${person.name} @[${person.id}] `));
    setSuggestions([]);
  }

  async function submit() {
    setBusy(true);
    setNotice(undefined);
    try {
      if (editing) await updateComment(editing, body);
      else await createComment({ entityType, entityId, body, parentId: replyTo ?? undefined });
      setBody('');
      setReplyTo(null);
      setEditing(null);
      await reload();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!canRead) return null;

  return (
    <section className="card">
      <div className="toolbar">
        <h3>تعليقات ({count})</h3>
        <label className="field inline">
          <input type="checkbox" checked={openOnly} onChange={(event) => setOpenOnly(event.target.checked)} />
          <span>المفتوحة فقط</span>
        </label>
      </div>
      {notice ? <p className="alert danger">{notice}</p> : null}
      {thread.map((comment) => (
        <CommentItem
          key={comment.id}
          comment={comment}
          userId={userId}
          canWrite={canWrite}
          busy={busy}
          onReply={() => {
            setReplyTo(comment.id);
            setEditing(null);
          }}
          onEdit={(id, text) => {
            setEditing(id);
            setReplyTo(null);
            setBody(text);
          }}
          onResolve={() => void resolveComment(comment.id).then(reload).catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))}
          onDelete={() => void deleteComment(comment.id).then(reload).catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)))}
        />
      ))}
      {canWrite ? (
        <div className="grid gap-2">
          {replyTo ? <p className="muted">رد على تعليق</p> : null}
          {editing ? <p className="muted">تعديل تعليقك</p> : null}
          <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="اكتب تعليقاً. @ يفتح الزملاء" />
          {suggestions.length > 0 ? (
            <ul>
              {suggestions.map((person) => (
                <li key={person.id}>
                  <button className="btn" type="button" onClick={() => pick(person)}>
                    @{person.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <button className="btn primary" type="button" disabled={busy || !body.trim()} onClick={() => void submit()}>
            حفظ
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CommentItem({
  comment,
  userId,
  canWrite,
  busy,
  onReply,
  onEdit,
  onResolve,
  onDelete,
}: {
  comment: CommentRow;
  userId?: string;
  canWrite: boolean;
  busy: boolean;
  onReply: () => void;
  onEdit: (id: string, body: string) => void;
  onResolve: () => void;
  onDelete: (id: string) => void;
}) {
  const mine = userId === comment.authorId;
  return (
    <article className="border-t py-2" style={comment.isResolved || comment.deleted ? { opacity: 0.55 } : undefined}>
      <strong>{comment.authorName}</strong>
      {comment.isResolved ? <span className="badge"> تم الحل</span> : null}
      <p>{comment.body}</p>
      {canWrite && !comment.deleted ? (
        <div className="flex gap-2">
          {!comment.parentId && !comment.isResolved ? (
            <button className="btn" type="button" disabled={busy} onClick={onReply}>
              رد
            </button>
          ) : null}
          {!comment.parentId && !comment.isResolved ? (
            <button className="btn" type="button" disabled={busy} onClick={onResolve}>
              حل
            </button>
          ) : null}
          {mine ? (
            <>
              <button className="btn" type="button" disabled={busy} onClick={() => onEdit(comment.id, comment.body)}>
                تعديل
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => onDelete(comment.id)}>
                حذف
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {(comment.replies ?? []).map((reply) => (
        <div key={reply.id} className="ms-4 border-s ps-3" style={reply.deleted ? { opacity: 0.55 } : undefined}>
          <strong>{reply.authorName}</strong>
          <p>{reply.body}</p>
          {canWrite && reply.authorId === userId && !reply.deleted ? (
            <div className="flex gap-2">
              <button className="btn" type="button" disabled={busy} onClick={() => onEdit(reply.id, reply.body)}>
                تعديل
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => onDelete(reply.id)}>
                حذف الرد
              </button>
            </div>
          ) : null}
        </div>
      ))}
    </article>
  );
}
