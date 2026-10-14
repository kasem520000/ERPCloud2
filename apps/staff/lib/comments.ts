import { apiData, apiDelete, apiPost, apiPut } from './api';

export type CommentRow = {
  id: string;
  body: string;
  authorId: string;
  authorName: string;
  parentId: string | null;
  isResolved: boolean;
  deleted: boolean;
  createdAt: string;
  replies?: CommentRow[];
};

export type CommentThread = {
  count: number;
  openCount: number;
  comments: CommentRow[];
};

export type MentionRow = {
  id: string;
  commentId: string;
  isRead: boolean;
  createdAt: string;
  entityType: string;
  entityId: string;
  authorName: string;
  excerpt: string;
  href: string;
};

export const listComments = (entityType: string, entityId: string, openOnly = false) =>
  apiData<CommentThread>(`/comments?entity_type=${entityType}&entity_id=${entityId}${openOnly ? '&open=true' : ''}`);

export const suggestMentions = (q: string) => apiData<Array<{ id: string; name: string }>>(`/comments/suggest?q=${encodeURIComponent(q)}`);

export const createComment = (body: { entityType: string; entityId: string; body: string; parentId?: string }) =>
  apiPost<CommentRow>('/comments', body);

export const updateComment = (id: string, body: string) => apiPut<CommentRow>(`/comments/${id}`, { body });

export const resolveComment = (id: string) => apiPut<CommentRow>(`/comments/${id}/resolve`, {});

export const deleteComment = (id: string) => apiDelete<{ id: string }>(`/comments/${id}`);

export const listMentions = (unreadOnly = false) =>
  apiData<MentionRow[]>(`/comments/mentions${unreadOnly ? '?is_read=false' : ''}`);

export const markMentionRead = (id: string) => apiPost<{ id: string }>(`/comments/mentions/${id}/read`, {});
