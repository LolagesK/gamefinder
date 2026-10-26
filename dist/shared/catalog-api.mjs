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
 if(counts){const rows=await run('SELECT count(*) AS n FROM games',[]);totals.exact=Number(rows[0]?.n||0);}
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
  const order=sorting[q.sort]||'app_id DESC';
  const rows=await run(`SELECT payload FROM games ORDER BY ${order}, app_id DESC LIMIT ? OFFSET ?`,[PAGE_SIZE,Math.min(500000,Math.max(0,Number(offset)||0))]);
  lists.exact=rows.map(({payload})=>({game:JSON.parse(payload)}));
 }
 return {...lists,totals,pageSize:PAGE_SIZE,offset,hasMore:group?null:undefined};
}
