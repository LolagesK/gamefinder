import {catalogPageSQL,catalogCountsSQL,parseCatalogQuery} from './catalog-sql.mjs';
export const PAGE_SIZE=18;
export async function executeCatalog(query,run,{group=null,offset=0,counts=true}={}){
 const q=parseCatalogQuery(query);
 if(!q.text.trim()&&!q.criteria.length)return executeUnfiltered(q,run,{group,offset,counts});
 const totals={exact:0,unverified:0,similar:0};
 if(counts){const sql=catalogCountsSQL(q);for(const row of await run(sql.sql,sql.params))totals[row.tier]=Number(row.n);}
 const groups=group?[group]:['exact','unverified',...(q.includeSimilar?['similar']:[])];
 const lists={exact:[],unverified:[],similar:[]};
 for(const key of groups){
  const statement=catalogPageSQL(q,key,PAGE_SIZE,offset);
  const rows=await run(statement.sql,statement.params);
  lists[key]=rows.map(({payload})=>({game:JSON.parse(payload)}));
 }
 return {...lists,totals,pageSize:PAGE_SIZE,offset,hasMore:group?null:undefined};
}

/** Fast path avoids four full JSON classification scans for browsing a large database. */
async function executeUnfiltered(q,run,{group=null,offset=0,counts=true}={}){
 const lists={exact:[],unverified:[],similar:[]},totals={exact:0,unverified:0,similar:0};
 if(counts){
  try{const stats=await run('SELECT total AS n FROM gamefinder_stats WHERE id=1',[]);
   if(!stats.length)throw Error('Statistics not initialised');totals.exact=Number(stats[0].n||0);
  }catch{const rows=await run('SELECT count(*) AS n FROM games',[]);totals.exact=Number(rows[0]?.n||0);}
 }
 if(!group||group==='exact'){
  const sorting={
   name:"json_extract(payload,'$.name') COLLATE NOCASE ASC",
   year:"json_extract(payload,'$.year') DESC",
   rating:"json_extract(payload,'$.reviewsPositive') DESC",
   reviews:"json_extract(payload,'$.reviewsTotal') DESC",
   storage:"json_extract(payload,'$.storageGb') ASC",
   'price-asc':"json_extract(payload,'$.priceCents') ASC",
   'price-desc':"json_extract(payload,'$.priceCents') DESC"
  };
  const skip=Math.min(500000,Math.max(0,Number(offset)||0));
  let rows;
  if(q.sort==='popular'||q.sort==='relevance'){
   // Indexed scores from SteamSpy: popular games first, not last-uploaded AppIDs.
   // When scores run out, continue with the unranked catalogue (stable pagination).
   try{
    const ranked=await run('SELECT count(*) AS n FROM game_popularity p JOIN games g ON g.app_id=p.app_id',[]);
    const rankedTotal=Number(ranked[0]?.n||0);
    rows=skip<rankedTotal?await run('SELECT g.payload FROM game_popularity p JOIN games g ON g.app_id=p.app_id ORDER BY p.score DESC,p.app_id DESC LIMIT ? OFFSET ?',[PAGE_SIZE,skip]):[];
    if(rows.length<PAGE_SIZE){
     const rest=await run('SELECT g.payload FROM games g WHERE NOT EXISTS (SELECT 1 FROM game_popularity p WHERE p.app_id=g.app_id) ORDER BY g.app_id DESC LIMIT ? OFFSET ?',[PAGE_SIZE-rows.length,Math.max(0,skip-rankedTotal)]);
     rows.push(...rest);
    }
   }catch{
    // Before the enrichment workflow creates its table, prioritise an editorial set of recognisable games.
    const seeds=[730,570,578080,1172470,1086940,1091500,1245620,413150,271590,945360,252490,255710,1145360,892970,548430,264710,105600,381210,292030,367520,275850,526870,739630,431960,1966720,2358720,553850,1551360,620980,4000,440,252950,304930,381210,322330,359550,271590];
    rows=await run(`SELECT payload FROM games ORDER BY CASE app_id ${seeds.map((id,i)=>`WHEN ${id} THEN ${seeds.length-i}`).join(' ')} ELSE 0 END DESC, app_id DESC LIMIT ? OFFSET ?`,[PAGE_SIZE,skip]);
   }
  }else{
   const order=sorting[q.sort]||'app_id DESC';
   rows=await run(`SELECT payload FROM games ORDER BY ${order}, app_id DESC LIMIT ? OFFSET ?`,[PAGE_SIZE,skip]);
  }
  lists.exact=rows.map(({payload})=>({game:JSON.parse(payload)}));
 }
 return {...lists,totals,pageSize:PAGE_SIZE,offset,hasMore:group?null:undefined};
}
