import { io } from 'socket.io-client';
import type { Session } from '../../shared/types';

export const socket = io({ autoConnect: true });

export type Ack = { ok: boolean; error?: string; session?: Session };

export function emit(event: string, payload: unknown = {}): Promise<Ack> {
  return new Promise((resolve) => {
    socket.timeout(15_000).emit(event, payload, (err: Error | null, res: Ack) => {
      resolve(err ? { ok: false, error: 'Server did not respond' } : res);
    });
  });
}

/** "$0.25" or "0.02 KITE", depending on what the bot pays with. */
export const fmt = (n: number, unit: string) => (unit === '$' ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${unit}`);

const KEY = 'wtb.session';
export const loadSession = (): Session | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};
export const saveSession = (s: Session) => localStorage.setItem(KEY, JSON.stringify(s));
export const clearSession = () => localStorage.removeItem(KEY);

export async function sha256hex(s: string): Promise<string | null> {
  if (!crypto?.subtle) return null; // requires https or localhost
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
