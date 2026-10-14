'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { ApiError, apiData, apiOpen, apiPost } from '../lib/api';

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type Suggestion = { kind?: string; title: string; body: string };
type ConversationRow = { id: string; title: string; updated_at?: string };
type StoredConversation = {
  id: string;
  messages: Array<{ role?: string; content?: string }>;
};

const PROMPTS = ['مبيعات اليوم', 'عملاء متأخرون', 'كيف أنشئ فاتورة مبيعات؟', 'كيف أرحل قيد؟'];
const GREETING = 'اسأل عن شاشة، أو عن مجاميع منشأتك. لا أرحّل قيوداً، ولا أقرأ رواتب أو أرقام هوية.';

function RichText({ text }: { text: string }) {
  const parts = text.split(/(\/[a-z0-9][a-z0-9\-/]*)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith('/') ? (
          <Link key={`${part}-${index}`} href={part}>
            {part}
          </Link>
        ) : (
          <span key={`${index}-${part.slice(0, 8)}`}>{part}</span>
        ),
      )}
    </>
  );
}

function suggestionHref(kind?: string): string | undefined {
  if (kind === 'low_stock') return '/inventory/items';
  if (kind === 'overdue_invoices') return '/sales/invoices';
  return undefined;
}

export function AssistantChat({ compact = false }: { compact?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: 'assistant', content: GREETING }]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  async function loadConversations() {
    const rows = await apiData<ConversationRow[]>('/ai/conversations');
    setConversations(Array.isArray(rows) ? rows : []);
  }

  async function loadSuggestions() {
    let rows = await apiData<Suggestion[]>('/ai/suggestions');
    if (!compact && (!Array.isArray(rows) || rows.length === 0)) {
      const created = await apiPost<Suggestion[]>('/ai/suggest', {});
      rows = Array.isArray(created) ? created : rows;
    }
    setSuggestions(Array.isArray(rows) ? rows : []);
  }

  useEffect(() => {
    void loadSuggestions().catch(() => setSuggestions([]));
    if (!compact) void loadConversations().catch(() => setConversations([]));
  }, [compact]);

  async function openConversation(id: string) {
    const row = await apiData<StoredConversation>(`/ai/conversations/${id}`);
    const history = (row.messages ?? [])
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content ?? '' }));
    setConversationId(row.id);
    setMessages(history.length > 0 ? history : [{ role: 'assistant', content: GREETING }]);
  }

  function startNew() {
    setConversationId(undefined);
    setMessages([{ role: 'assistant', content: GREETING }]);
  }

  async function ask(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setDraft('');
    setMessages((current) => [...current, { role: 'user', content: message }, { role: 'assistant', content: '' }]);
    setBusy(true);
    try {
      const response = await apiOpen('/ai/chat', {
        method: 'POST',
        headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ message, conversationId, stream: true }),
      });
      if (!response.ok || !response.body) {
        const problem = (await response.json().catch(() => ({}))) as { title?: string; detail?: string };
        throw new ApiError(response.status, 'AI_ERROR', problem.title || problem.detail || 'تعذر إكمال الإجابة');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assembled = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          const dataLine = event.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const payload = JSON.parse(dataLine.slice(6)) as {
            type?: string;
            text?: string;
            conversationId?: string;
            message?: string;
          };
          if (payload.conversationId) setConversationId(payload.conversationId);
          if (payload.type === 'error') throw new Error(payload.message || 'تعذر إكمال الإجابة');
          if (payload.type === 'delta' && payload.text) {
            assembled += payload.text;
            const snapshot = assembled;
            setMessages((current) => {
              const next = [...current];
              next[next.length - 1] = { role: 'assistant', content: snapshot };
              return next;
            });
          }
          if (payload.type === 'done' && payload.text) {
            assembled = payload.text;
            const finalText = payload.text;
            setMessages((current) => {
              const next = [...current];
              next[next.length - 1] = { role: 'assistant', content: finalText };
              return next;
            });
          }
        }
      }
      if (!compact) void loadConversations().catch(() => undefined);
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'تعذر إكمال الإجابة';
      setMessages((current) => {
        const next = [...current];
        next[next.length - 1] = { role: 'assistant', content: failure };
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  const suggestionBlock =
    suggestions.length > 0 ? (
      <div className="assistant-suggestions">
        {suggestions.slice(0, compact ? 1 : 3).map((suggestion) => {
          const href = suggestionHref(suggestion.kind);
          return (
            <p key={`${suggestion.kind ?? suggestion.title}`} className="alert warn">
              {suggestion.body || suggestion.title}
              {href ? (
                <>
                  {' '}
                  <Link href={href}>{href}</Link>
                </>
              ) : null}
            </p>
          );
        })}
      </div>
    ) : null;

  const thread = (
    <div className={compact ? 'assistant-compact' : 'assistant-panel'}>
      {suggestionBlock}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {PROMPTS.map((prompt) => (
          <button key={prompt} className="btn" type="button" disabled={busy} onClick={() => void ask(prompt)}>
            {prompt}
          </button>
        ))}
      </div>
      <div className="chat-log" aria-live="polite">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className={`chat-bubble ${message.role}`}>
            <RichText text={message.content || (busy && index === messages.length - 1 ? '…' : '')} />
          </div>
        ))}
      </div>
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <input
          className="input"
          value={draft}
          placeholder="اسأل: كم ربح فرع الرياض؟"
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy}
        />
        <button className="btn primary" type="submit" disabled={busy || !draft.trim()}>
          {busy ? '…' : 'اسأل'}
        </button>
      </form>
    </div>
  );

  if (compact) return thread;

  return (
    <div className="assistant-layout">
      <aside className="assistant-side" aria-label="المحادثات">
        <button className="btn" type="button" onClick={startNew}>
          محادثة جديدة
        </button>
        {conversations.map((conversation) => (
          <button
            key={conversation.id}
            className="btn"
            type="button"
            onClick={() => void openConversation(conversation.id).catch(() => undefined)}
          >
            {conversation.title || 'محادثة'}
          </button>
        ))}
      </aside>
      {thread}
    </div>
  );
}
