/** Pure matching engine, usable in Node and Cloudflare browsers. No dependency on the storage adapter. */
export const DEFAULT_QUERY = Object.freeze({
  text: '', criteria: [], tagMatch: 'any', modeMatch: 'any', sort: 'relevance', includeSimilar: true,
});
export const PRIORITIES = ['required','preferred','excluded'];
export const GROUPS = [
  {key:'tags',title:'Жанры и теги'}, {key:'modes',title:'Режимы игры'},
  {key:'price',title:'Стоимость'}, {key:'storage',title:'Место на диске'},
  {key:'reviews',title:'Отзывы Steam'}, {key:'system',title:'Система и железо'},
  {key:'release',title:'Дата выхода'}, {key:'extra',title:'Дополнительно'},
];
const numeric = (value) => value === '' || value == null ? null : Number(value);
const known = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const xlc = (x) => String(x||'').toLocaleLowerCase('ru').trim();
// Localised tag aliases make free-text search useful for Russian-language visitors.
// Aliases are search aids, not new verified tags or metadata.
const tagAliasesRu = {
 'Survival':'выживание','Horror':'хоррор ужасы','RPG':'ролевая игра','Open World':'открытый мир',
 'Crafting':'крафт создание предметов','Base Building':'строительство базы','Building':'строительство',
 'Co-op':'кооператив','FPS':'шутер от первого лица','Shooter':'шутер','Action':'экшен',
 'Strategy':'стратегия','Simulation':'симулятор','Farming Sim':'ферма фермерство',
 'Relaxing':'расслабляющая','Puzzle':'головоломка','2D':'двухмерная','3D':'трёхмерная',
 'Pixel Graphics':'пиксельная графика','Sci-fi':'научная фантастика','Space':'космос',
 'Story Rich':'сюжет','Multiplayer':'мультиплеер','Free To Play':'бесплатная',
 'First-Person':'от первого лица','Third-Person':'от третьего лица','Fantasy':'фэнтези',
 'Turn-Based':'пошаговая','Racing':'гонки','Driving':'машины вождение','Zombies':'зомби',
 'Exploration':'исследование','Roguelike':'рогалик','Platformer':'платформер',
 'Roguelite':'рогалайт','Historical':'историческая','Management':'управление',
 'Competitive':'соревновательная','Steam':'стим','Open World Survival':'выживание в открытом мире',
};


