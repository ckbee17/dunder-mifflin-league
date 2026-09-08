/* ==========================================================================
   DUNDER MIFFLIN PAPER LEAGUE — in-page engine (browser)
   Real same-day Polymarket markets · paper money · runs while the tab is open.
   State persists in localStorage. Assumes global ASSETS (portrait data URLs).
   ========================================================================== */
(function(){
"use strict";
const START=1000, BET_SIZE=25, MAX_OPEN=10, CONTEST_DAYS=30, KEY="dmpl_v1";
const GAMMA="https://gamma-api.polymarket.com/markets";

const META=[
 {id:'jim',name:'Jim Halpert',role:'Sales',strat:'Laid-back contrarian — fades the favorite',quote:"Everyone's piling into the same side. So, naturally, I'm out."},
 {id:'dwight',name:'Dwight Schrute',role:'Asst. Regional Manager',strat:'Always backs the safe high-probability favorite',quote:"The favorite wins because the favorite is correct. Question nothing."},
 {id:'pam',name:'Pam Beesly',role:'Reception → Sales',strat:'Cautious mean-reversion — fades overreactions',quote:"I keep it small and stick to the markets I actually get."},
 {id:'andy',name:'Andy Bernard',role:'Sales',strat:'Follow-the-leader momentum — copies whoever is hot',quote:"Whoever's up, that's my play. Big tuna."},
 {id:'stanley',name:'Stanley Hubbard',role:'Sales',strat:'Near-certain favorites, closed by five',quote:"Nine to five. Not one minute past. It's Pretzel Day, anyway."},
 {id:'phyllis',name:'Phyllis Vance',role:'Sales',strat:'Market maker — works the mid-priced spread',quote:"I post both sides and collect the spread. Patience, dear."},
 {id:'ryan',name:'Ryan Howard',role:'Sales (the temp)',strat:'Chases the newest hot markets — big and fast',quote:"I only move on what's about to blow up. I see the future."},
 {id:'michael',name:'Michael Scott',role:'Regional Manager',strat:'Big confident bets, zero research, pure whim',quote:"I'm not superstitious. But I am a little stitious."},
 {id:'oscar',name:'Oscar Martinez',role:'Accounting',strat:'Fair-value EV plays — always shows the math',quote:"I ran the expected value. The math is not up for debate."},
 {id:'kevin',name:'Kevin Malone',role:'Accounting',strat:'Bets the obvious markets — does the math wrong',quote:"Number go up. I like when the number go up."},
 {id:'angela',name:'Angela Martin',role:'Accounting',strat:'Small, conservative, by-the-book',quote:"Small, safe, and settled by five. I do not gamble."},
 {id:'creed',name:'Creed Bratton',role:'Quality Assurance',strat:'Erratic and unknowable — no discernible system',quote:"I've been trading since before money. Or after it. Unclear."},
 {id:'meredith',name:'Meredith Palmer',role:'Supplier Relations',strat:'YOLO all-in on the longshot',quote:"All of it. On the longshot. What is the worst that could happen."},
 {id:'kelly',name:'Kelly Kapoor',role:'Customer Service',strat:'Pop & entertainment markets only',quote:"Is it about a celebrity? No? Then honestly I do not care."},
 {id:'gabe',name:'Gabe Lewis',role:'Sabre Liaison',strat:'Corporate/index plays — aggregate favorites',quote:"I prefer broad aggregate exposure. It's about synergy."},
 {id:'darryl',name:'Darryl Philbin',role:'Warehouse → Office',strat:'Value per contract — best payout ratio',quote:"Cheapest good contract on the board. That's the whole game."},
 {id:'erin',name:'Erin Hannon',role:'Reception',strat:'Cautious favorites in familiar categories',quote:"I just bet on stuff I get! Fingers and toes crossed!"},
 {id:'toby',name:'Toby Flenderson',role:'Human Resources',strat:'Capital preservation — safest near-locks',quote:"The safe pick. Always the safe pick. Nobody objects to that."},
];
const METABY={}; META.forEach(m=>METABY[m.id]=m);

const ROSTER={
 jim:{prim:'favorite',min_p:.90,max_pos:3,day_frac:.20},
 dwight:{prim:'momentum',min_chg:.03,max_pos:2,day_frac:.25},
 pam:{prim:'meanrev',min_chg:.05,max_pos:3,day_frac:.12},
 andy:{prim:'crowd',top_volume:20,max_pos:3,day_frac:.18},
 stanley:{prim:'nearcert',min_p:.93,max_pos:2,day_frac:.10},
 phyllis:{prim:'value',min_p:.35,max_p:.65,max_pos:4,day_frac:.15},
 ryan:{prim:'hypenew',max_pos:2,day_frac:.30,oversize:true},
 michael:{prim:'crowd',top_volume:6,max_pos:1,day_frac:.35,oversize:true,size_mult:1.3},
 oscar:{prim:'ev',edge_min:.03,max_pos:3,day_frac:.18},
 kevin:{prim:'naive',max_pos:3,day_frac:.20},
 angela:{prim:'nearcert',min_p:.95,max_pos:2,day_frac:.06},
 creed:{prim:'random',max_pos:3,day_frac:.20},
 meredith:{prim:'longshot',max_p:.12,max_pos:1,day_frac:.30,oversize:true},
 kelly:{prim:'crowd',tags:['culture','mention','pop','celebrity','entertainment','music','award'],top_volume:40,max_pos:3,day_frac:.18},
 gabe:{prim:'favorite',min_p:.80,top_volume:15,max_pos:4,day_frac:.15},
 darryl:{prim:'value',min_p:.25,max_p:.6,max_pos:3,day_frac:.18},
 erin:{prim:'favorite',tags:['sport','soccer','nfl','nba','weather','epl','game','win','vs'],min_p:.75,max_pos:2,day_frac:.12},
 toby:{prim:'nearcert',min_p:.96,max_pos:1,day_frac:.05},
};
const IDS=Object.keys(ROSTER);

/* ---------- helpers ---------- */
function jload(v,d){ if(typeof v!=='string') return (v==null?d:v); try{return JSON.parse(v);}catch(e){return d;} }
function etToday(){ return new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}); }
const money=v=>(v<0?'-$':'$')+Math.abs(Math.round(v)).toLocaleString('en-US');
const signed=v=>(v>=0?'+$':'−$')+Math.abs(Math.round(v)).toLocaleString('en-US');
async function fetchJSON(url){ const r=await fetch(url,{headers:{Accept:'application/json'}}); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }

/* ---------- state ---------- */
function freshState(){
 const agents={}, records={};
 IDS.forEach(k=>{ agents[k]={cash:START,positions:{},realized:0,fees:0,trades:0,wins:0,losses:0,equity:[START],today_trades:0,log:[],day_spent:0};
   records[k]={daily:[],days_led:0,best_day:0,worst_day:0,brier_sum:0,brier_n:0,streak:0,peak:START}; });
 return {agents,records,seen:{},runs:0,last_run:null,start_date:etToday(),day:null,day_start:{},last_equity:{}};
}
function loadState(){
 try{ const s=JSON.parse(globalThis.localStorage.getItem(KEY)); if(s&&s.agents){ IDS.forEach(k=>{ if(!s.records[k]) s.records[k]={daily:[],days_led:0,best_day:0,worst_day:0,brier_sum:0,brier_n:0,streak:0,peak:START}; if(s.agents[k]&&!s.agents[k].log) s.agents[k].log=[]; if(s.agents[k]&&s.agents[k].day_spent==null) s.agents[k].day_spent=0; }); return s; } }catch(e){}
 return freshState();
}
function saveState(st){ try{ globalThis.localStorage.setItem(KEY,JSON.stringify(st)); }catch(e){} }

