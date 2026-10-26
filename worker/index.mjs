import {executeCatalog} from '../shared/catalog-api.mjs';
const headers={'content-type':'application/json; charset=utf-8','cache-control':'public, max-age=30','x-content-type-options':'nosniff'};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(url.pathname==='/api/catalog/meta'){
   if(!env.DB)return json({available:false,mode:'static'});
   try{const row=await env.DB.prepare('SELECT count(*) AS n FROM games').first();return json({available:true,mode:'d1',total:Number(row.n),pageSize:18});}
   catch(e){return json({available:false,error:'D1 schema not initialized'});}
  }
  if(url.pathname==='/api/catalog'){
   if(!env.DB)return json({error:'D1 is not bound'},503);
   const raw=url.searchParams.get('q')||'{}';if(raw.length>12000)return json({error:'Invalid search request'},400);
   try{
    const run=async(sql,args)=>{const r=await env.DB.prepare(sql).bind(...args).all();return r.results||[];};
    const group=url.searchParams.get('group');if(group&&!['exact','unverified','similar'].includes(group))return json({error:'Invalid group'},400);
    return json(await executeCatalog(raw,run,{group,offset:Number(url.searchParams.get('offset')||0),counts:!group}));
   }catch(e){return json({error:'Search failed',detail:String(e.message).slice(0,180)},500);}
  }
  if(/^\/api\/games\/\d+$/.test(url.pathname)&&env.DB){
   const id=Number(url.pathname.split('/').pop());const row=await env.DB.prepare('SELECT payload FROM games WHERE app_id=?').bind(id).first();
   return row?json(JSON.parse(row.payload)):json({error:'Game not found'},404);
  }
  return env.ASSETS.fetch(request);
 }
};
