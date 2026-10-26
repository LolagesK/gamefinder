import {catalogPageSQL,catalogCountsSQL,parseCatalogQuery} from './catalog-sql.mjs';
export const PAGE_SIZE=18;
export async function executeCatalog(query,run,{group=null,offset=0,counts=true}={}){
 const q=parseCatalogQuery(query);
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
