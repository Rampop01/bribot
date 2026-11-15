// Checks the bot's Kite wallet: prints its address and balance, then sends a tiny real payment.
// Usage:  npm run kite:check            (pays 0.001 back to the bot's own address)
//         npm run kite:check -- 0xABC…  (pays 0.001 to that address)
import { createPublicClient, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { config } from '../server/config';
import { isAddress, pay } from '../server/kite';

if (config.kite.mode !== 'chain') {
  console.log(`KITE_MODE is "${config.kite.mode}". Set KITE_MODE=chain in .env to make real payments.`);
  process.exit(1);
}
if (!config.kite.privateKey) {
  console.log('KITE_PRIVATE_KEY is empty. Add the bot wallet\'s private key to .env (never share it in chat).');
  process.exit(1);
}

const pk = (config.kite.privateKey.startsWith('0x') ? config.kite.privateKey : `0x${config.kite.privateKey}`) as `0x${string}`;
const account = privateKeyToAccount(pk);
const client = createPublicClient({ transport: http(config.kite.rpcUrl) });
const balance = await client.getBalance({ address: account.address });

console.log('Bot wallet :', account.address);
console.log('Balance    :', formatEther(balance), 'KITE');
console.log('Pays with  :', config.kite.native ? 'KITE (native coin)' : `token ${config.kite.tokenAddress}`);

const to = process.argv[2] ?? account.address;
if (!isAddress(to)) {
  console.log('Not a valid address:', to);
  process.exit(1);
}
console.log(`\nSending a 0.001 test payment to ${to} …`);
const res = await pay({ to, amount: 0.001, kind: 'bribe', ref: 'kite-check' });
if (!res.ok) {
  console.log('FAILED:', res.error);
  process.exit(1);
}
console.log('Sent. Transaction:', res.url);
const receipt = await client.waitForTransactionReceipt({ hash: res.txId as `0x${string}`, timeout: 60_000 });
console.log('Confirmed in block', receipt.blockNumber.toString(), '| status:', receipt.status);
process.exit(receipt.status === 'success' ? 0 : 1);