/* ---------- market model ---------- */
function snapshot(m,seen){
 const op=jload(m.outcomePrices,null); if(!op||op.length<2) return null;
 const yes=+op[0], bid=+(m.bestBid!=null?m.bestBid:yes), ask=+(m.bestAsk!=null?m.bestAsk:yes);
 const fs=jload(m.feeSchedule,{})||{}; const cid=m.conditionId||m.id;
 const ev=(m.events&&m.events[0])||{};
 const tags=((ev.tags||[]).map(t=>t.label||'').join(' ')).toLowerCase();
 const text=((m.question||'')+' '+(ev.title||'')+' '+(ev.ticker||'')+' '+tags).toLowerCase();
 const prev=seen[cid];
 return {id:cid,q:m.question||'',yes,bid,ask,liq:+(m.liquidityNum||m.liquidity||3000),
  vol:+(m.volume24hr||0),fee_rate:+(fs.rate||0),fee_exp:+(fs.exponent||1),
  text,created:m.createdAt||'',end:m.endDateIso||m.endDate||'',change: prev!=null? yes-prev : 0};
}
const price=(s,side)=> side==='YES'? s.yes : 1-s.yes;
const ask_of=(s,side)=> side==='YES'? s.ask : 1-s.bid;
const fee=(s,p,shares)=> s.fee_rate*Math.pow(Math.min(p,1-p),s.fee_exp)*shares;

function isnew(s){ try{ return (Date.now()-new Date(s.created).getTime())/864e5 <= 3; }catch(e){ return false; } }
function score(prim,s,side,cfg){
 const p=price(s,side), chg= side==='YES'? s.change : -s.change;
 switch(prim){
  case 'favorite': return p>=(cfg.min_p||.90)? p : -1;
  case 'nearcert': return p>=(cfg.min_p||.93)? p : -1;
  case 'longshot': return p<=(cfg.max_p||.12)? (1-p) : -1;
  case 'momentum': return chg>(cfg.min_chg||.02)? chg*Math.log1p(s.vol) : -1;
  case 'meanrev': return (Math.abs(s.change)>(cfg.min_chg||.05)&&chg<0)? -chg : -1;
  case 'crowd': return ((side==='YES'&&p>=.5)||(side==='NO'&&p>.5))? s.vol : -1;
  case 'hypenew': return (isnew(s)&&side==='YES')? s.vol : -1;
  case 'ev': { const fair=Math.min(.99,Math.max(.01,p+.02*(p>.5?1:-1))); const e=fair-ask_of(s,side); return e>(cfg.edge_min||.03)? e : -1; }
  case 'value': return (p>=(cfg.min_p||.25)&&p<=(cfg.max_p||.6))? (1-p)/p : -1;
  case 'naive': return (side==='YES'&&p<=.5)? (1-p) : -1;
  case 'random': return Math.random();
 }
 return -1;
}
function decide(id,snaps){
 const cfg=ROSTER[id]; let pool=snaps;
 if(cfg.tags) pool=pool.filter(s=>cfg.tags.some(t=>s.text.indexOf(t)>=0));
 if(cfg.top_volume) pool=pool.slice().sort((a,b)=>b.vol-a.vol).slice(0,cfg.top_volume);
 const cands=[];
 pool.forEach(s=>['YES','NO'].forEach(side=>{ const v=score(cfg.prim,s,side,cfg); if(v>0) cands.push([v,s,side]); }));
 cands.sort((a,b)=>b[0]-a[0]);
 const picks=(cfg.oversize? cands.slice(0,1) : cands.slice(0,cfg.max_pos||3));
 return picks.map(x=>[x[1],x[2]]);
}

/* ---------- portfolio ---------- */
function buy(a,s,side,budget){
 budget=Math.min(budget,a.cash*0.95); if(budget<1) return 0;
 const p=ask_of(s,side), slip=Math.min(0.5*budget/Math.max(s.liq,1),0.15), fp=Math.min(0.99,p*(1+slip));
 const f=fee(s,fp,budget/fp), shares=(budget-f)/fp;
 a.cash-=budget; a.fees+=f; a.trades++;
 const key=s.id+'|'+side, pos=a.positions[key];
 if(pos){ const tot=pos.shares+shares; pos.cost=(pos.cost*pos.shares+fp*shares)/tot; pos.shares=tot; }
 else a.positions[key]={mid:s.id,side,shares,cost:fp,q:s.q.slice(0,60),end:s.end};
 a.log=a.log||[]; a.log.push({t:Date.now(),mid:s.id,q:(s.q||'').slice(0,90),side:side,price:fp,shares:shares,cost:shares*fp,fee:f,status:'open'});
 if(a.log.length>600) a.log=a.log.slice(-600);
 return budget;
}
async function settleAll(st){
 const mids=new Set();
 Object.values(st.agents).forEach(a=>Object.values(a.positions).forEach(p=>mids.add(p.mid)));
 const resolved={};
 for(const mid of mids){
  try{ const arr=await fetchJSON(GAMMA+'?condition_ids='+encodeURIComponent(mid)); const m=arr&&arr[0];
    if(m&&m.closed){ const op=jload(m.outcomePrices,null); if(op) resolved[mid]=(+op[0]>=0.5); } }catch(e){}
 }
 let n=0;
 IDS.forEach(id=>{ const a=st.agents[id], r=st.records[id];
  Object.keys(a.positions).forEach(key=>{ const pos=a.positions[key]; if(!(pos.mid in resolved)) return;
   const yesWon=resolved[pos.mid], won=(pos.side==='YES'&&yesWon)||(pos.side==='NO'&&!yesWon);
   a.cash+=pos.shares*(won?1:0); a.realized+=pos.shares*(won?1:0)-pos.shares*pos.cost;
   a[won?'wins':'losses']++; r.brier_sum+=Math.pow(pos.cost-(won?1:0),2); r.brier_n++;
   (a.log||[]).forEach(function(e){ if(e.mid===pos.mid&&e.side===pos.side&&e.status==='open'){ e.status=won?'won':'lost'; e.exit=won?1:0; e.pnl=e.shares*(won?1:0)-e.cost-e.fee; e.settledT=Date.now(); } });
   delete a.positions[key]; n++; });
 });
 return n;
}
function markEquity(a,priceByMid,seen){
 let eq=a.cash;
 Object.values(a.positions).forEach(pos=>{
  let cur=priceByMid[pos.mid];                       // fresh quote from today's snapshot
  if(cur==null && seen) cur=seen[pos.mid];           // else last price we saw for this market
  if(cur!=null) eq+=pos.shares*(pos.side==='YES'? cur : 1-cur);
  else eq+=pos.shares*pos.cost;                      // never quoted → hold at entry until it settles (no phantom $0)
 });
 return Math.round(eq*100)/100;
}
function rollDay(st,today){
 if(st.day==null){ st.day=today; st.day_start={}; IDS.forEach(function(k){st.day_start[k]=st.last_equity[k]!=null?st.last_equity[k]:START;st.agents[k].day_spent=0;}); return null; }
 if(st.day===today) return null;
 const pnls={};
 IDS.forEach(k=>{ const end=st.last_equity[k]!=null?st.last_equity[k]:START, start=st.day_start[k]!=null?st.day_start[k]:START;
  const pnl=Math.round((end-start)*100)/100; pnls[k]=pnl; const r=st.records[k];
  r.daily.push({date:st.day,pnl}); r.best_day=Math.max(r.best_day,pnl); r.worst_day=Math.min(r.worst_day,pnl);
  if(pnl>0) r.streak=r.streak>=0?r.streak+1:1; else if(pnl<0) r.streak=r.streak<=0?r.streak-1:-1; });
 let leader=IDS[0]; IDS.forEach(k=>{ if(pnls[k]>pnls[leader]) leader=k; });
 st.records[leader].days_led++;
 const prev=st.day; st.day=today; st.day_start={}; IDS.forEach(function(k){st.day_start[k]=st.last_equity[k]!=null?st.last_equity[k]:START;st.agents[k].day_spent=0;});
 return {date:prev,leader};
}

