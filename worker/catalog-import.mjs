/** Public read-only import status used by the Cloudflare Worker UI.
 * Actual mass import runs in GitHub Actions to avoid 10ms Free Worker CPU caps. */
export const SOURCE_KEY='steam-appdb/game.json';
export async function importStatus(DB){
 try{
  const row=await DB.prepare('SELECT source,cursor,source_total,status,last_error,added_total,updated_at,completed_at FROM catalog_import_state WHERE source=?').bind(SOURCE_KEY).first();
  return row||{source:SOURCE_KEY,cursor:0,source_total:0,status:'not-started',last_error:null,updated_at:null,completed_at:null};
 }catch{return {source:SOURCE_KEY,cursor:0,source_total:0,status:'not-started',last_error:null,updated_at:null,completed_at:null};}
}
