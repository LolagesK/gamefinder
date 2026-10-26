/**
 * GameFinder PC v0.4.1: daily SteamSpy popularity + incremental official Steam Store metadata.
 * Uses existing CLOUDFLARE_* GitHub Actions secrets, no Worker write routes, no Steam API key.
 * SteamSpy estimates are explicitly labelled and are NOT official Valve popularity statistics.
 */
import {pathToFileURL} from 'node:url';
import {calculatePopularity,normaliseSpyEntries,chooseSpyTags} from '../shared/popularity.mjs';

const REQUIRED=['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_D1_ID'];
const STORE_PER_RUN=Math.min(80,Math.max(5,Number(process.env.STORE_PER_RUN||45)));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const pick=(val,old)=>val!=null&&val!==''?val:old;
const isBlank=(v)=>v==null||v===''||(Array.isArray(v)&&!v.length);
const limitedString=(val,max=450)=>String(val||'').trim().slice(0,max);
function plain(html){return limitedString(String(html||'').replace(/<br\s*\/?\s*>/gi,'; ').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/g,"'").replace(/\s+/g,' '),900);}
function dateYear(date){const m=String(date||'').match(/(?:19|20)\d{2}/);return m?Number(m[0]):null;}
function modesOf(categories){
 const names=new Set((categories||[]).map(c=>String(c?.description||'').toLowerCase()));
 const modes=[];
 const has=(...parts)=>[...names].some(name=>parts.some(part=>name.includes(part)));
 if(has('single-player'))modes.push('single');
 if(has('multi-player','multiplayer'))modes.push('multiplayer');
 if(has('online co-op'))modes.push('online-coop');
 if(has('shared/split screen co-op','local co-op'))modes.push('local-coop');
 if(has('online pvp'))modes.push('online-pvp');
 if(has('shared/split screen pvp','local pvp'))modes.push('local-pvp');
 if(has('remote play together'))modes.push('remote-play');
 return modes;
}
function diskGB(html){
 const s=plain(html);const m=s.match(/(?:storage|disk space|hard drive)[^:]{0,15}:?\s*(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)/i)||s.match(/(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)\s*(?:available\s+)?(?:space|storage)/i);
 if(!m)return null;const n=Number(m[1].replace(',','.'))*(m[2].toUpperCase()==='TB'?1024:m[2].toUpperCase()==='MB'?1/1024:1);
 return n>0&&n<5000?Math.round(n*10)/10:null;
}
export function mergeStoreData(game,store){
 if(!store||store.type!=='game')return null;
 const g={...game};
 const setIfMissing=(k,v)=>{if(isBlank(g[k])&&!isBlank(v))g[k]=v;};
 setIfMissing('shortDescription',plain(store.short_description));
 if(!g.shortDescription||g.shortDescription.startsWith('Сведения Steam для этой игры'))g.shortDescription=plain(store.short_description)||g.shortDescription;
 setIfMissing('headerImage',store.header_image);
 setIfMissing('backgroundImage',store.background_raw||store.background);
 setIfMissing('year',dateYear(store.release_date?.date));
 setIfMissing('tags',(store.genres||[]).map(x=>x.description).filter(Boolean).slice(0,10));
 setIfMissing('modes',modesOf(store.categories));
 setIfMissing('platforms',Object.entries(store.platforms||{}).filter(([,v])=>v===true).map(([key])=>key==='windows'?'windows':key==='mac'?'macos':key==='linux'?'linux':null).filter(Boolean));
 setIfMissing('developers',store.developers);
 setIfMissing('publishers',store.publishers);
 setIfMissing('storageGb',diskGB(store.pc_requirements?.minimum));
 setIfMissing('controller',store.controller_support?true:null);
 if(g.isFree==null&&typeof store.is_free==='boolean')g.isFree=store.is_free;
 // Prices are regional (NL/EUR). Do not manufacture a zero price for missing/coming-soon items.
 if(store.price_overview?.currency==='EUR'&&Number.isFinite(store.price_overview.final)){
  g.priceCents=Number(store.price_overview.final);g.currency='EUR';
 }
 if(store.is_free===true){g.priceCents=0;g.currency='EUR';}
 g.steamStoreSyncedAt=new Date().toISOString();
 g.dataNote='Данные из Steam Store; сведения о популярности (если есть) оценены SteamSpy.';
 g.dataSource='Steam Store / SteamSpy + исходная подборка';
 return g;
}

