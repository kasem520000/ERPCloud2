'use client';

import { Check, Copy, Terminal } from 'lucide-react';
import { useState } from 'react';

type Token = { text: string; cls: string };

/**
 * إبراز خفيف لـ JSON/مفاتيح: سلاسل، أرقام، مفتاح/قيمة، وأقواس — بلا مكتبة خارجية.
 * صك Linear/المفحط: خلفية slate-950، أقواس، رقم سطر اختياري.
 */
function tokenizeJson(line: string, lineIdx: number): Token[] {
  const tokens: Token[] = [];
  const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}[\],:])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) tokens.push({ text: line.slice(last, match.index), cls: 'text-muted' });
    const [full, str, colon, num, bool, nul, punct] = match;
    if (str !== undefined) tokens.push({ text: str, cls: colon ? 'text-info' : 'text-ok' });
    if (colon) tokens.push({ text: colon, cls: 'text-muted' });
    if (num !== undefined) tokens.push({ text: num, cls: 'text-warn' });
    if (bool !== undefined) tokens.push({ text: bool, cls: 'text-brand-2' });
    if (nul !== undefined) tokens.push({ text: nul, cls: 'text-muted' });
    if (punct !== undefined) tokens.push({ text: punct, cls: 'text-muted' });
    last = match.index + full.length;
  }
  if (last < line.length) tokens.push({ text: line.slice(last), cls: 'text-muted' });
  void lineIdx;
  return tokens;
}

/** بلوك كود — نسخ بنقرة، وأرقام أسطر، وإبراز JSON/مفاتيح خفيف. */
export function CodeBlock({ code, title, lines = true }: { code: string; title?: string; lines?: boolean }) {
  const [copied, setCopied] = useState(false);
  const rows = code.replace(/\n$/, '').split('\n');

  return (
    <div className="overflow-hidden rounded-[10px] border border-inverse-line bg-inverse shadow-2">
      <div className="flex items-center justify-between gap-2 border-b border-inverse-line bg-inverse px-3 py-2">
        <span className="flex items-center gap-2 text-[11.5px] font-bold text-muted">
          <Terminal size={13} />
          {title ?? 'output'}
        </span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
          className="flex items-center gap-1.5 rounded-md border border-inverse-line bg-inverse px-2.5 py-1 text-[11.5px] font-bold text-muted transition-colors duration-150 hover:bg-inverse hover:text-on-accent"
        >
          {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
          {copied ? 'تم النسخ' : 'نسخ'}
        </button>
      </div>
      <pre
        dir="ltr"
        className="m-0 overflow-auto p-3 text-start font-mono text-[12px] leading-[1.7] text-muted"
        style={{ fontFamily: 'var(--font-mono)', maxHeight: 420 }}
      >
        {rows.map((row, i) => (
          <div key={i} className="flex">
            {lines ? (
              <span className="w-8 flex-none select-none pe-3 text-end text-ink-2">{i + 1}</span>
            ) : null}
            <span className="whitespace-pre-wrap break-all">
              {tokenizeJson(row, i).map((token, j) => (
                <span key={j} className={token.cls}>
                  {token.text}
                </span>
              ))}
              {row === '' ? ' ' : ''}
            </span>
          </div>
        ))}
      </pre>
    </div>
  );
}
