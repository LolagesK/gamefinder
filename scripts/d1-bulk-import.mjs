/**
 * GameFinder PC v0.4.0 / GitHub Actions import.
 * Runs on GitHub's Node 22 runner, not on CPU-constrained Cloudflare Free Worker.
 * Imports ONLY community-listed Steam games, safely retaining existing D1 records.
 * Uses Cloudflare REST D1 query, batched prepared parameter lists, and DB cursor.
 */
import {pathToFileURL} from 'node:url';
const SOURCE='https://raw.githubusercontent.com/Austrum-lab/steam-appdb/master/data/game.json';
const SOURCE_KEY='steam-appdb/game.json';
const MAX_PER_RUN=30000;
const ROWS_PER_SQL=40;
const SQL_PER_REQUEST=10;
const SCAN_RECHECK_DAYS=7;
const required=['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_D1_ID'];
const iso=()=>new Date().toISOString();
export function validateEntry(item){
 const id=Number(item?.appid??item?.appId),name=String(item?.name??'').trim();
 if(!Number.isSafeInteger(id)||id<=0||id>2**31-1||name.length<2||name.length>250||item?.type&&String(item.type).toLowerCase()!=='game')return null;
 return {appId:id,name,year:null,tags:[],modes:[],platforms:[],developers:[],publishers:[],shortDescription:'Сведения Steam для этой игры пока не загружены.',headerImage:null,backgroundImage:null,isFree:null,priceCents:null,currency:null,storageGb:null,reviewsPositive:null,reviewsTotal:null,verifiedPlayerCount:false,playersMax:null,ramGb:null,earlyAccess:null,controller:null,catalogOrigin:'community-game-list',dataSource:'Austrum-lab/steam-appdb (PICS community game list)',dataNote:'Игра из стороннего списка; цена, режимы и другие свойства требуют подтверждения в Steam.'};
}
export function createInsertQueries(items){
 const valid=[...new Map(items.map(validateEntry).filter(Boolean).map(g=>[g.appId,g])).values()];
 const sql=[];
 for(let i=0;i<valid.length;i+=ROWS_PER_SQL){
  const part=valid.slice(i,i+ROWS_PER_SQL);
  sql.push({sql:`INSERT OR IGNORE INTO games (app_id,payload,updated_at) VALUES ${part.map(()=>'(?,?,NULL)').join(',')}`,params:part.flatMap(g=>[String(g.appId),JSON.stringify(g)])});
 }
 return sql;
}
export async function runImport({fetcher=fetch,env=process.env,log=console.log}={}){
 for(const name of required)if(!env[name])throw Error(`Missing GitHub Actions secret ${name}`);
 const endpoint=`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(env.CLOUDFLARE_D1_ID)}/query`;
 async function api(batch){
  for(let attempt=1;attempt<=5;attempt++){
   try{
    const response=await fetcher(endpoint,{method:'POST',headers:{Authorization:`Bearer ${env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(batch.length===1?batch[0]:{batch})});
    const obj=await response.json();
    if(!response.ok||obj.success===false||obj.result?.some(x=>x.success===false)){
     const detail=JSON.stringify(obj.errors||obj.result?.filter(x=>x.success===false)||obj).slice(0,350);
     if(response.status===429||response.status>=500)throw Error(`RETRY Cloudflare D1 ${response.status}: ${detail}`);
     throw Error(`D1 API refused query: ${response.status} ${detail}`);
    }
    return obj;
   }catch(e){if(attempt===5||!String(e.message).includes('RETRY'))throw e;await new Promise(r=>setTimeout(r,1300*attempt**2));}
  }
 }
 await api([{sql:'CREATE TABLE IF NOT EXISTS games(app_id INTEGER PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT)'}]);
 await api([{sql:'CREATE TABLE IF NOT EXISTS gamefinder_stats(id INTEGER PRIMARY KEY CHECK(id=1),total INTEGER NOT NULL,updated_at TEXT)'}]);
 const syncCount=async()=>{
  const info=await api([{sql:'SELECT count(*) AS n FROM games'}]);
  const n=Number(info.result?.[0]?.results?.[0]?.n||0);
  await api([{sql:`INSERT INTO gamefinder_stats(id,total,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET total=excluded.total,updated_at=excluded.updated_at`,params:[n,iso()]}]);
 };
 await api([{sql:`CREATE TABLE IF NOT EXISTS catalog_import_state(source TEXT PRIMARY KEY,cursor INTEGER NOT NULL DEFAULT 0,source_total INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',last_error TEXT,added_total INTEGER NOT NULL DEFAULT 0,updated_at TEXT,completed_at TEXT)`}]);
 const savedRaw=await api([{sql:'SELECT cursor,source_total,status,completed_at,added_total FROM catalog_import_state WHERE source=?',params:[SOURCE_KEY]}]);
 const previous=savedRaw.result?.[0]?.results?.[0]||{cursor:0,source_total:0,status:'not-started',added_total:0};
 if(previous.status==='complete'&&previous.completed_at&&Date.now()-Date.parse(previous.completed_at)<SCAN_RECHECK_DAYS*86400000){await syncCount();log('Already complete; weekly rescan not due.');return {skipped:true};}
 const sourceResponse=await fetcher(SOURCE,{headers:{Accept:'application/json'}});
 if(!sourceResponse.ok)throw Error('Could not fetch community source HTTP '+sourceResponse.status);
 const items=await sourceResponse.json();if(!Array.isArray(items))throw Error('Expected game.json array');
 let cursor=(previous.status==='complete'||previous.cursor>=items.length)?0:Math.max(0,Number(previous.cursor)||0);
 const until=Math.min(items.length,cursor+MAX_PER_RUN);
 const now=iso();let added=0;
 for(let i=cursor;i<until;i+=ROWS_PER_SQL*SQL_PER_REQUEST){
  const end=Math.min(until,i+ROWS_PER_SQL*SQL_PER_REQUEST);
  const queries=createInsertQueries(items.slice(i,end));
  // Submit INSERTs and checkpoint in ONE transaction — restart safe after interruptions.
  const inserted=queries.length?queries:[];
  const checkpoint={sql:`INSERT INTO catalog_import_state(source,cursor,source_total,status,last_error,added_total,updated_at,completed_at)
   VALUES(?,?,?,'running',NULL,0,?,NULL)
   ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,source_total=excluded.source_total,status='running',last_error=NULL,updated_at=excluded.updated_at,completed_at=NULL`,params:[SOURCE_KEY,String(end),String(items.length),now]};
  await api([...inserted,checkpoint]);
  cursor=end;
  if((end%4000)<400)log(`Processed ${end}/${items.length} source records`);
 }
 if(cursor===items.length){
  await api([{sql:`UPDATE catalog_import_state SET status='complete',completed_at=?,updated_at=? WHERE source=?`,params:[iso(),iso(),SOURCE_KEY]}]);
 }
 await syncCount();
 log(`IMPORT DONE: processed through ${cursor}/${items.length}. New games are available via /api/catalog/meta.`);
 return {cursor,total:items.length,completed:cursor===items.length};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runImport().catch(e=>{console.error('Import failed:',e.message);process.exitCode=1;});
}