async function fetchMarkets(){
 const raw=await fetchJSON(GAMMA+'?closed=false&active=true&limit=500&order=volume24hr&ascending=false');
 const today=etToday();
 return raw.filter(m=>{ const d=(m.endDate||'').slice(0,10); return d===today && m.acceptingOrders && m.enableOrderBook; });
}

let LAST_SNAPS=[];
async function runRound(){
 const st=loadState(), today=etToday();
 rollDay(st,today);
 status('settling resolved bets…');
 let settled=0; try{ settled=await settleAll(st); }catch(e){}
 status('fetching today’s markets…');
 let raw; try{ raw=await fetchMarkets(); }
 catch(e){ status('⚠ could not reach Polymarket ('+e.message+'). Will retry next cycle.',true); return {error:true}; }
 const snaps=raw.map(m=>snapshot(m,st.seen)).filter(Boolean); LAST_SNAPS=snaps;
 const priceByMid={}; snaps.forEach(s=>priceByMid[s.id]=s.yes);
 IDS.forEach(id=>{ const a=st.agents[id]; a.today_trades=0;
  const picks=decide(id,snaps); if(!picks.length) return;
  picks.forEach(pr=>{ const s=pr[0], side=pr[1], key=s.id+'|'+side;
    if(key in a.positions) return;                          // already holding this market — one $25 bet each
    if(Object.keys(a.positions).length>=MAX_OPEN) return;   // hard cap: 10 open positions at a time
    if(buy(a,s,side,BET_SIZE)>0) a.today_trades++; }); });
 snaps.forEach(s=>st.seen[s.id]=s.yes);
 IDS.forEach(id=>{ const a=st.agents[id], eq=markEquity(a,priceByMid,st.seen);
  a.equity.push(eq); if(a.equity.length>90) a.equity=a.equity.slice(-90);
  st.last_equity[id]=eq; st.records[id].peak=Math.max(st.records[id].peak,eq);
  if(st.day_start[id]==null) st.day_start[id]=eq; });
 st.runs++; st.last_run=new Date().toISOString();
 st.markets=snaps.slice(0,20).map(function(s){return {id:s.id,yes:s.yes,q:s.q,vol:s.vol};});
 saveState(st);
 if(typeof document!=='undefined') render(st,priceByMid,snaps);
 status('live · '+snaps.length+' same-day markets · settled '+settled+' · round #'+st.runs);
 return {settled,markets:snaps.length,runs:st.runs};
}

/* ---------- view model ---------- */
function rows(st){
 return IDS.map(id=>{ const a=st.agents[id], r=st.records[id], m=METABY[id];
  const bal=st.last_equity[id]!=null?st.last_equity[id]:(a.equity[a.equity.length-1]||START);
  const settled=a.wins+a.losses;
  return {id,name:m.name,role:m.role,strat:m.strat,quote:m.quote,
   balance:bal,pnl:bal-START,today_pnl:Math.round((bal-(st.day_start[id]!=null?st.day_start[id]:START))*100)/100,
   wins:a.wins,losses:a.losses,winRate:settled?Math.round(100*a.wins/settled):null,
   tradesToday:a.today_trades,position:(function(){const p=Object.values(a.positions)[0];return p?p.side+' · '+p.q.slice(0,30):'flat';})(),
   equity:a.equity.slice(),open_positions:Object.keys(a.positions).length,fees:Math.round(a.fees*100)/100,
   days_led:r.days_led,calibration:r.brier_n>=3?Math.round(r.brier_sum/r.brier_n*1000)/1000:null,
   avg:settled?(bal-START)/settled:0}; });
}