async function httpJSON(fetcher,url,options={}){
 for(let attempt=1;attempt<=3;attempt++){
  let response;
  try{response=await fetcher(url,{...options,signal:AbortSignal.timeout(25000)});}catch(e){if(attempt===3)throw e;await pause(attempt*1400);continue;}
  if((response.status===429||response.status>=500)&&attempt<3){await pause(attempt*2000);continue;}
  if(!response.ok)throw Error(`HTTP ${response.status} fetching ${new URL(url).hostname}`);
  return response.json();
 }
}

export async function runEnrichment({fetcher=fetch,env=process.env,log=console.log,storePerRun=STORE_PER_RUN,sleep=pause}={}){
 for(const name of REQUIRED)if(!env[name])throw Error('Missing GitHub Actions secret '+name);
 const endpoint=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.CLOUDFLARE_D1_ID)}/query`;
 async function api(queries){
  if(!queries.length)return [];
  for(let attempt=1;attempt<=4;attempt++){
   let res;
   try{res=await fetcher(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(queries.length===1?queries[0]:{batch:queries})});}
   catch(e){if(attempt===4)throw e;await pause(1500*attempt);continue;}
   const json=await res.json();
   if(res.ok&&json.success!==false&&!json.result?.some(x=>x.success===false))return json.result||[];
   if((res.status===429||res.status>=500)&&attempt<4){await pause(1500*attempt);continue;}
   throw Error(`D1 write refused: HTTP ${res.status} ${JSON.stringify(json.errors||[]).slice(0,260)}`);
  }
 }
 await api([{sql:'CREATE TABLE IF NOT EXISTS game_popularity (app_id INTEGER PRIMARY KEY, score INTEGER NOT NULL, updated_at TEXT NOT NULL)'},
  {sql:'CREATE INDEX IF NOT EXISTS idx_game_popularity_score ON game_popularity(score DESC,app_id DESC)'},
  {sql:'CREATE TABLE IF NOT EXISTS game_enrich_state (id INTEGER PRIMARY KEY CHECK(id=1), cursor INTEGER NOT NULL DEFAULT 0, updated_at TEXT, last_error TEXT,ranked_total INTEGER NOT NULL DEFAULT 0)'},
  {sql:'CREATE TABLE IF NOT EXISTS game_store_attempts (app_id INTEGER PRIMARY KEY, attempted_at TEXT NOT NULL, succeeded INTEGER NOT NULL DEFAULT 0)'},
  {sql:'CREATE TABLE IF NOT EXISTS game_popularity_scan (id INTEGER PRIMARY KEY CHECK(id=1), page INTEGER NOT NULL DEFAULT 0, updated_at TEXT)'},
  {sql:'CREATE TABLE IF NOT EXISTS gamefinder_stats (id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL, updated_at TEXT)'}]);
 const scan=await api([{sql:'SELECT page FROM game_popularity_scan WHERE id=1'}]);
 const page=Math.max(0,Number(scan[0]?.results?.[0]?.page||0));
 const endpoints=[['recent','top100in2weeks'],['forever','top100forever'],['owned','top100owned'],['all',`all&page=${page}`]];
 const byId=new Map();let successful=0,processedAllPage=false;
 for(const [kind,request] of endpoints){
  try{
   const raw=await httpJSON(fetcher,`https://steamspy.com/api.php?request=${request}`);
   const found=normaliseSpyEntries(raw);
   if(!found.length){
    if(kind==='all'&&raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).length===0){
     // SteamSpy's paginated all-feed has ended. Start another scan next day.
     await api([{sql:`INSERT INTO game_popularity_scan(id,page,updated_at) VALUES(1,0,?)
      ON CONFLICT(id) DO UPDATE SET page=0,updated_at=excluded.updated_at`,params:[new Date().toISOString()]}]);
     log('SteamSpy all pages finished; restart from page 0 tomorrow');continue;
    }
    throw Error('no valid SteamSpy records');
   }
   successful++;
   if(kind==='all')processedAllPage=true;
   for(const data of found){
    const id=Number(data.appid);const prev=byId.get(id);
    const flags={...prev?.flags,[kind]:true};
    // A top-list entry can be absent from the paginated all endpoint; preserve the richer version.
    const richer=prev?.data&&Object.keys(prev.data.tags||{}).length>Object.keys(data.tags||{}).length?prev.data:data;
    byId.set(id,{data:richer,flags});
   }
   log(`SteamSpy ${kind}: ${found.length} entries`);
  }catch(e){log(`WARNING: SteamSpy ${kind} unavailable: ${e.message}`);}
  await sleep(1250);
 }
 if(!successful||!byId.size)throw Error('No popularity data received from SteamSpy; retry later');
 const ranked=[...byId].map(([appId,{data,flags}])=>({appId,data,score:calculatePopularity(data,flags)}))
  .sort((a,b)=>b.score-a.score||a.appId-b.appId);
 // Small transactions and INSERT OR REPLACE are safe to run daily. Scores are based on SteamSpy estimates.
 const date=new Date().toISOString();
 for(let i=0;i<ranked.length;i+=300){
  const slice=ranked.slice(i,i+300);
  const queries=[];
  for(let j=0;j<slice.length;j+=30){
   const group=slice.slice(j,j+30);
   queries.push({sql:`INSERT INTO game_popularity(app_id,score,updated_at) VALUES ${group.map(()=>'(?,?,?)').join(',')} ON CONFLICT(app_id) DO UPDATE SET score=excluded.score,updated_at=excluded.updated_at`,
    params:group.flatMap(x=>[x.appId,x.score,date])});
  }
  await api(queries);
 }
 // For the most visible games, add SteamSpy tag & review estimates without overriding curated tags.
 for(let i=0;i<ranked.length;i+=40){
  const queries=ranked.slice(i,i+40).map(x=>({sql:`UPDATE games SET payload=json_set(payload,
   '$.popularityScore', ?, '$.popularitySource','SteamSpy', '$.popularityUpdatedAt', ?,
   '$.steamspyOwnersRange', ?, '$.steamspyCcu', ?, '$.steamspyPositive', ?, '$.steamspyNegative', ?,
   '$.tags', CASE WHEN json_array_length(json_extract(payload,'$.tags'))=0 THEN json(?) ELSE json(json_extract(payload,'$.tags')) END)
   WHERE app_id=?`,params:[x.score,date,limitedString(x.data.owners,60),Math.max(0,Number(x.data.ccu)||0),Math.max(0,Number(x.data.positive)||0),Math.max(0,Number(x.data.negative)||0),JSON.stringify(chooseSpyTags(x.data)),x.appId]}));
  await api(queries);
 }
 if(processedAllPage)await api([{sql:`INSERT INTO game_popularity_scan(id,page,updated_at) VALUES(1,?,?)
  ON CONFLICT(id) DO UPDATE SET page=excluded.page,updated_at=excluded.updated_at`,params:[page+1,date]}]);
 const stats=await api([{sql:'SELECT count(*) AS n FROM games'},{sql:'SELECT count(*) AS n FROM game_popularity'}]);
 const gameTotal=Number(stats[0]?.results?.[0]?.n||0),rankedTotal=Number(stats[1]?.results?.[0]?.n||0);
 await api([{sql:`INSERT INTO gamefinder_stats(id,total,updated_at) VALUES(1,?,?)
  ON CONFLICT(id) DO UPDATE SET total=excluded.total,updated_at=excluded.updated_at`,params:[gameTotal,date]}]);
 log(`Popularity scores ready: ${rankedTotal}; SteamSpy community tags for existing ranked games`);
 // Enrich popular games first. Once they are covered, advance into ALL unranked
 // community games, not just the first SteamSpy page. Retry unavailable entries after 30 days.
 const cap=Math.min(80,Math.max(1,storePerRun));
 const available=await api([{sql:`SELECT g.app_id,g.payload FROM game_popularity p
    JOIN games g ON g.app_id=p.app_id LEFT JOIN game_store_attempts a ON a.app_id=g.app_id
    WHERE json_extract(g.payload,'$.steamStoreSyncedAt') IS NULL
      AND (a.app_id IS NULL OR a.attempted_at < datetime('now','-30 days'))
    ORDER BY p.score DESC,p.app_id DESC LIMIT ?`,params:[cap]}]);
 const chosen=[...(available[0]?.results||[])];
 if(chosen.length<cap){
  const unranked=await api([{sql:`SELECT g.app_id,g.payload FROM games g
   LEFT JOIN game_popularity p ON p.app_id=g.app_id
   LEFT JOIN game_store_attempts a ON a.app_id=g.app_id
   WHERE p.app_id IS NULL AND json_extract(g.payload,'$.steamStoreSyncedAt') IS NULL
      AND (a.app_id IS NULL OR a.attempted_at < datetime('now','-30 days'))
   ORDER BY g.app_id DESC LIMIT ?`,params:[cap-chosen.length]}]);
  chosen.push(...(unranked[0]?.results||[]));
 }
 if(!chosen.length){
  await api([{sql:`INSERT INTO game_enrich_state(id,cursor,updated_at,last_error,ranked_total) VALUES(1,0,?,NULL,?)
   ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,ranked_total=excluded.ranked_total`,params:[date,rankedTotal]}]);
  log('Store metadata already current for eligible games.');return {ranked:rankedTotal,store:0};
 }
 const updates=[],attempts=[];let storeSuccess=0,storeErrors=0;
 for(const entry of chosen){
  const id=Number(entry.app_id),old=JSON.parse(entry.payload);
  try{
   const response=await httpJSON(fetcher,`https://store.steampowered.com/api/appdetails?appids=${id}&cc=nl&l=english&filters=basic,price_overview,platforms,categories,genres,pc_requirements`);
   const body=response?.[String(id)];
   if(body?.success&&body.data?.type==='game'){
    const merged=mergeStoreData(old,body.data);
    if(merged){updates.push({sql:'UPDATE games SET payload=?,updated_at=? WHERE app_id=?',params:[JSON.stringify(merged),date,id]});storeSuccess++;}
   }
   // Even a non-game or currently unavailable Store entry should not block future games.
   attempts.push({sql:`INSERT INTO game_store_attempts(app_id,attempted_at,succeeded) VALUES (?,?,?)
    ON CONFLICT(app_id) DO UPDATE SET attempted_at=excluded.attempted_at,succeeded=excluded.succeeded`,
    params:[id,date,body?.success&&body.data?.type==='game'?1:0]});
  }catch(e){storeErrors++;if(storeErrors<=4)log(`WARNING Steam Store app ${id}: ${e.message}`);}
  await sleep(1250);
 }
 // D1 batch queries execute atomically: record attempt alongside the matching payload write.
 const all=[...updates,...attempts];
 for(let i=0;i<all.length;i+=15)await api(all.slice(i,i+15));
 const state=await api([{sql:'SELECT cursor FROM game_enrich_state WHERE id=1'}]);
 const previous=Number(state[0]?.results?.[0]?.cursor||0);
 const cursor=previous+attempts.length;
 await api([{sql:`INSERT INTO game_enrich_state (id,cursor,updated_at,last_error,ranked_total) VALUES (1,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at,last_error=excluded.last_error,ranked_total=excluded.ranked_total`,params:[cursor,date,storeErrors?`${storeErrors} temporary Steam Store request errors`:null,rankedTotal]}]);
 log(`ENRICH DONE: scored ${rankedTotal}, Steam Store metadata updated ${storeSuccess}/${chosen.length}, failures ${storeErrors}, attempted total ${cursor}`);
 return {ranked:rankedTotal,store:storeSuccess,attempted:chosen.length,cursor};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runEnrichment().catch(e=>{console.error('Enrichment failed:',e.message);process.exitCode=1;});
}
