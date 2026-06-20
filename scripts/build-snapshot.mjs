// SN25 Mainframe daily snapshot generator (Taostats -> data/sn25-snapshot.json).
// Design goal: the API is only ever hit by this daily job, never by viewers.
//
//  - 6 cheap "core" calls each run: pool, pool history, TAO/USD, subnet meta,
//    top-25 ranked holders, coldkey distribution.
//  - Holder 24h/7d/30d Δ$ are computed from a rolling day-over-day history
//    (data/sn25-history.json), robust, no per-wallet calls needed.
//  - "First funded" is backfilled gradually (a few wallets per run, rate
//    permitting) into a persistent map (data/sn25-firstfunded.json), and a
//    best-effort full per-wallet enrichment runs when the API allows (Actions
//    has no time limit, so it can absorb 429 backoffs).
//
// Env: TAOSTATS_KEY (required in CI), BUDGET_MS (0 = unlimited), FF_BATCH (default 25).

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';

const API = 'https://api.taostats.io';
const KEY = process.env.TAOSTATS_KEY || 'tao-8c2e099e-9e07-45c1-9069-727768f8f7a1:3f972bae';
const NETUID = 25, RAO = 1e9, BLOCKS_PER_DAY = 7200;
const OUT = 'data/sn25-snapshot.json', HIST = 'data/sn25-history.json', FF = 'data/sn25-firstfunded.json', ALERTED = 'data/sn25-alerted.json';
const WATCH = Number(process.env.WATCH || 100);            // holders to watch for new entrants
const SIZE_USD = Number(process.env.SIZE_USD || 25000);    // "with size" threshold
const FUNDED_DAYS = Number(process.env.FUNDED_DAYS || 7);  // "newly funded" window
const ALERT_SIZE_USD = Number(process.env.ALERT_SIZE_USD || 10000); // min size to fire a Slack alert
const PENDING = 'data/sn25-alerts-pending.json';
const BUDGET_MS = Number(process.env.BUDGET_MS || 0);
const FF_BATCH = Number(process.env.FF_BATCH || 25);
const START = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toF = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
const overBudget = () => BUDGET_MS && (Date.now() - START) > BUDGET_MS;
const readJ = (p,d) => { try { return existsSync(p) ? JSON.parse(readFileSync(p,'utf8')) : d; } catch(e){ return d; } };
const writeJ = (p,o) => { mkdirSync('data',{recursive:true}); writeFileSync(p, JSON.stringify(o,null,2)); };

