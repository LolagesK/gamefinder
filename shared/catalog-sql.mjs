/** Parameterized SQL query builder shared by local SQLite and Cloudflare D1.
 * Uses the existing JSON payload to preserve full fidelity of Steam data.
 * Missing metadata stays UNKNOWN; do not turn it into negative evidence.
 */
const allowOps={gte:'>=',lte:'<=',eq:'=',gt:'>',lt:'<'};
const numerical={price:'priceCents',storage:'storageGb',rating:'reviewsPositive',reviews:'reviewsTotal',year:'year',ram:'ramGb'};
const arrays={tag:'tags',mode:'modes',os:'platforms',language:'languages'};
const booleans={free:'isFree',controller:'controller',earlyAccess:'earlyAccess'};
const limited=(x,max=140)=>String(x??'').slice(0,max);
const utf8Prefix=(s,maxBytes=36)=>{let out='',size=0;for(const ch of String(s)){const n=new TextEncoder().encode(ch).length;if(size+n>maxBytes)break;size+=n;out+=ch;}return out;};
const tagAliasesRu={Survival:'выживание',Horror:'хоррор ужасы',RPG:'ролевая игра','Open World':'открытый мир',Crafting:'крафт создание предметов','Base Building':'строительство базы',Building:'строительство','Co-op':'кооператив',Shooter:'шутер',Action:'экшен',Strategy:'стратегия',Simulation:'симулятор',Racing:'гонки','Farming Sim':'ферма фермерство',Puzzle:'головоломка',Exploration:'исследование',Zombies:'зомби',Fantasy:'фэнтези',Multiplayer:'мультиплеер'};
const prop=(k)=>`json_extract(g.payload, '$.${k}')`;
export function buildCatalogSQL(query={}){
  const criteria=Array.isArray(query.criteria)?query.criteria.slice(0,40):[];
  const exprs=[],params=[],required=[],excluded=[],preferred=[],requiredTags=[],requiredModes=[];
  for(const c of criteria){
    if(!c||!['required','preferred','excluded'].includes(c.priority))continue;
    let expr=null;const key=c.key;
    if(arrays[key]){
      // The curated / Steam lists may have incomplete tags: absent ≠ false.
      expr=`CASE WHEN EXISTS(SELECT 1 FROM json_each(g.payload, '$.${arrays[key]}') WHERE value = ?) THEN 1 ELSE NULL END`;
      params.push(limited(c.value,120));
    } else if(booleans[key]){
      expr=`CASE WHEN ${prop(booleans[key])} IS NULL THEN NULL WHEN ${prop(booleans[key])} = ? THEN 1 ELSE 0 END`;
      params.push(c.value===true||c.value==='true'?1:0);
    } else if(key==='players'){
      expr=`CASE WHEN ${prop('verifiedPlayerCount')} != 1 OR ${prop('playersMax')} IS NULL THEN NULL WHEN ${prop('playersMax')} >= ? THEN 1 ELSE 0 END`;
      params.push(Number(c.value));
    } else if(numerical[key]){
      const col=key==='price'?`CASE WHEN ${prop('isFree')} = 1 THEN 0 ELSE ${prop('priceCents')} END`:prop(numerical[key]);
      const op=allowOps[c.op||'eq'];
      if(!op||!Number.isFinite(Number(c.value)))continue;
      expr=`CASE WHEN (${col}) IS NULL THEN NULL WHEN (${col}) ${op} ? THEN 1 ELSE 0 END`;
      params.push(Number(c.value));
    }
    if(!expr)continue;
    const alias=`c${exprs.length}`;
    exprs.push(`${expr} AS ${alias}`);
    if(c.priority==='required'){
      if(key==='tag')requiredTags.push(alias);
      else if(key==='mode')requiredModes.push(alias);
      else required.push(alias);
    }else if(c.priority==='excluded')excluded.push(`CASE WHEN ${alias} = 1 THEN 0 WHEN ${alias} = 0 THEN 1 ELSE NULL END`);
    else preferred.push(alias);
  }
  const joined=(aliases,mode)=>{
    if(!aliases.length)return null;
    if(aliases.length===1)return aliases[0];
    return mode==='all'
      ?`CASE WHEN (${aliases.map(x=>`${x}=0`).join(' OR ')}) THEN 0 WHEN (${aliases.map(x=>`${x}=1`).join(' AND ')}) THEN 1 ELSE NULL END`
      :`CASE WHEN (${aliases.map(x=>`${x}=1`).join(' OR ')}) THEN 1 WHEN (${aliases.map(x=>`${x}=0`).join(' AND ')}) THEN 0 ELSE NULL END`;
  };
  const strict=[...required,...excluded];
  if(requiredTags.length)strict.push(joined(requiredTags,query.tagMatch==='all'?'all':'any'));
  if(requiredModes.length)strict.push(joined(requiredModes,query.modeMatch==='all'?'all':'any'));
  const fails=strict.length?strict.map(x=>`(${x}) = 0`).join(' OR '):'0';
  const unknown=strict.length?strict.map(x=>`(${x}) IS NULL`).join(' OR '):'0';
  const score=preferred.length?preferred.map(x=>`CASE WHEN ${x}=1 THEN 1 ELSE 0 END`).join(' + '):'0';
  const rawText=utf8Prefix(limited(query.text,48).trim().toLowerCase()).replace(/[\\%_]/g,c=>'\\'+c);
  let where='1=1';
  if(rawText){where="(LOWER(json_extract(g.payload,'$.name')) LIKE ? ESCAPE '\\' OR LOWER(json_extract(g.payload,'$.tags')) LIKE ? ESCAPE '\\'";params.push(`%${rawText}%`,`%${rawText}%`);const translations=Object.entries(tagAliasesRu).filter(([,ru])=>ru.includes(rawText)).map(([en])=>en).slice(0,8);for(const tag of translations){where+=" OR EXISTS (SELECT 1 FROM json_each(g.payload,'$.tags') WHERE value = ?)";params.push(tag);}where+=')';}
  const cte=`WITH evaluated AS (SELECT g.app_id, g.payload${exprs.length?', '+exprs.join(', '):''} FROM games g WHERE ${where}), classified AS (SELECT app_id, payload, (${score}) AS preferred_hits, CASE WHEN (${fails}) THEN 'similar' WHEN (${unknown}) THEN 'unverified' ELSE 'exact' END AS tier FROM evaluated)`;
  const orderKey={name:`json_extract(payload,'$.name') COLLATE NOCASE ASC`,year:`json_extract(payload,'$.year') DESC`,rating:`json_extract(payload,'$.reviewsPositive') DESC`,reviews:`json_extract(payload,'$.reviewsTotal') DESC`,storage:`json_extract(payload,'$.storageGb') ASC`};
  let order=`preferred_hits DESC, json_extract(payload,'$.name') COLLATE NOCASE ASC`;
  if(orderKey[query.sort])order=`${orderKey[query.sort]}, preferred_hits DESC, json_extract(payload,'$.name') COLLATE NOCASE ASC`;
  if(query.sort==='price-asc'||query.sort==='price-desc')order=`COALESCE(CASE WHEN json_extract(payload,'$.isFree') = 1 THEN 0 ELSE json_extract(payload,'$.priceCents') END, 999999999) ${query.sort==='price-desc'?'DESC':'ASC'}, preferred_hits DESC, json_extract(payload,'$.name') COLLATE NOCASE ASC`;
  return {cte,params,order};
}
export function parseCatalogQuery(raw){let query={};if(typeof raw==='string'&&raw.length<12000){try{query=JSON.parse(raw)}catch{}}return {
 text:limited(query.text||'',48),criteria:Array.isArray(query.criteria)?query.criteria.slice(0,40):[],tagMatch:query.tagMatch==='all'?'all':'any',modeMatch:query.modeMatch==='all'?'all':'any',sort:limited(query.sort||'relevance',20),includeSimilar:query.includeSimilar!==false
};}
export function catalogPageSQL(query,group,limit=18,offset=0){
 const {cte,params,order}=buildCatalogSQL(query);
 if(!['exact','unverified','similar'].includes(group))throw Error('Unknown result group');
 const amount=Math.min(48,Math.max(1,Number(limit)||18)),skip=Math.min(500000,Math.max(0,Number(offset)||0));
 return {sql:`${cte} SELECT payload FROM classified WHERE tier = ? ORDER BY ${order} LIMIT ? OFFSET ?`,params:[...params,group,amount,skip]};
}
export function catalogCountsSQL(query){const {cte,params}=buildCatalogSQL(query);return {sql:`${cte} SELECT tier, count(*) AS n FROM classified GROUP BY tier`,params};}
