import 'dotenv/config';

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

export type KiteMode = 'mock' | 'kpass' | 'chain';

const kiteMode = (process.env.KITE_MODE ?? 'mock') as KiteMode;
if (!['mock', 'kpass', 'chain'].includes(kiteMode)) throw new Error(`KITE_MODE must be mock | kpass | chain, got "${kiteMode}"`);

export const config = {
  port: num(process.env.PORT, 3001),

  serv: {
    apiKey: process.env.SERV_API_KEY ?? '',
    baseURL: process.env.SERV_BASE_URL ?? 'https://inference-api.openserv.ai/v1',
    model: process.env.SERV_MODEL ?? 'gpt-5.4-mini',
  },

  reppo: {
    apiKey: process.env.REPPO_API_KEY ?? '',
    baseURL: process.env.REPPO_BASE_URL ?? 'https://eval.reppo.xyz/api/v1',
  },

  kite: {
    mode: kiteMode,
    asset: process.env.KITE_ASSET ?? 'USDC',
    kpassBin: process.env.KPASS_BIN ?? 'kpass',
    rpcUrl: process.env.KITE_RPC_URL ?? 'https://rpc-testnet.gokite.ai/',
    chainId: num(process.env.KITE_CHAIN_ID, 2368),
    privateKey: process.env.KITE_PRIVATE_KEY ?? '',
    // pieUSD on Kite testnet (18 decimals), per the kite-x402 example repos.
    tokenAddress: process.env.KITE_TOKEN_ADDRESS ?? '0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A',
    tokenDecimals: num(process.env.KITE_TOKEN_DECIMALS, 18),
    explorer: process.env.KITE_EXPLORER ?? 'https://testnet.kitescan.ai',
    // KITE_TOKEN_ADDRESS=native pays in the chain's own coin (KITE) instead of an ERC-20 token.
    native: (process.env.KITE_TOKEN_ADDRESS ?? '').toLowerCase() === 'native',
    unit: process.env.CURRENCY_LABEL ?? (kiteMode === 'chain' && (process.env.KITE_TOKEN_ADDRESS ?? '').toLowerCase() === 'native' ? 'KITE' : '$'),
    dailyCap: num(process.env.BOT_DAILY_CAP, 50), // hard cap on what the bot may spend in 24h
  },

  game: {
    chatSeconds: num(process.env.CHAT_SECONDS, 120),
    voteSeconds: num(process.env.VOTE_SECONDS, 30),
    maxRounds: num(process.env.MAX_ROUNDS, 2),
    minPlayers: num(process.env.MIN_PLAYERS, 3), // total, including the bot
    botStake: num(process.env.BOT_STAKE, 1), // bounty the bot puts up; split by humans who catch it
    bribeMax: num(process.env.BRIBE_MAX, 0.5), // max per bribe
    bribeBudget: num(process.env.BRIBE_BUDGET, 1), // max bribe spend per game
  },
};

/** Format an amount in the currency the bot actually pays with. */
export const money = (n: number) => (config.kite.unit === '$' ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${config.kite.unit}`);

export const servEnabled = config.serv.apiKey !== '';
export const reppoEnabled = config.reppo.apiKey !== '';
