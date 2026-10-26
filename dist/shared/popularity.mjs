/** Popularity is an *estimate* derived from third-party SteamSpy data; it is not Valve's official ranking. */
export function ownersMinimum(text){
 const m=String(text||'').replaceAll(',','').match(/^(\d+)\s*\.\.\s*(\d+)/);
 return m?Number(m[1]):0;
}
export function calculatePopularity(item,{recent=false,forever=false,owned=false}={}){
 const owners=ownersMinimum(item?.owners);
 const ccu=Math.max(0,Number(item?.ccu)||0);
 const avg=Math.max(0,Number(item?.average_2weeks)||0);
 // Strongly favor games played recently; for the remaining catalogue, ownership is a useful proxy.
 return Math.round(Math.log10(owners+1)*1000 + Math.log10(ccu+1)*750 + Math.log10(avg+1)*250 +
  (recent?18000:0)+(owned?1500:0)+(forever?750:0));
}
export function normaliseSpyEntries(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return [];
 return Object.values(raw).filter(x=>Number.isSafeInteger(Number(x?.appid))&&Number(x?.appid)>0);
}
export function chooseSpyTags(item){
 const tags=item?.tags&&typeof item.tags==='object'&&!Array.isArray(item.tags)?
  Object.entries(item.tags).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,8).map(([t])=>t):[];
 return tags.length?tags:String(item?.genre||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,6);
}
