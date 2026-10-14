import { Decimal } from 'decimal.js';

import { estimateTokens, type AiProviderName, type LlmPort, type LlmRequest } from './ai-engine.js';

/**
 * Model ports. The HTTP answer is streamed to the browser after this call
 * returns, and only after unknown figures are stripped. A provider failure
 * falls back to the grounded Arabic answer so a missing key never hides the
 * tenant's own totals.
 */

export type LlmConfig = {
  provider: AiProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
};

type RemoteUsage = { tokensIn: number; tokensOut: number; text: string };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) throw new Error(`llm ${response.status}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function completeOpenAi(config: LlmConfig, input: LlmRequest): Promise<RemoteUsage> {
  const defaultBase =
    config.provider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : 'https://api.openai.com';
  const rawBase = (config.baseUrl || defaultBase).replace(/\/+$/, '');
  const endpoint = rawBase.endsWith('/chat/completions')
    ? rawBase
    : rawBase.endsWith('/v1') || rawBase.endsWith('/openai')
      ? `${rawBase}/chat/completions`
      : `${rawBase}/v1/chat/completions`;
  const defaultModel = config.provider === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model || defaultModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await readJson(response);
  const choice = (body.choices as Array<{ message?: { content?: string } }> | undefined)?.[0];
  const usage = body.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    text: choice?.message?.content ?? input.grounded,
    tokensIn: usage?.prompt_tokens ?? estimateTokens(input.user),
    tokensOut: usage?.completion_tokens ?? estimateTokens(choice?.message?.content ?? ''),
  };
}

async function completeAnthropic(config: LlmConfig, input: LlmRequest): Promise<RemoteUsage> {
  const base = (config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model || 'claude-3-5-haiku-latest',
      max_tokens: 800,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await readJson(response);
  const blocks = body.content as Array<{ text?: string }> | undefined;
  const text = blocks?.map((block) => block.text ?? '').join('') || input.grounded;
  const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return {
    text,
    tokensIn: usage?.input_tokens ?? estimateTokens(input.user),
    tokensOut: usage?.output_tokens ?? estimateTokens(text),
  };
}

export function createLlmPort(config: LlmConfig): LlmPort {
  return {
    async *complete(input: LlmRequest) {
      if (config.provider === 'local' || !config.apiKey) {
        const text = input.grounded;
        yield { type: 'done', text, tokensIn: estimateTokens(input.user), tokensOut: estimateTokens(text) };
        return;
      }
      try {
        const remote =
          config.provider === 'anthropic' ? await completeAnthropic(config, input) : await completeOpenAi(config, input);
        yield { type: 'done', text: remote.text, tokensIn: remote.tokensIn, tokensOut: remote.tokensOut };
      } catch {
        const text = input.grounded;
        yield { type: 'done', text, tokensIn: estimateTokens(input.user), tokensOut: estimateTokens(text) };
      }
    },
  };
}

export function estimateCost(tokensIn: number, tokensOut: number, perMillionIn: string, perMillionOut: string): string {
  return new Decimal(tokensIn)
    .div(1_000_000)
    .mul(perMillionIn || 0)
    .plus(new Decimal(tokensOut).div(1_000_000).mul(perMillionOut || 0))
    .toFixed(6);
}
