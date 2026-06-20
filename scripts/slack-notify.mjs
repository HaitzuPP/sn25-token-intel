// Posts a Slack alert when the daily run flags new SN25 buyers.
// Reads data/sn25-alerts-pending.json (written by build-snapshot.mjs) and POSTs
// to the Slack Incoming Webhook in env SLACK_WEBHOOK_URL. No-ops safely if the
// webhook is unset or there are no new flags, so the workflow never fails on it.

import { readFileSync, existsSync } from 'node:fs';

const url = process.env.SLACK_WEBHOOK_URL;
if (!url) { console.error('SLACK_WEBHOOK_URL not set, skipping.'); process.exit(0); }

const path = 'data/sn25-alerts-pending.json';
if (!existsSync(path)) { console.error('no pending file, skipping.'); process.exit(0); }

const { flagged = [], thresholdUsd, fundedDays } = JSON.parse(readFileSync(path, 'utf8'));
if (!flagged.length) { console.error('no new flags, skipping.'); process.exit(0); }

const short = k => k.slice(0,6) + '…' + k.slice(-4);
const usd = n => '$' + Math.round(n).toLocaleString('en-US');
const num = n => Math.round(n).toLocaleString('en-US');

const lines = flagged.map(f =>
  `• <https://taostats.io/coldkey/${f.ck}|${short(f.ck)}>  ·  rank #${f.rank}  ·  *${usd(f.usd)}*  ·  ${num(f.alpha)} α  ·  first bought ${f.firstFunded.slice(0,10)} (${f.days}d ago)`
);

const header = `:rotating_light: *SN25 Mainframe: ${flagged.length} new buyer${flagged.length>1?'s':''} flagged*  _(≥${usd(thresholdUsd)}, funded ≤${fundedDays}d)_`;
const footer = `<https://haitzupp.github.io/sn25-token-intel/newwallets.html|Open New Buyers dashboard ↗>`;
const text = [header, ...lines, footer].join('\n');

const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text }) });
console.error('slack POST status', r.status);
if (!r.ok) process.exit(1);