async function get(path, params = {}, retry = 4) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: { Authorization: KEY, Accept: 'application/json' } });
  if (r.status === 429 && retry > 0) { await sleep(2500 * (5 - retry)); return get(path, params, retry - 1); }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}: ${(await r.text()).slice(0,100)}`);
  const j = await r.json();
  return { data: Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : j), pagination: j?.pagination || null };
}
const today = () => new Date().toISOString().slice(0,10);
const nearestUsdInHistory = (hist, ck, days) => {
  const cut = Date.now() - days*86400000;
  let best=null, bestDt=Infinity;
  for (const day of hist){ const dt=Math.abs(new Date(day.ts).getTime()-cut); const row=day.holders.find(h=>h.ck===ck); if(row&&dt<bestDt&&new Date(day.ts).getTime()<=Date.now()-days*86400000+43200000){ best=row; bestDt=dt; } }
  return best ? best.usd : null;
};

// New SN25 buyers: bucket watched holders by their first-SN25-stake date (frequency),
// plus an unbiased net-new holder count from the rolling holder-count history.
function computeNewWallets(holders, hist){
  const resolved = holders.filter(h=>h.firstFunded);
  const dayKey = ts => new Date(ts).toISOString().slice(0,10);
  const weekKey = ts => { const d=new Date(ts); const o=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())); const dn=(o.getUTCDay()+6)%7; o.setUTCDate(o.getUTCDate()-dn); return o.toISOString().slice(0,10); };
  const bucket = keyFn => { const m={}; resolved.forEach(h=>{ const k=keyFn(h.firstFunded); (m[k]=m[k]||{count:0,usd:0,alpha:0}); m[k].count++; m[k].usd+=h.usd||0; m[k].alpha+=h.alpha||0; }); return Object.keys(m).sort().map(k=>({d:k,count:m[k].count,usd:m[k].usd,alpha:m[k].alpha})); };
  const daily=bucket(dayKey), weekly=bucket(weekKey);
  const now=Date.now();
  const inWin=d=> resolved.filter(h=> (now-new Date(h.firstFunded).getTime())/86400000 <= d && (now-new Date(h.firstFunded).getTime())>=0);
  const cap=arr=>arr.reduce((a,h)=>a+(h.usd||0),0);
  const recent=[...resolved].sort((a,b)=>new Date(b.firstFunded)-new Date(a.firstFunded)).slice(0,40)
    .map(h=>({ck:h.ck,rank:h.rank,alpha:h.alpha,usd:h.usd,firstFunded:h.firstFunded,days:Math.floor((now-new Date(h.firstFunded).getTime())/86400000)}));
  const netNew=[]; const hs=(hist||[]).filter(d=>d.totalHolders!=null);
  for(let i=1;i<hs.length;i++) netNew.push({d:hs[i].day, net:hs[i].totalHolders-hs[i-1].totalHolders});
  return {
    watched:holders.length, resolvedCount:resolved.length,
    today:inWin(1).length, d7:inWin(7).length, d30:inWin(30).length, runRate30:inWin(30).length/30,
    cap7:cap(inWin(7)), cap30:cap(inWin(30)),
    daily, weekly, recent, netNew
  };
}

async function computeOwnerEmission(histRaw, ownerCk, taoUsd){
  const rows=(histRaw||[]).filter(r=>r.timestamp&&r.total_alpha).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const day={}; rows.forEach(r=>{ day[r.timestamp.slice(0,10)]={ta:(toF(r.total_alpha)||0)/RAO, px:toF(r.price)}; });
  const ds=Object.keys(day).sort();
  const series=[];
  for(let i=1;i<ds.length;i++){ const dA=day[ds[i]].ta-day[ds[i-1]].ta; if(dA<=0||dA>1e6) continue; const alpha=0.18*dA; series.push({d:ds[i], alpha, tao: alpha*(day[ds[i]].px||0)}); }
  const arrA=series.map(x=>x.alpha), arrT=series.map(x=>x.tao);
  const st=a=>{ if(!a.length) return {n:0}; const s=[...a].sort((x,y)=>x-y); const n=s.length; const mean=a.reduce((p,v)=>p+v,0)/n; const med=s[(n/2)|0]; const sd=Math.sqrt(a.reduce((p,v)=>p+(v-mean)**2,0)/n); return {n,mean,med,sd,min:s[0],max:s[n-1],cv: mean? sd/mean*100:0}; };
  const sA=st(arrA), sT=st(arrT);
  const last=series[series.length-1]||{alpha:null,tao:null};
  const mn=(arr,k)=>arr.length?arr.reduce((p,x)=>p+x[k],0)/arr.length:null;
  const l30=series.slice(-30), l7=series.slice(-7);
  let realizedAlphaPerDay=null;
  try{
    let h=(await get('/api/dtao/stake_balance/history/v1',{coldkey:ownerCk,hotkey:ownerCk,netuid:NETUID,limit:120})).data;
    h=(h||[]).filter(x=>x.timestamp).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    const hd={}; h.forEach(x=>hd[x.timestamp.slice(0,10)]=(toF(x.balance)||0)/RAO);
    const hds=Object.keys(hd).sort(); const dl=[]; for(let i=1;i<hds.length;i++) dl.push(hd[hds[i]]-hd[hds[i-1]]);
    const recent=dl.slice(-7).filter(x=>x>0&&x<1e5);
    realizedAlphaPerDay = recent.length? recent.reduce((p,v)=>p+v,0)/recent.length : null;
  }catch(e){ console.error('owner-hk',e.message); }
  const px=day[ds[ds.length-1]]?.px||0;
  return {
    cutPct:18,
    todayAlpha:last.alpha, todayTao:last.tao, todayUsd:(last.tao!=null&&taoUsd)?last.tao*taoUsd:null,
    mean7Alpha:mn(l7,'alpha'), mean7Tao:mn(l7,'tao'),
    mean30Alpha:mn(l30,'alpha'), mean30Tao:mn(l30,'tao'),
    meanAllAlpha:sA.mean, meanAllTao:sT.mean, medianAlpha:sA.med, sdAlpha:sA.sd, cvAlpha:sA.cv, minAlpha:sA.min, maxAlpha:sA.max,
    annualTao:(sT.mean!=null)?sT.mean*365:null, annualUsd:(sT.mean!=null&&taoUsd)?sT.mean*365*taoUsd:null,
    realizedAlphaPerDay, realizedTao:(realizedAlphaPerDay!=null)?realizedAlphaPerDay*px:null,
    series: series.slice(-120)
  };
}

async function main(){
  // ---- core ----
  console.error('pool…');
  const pr=(await get('/api/dtao/pool/v1',{netuid:NETUID})).data; const pool=Array.isArray(pr)?pr[0]:pr;
  if(!pool?.netuid) throw new Error('pool not found');
  await sleep(400); console.error('history…');
  const histRaw=(await get('/api/dtao/pool/history/v1',{netuid:NETUID,limit:450})).data||[];
  await sleep(400); console.error('tao usd…');
  let taoUsd=null; try{const t=(await get('/api/price/history/v1',{asset:'tao',limit:1})).data;const it=Array.isArray(t)?t[0]:t;taoUsd=toF(it?.price)||toF(it?.usd_price)||toF(it?.close);}catch(e){console.error(e.message);}
  await sleep(400); console.error('meta…');
  let meta={}; try{const m=(await get('/api/subnet/latest/v1',{netuid:NETUID})).data;meta=(Array.isArray(m)?m[0]:m)||{};}catch(e){console.error(e.message);}
  await sleep(400); console.error('top'+WATCH+'…');
  const hr=await get('/api/dtao/stake_balance/latest/v1',{netuid:NETUID,order:'balance_desc',limit:WATCH});
  const holdersRaw=hr.data||[]; const totalHolders=hr.pagination?.total_items||meta.total_holders||null;
  await sleep(400); console.error('dist…');
  let dist=null; try{dist=(await get('/api/subnet/distribution/coldkey/v1',{netuid:NETUID})).data;}catch(e){console.error('dist',e.message);}
  await sleep(400); console.error('subnet count…');
  let totalSubnets=null; try{ const all=(await get('/api/dtao/pool/v1',{limit:200})).data; totalSubnets=Array.isArray(all)?all.length:null; }catch(e){console.error('count',e.message);}

  const priceTao=toF(pool.price), mcapTao=(toF(pool.market_cap)||0)/RAO;
  const totalAlpha=(toF(pool.total_alpha)||0)/RAO;
  const alphaStaked=(toF(pool.alpha_staked)||0)/RAO;
  const alphaInPool=(toF(pool.alpha_in_pool)||0)/RAO;
  const poolTao=(toF(pool.total_tao)||0)/RAO;
  const vol24=(toF(pool.tao_volume_24_hr)||0)/RAO;
  const buyVol=(toF(pool.tao_buy_volume_24_hr)||0)/RAO, sellVol=(toF(pool.tao_sell_volume_24_hr)||0)/RAO;
  const alphaSupply=totalAlpha>0?totalAlpha:((priceTao&&priceTao>0)?mcapTao/priceTao:null);

  const allHolders=holdersRaw.map((h,i)=>({ rank:h.subnet_rank||i+1, ck:h.coldkey?.ss58, hk:h.hotkey?.ss58,
    alpha:(toF(h.balance)||0)/RAO, tao:(toF(h.balance_as_tao)||0)/RAO,
    usd: taoUsd?((toF(h.balance_as_tao)||0)/RAO)*taoUsd:null,
    pct: alphaSupply?((toF(h.balance)||0)/RAO)/alphaSupply*100:null,
    firstFunded:null, d24:null, d7:null, d30:null }));
  let holders=allHolders.slice(0,25);   // home dashboard shows top 25

  // ---- rolling history (Δ + net-new holder count) ----
  let hist=readJ(HIST,[]);
  hist=hist.filter(d=>d.day!==today());
  hist.push({ day:today(), ts:new Date().toISOString(), taoUsd, price:priceTao, rank:pool.rank, totalHolders,
    holders: holders.map(h=>({ck:h.ck,usd:h.usd,alpha:h.alpha})) });
  while(hist.length>180) hist.shift();
  writeJ(HIST,hist);

  for(const h of holders){
    const u24=nearestUsdInHistory(hist,h.ck,1), u7=nearestUsdInHistory(hist,h.ck,7), u30=nearestUsdInHistory(hist,h.ck,30);
    if(h.usd!=null){ if(u24!=null)h.d24=h.usd-u24; if(u7!=null)h.d7=h.usd-u7; if(u30!=null)h.d30=h.usd-u30; }
  }

  // ---- first funded (persistent, gradual backfill across the watched set) ----
  const ffMap=readJ(FF,{});
  let filled=0;
  for(const h of allHolders){
    if(ffMap[h.ck]){ h.firstFunded=ffMap[h.ck]; continue; }
    if(filled>=FF_BATCH || overBudget()) continue;
    try{
      let wh=(await get('/api/dtao/stake_balance/history/v1',{coldkey:h.ck,hotkey:h.hk,netuid:NETUID,limit:400})).data;
      if(!wh||!wh.length){ await sleep(300); wh=(await get('/api/dtao/stake_balance/history/v1',{coldkey:h.ck,hotkey:h.hk,limit:400})).data; }
      wh=(wh||[]).filter(r=>r.timestamp).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
      if(wh.length){ ffMap[h.ck]=wh[0].timestamp; h.firstFunded=wh[0].timestamp; filled++; writeJ(FF,ffMap); }
    }catch(e){ console.error('ff',h.ck,e.message); }
    await sleep(400);
  }
  for(const h of allHolders){ if(ffMap[h.ck]) h.firstFunded=ffMap[h.ck]; }

  // ---- new SN25 buyers: frequency, capital, recent, net-new ----
  const newWallets = computeNewWallets(allHolders, hist);

  // ---- flag new buyers for Slack alert (recent + size, once per wallet) ----
  const alerted = new Set(readJ(ALERTED, []));
  const nowMs = Date.now();
  const flagged = [];
  for(const h of allHolders){
    if(!h.firstFunded || h.usd==null) continue;
    const days = (nowMs - new Date(h.firstFunded).getTime())/86400000;
    if(days>=0 && days<=FUNDED_DAYS && h.usd>=ALERT_SIZE_USD && !alerted.has(h.ck)){
      flagged.push({ ck:h.ck, rank:h.rank, alpha:h.alpha, usd:h.usd, firstFunded:h.firstFunded, days:Math.floor(days) });
      alerted.add(h.ck);
    }
  }
  flagged.sort((a,b)=>b.usd-a.usd);
  writeJ(ALERTED, [...alerted]);
  writeJ(PENDING, { generatedAt:new Date().toISOString(), netuid:NETUID, thresholdUsd:ALERT_SIZE_USD, fundedDays:FUNDED_DAYS, flagged });
  newWallets.flaggedCount = flagged.length;

  // ---- owner emission: 18% cut, derived from subnet alpha emission, cross-checked vs owner hotkey ----
  const ownerEmission = await computeOwnerEmission(histRaw, meta?.owner?.ss58, taoUsd);

  const daysTracked=new Set(hist.map(d=>d.day)).size;
  const snapshot={
    generatedAt:new Date().toISOString(), day:today(), netuid:NETUID,
    name:pool.name||'Mainframe', symbol:pool.symbol||null, taoUsd, daysTracked, totalSubnets,
    pool:{ price:priceTao, market_cap:toF(pool.market_cap), rank:pool.rank, total_tao:toF(pool.total_tao),
      total_alpha:toF(pool.total_alpha), alpha_staked:toF(pool.alpha_staked), alpha_in_pool:toF(pool.alpha_in_pool),
      tao_volume_24_hr:toF(pool.tao_volume_24_hr), tao_buy_volume_24_hr:toF(pool.tao_buy_volume_24_hr), tao_sell_volume_24_hr:toF(pool.tao_sell_volume_24_hr),
      fear_and_greed_index:pool.fear_and_greed_index, fear_and_greed_sentiment:pool.fear_and_greed_sentiment, root_prop:toF(pool.root_prop),
      price_change_1_day:toF(pool.price_change_1_day), price_change_1_week:toF(pool.price_change_1_week), price_change_1_month:toF(pool.price_change_1_month),
      buys_24_hr:pool.buys_24_hr, sells_24_hr:pool.sells_24_hr },
    meta:{ owner:meta.owner||null, registered_at:meta.registered_at||meta.created_at||null },
    totalHolders, derived:{ priceTao, mcapTao, alphaSupply, totalAlpha, alphaStaked, alphaInPool, poolTao, vol24, buyVol, sellVol },
    ownerEmission, newWallets,
    history: histRaw.filter(h=>h.timestamp).map(h=>({timestamp:h.timestamp,price:toF(h.price),rank:toF(h.rank),total_tao:toF(h.total_tao),total_alpha:toF(h.total_alpha)})),
    holders
  };
  writeJ(OUT,snapshot);
  console.error(`OK day=${snapshot.day} price=${priceTao} rank=${pool.rank} holders=${holders.length} watched=${allHolders.length} ff=${Object.keys(ffMap).length} newBuyers7d=${newWallets.d7} daysTracked=${daysTracked}`);
}
main().catch(e=>{ console.error('FATAL',e.message); process.exit(1); });
