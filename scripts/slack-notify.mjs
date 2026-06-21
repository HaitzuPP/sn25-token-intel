// Posts a Slack alert when the daily run flags new SN25 buyers.
// Reads data/sn25-alerts-pending.json (written by build-snapshot.mjs) and POSTs
// a Block Kit message to the Slack Incoming Webhook in env SLACK_WEBHOOK_URL.
// No-ops safely if the webhook is unset or there are no new flags.

import { readFileSync, existsSync } from 'node:fs';

const url = process.env.SLACK_WEBHOOK_URL;
if (!url) { console.error('SLACK_WEBHOOK_URL not set, skipping.'); process.exit(0); }

const path = 'data/sn25-alerts-pending.json';
if (!existsSync(path)) { console.error('no pending file, skipping.'); process.exit(0); }

const { flagged = [], thresholdUsd = 10000, fundedDays = 7, total7dUsd = 0, total7dCount = 0 } = JSON.parse(readFileSync(path, 'utf8'));
if (!flagged.length) { console.error('no new flags, skipping.'); process.exit(0); }

const short = k => k.slice(0,6) + '…' + k.slice(-4);
const usd = n => '$' + Math.round(n).toLocaleString('en-US');
const num = n => Math.round(n).toLocaleString('en-US');

const blocks = [
  { type:'header', text:{ type:'plain_text', text:`🟢 New SN25 Buyer${flagged.length>1 ? 's ('+flagged.length+')' : ''}`, emoji:true } }
];
for (const f of flagged) {
  const created = f.created ? `${f.created.slice(0,10)}${f.ageDays!=null?' ('+f.ageDays+'d old)':''}` : 'unknown';
  const holdings = f.totalTao!=null ? `τ${num(f.totalTao)}${f.totalUsd!=null?' ('+usd(f.totalUsd)+')':''}` : 'unknown';
  const breadth = f.subnetsHeld!=null ? `${f.subnetsHeld} subnet${f.subnetsHeld===1?'':'s'}` : '';
  const profile = f.profile ? `*${f.profile}*${f.profileReason?` (${f.profileReason})`:''}` : '';
  blocks.push({ type:'section', text:{ type:'mrkdwn', text:
    `*Bought ${usd(f.usd)}*  ·  ${num(f.alpha)} α  ·  rank #${f.rank}\n` +
    `Wallet: <https://taostats.io/coldkey/${f.ck}|${short(f.ck)}>  ·  first buy ${f.firstFunded.slice(0,10)} (${f.days}d ago)\n` +
    `Account created: ${created}\n` +
    `Total holdings: ${holdings}${breadth?'  ·  '+breadth:''}\n` +
    `Profile: ${profile}` } });
}
blocks.push({ type:'divider' });
blocks.push({ type:'context', elements:[{ type:'mrkdwn',
  text:`*7-day total flagged: ${usd(total7dUsd)}* across ${total7dCount} wallet${total7dCount===1?'':'s'}  ·  threshold ≥${usd(thresholdUsd)} in ${fundedDays}d  ·  <https://haitzupp.github.io/sn25-token-intel/newwallets.html|New Buyers dashboard ↗>` }] });

const fallback = `New SN25 buyer flagged (${flagged.length}): ${flagged.map(f=>usd(f.usd)).join(', ')} · 7d total ${usd(total7dUsd)}`;

const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text: fallback, blocks }) });
console.error('slack POST status', r.status);
if (!r.ok) process.exit(1);
