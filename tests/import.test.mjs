import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createInsertQueries,validateEntry,runImport} from '../scripts/d1-bulk-import.mjs';
import worker from '../worker/index.mjs';

function fakeCloudflare(items){
 const db=new DatabaseSync(':memory:');
 let writes=0;
 const fetcher=async(url,opts={})=>{
  if(!url.includes('/d1/database/'))return {ok:true,status:200,json:async()=>items};
  const body=JSON.parse(opts.body);
  const statements=body.batch||[body];const result=[];
  try{
   db.exec('BEGIN');
   for(const st of statements){
    const compiled=db.prepare(st.sql); const first=/^\s*SELECT/i.test(st.sql);
    if(first)result.push({success:true,results:compiled.all(...(st.params||[]))});
    else {const r=compiled.run(...(st.params||[]));writes+=r.changes;result.push({success:true,results:[],meta:{changes:r.changes}});}
   }
   db.exec('COMMIT');
   return {ok:true,status:200,json:async()=>({success:true,result})};
  }catch(err){db.exec('ROLLBACK');return {ok:false,status:400,json:async()=>({success:false,errors:[{message:err.message}]})};}
 };
 return {db,fetcher,getWrites:()=>writes};
}
const env={CLOUDFLARE_API_TOKEN:'test',CLOUDFLARE_ACCOUNT_ID:'testingaccount',CLOUDFLARE_D1_ID:'testdb'};
const rows=[{appid:220,name:'Half-Life 2'}, {appid:1001,name:'A Game'},{appid:1002,name:'B Game'},{appid:2,name:'fake DLC',type:'dlc'},{appid:0,name:'invalid'}];
test('mass import removes non-games and invalid IDs',()=>{
 assert.equal(validateEntry(rows[3]),null);assert.equal(validateEntry(rows[4]),null);assert.ok(validateEntry(rows[0]));
 assert.equal(createInsertQueries(rows).length,1);
 assert.equal(createInsertQueries(rows)[0].params.length,6);
});
test('D1 batch query never exceeds 100 bound parameters',()=>{
 const games=Array.from({length:1200},(_,i)=>({appid:3000+i,name:`Demo game ${i}`}));
 const chunks=createInsertQueries(games);assert.equal(chunks.length,30);
 assert.ok(chunks.every(c=>c.params.length<=80));
});
test('GitHub import writes games safely, preserves old curated data and resumes',async()=>{
 const {db,fetcher}=fakeCloudflare(rows);
 const first=await runImport({fetcher,env,log:()=>{}});
 assert.equal(first.completed,true);
 assert.equal(db.prepare('SELECT count(*) n FROM games').get().n,3);
 // Existing enriched row: an identical ID in the next cycle must not overwrite it.
 db.prepare('UPDATE games SET payload=? WHERE app_id=220').run(JSON.stringify({appId:220,name:'Half-Life 2',tags:['FPS'],priceCents:1000}));
 const second=await runImport({fetcher,env,log:()=>{}});assert.equal(second.skipped,true);
 assert.equal(JSON.parse(db.prepare('SELECT payload FROM games WHERE app_id=220').get().payload).priceCents,1000);
});
test('Worker read-only status endpoints work and do not enable public writes',async()=>{
 const {db,fetcher}=fakeCloudflare(rows);await runImport({fetcher,env,log:()=>{}});
 const D1={prepare(sql){let args=[];return {bind(...p){args=p;return this;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)}}}}};
 const ASSETS={fetch:async()=>new Response('static')};
 const meta=await (await worker.fetch(new Request('https://x.test/api/catalog/meta'),{DB:D1,ASSETS})).json();
 assert.equal(meta.total,3);assert.equal(meta.version,'0.4.0');assert.equal(meta.importStatus.status,'complete');
 const other=await worker.fetch(new Request('https://x.test/api/admin/import',{method:'POST'}),{DB:D1,ASSETS});assert.equal(other.status,404);
});