export function evaluateCriterion(game, c) {
  const {key, value, op='eq'} = c;
  if (!key) return {state:null, reason:'Неверное условие'};
  if (key==='tag') return {state:game.tags?.includes(value) ? true : null, reason:game.tags?.includes(value)?'Тег указан в каталоге':'Тег не подтверждён'};
  if (key==='mode') return {state:game.modes?.includes(value) ? true : null, reason:game.modes?.includes(value)?'Режим указан в каталоге':'Режим не подтверждён'};
  if (key==='os') return {state:game.platforms?.includes(value) ? true : null,reason:game.platforms?.includes(value)?'ОС указана в Steam':'Сведения об ОС не подтверждены'};
  if (key==='language') return {state:game.languages?.includes(value)?true:null,reason:'Поддержка языка'};
  if (key==='free') return {state:game.isFree==null?null:game.isFree===Boolean(value), reason: game.isFree==null?'Нет сведений о типе покупки':'Сведения о бесплатности'};
  if (key==='players') {
    return {state:game.verifiedPlayerCount && known(game.playersMax)?Number(game.playersMax)>=Number(value):null,reason:game.verifiedPlayerCount?'Максимальное число участников':'Число игроков не подтверждено'};
  }
  if (key==='controller') return {state:game.controller == null?null:game.controller===Boolean(value),reason:'Поддержка контроллера'};
  if (key==='earlyAccess') return {state:game.earlyAccess == null?null:game.earlyAccess===Boolean(value),reason:'Ранний доступ'};
  const field = ({price:'priceCents',storage:'storageGb',rating:'reviewsPositive',reviews:'reviewsTotal',year:'year',ram:'ramGb'})[key];
  if (!field) return {state:null,reason:'Параметр пока недоступен'};
  let actual=game[field];
  if (key==='price' && game.isFree===true) actual=0;
  if (key==='rating' && game.reviewsTotal===0) actual=null;
  if (!known(actual)||!known(value)) return {state:null,reason:'Значение отсутствует'};
  const a=numeric(actual), b=numeric(value);
  const state=op==='gte'?a>=b:op==='lte'?a<=b:op==='eq'?a===b:op==='gt'?a>b:op==='lt'?a<b:null;
  return {state,reason:state?'Условие выполнено':'Условие не выполнено'};
}
function resolveGroup(evals, mode) {
  if (!evals.length) return true;
  if (mode==='any') return evals.some(x=>x===true)?true:evals.every(x=>x===false)?false:null;
  return evals.some(x=>x===false)?false:evals.every(x=>x===true)?true:null;
}
export function matchGame(game, query=DEFAULT_QUERY) {
  const criteria=(query.criteria||[]).filter(c=>c&&PRIORITIES.includes(c.priority));
  const details = criteria.map(c=>({ ...c, ...evaluateCriterion(game,c) }));
  // Required tags are interpreted with configurable ANY/ALL; other categories are joined by AND.
  const strict = details.filter(c=>c.priority==='required');
  const direct = strict.filter(c=>c.key!=='tag'&&c.key!=='mode');
  const t = strict.filter(c=>c.key==='tag').map(c=>c.state);
  const m = strict.filter(c=>c.key==='mode').map(c=>c.state);
  const requireStates=[...direct.map(c=>c.state), ...(t.length?[resolveGroup(t,query.tagMatch||'any')]:[]), ...(m.length?[resolveGroup(m,query.modeMatch||'any')]:[])];
  const prohibited = details.filter(c=>c.priority==='excluded');
  // Exclusion means the positive feature is forbidden, not that the criterion is negated manually.
  const excludeStates = prohibited.map(c=>c.state === null?null:!c.state);
  const states = [...requireStates,...excludeStates];
  const group = states.includes(false)?'similar':states.includes(null)?'unverified':'exact';
  const preferredHits = details.filter(c=>c.priority==='preferred'&&c.state===true).length;
  const issues = details.filter(c=>{
    if (c.priority==='preferred')return false;
    return c.priority==='excluded' ? c.state!==false : c.state!==true;
  }).map(c=>({...c, issue:c.state===null?'unknown':'failed'}));
  return {game,group,preferredHits,details,issues,violations:issues.filter(c=>c.issue==='failed').length};
}
function compareKnown(a,b, asc=true) {
  const ak=known(a),bk=known(b);
  if (!ak&&!bk)return 0; if(!ak)return 1; if(!bk)return -1;
  return (Number(a)-Number(b))*(asc?1:-1);
}
function comparator(sort) {
  return (a,b)=>{
    if(a.preferredHits!==b.preferredHits)return b.preferredHits-a.preferredHits;
    let compare=0;
    if(sort==='name')compare=a.game.name.localeCompare(b.game.name,'ru');
    if(sort==='year')compare=compareKnown(a.game.year,b.game.year,false);
    if(sort==='rating')compare=compareKnown(a.game.reviewsPositive,b.game.reviewsPositive,false);
    if(sort==='reviews')compare=compareKnown(a.game.reviewsTotal,b.game.reviewsTotal,false);
    if(sort==='price-asc')compare=compareKnown(a.game.isFree?0:a.game.priceCents,b.game.isFree?0:b.game.priceCents,true);
    if(sort==='price-desc')compare=compareKnown(a.game.isFree?0:a.game.priceCents,b.game.isFree?0:b.game.priceCents,false);
    if(sort==='storage')compare=compareKnown(a.game.storageGb,b.game.storageGb,true);
    if(compare!==0)return compare;
    return a.game.name.localeCompare(b.game.name,'ru')||a.game.appId-b.game.appId;
  };
}
export function searchGames(games,query=DEFAULT_QUERY) {
  const text=xlc(query.text);
  const output={exact:[],unverified:[],similar:[],totals:{exact:0,unverified:0,similar:0,catalog:games.length},coverage:{}};
  for(const game of games) {
    if(text && !xlc([game.name,...(game.tags||[]),...(game.tags||[]).map(t=>tagAliasesRu[t]||'')].join(' ')).includes(text))continue;
    const result=matchGame(game,query);
    output[result.group].push(result);
  }
  const compare=comparator(query.sort||'relevance');
  for(const key of ['exact','unverified','similar']) {
    output[key].sort(compare);
    output.totals[key]=output[key].length;
  }
  if(query.includeSimilar===false)output.similar=[];
  return output;
}
export function deriveTagOptions(games) {
  const count=new Map();
  for(const game of games)for(const tag of game.tags||[]) count.set(tag,(count.get(tag)||0)+1);
  return [...count].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([tag,total])=>({tag,total}));
}
export function criterionLabel(c) {
  if(c.label)return c.label;
  if(c.key==='tag')return c.value;
  if(c.key==='mode')return ({'single':'Одиночная','online-coop':'Онлайн-кооператив','local-coop':'Локальный кооператив','online-pvp':'Онлайн-PvP','multiplayer':'Мультиплеер'})[c.value]||c.value;
  if(c.key==='os')return c.value;
  if(c.key==='language')return c.value;
  if(c.key==='price')return `${c.op==='gte'?'От':'До'} ${(Number(c.value)/100).toFixed(2)} €`;
  if(c.key==='storage')return `Диск ${c.op==='gte'?'от':'до'} ${c.value} ГБ`;
  if(c.key==='rating')return `Отзывы от ${c.value}%`;
  if(c.key==='reviews')return `От ${c.value} отзывов`;
  if(c.key==='year')return `${c.op==='gte'?'От':'До'} ${c.value} года`;
  if(c.key==='ram')return `ОЗУ до ${c.value} ГБ`;
  if(c.key==='free')return 'Бесплатно';
  if(c.key==='players')return `От ${c.value} игроков`;
  if(c.key==='controller')return 'Поддержка контроллера';
  if(c.key==='earlyAccess')return 'Ранний доступ';
  return String(c.value);
}
