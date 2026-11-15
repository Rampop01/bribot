// SERV Reasoning client. SERV exposes an OpenAI-compatible endpoint, so we use the official `openai` SDK.
// Docs: https://docs.openserv.ai/serv-reasoning
import OpenAI from 'openai';
import { config, servEnabled } from './config';

const client = servEnabled
  ? new OpenAI({ apiKey: config.serv.apiKey, baseURL: config.serv.baseURL, timeout: 45_000, maxRetries: 1 })
  : null;

export const brainLabel = servEnabled ? `SERV Reasoning · ${config.serv.model}` : 'offline fallback (no SERV_API_KEY)';

/** Ask SERV for a JSON object. Returns null on any failure so callers can fall back gracefully. */
export async function servJSON<T>(system: string, user: string, maxTokens = 1500): Promise<T | null> {
  if (!client) return null;
  try {
    const res = await client.chat.completions.create({
      model: config.serv.model,
      // SERV rejects requests without a system message.
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_completion_tokens: maxTokens,
    });
    const text = res.choices[0]?.message?.content ?? '';
    const parsed = parseJSON<T>(text);
    if (!parsed) console.warn('[serv] could not parse JSON from:', text.slice(0, 300));
    return parsed;
  } catch (e) {
    console.error('[serv] request failed:', (e as Error).message);
    return null;
  }
}

function parseJSON<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