/* ---------- rendering ---------- */
let selected=null;
function spark(eq,w,h){
 const mn=Math.min.apply(null,eq),mx=Math.max.apply(null,eq),rg=(mx-mn)||1,st=eq[0],en=eq[eq.length-1],up=en>=st;
 const col=up?'var(--gain)':'var(--loss)'; const X=i=>(i/(eq.length-1||1))*(w-2)+1, Y=v=>h-3-((v-mn)/rg)*(h-6);
 let ln=''; eq.forEach((v,i)=>ln+=(i?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' ');
 const ar='M'+X(0).toFixed(1)+' '+(h-1)+' '+ln.slice(1)+'L'+X(eq.length-1).toFixed(1)+' '+(h-1)+'Z', yb=Y(st).toFixed(1);
 return '<svg class="spk" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" aria-hidden="true">'+
  '<path d="'+ar+'" fill="'+col+'" opacity=".13"/>'+
  '<line x1="1" y1="'+yb+'" x2="'+(w-1)+'" y2="'+yb+'" stroke="var(--faint)" stroke-width=".7" stroke-dasharray="3 3"/>'+
  '<path d="'+ln+'" fill="none" stroke="'+col+'" stroke-width="1.8" stroke-linejoin="round"/>'+
  '<circle cx="'+X(eq.length-1).toFixed(1)+'" cy="'+Y(en).toFixed(1)+'" r="2.3" fill="'+col+'"/></svg>';
}
function img(id){ return (typeof ASSETS!=='undefined'&&ASSETS[id])||''; }
function renderGrid(R){
 const el=document.getElementById('grid'); if(!el) return;
 el.innerHTML=R.map((t,i)=>{ const cl=i<3?'p'+(i+1):'', settled=t.wins+t.losses;
  return '<div class="card '+cl+(t.id===selected?' sel':'')+'" data-id="'+t.id+'">'+
   '<div class="rk '+cl+'">'+(i+1)+'</div>'+
   '<div class="pf"><img src="'+img(t.id)+'" alt=""></div>'+
   '<div class="meta"><div class="nm">'+t.name+'</div><div class="role">'+t.role+'</div><div class="strat">'+t.strat+'</div></div>'+
   '<div>'+spark(t.equity,150,44)+'</div>'+
   '<div class="figs"><div class="bal">'+money(t.balance)+'</div>'+
     '<span class="pnl '+(t.pnl>=0?'g':'l')+'">'+signed(t.pnl)+'</span>'+
     '<div class="wr">'+(settled?t.winRate+'% W':'no bets settled')+' · '+t.tradesToday+' today</div></div>'+
   '<div class="cardstats"><span>Record <b>'+t.wins+'-'+t.losses+'</b></span>'+
     '<span>Avg/bet <b class="'+(t.avg>=0?'g':'l')+'">'+signed(t.avg)+'</b></span>'+
     '<span>Total <b class="'+(t.pnl>=0?'g':'l')+'">'+signed(t.pnl)+'</b></span>'+
     '<span>Fees <b>$'+Math.round(t.fees)+'</b></span>'+
     '<span>Open <b>'+t.open_positions+'</b></span></div>'+
   '</div>'; }).join('');
}
function renderSpot(R){
 const el=document.getElementById('spot'); if(!el) return;
 const t=R.find(x=>x.id===selected)||R[0]; const rank=R.findIndex(x=>x.id===t.id)+1;
 el.innerHTML=
  '<div class="frame"><div class="ribbon">'+(rank===1?"World's Best Trader":'#'+rank+' On The Board')+'</div>'+
   '<img src="'+img(t.id)+'" alt="'+t.name+'"></div>'+
  '<div class="body"><div class="who"><div class="nm">'+t.name+'</div><div class="role">'+t.role+'</div></div>'+
   '<div class="quote">"'+t.quote+'"</div><div class="strat">'+t.strat+'</div>'+
   '<div class="kpis">'+
    '<div class="kpi"><div class="k">Balance</div><div class="v">'+money(t.balance)+'</div></div>'+
    '<div class="kpi"><div class="k">Net P&amp;L</div><div class="v" style="color:'+(t.pnl>=0?'var(--gain)':'var(--loss)')+'">'+signed(t.pnl)+'</div></div>'+
    '<div class="kpi"><div class="k">Win rate</div><div class="v">'+(t.winRate!=null?t.winRate+'%':'—')+'</div></div>'+
    '<div class="kpi"><div class="k">Calibration</div><div class="v">'+(t.calibration!=null?t.calibration:'—')+'</div></div>'+
    '<div class="kpi chart"><div class="k">Equity · holding '+t.position+'</div>'+spark(t.equity,300,52)+'</div>'+
   '</div></div>';
}
function renderMarq(R){
 const el=document.getElementById('run'); if(!el) return;
 el.innerHTML=R.map(t=>'<span><b>'+t.name.split(' ')[0].toUpperCase()+'</b> '+money(t.balance)+' <span class="'+(t.pnl>=0?'up':'dn')+'">'+signed(t.pnl)+'</span></span>').join('')+
  '<span>◆ WINNER BECOMES THE LIVE DUNDER MIFFLIN PAPER CO. BOT ◆</span>';
}
function renderMarkets(snaps){
 const el=document.getElementById('markets'); if(!el) return;
 const top=snaps.slice().sort((a,b)=>b.vol-a.vol).slice(0,7);
 el.innerHTML=top.map(s=>'<div class="mk"><div><div class="q">'+(s.q||'').slice(0,42)+'</div><div class="c">same-day · vol '+Math.round((s.vol||0)/1000)+'k</div></div><div class="pr">'+Math.round(s.yes*100)+'c</div></div>').join('')
  || '<div class="mk"><div class="q">No same-day markets open right now.</div></div>';
}
function renderConf(R){
 if(!document.getElementById('confList')) return;
 const last=R[R.length-1]; const byToday=R.slice().sort((a,b)=>b.today_pnl-a.today_pnl);
 document.getElementById('confList').innerHTML=R.slice(0,10).map((t,i)=>{
  const cls=i===0?'lead':(t.id===last.id?'last':'');
  return '<li class="'+cls+'"><span><span class="r">'+(i+1)+'.</span>'+t.name+'</span><b>'+money(t.balance)+'</b></li>'; }).join('');
 const dEl=document.getElementById('day');
 document.getElementById('confDate').textContent='Day '+(dEl?dEl.textContent:'1')+' · winner goes live';
 document.getElementById('confAwards').innerHTML=
  '<div class="award"><h4>Top Dog</h4><div class="big">'+R[0].name+'</div></div>'+
  '<div class="award" style="border-color:#1553a6;transform:rotate(-1.5deg)"><h4>Leading Today</h4><div class="big" style="color:#1553a6">'+byToday[0].name+'</div></div>'+
  '<div class="award" style="border-color:#c1442e;transform:rotate(2deg)"><h4 style="color:#c1442e">In the Cellar</h4><div class="big" style="color:#c1442e">'+last.name+'</div></div>';
 document.getElementById('confNote').textContent='Whoever wins becomes our real bot. No pressure. — Management';
}
function renderFeed(R){
 const f=document.getElementById('feed'); if(!f) return;
 const by=R.slice().sort((a,b)=>b.today_pnl-a.today_pnl); let h='';
 h+='<div class="fi"><b>Live</b> — bets settle as today’s games finish.</div>';
 by.slice(0,2).forEach(r=>h+='<div class="fi"><b>'+r.name.split(' ')[0]+'</b> up <span style="color:var(--gain)">+$'+Math.round(r.today_pnl)+'</span> · '+r.position.slice(0,24)+'</div>');
 by.slice(-2).reverse().forEach(r=>{ if(r.today_pnl<0) h+='<div class="fi"><b>'+r.name.split(' ')[0]+'</b> down <span style="color:var(--loss)">−$'+Math.abs(Math.round(r.today_pnl))+'</span> · $'+Math.round(r.fees)+' fees</div>'; });
 f.innerHTML=h;
}
function render(st,priceByMid,snaps){
 const R=rows(st).sort((a,b)=>b.balance-a.balance);
 const dEl=document.getElementById('day'); if(dEl){ const dn=Math.round((new Date(etToday())-new Date(st.start_date))/864e5)+1; dEl.textContent=dn>0?dn:1; }
 renderSpot(R); renderGrid(R); renderMarq(R); renderConf(R); renderFeed(R); renderOffice(R); renderOpenTrades();
 if(snaps&&snaps.length) renderMarkets(snaps); else if(LAST_SNAPS.length) renderMarkets(LAST_SNAPS);
}

/* ---------- The Office (floor-plan) view ---------- */
function px(x,y,w,h,c){return '<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="'+c+'"/>';}
function hairShape(st,hair){ var s='';
 if(st==='bald'){ s+=px(6,7,1,3,hair)+px(15,7,1,3,hair)+px(7,5,8,1,hair); }
 else if(st==='bun'){ s+=px(6,5,10,3,hair)+px(6,6,1,3,hair)+px(15,6,1,3,hair)+px(9,2,4,3,hair); }
 else if(st==='curly'){ s+=px(6,5,10,3,hair)+px(5,4,3,2,hair)+px(9,3,4,2,hair)+px(13,4,3,2,hair)+px(6,6,1,3,hair)+px(15,6,1,3,hair); }
 else if(st==='long'){ s+=px(6,4,10,4,hair)+px(5,7,2,9,hair)+px(15,7,2,9,hair); }
 else if(st==='longwavy'){ s+=px(6,4,10,4,hair)+px(5,7,2,8,hair)+px(15,7,2,8,hair)+px(4,10,1,3,hair)+px(17,10,1,3,hair); }
 else if(st==='spiky'){ s+=px(6,5,10,2,hair)+px(6,3,2,2,hair)+px(9,2,2,3,hair)+px(12,3,2,2,hair)+px(14,3,2,2,hair)+px(6,6,1,2,hair)+px(15,6,1,2,hair); }
 else { s+=px(6,5,10,3,hair)+px(6,6,1,3,hair)+px(15,6,1,3,hair); } return s; }
function spriteSVG(c){ var s='';
 s+=px(7,24,3,5,c.pants)+px(12,24,3,5,c.pants)+px(6,29,4,1,'#2a2a2a')+px(12,29,4,1,'#2a2a2a');
 s+=px(6,15,10,10,c.shirt)+px(4,15,2,8,c.shirt)+px(16,15,2,8,c.shirt)+px(4,22,2,2,c.skin)+px(16,22,2,2,c.skin);
 if(c.vest){ s+=px(6,15,2,10,c.accent)+px(14,15,2,10,c.accent); }
 s+=px(9,13,4,2,c.skin);
 if(c.tie){ s+=px(9,15,4,1,'#fff')+px(10,16,2,7,c.accent); } else { s+=px(9,15,4,2,'#ffffff'); }
 s+=px(6,6,10,8,c.skin)+hairShape(c.hairStyle,c.hair)+px(8,9,2,2,'#23252e')+px(12,9,2,2,'#23252e');
 if(c.mustache) s+=px(8,12,6,1,c.hair);
 if(c.glasses){ s+=px(7,9,4,1,'#20242e')+px(7,11,4,1,'#20242e')+px(7,9,1,3,'#20242e')+px(10,9,1,3,'#20242e')+px(12,9,4,1,'#20242e')+px(12,11,4,1,'#20242e')+px(12,9,1,3,'#20242e')+px(15,9,1,3,'#20242e')+px(11,10,1,1,'#20242e'); }
 return '<svg viewBox="0 0 22 31" xmlns="http://www.w3.org/2000/svg">'+s+'</svg>'; }
var SPR={
 jim:{skin:'#e8b58a',hair:'#4a3220',shirt:'#3f7fd6',pants:'#26303f',hairStyle:'short'},
 dwight:{skin:'#e0a878',hair:'#6b4a2a',shirt:'#7d7a3a',accent:'#d4a52a',pants:'#3a3320',glasses:true,tie:true,hairStyle:'short'},
 pam:{skin:'#e8b58a',hair:'#7a5230',shirt:'#8fbf8a',pants:'#5a4a3a',hairStyle:'longwavy'},
 andy:{skin:'#eab88c',hair:'#5a3a20',shirt:'#e79bb0',accent:'#c0392b',vest:true,pants:'#33507a',hairStyle:'short'},
 stanley:{skin:'#7a4a2e',hair:'#161616',shirt:'#dcd2b0',accent:'#5a3a2a',pants:'#4a3a2a',tie:true,mustache:true,hairStyle:'short'},
 phyllis:{skin:'#e6b48c',hair:'#734a30',shirt:'#d98aa0',pants:'#6a5a4a',glasses:true,hairStyle:'curly'},
 ryan:{skin:'#e0a878',hair:'#161616',shirt:'#5b6472',accent:'#222222',pants:'#2a2a2a',tie:true,hairStyle:'spiky'},
 michael:{skin:'#e8b58a',hair:'#5a3a20',shirt:'#2a3550',accent:'#8a2a2a',pants:'#2a3550',tie:true,hairStyle:'short'},
 oscar:{skin:'#c98a5e',hair:'#161616',shirt:'#2a3550',accent:'#3a6ea5',vest:true,tie:true,glasses:true,pants:'#22283a',hairStyle:'curly'},
 kevin:{skin:'#e8b58a',hair:'#5a3a20',shirt:'#7fa8d0',pants:'#3a3a3a',hairStyle:'short'},
 angela:{skin:'#f0c89a',hair:'#d9c48a',shirt:'#b7a6c9',pants:'#5a5060',hairStyle:'bun'},
 creed:{skin:'#d0a074',hair:'#9a9086',shirt:'#6a6a5a',pants:'#4a4030',hairStyle:'bald'},
 meredith:{skin:'#e6b48c',hair:'#c05a30',shirt:'#b08040',pants:'#5a4030',hairStyle:'longwavy'},
 kelly:{skin:'#b07a4a',hair:'#161616',shirt:'#e08ab0',pants:'#4a3a4a',hairStyle:'long'},
 gabe:{skin:'#e0c0a0',hair:'#2a2320',shirt:'#3a3f48',accent:'#4a5560',pants:'#3a3f48',tie:true,hairStyle:'short'},
 darryl:{skin:'#6a4028',hair:'#161616',shirt:'#7a2a2a',pants:'#2a2a2a',mustache:true,hairStyle:'short'},
 erin:{skin:'#f0c89a',hair:'#c98a4a',shirt:'#e6c85a',pants:'#5a4a3a',hairStyle:'longwavy'},
 toby:{skin:'#e6c0a0',hair:'#8a6a4a',shirt:'#b8a884',pants:'#4a4030',hairStyle:'bald'},
};
var POS={ jim:[22,46], pam:[18,54], dwight:[26,55], andy:[35,45], phyllis:[33,56], stanley:[40,56],
 erin:[8.5,57], michael:[18,16], oscar:[16,77], kevin:[8.5,87], angela:[9,71],
 meredith:[22,84], creed:[29,82], darryl:[41,82], ryan:[57,66], gabe:[89,56], toby:[93,66], kelly:[92,83] };
var ZONES={ mich:[20,20], conf:[64,50], brk:[89,20] };
/* Walkable navigation graph traced from the office floor plan (percent coords).
   Sprites route along these corridors/doorways instead of cutting across walls. */
var NAV={
 ml_top:[8,24],ml_mid:[10,42],ml_low:[12,60],bl:[15,80],mich:[17,16],
 bp_nw:[22,30],bp_w:[20,52],bp_c:[31,50],bp_e:[41,50],bp_ntop:[34,20],
 top_l:[45,14],cv_top:[45,33],cv_mid:[46,52],cv_low:[47,70],cbot:[49,84],
 mh_l:[52,50],kitchen:[60,47],round:[66,49],mh_r:[72,51],
 croom_w:[55,63],croom:[63,67],bath:[59,80],
 r_top:[77,44],r_mid:[77,60],r_low:[78,76],r_bot:[76,88],
 gabe:[87,58],kelly:[91,84],brk_dn:[83,32],brk:[89,20]
};
var NAV_E=[['ml_top','ml_mid'],['ml_mid','ml_low'],['ml_low','bl'],['ml_top','mich'],['mich','bp_nw'],
 ['bp_nw','bp_w'],['ml_mid','bp_w'],['bl','bp_w'],['bp_w','bp_c'],['bp_c','bp_e'],
 ['bp_nw','bp_ntop'],['bp_ntop','top_l'],['bp_e','cv_mid'],['cv_top','cv_mid'],['cv_mid','cv_low'],
 ['cv_low','cbot'],['top_l','cv_top'],['cv_mid','mh_l'],['mh_l','kitchen'],['kitchen','round'],
 ['round','mh_r'],['cv_low','croom_w'],['croom_w','croom'],['cbot','bath'],['bath','croom'],
 ['croom','r_mid'],['mh_r','r_top'],['r_top','r_mid'],['r_mid','r_low'],['r_low','r_bot'],
 ['r_top','brk_dn'],['brk_dn','brk'],['r_mid','gabe'],['r_low','kelly'],['r_bot','kelly'],['bath','r_bot']];
/* Blue spare seats sprites can sit in during idle moments. */
var SEATS=[[34,16],[40,15],[45,20],[66,63],[70,63],[10,46],[95,58],[95,82],[87,12],[92,22]];
function buildOffice(){
 if(typeof document==='undefined'||document.getElementById('office')) return;
 var tabs=document.querySelector('.tabs');
 if(tabs){ var b=document.createElement('button'); b.className='tab'; b.setAttribute('data-tab','office'); b.textContent='The Office'; tabs.appendChild(b); }
 var sec=document.createElement('section'); sec.id='office'; sec.hidden=true;
 sec.innerHTML='<div class="floormap" id="floormap"><div id="spriteLayer"></div>'+
  '<div id="whiteboard"><h5>STANDINGS</h5><ol id="wbList"></ol></div>'+
  '<div class="fmhint">hover any sprite for their stats · they work at their desks, wander when they’re flat, gather for meetings — and trudge to Michael’s office after a losing trade</div></div>';
 var conf=document.getElementById('conf'); conf.parentNode.insertBefore(sec,conf.nextSibling);
 var fm=document.getElementById('floormap'); if(typeof FLOORPLAN!=='undefined') fm.style.backgroundImage='url('+FLOORPLAN+')';
 document.getElementById('spriteLayer').innerHTML=IDS.map(function(id){ return '<div class="sprite" id="spr-'+id+'" data-id="'+id+'">'+spriteSVG(SPR[id])+'<div class="tip"></div></div>'; }).join('');
 var wb=document.getElementById('whiteboard'); wb.style.left='52%'; wb.style.top='11%'; wb.style.width='22%';
 OFFICE.start();
}
function renderOffice(R){
 if(typeof document==='undefined'||!document.getElementById('spriteLayer')) return;
 // Whiteboard standings + crown live here; the OFFICE director owns sprite movement & tips.
 var wl=document.getElementById('wbList');
 if(wl) wl.innerHTML=R.slice(0,6).map(function(t,i){ return '<li class="'+(i===0?'lead':'')+'"><span>'+(i+1)+'. '+t.name.split(' ')[0]+'</span><b>'+money(t.balance)+'</b></li>'; }).join('');
 R.forEach(function(r,i){ var el=document.getElementById('spr-'+r.id); if(!el) return;
  var crown=el.querySelector('.crown');
  if(i===0&&!crown){ var cr=document.createElement('div'); cr.className='crown'; cr.textContent='♛'; el.appendChild(cr); }
  else if(i!==0&&crown){ crown.remove(); }
 });
 OFFICE.feed(R);
}

/* ---------- office director: subtle, life-like sprite movement ----------
   Runs on its own browser timer so the floor feels alive between the 15-min
   data updates. Modes (priority): all-hands meeting > walk of shame (a trade
   just settled at a loss) > winners' huddle (a top-3 bot just booked a win) >
   at desk (holding open trades) > idle wandering. Inert under Node (DOM-guarded). */
var OFFICE=(function(){
 var HOP=1150;                             // ms per corridor hop (walking speed)
 var last=[], prevW={}, prevL={}, seeded=false, started=false;
 var shame={}, celeb={}, sit={};           // id -> expiry ms (sit: {until,spot,tip})
 var meetingUntil=0, nextMeeting=0;
 var S={};                                 // id -> {x,y,route:[[x,y]..],key}
 // adjacency
 var ADJ={}; Object.keys(NAV).forEach(function(k){ADJ[k]=[];});
 NAV_E.forEach(function(e){ ADJ[e[0]].push(e[1]); ADJ[e[1]].push(e[0]); });
 function d2(a,b){ var dx=a[0]-b[0],dy=a[1]-b[1]; return dx*dx+dy*dy; }
 function nearest(p){ var best=null,bd=1e9; for(var k in NAV){ var dd=d2(p,NAV[k]); if(dd<bd){bd=dd;best=k;} } return best; }
 function bfs(a,b){ if(a===b) return [a]; var q=[a],prev={}; prev[a]=null;
  while(q.length){ var n=q.shift(); var nb=ADJ[n]; for(var i=0;i<nb.length;i++){ var m=nb[i]; if(!(m in prev)){ prev[m]=n; if(m===b){ var path=[m]; while(prev[path[0]]!=null) path.unshift(prev[path[0]]); return path; } q.push(m); } } }
  return [a,b]; }
 function routeTo(id,dx,dy){ var s=S[id]; var sn=nearest([s.x,s.y]), en=nearest([dx,dy]);
  var path=(sn===en)?[]:bfs(sn,en).map(function(k){return NAV[k];});
  path.push([dx,dy]); s.route=path; }
 // stable per-bot slot offset so a zone's occupants don't stack (doesn't change over time → no re-route thrash)
 function slot(id,w,dx,dy){ var i=IDS.indexOf(id); return [((i%w)-(w-1)/2)*dx, Math.floor(i/w%4)*dy]; }
 function feed(R){
  last=R; var now=Date.now();
  if(!seeded){ R.forEach(function(r){ prevW[r.id]=r.wins; prevL[r.id]=r.losses; }); seeded=true; return; }
  R.forEach(function(r,idx){
   if(r.losses>(prevL[r.id]||0)) shame[r.id]=now+110000;             // new settled loss → Michael's office ~2 min
   if(r.wins>(prevW[r.id]||0) && idx<3) celeb[r.id]=now+45000;       // top-3 books a win → conference huddle
   prevW[r.id]=r.wins; prevL[r.id]=r.losses;
  });
 }
 function decide(){                        // choose each bot's destination + tip (every 4.5s)
  var now=Date.now();
  if(nextMeeting===0) nextMeeting=now+(7+Math.random()*4)*60000;
  if(now>=nextMeeting && meetingUntil===0) meetingUntil=now+40000;   // all-hands ~40s
  if(meetingUntil && now>meetingUntil){ meetingUntil=0; nextMeeting=now+(7+Math.random()*4)*60000; }
  var meeting=meetingUntil && now<meetingUntil;
  last.forEach(function(r){
   var el=document.getElementById('spr-'+r.id); if(!el||!S[r.id]) return;
   var key,dest,tip,o;
   if(meeting){ key='meet'; o=slot(r.id,6,3.0,3.4); dest=[ZONES.conf[0]+o[0],ZONES.conf[1]+o[1]]; tip='all-hands meeting'; }
   else if(shame[r.id]&&now<shame[r.id]){ key='mich'; o=slot(r.id,3,4.0,4.6); dest=[ZONES.mich[0]+o[0],ZONES.mich[1]+o[1]]; tip='in Michael’s office · '+signed(r.pnl); }
   else if(celeb[r.id]&&now<celeb[r.id]){ key='conf'; o=slot(r.id,4,3.2,3.6); dest=[ZONES.conf[0]+o[0],ZONES.conf[1]+o[1]]; tip='conference room · '+signed(r.today_pnl)+' today'; }
   else if(r.open_positions>0){ key='desk'; dest=POS[r.id]; tip=r.open_positions+' open · at their desk'; delete sit[r.id]; }
   else {
    var w=sit[r.id];
    if(w&&now<w.until){ key=w.key; dest=w.spot; tip=w.tip; }
    else { delete sit[r.id];
     if(Math.random()<0.06){                                         // idle → occasional trip, then back to desk
      var pick=Math.random();
      if(pick<0.3){ sit[r.id]={until:now+22000,key:'brk',spot:[ZONES.brk[0]+slot(r.id,2,4.0,4.6)[0],ZONES.brk[1]+slot(r.id,2,4.0,4.6)[1]],tip:'break room'}; }
      else if(pick<0.65){ var st=SEATS[Math.floor(Math.random()*SEATS.length)]; sit[r.id]={until:now+20000,key:'seat'+st[0]+st[1],spot:st,tip:'taking a seat'}; }
      else { sit[r.id]={until:now+16000,key:'brk2',spot:ZONES.brk.slice(),tip:'grabbing coffee'}; }
      key=sit[r.id].key; dest=sit[r.id].spot; tip=sit[r.id].tip;
     } else { key='desk'; dest=POS[r.id]; tip='at their desk'; }
    }
   }
   if(S[r.id].key!==key){ S[r.id].key=key; routeTo(r.id,dest[0],dest[1]); }
   var t=el.querySelector('.tip'); if(t) t.innerHTML='<b>'+r.name+'</b><br>'+money(r.balance)+' ('+signed(r.pnl)+') · '+tip;
  });
 }
 function step(){                          // advance every sprite one corridor hop
  IDS.forEach(function(id){ var s=S[id]; if(!s||!s.route||!s.route.length) return;
   var el=document.getElementById('spr-'+id); if(!el) return;
   var p=s.route.shift(); s.x=p[0]; s.y=p[1];
   el.style.transition='left '+HOP+'ms linear, top '+HOP+'ms linear';
   el.style.left=p[0]+'%'; el.style.top=p[1]+'%';
  });
 }
 function start(){
  if(started||typeof document==='undefined') return; started=true;
  IDS.forEach(function(id){ var el=document.getElementById('spr-'+id); if(el){ var p=POS[id]; S[id]={x:p[0],y:p[1],route:[],key:'desk'}; el.style.transition='none'; el.style.left=p[0]+'%'; el.style.top=p[1]+'%'; } });
  setTimeout(function(){ decide(); },80);
  setInterval(decide,4500);
  setInterval(step,HOP);
 }
 return {feed:feed, tick:decide, start:start};
})();

/* ---------- open-trades side panel ---------- */
function buildOpenPanel(){
 if(typeof document==='undefined'||document.getElementById('opentrades')) return;
 var aside=document.querySelector('.cols aside'); if(!aside) return;
 var sec=document.createElement('section'); sec.className='panel';
 sec.innerHTML='<div class="ph">Open Trades <span class="r" id="opencount">0 live</span></div><div id="opentrades" class="opentr"></div>';
 aside.insertBefore(sec, aside.firstChild);
}
function renderOpenTrades(){
 if(typeof document==='undefined') return;
 var el=document.getElementById('opentrades'); if(!el) return;
 var st=loadState(), pmap=Object.assign({},st.seen||{}); LAST_SNAPS.forEach(function(s){pmap[s.id]=s.yes;});
 var rows=[];
 IDS.forEach(function(id){ var a=st.agents[id], m=METABY[id];
  Object.keys(a.positions).forEach(function(k){ var p=a.positions[k];
   var cur=pmap[p.mid]; var cs=cur==null?null:(p.side==='YES'?cur:1-cur);
   rows.push({id:id,name:m.name.split(' ')[0],q:p.q,side:p.side,entry:p.cost,cur:cs,unreal:cs==null?null:p.shares*(cs-p.cost)}); });
 });
 var cnt=document.getElementById('opencount'); if(cnt) cnt.textContent=rows.length+' live';
 if(!rows.length){ el.innerHTML='<div class="otempty">No open trades right now.</div>'; return; }
 rows.sort(function(a,b){ return (b.unreal==null?-1e9:b.unreal)-(a.unreal==null?-1e9:a.unreal); });
 el.innerHTML=rows.map(function(r){
  var now=r.cur==null?'<span class="otawait">awaiting close</span>':('→ '+Math.round(r.cur*100)+'c');
  var stat=r.unreal==null?'':'<div class="otstat '+(r.unreal>=0?'ahead':'behind')+'">'+signed(r.unreal)+'</div>';
  return '<div class="otrow" data-id="'+r.id+'"><img class="otimg" src="'+img(r.id)+'" alt="">'+
   '<div class="otmain"><div class="otname">'+r.name+' <span class="otside '+(r.side==='YES'?'yes':'no')+'">'+r.side+'</span></div>'+
   '<div class="otq">'+esc(r.q).slice(0,42)+'</div></div>'+
   '<div class="otfig"><div class="otodds">@'+Math.round(r.entry*100)+'c '+now+'</div>'+stat+'</div></div>';
 }).join('');
}

/* ---------- trade-log modal ---------- */
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function fmtTime(t){ try{ return new Date(t).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; } }
function buildModal(){
 if(typeof document==='undefined'||document.getElementById('trmodal')) return;
 var d=document.createElement('div'); d.id='trmodal'; d.className='trmodal'; d.hidden=true;
 d.innerHTML='<div class="trbox"><div class="trhead"><img id="trimg" alt=""><div><div class="nm" id="trname"></div><div class="sub" id="trsub"></div></div><button id="trclose" title="Close">✕</button></div>'+
  '<div class="trwrap"><table class="trtable"><thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Entry</th><th>Shares</th><th>Cost</th><th>Fee</th><th>Result · P&amp;L</th></tr></thead><tbody id="trbody"></tbody></table></div></div>';
 document.body.appendChild(d);
 d.addEventListener('click',function(e){ if(e.target===d) closeTrades(); });
 document.getElementById('trclose').addEventListener('click',closeTrades);
 document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeTrades(); });
}
function renderTrades(id){
 var st=loadState(), a=st.agents[id], m=METABY[id];
 var bal=st.last_equity[id]!=null?st.last_equity[id]:START, pnl=bal-START, settled=a.wins+a.losses;
 document.getElementById('trimg').src=img(id);
 document.getElementById('trname').textContent=m.name;
 document.getElementById('trsub').innerHTML=esc(m.strat)+' · '+money(bal)+' ('+signed(pnl)+') · '+((a.log||[]).length)+' trades · '+(settled?Math.round(100*a.wins/settled)+'% W':'0 settled');
 var log=(a.log||[]).slice().reverse(), body=document.getElementById('trbody');
 if(!log.length){ body.innerHTML='<tr><td colspan="8" style="padding:20px;text-align:center;color:var(--faint)">No trades yet — this bot hasn’t placed a bet.</td></tr>'; return; }
 body.innerHTML=log.map(function(e){
  var res=e.status==='open'?'<span class="trpill open">OPEN</span>':(e.status==='won'?'<span class="trpill won">WON</span>':'<span class="trpill lost">LOST</span>');
  var pc=e.status==='open'?'<span style="color:var(--faint)">—</span>':'<span class="'+(e.pnl>=0?'trg':'trl')+'">'+signed(e.pnl)+'</span>';
  return '<tr><td>'+fmtTime(e.t)+'</td><td class="q" title="'+esc(e.q)+'">'+esc(e.q).slice(0,48)+'</td>'+
   '<td class="'+(e.side==='YES'?'yes':'no')+'">'+e.side+'</td><td>'+Math.round(e.price*100)+'c</td>'+
   '<td>'+e.shares.toFixed(1)+'</td><td>$'+e.cost.toFixed(2)+'</td><td>$'+e.fee.toFixed(2)+'</td>'+
   '<td>'+res+' '+pc+'</td></tr>';
 }).join('');
}
function openTrades(id){ buildModal(); renderTrades(id); var m=document.getElementById('trmodal'); if(m) m.hidden=false; }
function closeTrades(){ var m=document.getElementById('trmodal'); if(m) m.hidden=true; }

