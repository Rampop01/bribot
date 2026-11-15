// Kite payments for the bot agent: bribes and bounty payouts.
//
// Modes (KITE_MODE):
//   mock  – no money moves; a ledger entry with a fake tx id is recorded. For local dev.
//   kpass – shells out to the Kite Passport CLI: `kpass wallet send ...`. The agent's spending
//           limits are enforced by Kite Passport itself (session/allowance you approve with a passkey).
//   chain – direct ERC-20 transfer on Kite testnet from an agent key (viem). Shows real tx on KiteScan.
//
// In every mode the app ALSO enforces its own caps: per-bribe max, per-game budget, and a 24h cap.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { createWalletClient, defineChain, erc20Abi, http, parseEther, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from './config';
import { db, persist, spentLast24h, type SpendEntry } from './store';

export interface PayResult {
  ok: boolean;
  mode: string;
  txId?: string;
  url?: string;
  error?: string;
}

export const isAddress = (s: string | undefined): s is `0x${string}` => !!s && /^0x[0-9a-fA-F]{40}$/.test(s);

export async function pay(opts: { to?: string; amount: number; kind: SpendEntry['kind']; ref: string }): Promise<PayResult> {
  const { to, amount, kind, ref } = opts;
  const mode = config.kite.mode;
  if (!(amount > 0)) return { ok: false, mode, error: 'amount must be positive' };
  if (spentLast24h() + amount > config.kite.dailyCap) {
    return { ok: false, mode, error: `24h spending cap of ${config.kite.dailyCap} reached` };
  }

  let res: PayResult;
  if (mode === 'mock') {
    res = { ok: true, mode, txId: `mock_${crypto.randomBytes(8).toString('hex')}` };
  } else if (!isAddress(to)) {
    return { ok: false, mode, error: 'recipient has no wallet address' };
  } else if (mode === 'kpass') {
    res = await payWithKpass(to, amount);
  } else {
    res = await payOnChain(to, amount);
  }

  if (res.ok) {
    db.spend.push({ ts: Date.now(), amount, to: to ?? 'n/a', kind, ref, mode });
    persist();
  }
  console.log(`[kite] ${kind} ${amount} -> ${to ?? 'n/a'}: ${res.ok ? res.txId : res.error}`);
  return res;
}

function payWithKpass(to: string, amount: number): Promise<PayResult> {
  const args = ['wallet', 'send', '--to', to, '--amount', amount.toFixed(2), '--asset', config.kite.asset, '--output', 'json'];
  return new Promise((resolve) => {
    // execFile (no shell) + validated address => no injection.
    execFile(config.kite.kpassBin, args, { timeout: 90_000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, mode: 'kpass', error: (stderr || err.message).trim().slice(0, 300) });
      const hash = stdout.match(/0x[0-9a-fA-F]{64}/)?.[0];
      let error: string | undefined;
      try {
        const json = JSON.parse(stdout);
        if (json?.error) error = String(json.error.message ?? json.error);
      } catch {
        /* non-JSON output is fine if it contains a hash */
      }
      if (error) return resolve({ ok: false, mode: 'kpass', error });
      resolve({ ok: true, mode: 'kpass', txId: hash ?? stdout.trim().slice(0, 120), url: hash ? `${config.kite.explorer}/tx/${hash}` : undefined });
    });
  });
}

let chainClient: ReturnType<typeof makeChainClient> | null = null;
function makeChainClient() {
  const chain = defineChain({
    id: config.kite.chainId,
    name: 'KiteAI',
    nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 },
    rpcUrls: { default: { http: [config.kite.rpcUrl] } },
    blockExplorers: { default: { name: 'KiteScan', url: config.kite.explorer } },
  });
  const pk = (config.kite.privateKey.startsWith('0x') ? config.kite.privateKey : `0x${config.kite.privateKey}`) as Hex;
  return createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(config.kite.rpcUrl) });
}

async function payOnChain(to: `0x${string}`, amount: number): Promise<PayResult> {
  try {
    if (!config.kite.privateKey) return { ok: false, mode: 'chain', error: 'KITE_PRIVATE_KEY not set' };
    chainClient ??= makeChainClient();
    if (config.kite.native) {
      // Pay in the chain's own coin (KITE).
      const hash = await chainClient.sendTransaction({ to, value: parseEther(amount.toFixed(6)) });
      return { ok: true, mode: 'chain', txId: hash, url: `${config.kite.explorer}/tx/${hash}` };
    }
    const hash = await chainClient.writeContract({
      address: config.kite.tokenAddress as `0x${string}`,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, parseUnits(amount.toFixed(6), config.kite.tokenDecimals)],
    });
    return { ok: true, mode: 'chain', txId: hash, url: `${config.kite.explorer}/tx/${hash}` };
  } catch (e) {
    return { ok: false, mode: 'chain', error: (e as Error).message.split('\n')[0].slice(0, 300) };
  }
}
