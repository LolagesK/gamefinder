import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {calculatePopularity,normaliseSpyEntries,chooseSpyTags,ownersMinimum} from '../shared/popularity.mjs';
import {mergeStoreData,runEnrichment} from '../scripts/d1-enrich-games.mjs';
import {executeCatalog} from '../shared/catalog-api.mjs';

const spyA={appid:730,name:'Counter-Strike 2',owners:'50,000,000 .. 100,000,000',ccu:500000,average_2weeks:800,tags:{FPS:500,'Free To Play':400},positive:3000,negative:100};
const spyB={appid:20,name:'Test Indie',owners:'20,000 .. 50,000',ccu:2,average_2weeks:7,tags:{Indie:5},positive:10,negative:1};
test('SteamSpy ranking is estimated from real numeric fields, not from AppID',()=>{
 assert.equal(ownersMinimum(spyA.owners),50000000);
 assert.ok(calculatePopularity(spyA,{recent:true})>calculatePopularity(spyB));
 assert.deepEqual(chooseSpyTags(spyA),['FPS','Free To Play']);
 assert.equal(normaliseSpyEntries({'730':spyA,'20':spyB}).length,2);
});
test('Store enrichment retains curated game data and adds only verified store fields',()=>{
 const game={appId:730,name:'Curated game',tags:['FPS'],modes:[],platforms:[],developers:[],shortDescription:'Сведения Steam для этой игры пока не загружены.',isFree:null,priceCents:null};
 const store={type:'game',short_description:'Official short <b>description</b>',header_image:'https://steamstatic.com/header.jpg',genres:[{description:'Action'}],
  categories:[{description:'Online Co-op'},{description:'Single-player'}],platforms:{windows:true,linux:true},developers:['Valve'],release_date:{date:'13 Sep, 2025'},price_overview:{currency:'EUR',final:2499},pc_requirements:{minimum:'Storage: 25 GB available space'}};
 const result=mergeStoreData(game,store);
 assert.equal(result.name,'Curated game');assert.deepEqual(result.tags,['FPS']);assert.equal(result.priceCents,2499);
 assert.equal(result.currency,'EUR');assert.equal(result.storageGb,25);assert.equal(result.year,2025);
 assert.ok(result.modes.includes('online-coop'));assert.ok(result.shortDescription.includes('Official short description'));
 assert.equal(mergeStoreData(game,{type:'dlc'}),null);
});
function fakeD1(){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE games (app_id INTEGER PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT)');
 for(const game of [{appId:730,name:'Counter-Strike 2'}, {appId:20,name:'Test Indie'},{appId:600,name:'Unknown'}]){
  game.tags=[];game.modes=[];game.platforms=[];game.developers=[];game.shortDescription='Сведения Steam для этой игры пока не загружены.';
  db.prepare('INSERT INTO games(app_id,payload) VALUES(?,?)').run(game.appId,JSON.stringify(game));
 }
 return db;
}
function mockedFetcher(db){
 return async (url,opts={})=>{
  const answer=(json,status=200)=>({ok:status<300,status,json:async()=>json});
  if(url.includes('/d1/database/')){
   const body=JSON.parse(opts.body),batch=body.batch||[body];const results=[];
   try{
    db.exec('BEGIN');
    for(const q of batch){const st=db.prepare(q.sql),args=q.params||[];
     if(/^\s*SELECT/i.test(q.sql))results.push({success:true,results:st.all(...args)});
     else {st.run(...args);results.push({success:true,results:[]});}
    }
    db.exec('COMMIT');return answer({success:true,result:results});
   }catch(e){db.exec('ROLLBACK');return answer({success:false,errors:[{message:e.message}]},400);}
  }
  if(url.includes('steamspy.com')){
   if(url.includes('top100in2weeks'))return answer({'730':spyA});
   return answer({'730':spyA,'20':spyB});
  }
  if(url.includes('/api/appdetails')){
   const id=url.match(/appids=(\d+)/)?.[1];
   return answer({[id]:{success:true,data:{type:'game',short_description:'Steam information',header_image:`https://steamstatic.com/${id}.jpg`,genres:[{description:'Action'}],
    categories:[{description:'Single-player'}],platforms:{windows:true},is_free:false,price_overview:{currency:'EUR',final:1999}}}});
  }
  throw Error('Unexpected URL '+url);
 };
}
const env={CLOUDFLARE_API_TOKEN:'test',CLOUDFLARE_ACCOUNT_ID:'id',CLOUDFLARE_D1_ID:'database'};
test('enrichment ranks popular games globally, hydrates data, and retains unknowns',async()=>{
 const db=fakeD1();
 const result=await runEnrichment({fetcher:mockedFetcher(db),env,log:()=>{},sleep:async()=>{},storePerRun:2});
 assert.ok(result.ranked>=2);assert.equal(result.store,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM game_popularity').get().n,2);
 const game=JSON.parse(db.prepare('SELECT payload FROM games WHERE app_id=730').get().payload);
 assert.equal(game.priceCents,1999);assert.ok(game.tags.length>0);assert.ok(game.popularityScore>0);
 const run=(sql,args)=>Promise.resolve(db.prepare(sql).all(...args));
 const first=await executeCatalog(JSON.stringify({sort:'popular'}),run);
 assert.deepEqual(first.exact.map(x=>x.game.appId),[730,20,600]);
 const search=await executeCatalog(JSON.stringify({text:'Counter',sort:'popular'}),run);
 assert.equal(search.exact[0].game.appId,730);
 // Old, unaudited games remain in D1 and are never assigned made-up metadata.
 const unknown=JSON.parse(db.prepare('SELECT payload FROM games WHERE app_id=600').get().payload);
 assert.equal(unknown.priceCents,undefined);assert.equal(unknown.popularityScore,undefined);
 const next=await runEnrichment({fetcher:mockedFetcher(db),env,log:()=>{},sleep:async()=>{},storePerRun:2});
 assert.equal(next.store,1); // After popular games, metadata reaches the unranked long tail.
 const hydrated=JSON.parse(db.prepare('SELECT payload FROM games WHERE app_id=600').get().payload);
 assert.equal(hydrated.priceCents,1999);
});