/* ---------- status + controls + loop ---------- */
function status(msg,err){ if(typeof document==='undefined') return; const s=document.getElementById('statusText'); if(s){ s.textContent=msg; s.style.color=err?'#ffd2c9':'#eafff2'; }
 const dot=document.getElementById('statusDot'); if(dot) dot.style.background=err?'#c1442e':(running?'#3ddc84':'#8a7f6a'); }
let running=false, timer=null, INTERVAL=15*60*1000, nextAt=0, busy=false;
async function tick(){ if(busy) return; busy=true; try{ await runRound(); }catch(e){ status('⚠ '+e.message,true); } busy=false; nextAt=Date.now()+INTERVAL; }
function schedule(){ clearTimeout(timer); nextAt=Date.now()+INTERVAL; timer=setTimeout(function(){ tick().then(function(){ if(running) schedule(); }); }, INTERVAL); }
function start(){ running=true; setBtns(); tick().then(function(){ if(running) schedule(); }); }
function pause(){ running=false; clearTimeout(timer); setBtns(); status('paused'); }
function setBtns(){ const b=document.getElementById('toggleBtn'); if(b){ b.textContent=running?'❚❚ Pause':'▶ Start'; } const d=document.getElementById('statusDot'); if(d) d.style.background=running?'#3ddc84':'#8a7f6a'; }
function fmtCountdown(){ const c=document.getElementById('countdown'); if(!c) return; if(!running){ c.textContent='—'; return; } const s=Math.max(0,Math.round((nextAt-Date.now())/1000)); c.textContent=Math.floor(s/60)+':'+('0'+(s%60)).slice(-2); }

function buildControls(){
 const bar=document.createElement('div'); bar.className='ctrl';
 bar.innerHTML=
  '<span class="dot" id="statusDot"></span>'+
  '<span id="statusText">ready</span>'+
  '<span class="grow"></span>'+
  '<label>Every <select id="intervalSel">'+
   '<option value="5">5 min</option><option value="15" selected>15 min</option>'+
   '<option value="30">30 min</option><option value="60">60 min</option></select></label>'+
  '<span class="cd">next: <b id="countdown">—</b></span>'+
  '<button id="runNow">Run now</button>'+
  '<button id="toggleBtn">▶ Start</button>'+
  '<button id="resetBtn" class="danger">Reset</button>';
 const anchor=document.querySelector('.tabs')||document.querySelector('.marq');
 anchor.parentNode.insertBefore(bar,anchor);
 document.getElementById('intervalSel').addEventListener('change',function(e){ INTERVAL=(+e.target.value)*60000; if(running) schedule(); });
 document.getElementById('runNow').addEventListener('click',function(){ tick(); });
 document.getElementById('toggleBtn').addEventListener('click',function(){ running?pause():start(); });
 document.getElementById('resetBtn').addEventListener('click',function(){ if(confirm('Reset the whole league back to $1,000 each? This clears all history.')){ saveState(freshState()); render(loadState(),{},[]); status('reset to $1,000 each · Day 1'); } });
 document.addEventListener('click',function(e){ const c=e.target.closest&&e.target.closest('#grid .card[data-id], .sprite[data-id], .otrow[data-id]'); if(c){ selected=c.dataset.id; render(loadState(),{},LAST_SNAPS); openTrades(c.dataset.id); } });
 var tabsEl=document.querySelector('.tabs');
 if(tabsEl) tabsEl.addEventListener('click',function(e){ var btn=e.target.closest&&e.target.closest('.tab'); if(!btn) return;
   document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); btn.classList.add('active');
   var t=btn.dataset.tab; ['bullpen','conf','office'].forEach(function(id){ var el=document.getElementById(id); if(el) el.hidden=(id!==t); });
   render(loadState(),{},LAST_SNAPS); });
 setInterval(fmtCountdown,1000);
}

function init(){
 if(typeof document==='undefined') return;
 // swap demo badge for our live badge
 const badge=document.querySelector('.hud .demo'); if(badge){ badge.id='liveBadge'; badge.classList.remove('blink'); badge.textContent='● LIVE'; badge.style.background='#2f8f5b'; badge.style.color='#eafff2'; badge.style.borderColor='#256f47'; }
 buildControls();
 buildOffice();
 buildOpenPanel();
 render(loadState(),{},[]);              // show saved state immediately
 start();                                // auto-run on open
}
/* ---------- viewer mode (reads server-produced state.json, no trading) ---------- */
function wireInteractions(){
 var tabsEl=document.querySelector('.tabs');
 if(tabsEl) tabsEl.addEventListener('click',function(e){ var btn=e.target.closest&&e.target.closest('.tab'); if(!btn) return;
   document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active')); btn.classList.add('active');
   var t=btn.dataset.tab; ['bullpen','conf','office'].forEach(function(id){ var el=document.getElementById(id); if(el) el.hidden=(id!==t); });
   render(loadState(),{},LAST_SNAPS); });
 document.addEventListener('click',function(e){ var c=e.target.closest&&e.target.closest('#grid .card[data-id], .sprite[data-id], .otrow[data-id]'); if(c){ selected=c.dataset.id; render(loadState(),{},LAST_SNAPS); openTrades(c.dataset.id); } });
}
function fetchState(){
 if(typeof fetch==='undefined') return;
 fetch('state.json?t='+Date.now(),{cache:'no-store'}).then(function(r){return r.json();}).then(function(st){
   try{ globalThis.localStorage.setItem(KEY, JSON.stringify(st)); }catch(e){}
   LAST_SNAPS=(st.markets||[]);
   render(loadState(),{},LAST_SNAPS);
   var b=document.getElementById('liveBadge');
   if(b){ var mins=st.last_run?Math.round((Date.now()-new Date(st.last_run).getTime())/60000):null;
     b.textContent='● LIVE'+(mins==null?'':' · updated '+(mins<1?'just now':mins+'m ago')); }
 }).catch(function(e){});
}
function clock(){ if(typeof document==='undefined') return; var c=document.getElementById('clock'); if(c){ try{ c.textContent=new Date().toLocaleTimeString('en-US',{timeZone:'America/New_York',hour12:false})+' ET'; }catch(e){} } }
function initViewer(){
 if(typeof document==='undefined') return;
 var badge=document.querySelector('.hud .demo'); if(badge){ badge.id='liveBadge'; badge.classList.remove('blink'); badge.textContent='● LIVE'; badge.style.background='#2f8f5b'; badge.style.color='#eafff2'; badge.style.borderColor='#256f47'; }
 buildOffice(); buildOpenPanel(); buildModal(); wireInteractions();
 fetchState(); setInterval(fetchState,60000);
 clock(); setInterval(clock,1000);
}
function boot(){ if(typeof VIEWER!=='undefined'&&VIEWER) initViewer(); else init(); }
if(typeof document!=='undefined'){ if(document.readyState!=='loading') boot(); else document.addEventListener('DOMContentLoaded',boot); }

// expose for offline tests
if(typeof module!=='undefined') module.exports={runRound,loadState,saveState,freshState,rows,ROSTER,IDS,snapshot,decide};
globalThis.__DMPL={runRound,loadState,saveState,freshState,rows,snapshot,decide,ROSTER,IDS,setSnaps:function(s){LAST_SNAPS=s;},render:function(){render(loadState(),{},LAST_SNAPS);}};
})();
