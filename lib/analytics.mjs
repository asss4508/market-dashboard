/** Browser-safe retrospective research. Percentages are in percentage units, spreads in bp. */
import { buildInterpretation } from './interpretation.mjs';
const DAY = 86_400_000;
const WINDOWS = [252,756,1260];
const HORIZONS = [5,20,60,120];
export const DEFAULT_CONFIG = {
  window:252, minCoverage:0.6,
  weights:{
    overheat:{rsi:30,disparity60:20,creditGrowth20:25,creditDeposit:25},
    stress:{rv20:25,fxChange20:20,creditSpread:20,forcedSales5:20,creditDeposit:15},
    momentum:{trend200:30,momentum20:25,foreign20:20,institution20:15,breadth60:10},
  },
};
const finite = Number.isFinite;
const sum = a=>a.reduce((s,v)=>s+v,0);
const mean = a=>a.length?sum(a)/a.length:null;
const sd = (a,m=mean(a))=>a.length>1?Math.sqrt(sum(a.map(v=>(v-m)**2))/(a.length-1)):null;
const pct = (a,b)=>positive(b) && finite(a)?100*(a/b-1):null;
const positive = v=>finite(v) && v>0;
function day(s) {
  if(typeof s!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const t=Date.parse(s);
  return finite(t) && new Date(t).toISOString().slice(0,10)===s?t/DAY:NaN;
}
function localDay(s) {
  if(typeof s!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !finite(day(s.slice(0,10)))) return NaN;
  return Math.floor((Date.parse(s)+9*3600_000)/DAY);
}
function ordered(points,through='9999-12-31') {
  const unique=new Map();
  for(const p of points??[]) {
    if(!p || !finite(day(p.date)) || p.date>through || !finite(p.value)) continue;
    const old=unique.get(p.date);
    if(old && old.value!==p.value) return []; // conflicting versions cannot support historical comparison
    if(!old || (p.availableAt && (!old.availableAt || Date.parse(p.availableAt)>Date.parse(old.availableAt)))) unique.set(p.date,p);
  }
  return [...unique.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
export function seriesPoints(dashboard,id) {
  return ordered(dashboard?.series?.[id]?.points).map(p=>({date:p.date,value:p.value}));
}
function seriesLag(series) {
  if(finite(series?.publicationLagDays) && series.publicationLagDays>=0) return Math.ceil(series.publicationLagDays);
  const frequency=series?.frequency??'daily', minimum=frequency==='monthly'?35:frequency==='quarterly'?90:1;
  return Math.max(minimum,Math.ceil(finite(series?.expectedLagDays)?series.expectedLagDays:minimum));
}
function observation(p,lag) {
  const t=day(p.date);
  // Using the following local date avoids assuming the hour of a Korean close on special sessions.
  const release=p.availableAt==null?t+lag:localDay(p.availableAt)+1;
  return finite(release)?{v:p.value,ready:Math.max(t,release)}:null;
}
function cell(v,ready) {return finite(v) && finite(ready)?{v,ready}:null;}
function combine(a,b,fn) {return a.map((x,i)=>x && b[i]?cell(fn(x.v,b[i].v),Math.max(x.ready,b[i].ready)):null);}
function roll(a,n,fn) {
  if(!Number.isInteger(n) || n<1) return a.map(()=>null);
  return a.map((_,i)=>{
    if(i+1<n) return null;
    const w=a.slice(i-n+1,i+1);
    if(w.some(x=>!x)) return null;
    return cell(fn(w.map(x=>x.v)),Math.max(...w.map(x=>x.ready)));
  });
}
function lagChange(a,n) {
  return a.map((x,i)=>x && i>=n && a[i-n]?cell(pct(x.v,a[i-n].v),Math.max(x.ready,a[i-n].ready)):null);
}
function rsiValues(a,n) {
  const out=a.map(()=>null);
  if(!Number.isInteger(n) || n<1) return out;
  let gain=0,loss=0,count=0,ready=-Infinity;
  for(let i=1;i<a.length;i++) {
    const prev=a[i-1],x=a[i];
    if(!prev || !x) {gain=loss=count=0;ready=-Infinity;continue;}
    const d=x.v-prev.v,g=Math.max(0,d),l=Math.max(0,-d);
    ready=Math.max(ready,prev.ready,x.ready); count++;
    if(count<=n){gain+=g/n;loss+=l/n;}else{gain=(gain*(n-1)+g)/n;loss=(loss*(n-1)+l)/n;}
    if(count>=n) out[i]=cell(loss===0?(gain===0?50:100):100-100/(1+gain/loss),ready);
  }
  return out;
}
function ema(a,n) {
  let count=0,init=0,prev=0,ready=-Infinity;
  return a.map(x=>{
    if(!x){count=init=prev=0;ready=-Infinity;return null;}
    count++;ready=Math.max(ready,x.ready);
    if(count<=n){init+=x.v;if(count<n)return null;prev=init/n;}
    else prev+=2/(n+1)*(x.v-prev);
    return cell(prev,ready);
  });
}
function macdValues(a) {
  const m=combine(ema(a,12),ema(a,26),(x,y)=>x-y), signal=ema(m,9);
  return {macd:m,signal,histogram:combine(m,signal,(x,y)=>x-y)};
}
function rvValues(a,n) {
  const returns=a.map((x,i)=>x && i && a[i-1] && positive(x.v) && positive(a[i-1].v)?
    cell(Math.log(x.v)-Math.log(a[i-1].v),Math.max(x.ready,a[i-1].ready)):null);
  return n>1?roll(returns,n,w=>sd(w)*100*Math.sqrt(252)):a.map(()=>null);
}
function helper(points,fn) {
  const p=ordered(points), values=fn(p.map(x=>cell(x.value,day(x.date))));
  return p.flatMap((x,i)=>values[i]?[{date:x.date,value:values[i].v}]:[]);
}
export function movingAverage(points,n){return helper(points,a=>roll(a,n,mean));}
export function rsi(points,n=14){return helper(points,a=>rsiValues(a,n));}
export function realizedVolatility(points,n=20){return helper(points,a=>rvValues(a,n));}
export function macd(points) {
  const p=ordered(points), m=macdValues(p.map(x=>cell(x.value,day(x.date))));
  return p.flatMap((x,i)=>m.macd[i]?[{date:x.date,macd:m.macd[i].v,signal:m.signal[i]?.v??null,histogram:m.histogram[i]?.v??null}]:[]);
}
function pathMdd(values) {
  let peak=values[0],worst=0;
  for(const value of values){peak=Math.max(peak,value);worst=Math.min(worst,pct(value,peak));}
  return worst;
}
function ranked(sorted,v) {
  function bound(upper) {
    let low=0,high=sorted.length;
    while(low<high){const m=(low+high)>>>1;if(sorted[m]<v || (upper && sorted[m]===v))low=m+1;else high=m;}
    return low;
  }
  return (bound(false)+bound(true))*50/sorted.length;
}
function insertIndex(sorted,v) {
  let lo=0,hi=sorted.length;
  while(lo<hi){const m=(lo+hi)>>>1;if(sorted[m]<v)lo=m+1;else hi=m;}
  return lo;
}
function selectSource(dashboard,ids,cutoff,minLength=252) {
  const through=day(cutoff);
  const candidates=ids.map(id=>{
    const line=dashboard?.series?.[id],all=ordered(line?.points,cutoff);
    const last=all.findLastIndex(p=>p.availableAt==null || localDay(p.availableAt)+1<=through);
    return {id,line,p:all.slice(0,last+1)};
  })
    .filter(x=>x.line?.frequency==='daily' && x.line?.unit==='pt' && x.p.length && x.p.every(p=>positive(p.value)));
  return (candidates.some(x=>x.p.length>=minLength)?candidates.filter(x=>x.p.length>=minLength):candidates)
    .sort((a,b)=>b.p.at(-1).date.localeCompare(a.p.at(-1).date)||b.p.length-a.p.length)[0];
}
function configOf(input) {
  const cfg=input??{};
  const weights={};
  for(const [group,defaults] of Object.entries(DEFAULT_CONFIG.weights)) {
    weights[group]=Object.fromEntries(Object.entries(defaults).map(([id,v])=>{
      const w=cfg.weights?.[group]?.[id]; return [id,finite(w) && w>=0?w:v];
    }));
  }
  return {window:WINDOWS.includes(cfg.window)?cfg.window:252,
    minCoverage:Math.max(.6,Math.min(1,finite(cfg.minCoverage)?cfg.minCoverage:.6)),weights};
}
const iso=t=>new Date(t*DAY).toISOString().slice(0,10);
const DEFINITIONS = {
  rsi:['RSI(14)','pt','price'], disparity60:['60일 평균 대비 이격률','%','price'],
  creditGrowth20:['양 시장 신용융자 20일 증가율','%','leverage'],creditDeposit:['신용융자 / 투자자예탁금','%','leverage'],
  rv20:['20일 연율 실현변동성','%','price'],fxChange20:['원/달러 20일 변화율','%','fx'],
  creditSpread:['AA− 회사채 − 국고채 3년','bp','credit'], forcedSales5:['반대매매 금액 5일 평균','억원','leverage'],
  trend200:['200일 평균 대비 이격률','%','price'],momentum5:['코스피 5일 수익률','%','price'],momentum20:['코스피 20일 수익률','%','price'],
  foreign20:['양 시장 외국인 20일 순매수','억원','flows'],institution20:['양 시장 기관 20일 순매수','억원','flows'],
  breadth60:['60일선 상회 비율','%','breadth'],
  ma20:['20일 이동평균','pt','price'],ma60:['60일 이동평균','pt','price'],ma120:['120일 이동평균','pt','price'],ma200:['200일 이동평균','pt','price'],
  macd:['MACD(12,26)','pt','price'],macdSignal:['MACD 신호선(9)','pt','price'],macdHistogram:['MACD 히스토그램','pt','price'],
  mdd252:['최근 252종가 최대낙폭','%','price'],
};
function alignedInputs(dashboard,source,dates,cutoff) {
  const lines=dashboard?.series??{}, readyLag={}, labels={}, units={},inputs={};
  function read(id,unit,toMoney=false) {
    const s=lines[id],lag=seriesLag(s);
    const scale=toMoney?({'원':1e-8,'백만원':.01,'억원':1,'조원':1e4})[s?.unit]:1;
    if(!s || s.frequency!=='daily' || (unit && s.unit!==unit) || !finite(scale)) return dates.map(()=>null);
    const m=new Map(ordered(s.points,cutoff).map(p=>[p.date,observation(p,lag)]));
    return dates.map(d=>{const x=m.get(d);return x?cell(x.v*scale,x.ready):null;});
  }
  const p=source?source.p.map(x=>observation(x,seriesLag(source.line))):[];
  const result={}, ml=macdValues(p);
  for(const n of [20,60,120,200]) result['ma'+n]=roll(p,n,mean);
  Object.assign(result,{rsi:rsiValues(p,14),disparity60:combine(p,result.ma60,pct),trend200:combine(p,result.ma200,pct),
    momentum5:lagChange(p,5),momentum20:lagChange(p,20),rv20:rvValues(p,20),macd:ml.macd,macdSignal:ml.signal,macdHistogram:ml.histogram,
    mdd252:roll(p,252,pathMdd)});
  for(const id of Object.keys(result)) inputs[id]=source?[source.id]:[];
  const credit=combine(read('credit_kospi',null,true),read('credit_kosdaq',null,true),(a,b)=>a>=0&&b>=0?a+b:null);
  result.creditGrowth20=lagChange(credit,20);
  result.creditDeposit=combine(credit,read('deposit',null,true),(a,b)=>a>=0 && b>0?100*a/b:null);
  result.forcedSales5=roll(read('forced_sales',null,true).map(x=>x&&x.v>=0?x:null),5,mean);
  result.fxChange20=lagChange(read('usdkrw','원').map(x=>x&&x.v>0?x:null),20);
  result.creditSpread=combine(read('kr_aa3y','%'),read('kr3y','%'),(a,b)=>100*(a-b));
  result.breadth60=read('above_ma60','%').map(x=>x&&x.v>=0&&x.v<=100?x:null);
  Object.assign(inputs,{creditGrowth20:['credit_kospi','credit_kosdaq'],creditDeposit:['credit_kospi','credit_kosdaq','deposit'],
    forcedSales5:['forced_sales'],fxChange20:['usdkrw'],creditSpread:['kr_aa3y','kr3y'],breadth60:['above_ma60']});
  const turnoverK=read('kospi_turnover',null,true),turnoverQ=read('kosdaq_turnover',null,true);
  const turnover=lines.kospi_turnover?.scope==='코스피' && lines.kosdaq_turnover?.scope==='코스닥'?
    combine(turnoverK,turnoverQ,(a,b)=>a>=0 && b>=0?a+b:null):dates.map(()=>null);
  for(const [feature,ids] of [['foreign20',['foreign_net_ecos','foreign_net']],['institution20',['institution_net']]]) {
    const candidate=ids.map(id=>({id,p:ordered(lines[id]?.points,cutoff),scope:lines[id]?.scope}))
      .filter(v=>v.p.length && v.scope==='코스피+코스닥').sort((a,b)=>b.p.at(-1).date.localeCompare(a.p.at(-1).date)||b.p.length-a.p.length)[0];
    const f=read(candidate?.id,null,true);
    // Select one unit and one source for the whole study, including the 20 raw amounts in every window.
    // A fixed raw-amount definition avoids switching units if turnover begins later.
    result[feature]=roll(f,20,sum);
    const normId=feature+'Turnover';
    inputs[feature]=candidate?[candidate.id]:[];
    inputs[normId]=[...inputs[feature],'kospi_turnover','kosdaq_turnover'];
    result[normId]=combine(result[feature],roll(turnover,20,sum),(net,t)=>t>0?net/t*100:null);
    labels[normId]=DEFINITIONS[feature][0]+' / 20일 합산 거래대금';
    units[normId]='%';
    readyLag[feature]=seriesLag(lines[candidate?.id]);
    readyLag[normId]=Math.max(readyLag[feature],seriesLag(lines.kospi_turnover),seriesLag(lines.kosdaq_turnover));
  }
  for(const id of Object.keys(result)) readyLag[id]??=seriesLag(source?.line);
  for(const id of ['creditGrowth20','creditDeposit']) readyLag[id]=Math.max(...['credit_kospi','credit_kosdaq',...(id==='creditDeposit'?['deposit']:[])].map(k=>seriesLag(lines[k])));
  readyLag.forcedSales5=seriesLag(lines.forced_sales); readyLag.fxChange20=seriesLag(lines.usdkrw);
  readyLag.creditSpread=Math.max(seriesLag(lines.kr3y),seriesLag(lines.kr_aa3y)); readyLag.breadth60=seriesLag(lines.above_ma60);
  const provenance={};
  for(const [id,sourceIds] of Object.entries(inputs)) {
    const sourceDefinitions=sourceIds.map(key=>{
      const line=lines[key];
      return {id:key,label:line?.label??key,unit:line?.unit??null,scope:line?.scope??null,
        definition:line?.definition??null,sourceName:line?.source?.name??null,sourceUrl:line?.source?.url??null};
    });
    provenance[id]={sourceIds,sourceDefinitions};
  }
  return {result,readyLag,labels,units,provenance};
}

function featureIndex(id,values,dates,days,window,meta) {
  const records=[],slots=new Array(dates.length),sorted=[],maxReady=[];
  let head=0;
  for(let i=0;i<values.length;i++) {
    const x=values[i];
    if(!x) continue;
    const j=records.length;
    while(head<maxReady.length && maxReady[head]<j-window) head++;
    const r={i,j,date:dates[i],t:days[i],v:x.v,ready:x.ready,
      rank:sorted.length===window?ranked(sorted,x.v):null,
      rankReady:Math.max(x.ready,head<maxReady.length?records[maxReady[head]].ready:-Infinity)};
    slots[i]=r; records.push(r);
    if(sorted.length===window) sorted.splice(insertIndex(sorted,records[j-window].v),1);
    sorted.splice(insertIndex(sorted,r.v),0,r.v);
    while(maxReady.length>head && records[maxReady.at(-1)].ready<=r.ready) maxReady.pop();
    maxReady.push(j);
  }
  return {id,records,slots,label:DEFINITIONS[id]?.[0]??meta.labels[id],unit:DEFINITIONS[id]?.[1]??meta.units[id],
    factor:DEFINITIONS[id]?.[2]??'flows',maxAge:Math.max(7,meta.readyLag[id]+5),...meta.provenance[id]};
}
function known(frame,i,days) {
  for(let k=i;k>=0 && days[i]-days[k]<=frame.maxAge;k--) {
    const r=frame.slots[k];
    if(r && r.ready<=days[i]) return r;
  }
  return null;
}
function snapshot(f,r,t,window,includeHistory) {
  const ranks={},zs={},moments={};
  for(const n of WINDOWS) {
    ranks[n]=zs[n]=null; moments[n]={mean:null,sd:null};
    if(!r || r.j<n) continue;
    const prior=f.records.slice(r.j-n,r.j);
    if(prior.some(x=>x.ready>t)) continue;
    const vals=prior.map(x=>x.v).sort((a,b)=>a-b),m=mean(vals),s=sd(vals,m);
    moments[n]={mean:m,sd:s};ranks[n]=ranked(vals,r.v);zs[n]=s>0?(r.v-m)/s:null;
  }
  function diff(n) {
    const prior=r?f.slots[r.i-n]:null;
    return r && prior && prior.ready<=t?r.v-prior.v:null;
  }
  return {id:f.id,label:f.label,value:r?.v??null,unit:f.unit,date:r?.date??null,maxAge:f.maxAge,sourceIds:f.sourceIds,sourceDefinitions:f.sourceDefinitions,
    percentile:ranks[window],z:zs[window],mean:moments[252].mean,sd:moments[252].sd,
    change5:diff(5),change20:diff(20),ranks,zs,
    history:includeHistory?f.records.filter(x=>x.ready<=t).map(x=>({date:x.date,value:x.v})):[]};
}
function scoresAt(fmap,i,days,cfg,details=false) {
  const scores={},t=days[i];
  for(const [group,weights] of Object.entries(cfg.weights)) {
    let usedWeight=0,weightedRank=0,used=0;
    const configured=Object.entries(weights).filter(([,weight])=>weight>0);
    const totalWeight=sum(configured.map(([,weight])=>weight)),factors=new Set(),contributors=[];
    for(const [id,weight] of configured) {
      let feature=fmap.get(id),obs=known(feature,i,days);
      if(id==='foreign20' || id==='institution20') {
        const normalized=fmap.get(id+'Turnover'), n=known(normalized,i,days);
        if(n && n.rank!==null && n.rankReady<=t) {feature=normalized;obs=n;}
      }
      if(!obs || obs.rank===null || obs.rankReady>t) continue;
      usedWeight+=weight;weightedRank+=weight*obs.rank;used++; factors.add(feature.factor);
      if(details) contributors.push({id:feature.id,configuredId:id,label:feature.label,value:obs.v,unit:feature.unit,
        date:obs.date,maxAge:feature.maxAge,weight,percentile:obs.rank,contribution:weight*obs.rank,
        sourceIds:feature.sourceIds,sourceDefinitions:feature.sourceDefinitions});
    }
    const coveragePct=totalWeight?100*usedWeight/totalWeight:0;
    const value=usedWeight>0 && coveragePct+1e-10>=100*cfg.minCoverage && factors.size>=2?weightedRank/usedWeight:null;
    if(!details){scores[group]=value;continue;}
    for(const c of contributors){c.contribution=value===null?null:c.contribution/usedWeight;c.effectiveWeightPct=100*c.weight/usedWeight;}
    scores[group]={value,coveragePct,used,total:configured.length,contributors,
      reason:value!==null?'확인된 가중치로 재정규화한 과거 백분위 가중평균':
        '유효 가중치 '+coveragePct.toFixed(0)+'% 및 경제 요인 '+factors.size+'개. 최소 '+Math.round(100*cfg.minCoverage)+'%·서로 다른 요인 2개가 필요합니다.'};
  }
  return scores;
}
const REGIMES={
  stable:'안정적 상승',hot:'과열 상승',slowing:'상승 둔화',risk:'위험 확대',
  liquidation:'디레버리징 및 투매',bottom:'바닥 형성 후보',recovery:'회복 초기',unknown:'판단 보류',
};
function regimeOf(s,prev,forced,credit,return20,return5) {
  function state(id,reason){return {id,label:REGIMES[id],reason};}
  if(!s || ![s.overheat,s.stress,s.momentum].every(finite))return state('unknown','세 점수의 공통 유효 자료가 부족합니다.');
  const {overheat:h,stress:r,momentum:m}=s,old=prev?.momentum,oldRisk=prev?.stress;
  if(r>=75 && m<=35 && forced>=75 && finite(credit) && credit<0)
    return state('liquidation','스트레스 75 이상·모멘텀 35 이하와 반대매매 상위 25%·신용잔고 감소가 겹칩니다.');
  if(finite(old) && old<=35 && m>old && h<45 && r>=50 && finite(oldRisk) && r<oldRisk)
    return state('bottom','5거래일 전 약한 모멘텀이 반등하고 스트레스가 완화됐습니다. 과열 점수는 45 미만입니다.');
  if(r>=65)return state('risk','스트레스 점수가 65 이상입니다.');
  if(h>=75 && m>=55 && finite(return20) && return20>0)
    return state('hot','코스피 20일 수익률이 양수이며 과열 점수 75 이상과 모멘텀 55 이상이 함께 관측됐습니다.');
  if(finite(old) && old<45 && m>=50 && finite(oldRisk) && r<=oldRisk)
    return state('recovery','5거래일 전 45 미만의 모멘텀이 50 이상으로 회복했고 스트레스가 악화되지 않았습니다.');
  if(finite(old) && old>=50 && m<old && (m<55 || old-m>=5) && finite(return5) && return5<0)
    return state('slowing','코스피 5일 수익률이 음수이고 5거래일 전 50 이상이던 모멘텀이 약해졌습니다. 현재 55 미만이거나 하락폭이 5점 이상입니다.');
  if(m>=50 && r<60 && h<75 && finite(return20) && return20>0)
    return state('stable','코스피 20일 수익률이 양수이며 모멘텀 50 이상·스트레스 60 미만·과열 75 미만입니다.');
  return state('unknown','가용 점수가 사전 정의한 일곱 국면의 조건을 충족하지 않습니다.');
}
function correlation(x,y) {
  const n=x.length;
  if(n<30)return null;
  const mx=mean(x),my=mean(y);
  let vx=0,vy=0,cov=0;
  for(let i=0;i<n;i++){const a=x[i]-mx,b=y[i]-my;vx+=a*a;vy+=b*b;cov+=a*b;}
  return vx>0&&vy>0?Math.max(-1,Math.min(1,cov/Math.sqrt(vx*vy))):null;
}
function correlations(fmap,ids,days) {
  const result=[],t=days.at(-1),start=Math.max(0,days.length-252);
  for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++) {
    const first=fmap.get(ids[a]),second=fmap.get(ids[b]),x=[],y=[];
    for(let i=start;i<days.length;i++) {
      const u=first.slots[i],v=second.slots[i];
      if(u && v && u.ready<=t && v.ready<=t){x.push(u.v);y.push(v.v);}
    }
    const r=correlation(x,y);
    result.push({left:ids[a],right:ids[b],r,n:x.length,flag:r!==null && Math.abs(r)>.8});
  }
  return result.sort((a,b)=>(Math.abs(b.r??0)-Math.abs(a.r??0)));
}
function intervals(returns,p) {
  const n=returns.length;
  if(n<30) return {ci:null,upCi:null};
  const m=mean(returns),errors=returns.map(v=>v-m),band=Math.floor(n**(1/3));
  let varSum=sum(errors.map(e=>e*e));
  for(let k=1;k<=band;k++){
    let cov=0;for(let i=k;i<n;i++)cov+=errors[i]*errors[i-k];
    varSum+=2*(1-k/(band+1))*cov;
  }
  const half=1.96*Math.sqrt(Math.max(0,varSum))/n,z2=1.96**2;
  const center=(p+z2/(2*n))/(1+z2/n),radius=1.96*Math.sqrt(p*(1-p)/n+z2/(4*n*n))/(1+z2/n);
  return {ci:[m-half,m+half],upCi:[100*Math.max(0,center-radius),100*Math.min(1,center+radius)]};
}
function nonoverlap(all) {
  let end=-1;
  return all.filter(c=>{if(c.entry<end)return false;end=c.exit;return true;});
}
function validation(cases,base) {
  const blank={n:0,mean:null,upProbability:null,brier:null,baselineBrier:null,folds:0};
  if(!cases.length || !base.length) return blank;
  let n=0,folds=0,r=0,ups=0,loss=0,baseLoss=0;
  for(let first=base[0].entry;first<=cases.at(-1).entry;first+=63) {
    const test=cases.filter(c=>c.entry>=first && c.entry<first+63);
    if(!test.length)continue;
    // First decision is the preceding close. Only already-knowable outcome publications train this fold.
    const train=cases.filter(c=>c.mature<first-1), uncond=base.filter(c=>c.mature<first-1);
    if(train.length<30 || uncond.length<30) continue;
    const prob=train.filter(c=>c.ret>0).length/train.length,prior=uncond.filter(c=>c.ret>0).length/uncond.length;
    folds++;
    for(const c of test) {
      const up=Number(c.ret>0);
      n++;r+=c.ret;ups+=up;loss+=(prob-up)**2;baseLoss+=(prior-up)**2;
    }
  }
  return {n,folds,mean:n>=5?r/n:null,upProbability:n>=5?100*ups/n:null,brier:n>=5?loss/n:null,baselineBrier:n>=5?baseLoss/n:null};
}
function summary(cases,unconditional,horizon) {
  const n=cases.length,vals=cases.map(c=>c.ret),m=n>=5?mean(vals):null;
  const sorted=[...vals].sort((a,b)=>a-b),up=n?vals.filter(v=>v>0).length/n:null;
  const baselineMean=unconditional.length>=5?mean(unconditional.map(c=>c.ret)):null;
  return {horizon,n,mean:m,median:n>=5?(sorted[(n-1)>>>1]+sorted[n>>>1])/2:null,
    upProbability:n>=5?100*up:null,sd:n>=5?sd(vals,m):null,maxDrawdown:n>=5?Math.min(...cases.map(c=>c.mdd)):null,
    ...intervals(vals,up),baselineN:unconditional.length,baselineMean,excess:m!==null && baselineMean!==null?m-baselineMean:null,
    oos:validation(cases,unconditional)};
}
function backtest(prices,days,decisions,values,through) {
  const specs=[
    ['highHeat','높은 과열','과열 점수 ≥ 75',s=>s.overheat,v=>v>=75],
    ['highStress','높은 스트레스','스트레스 점수 ≥ 75',s=>s.stress,v=>v>=75],
    ['highMomentum','강한 모멘텀','모멘텀 점수 ≥ 75',s=>s.momentum,v=>v>=75],
    ['lowMomentum','낮은 모멘텀','모멘텀 점수 ≤ 25',s=>s.momentum,v=>v<=25],
    ...Object.entries(REGIMES).filter(([id])=>id!=='unknown').map(([id,label])=>[id,label,'사전 정의한 '+label+' 국면',
      s=>[s.overheat,s.stress,s.momentum].every(finite)?s.regime:null,v=>v===id]),
  ];
  const groups=specs.map(([id,label,condition])=>({id,label,condition,horizons:[]}));
  for(const h of HORIZONS) {
    const paths=[];
    for(let i=0;i+h+1<prices.length;i++) {
      const entry=i+1,exit=entry+h;
      const path=values.slice(entry,exit+1);
      if(path.some(x=>!x))continue;
      const ready=Math.max(...path.map(x=>x.ready));
      if(ready>through)continue;
      let lo=exit,hi=days.length;
      while(lo<hi){const mid=(lo+hi)>>>1;if(days[mid]<ready)lo=mid+1;else hi=mid;}
      paths.push({i,entry,exit,mature:lo,ret:pct(prices[exit].value,prices[entry].value),mdd:pathMdd(path.map(x=>x.v))});
    }
    specs.forEach(([, , ,metric,hit],j)=>{
      const eligible=paths.filter(c=>metric(decisions[c.i])!==null);
      groups[j].horizons.push(summary(nonoverlap(eligible.filter(c=>hit(metric(decisions[c.i])))),nonoverlap(eligible),h));
    });
  }
  return {groups,assumptions:[
    '결정일에 이용할 수 있는 입력으로만 조건을 정하고 다음 관측 종가에 진입해 5·20·60·120개 종가 구간을 보유합니다. 비용·배당은 제외합니다.',
    '같은 조건과 무조건 비교군에서 각각 시간순으로 겹치지 않는 보유 구간을 선택합니다. 비교군도 해당 조건을 계산할 수 있는 같은 코스피 거래일을 사용합니다. 초과 평균의 단위는 %p입니다.',
    '상승 비율은 종료 수익률이 양수였던 과거 빈도입니다. 최대낙폭은 각 보유 구간에서 종가 고점 이후 발생한 낙폭 중 최악값입니다.',
    '5건부터 기술 통계를, 30건부터 평균의 Bartlett HAC 95% 구간(지연 ⌊n⅓⌋)과 상승 빈도의 Wilson 구간을 표시합니다. 잔여 자기상관과 여러 조건의 반복 비교 한계가 있습니다.',
    '63거래일씩 워크포워드 검증합니다. 검증 첫 결정일보다 앞서 결과가 공개된 조건·무조건 비중첩 표본 각각 30건 이상일 때 과거 상승 빈도로 예측해 이후 Brier를 계산합니다. 기준 Brier는 학습 무조건 상승 빈도에 대한 동일 검증 사례의 값입니다.',
  ]};
}

export function buildResearch(dashboard,config=DEFAULT_CONFIG,options={}) {
  const cfg=configOf(config);
  const generated=localDay(dashboard?.generatedAt),explicit=options.asOf;
  if(explicit!==undefined && !finite(day(explicit))) throw Error('분석 기준일은 YYYY-MM-DD 형식이어야 합니다.');
  const cutoff=explicit??(finite(generated)?iso(generated):'9999-12-31');
  const source=selectSource(dashboard,['kospi_ecos','kospi','kospi_naver','kospi_yahoo'],cutoff);
  const prices=(source?.p??[]).map(p=>({date:p.date,value:p.value}));
  const dates=prices.map(p=>p.date),days=dates.map(day),i=days.length-1,t=days.at(-1)??-Infinity;
  const asOf=dates.at(-1)??null, through=explicit?day(explicit):finite(generated)?generated:t;
  const meta=alignedInputs(dashboard,source,dates,cutoff), fmap=new Map();
  for(const [id,values] of Object.entries(meta.result)) fmap.set(id,featureIndex(id,values,dates,days,cfg.window,meta));
  const decisions=days.map((_,j)=>scoresAt(fmap,j,days,cfg));
  const regimes=decisions.map((s,j)=>{
    const forced=known(fmap.get('forcedSales5'),j,days), credit=known(fmap.get('creditGrowth20'),j,days);
    const regime=regimeOf(s,decisions[j-5],forced && forced.rankReady<=days[j]?forced.rank:null,credit?.v??null,
      known(fmap.get('momentum20'),j,days)?.v??null,known(fmap.get('momentum5'),j,days)?.v??null);
    s.regime=regime.id;
    return {...regime,date:dates[j]};
  });
  const features=[...fmap.values()].map(f=>snapshot(f,known(f,i,days),t,cfg.window,options.includeHistory!==false));
  const scores=scoresAt(fmap,i,days,cfg,true);
  const stale=asOf!==null && through-t>Math.max(4,seriesLag(source?.line));
  const regime=stale?{id:'unknown',label:REGIMES.unknown,date:asOf,reason:'코스피 마지막 기준일 '+asOf+' 이후의 국면은 최신 종가가 필요합니다.'}:
    regimes.at(-1)??{id:'unknown',label:REGIMES.unknown,reason:'유효한 코스피 종가가 없습니다.',date:null};
  if(stale) for(const s of Object.values(scores)) {
    s.value=null;s.reason='코스피 최신 종가가 지연되어 현재 점수 판단을 보류합니다.';
    for(const c of s.contributors)c.contribution=null;
  }
  const contributors=Object.entries(scores).flatMap(([group,s])=>s.contributors.filter(c=>finite(c.contribution)).map(c=>({...c,group})))
    .sort((a,b)=>b.contribution-a.contribution).slice(0,5);
  const activeIds=Object.values(scores).flatMap(s=>s.contributors.map(c=>[c.configuredId,c.id]));
  const active=new Map(activeIds);
  const ids=[...new Set(Object.values(cfg.weights).flatMap(group=>Object.entries(group).filter(([,w])=>w>0).map(([id])=>active.get(id)??id)))];
  const related=correlations(fmap,ids,days),top=related.find(x=>x.flag);
  const diagnosis=[{title:'국면 판단',text:regime.reason,kind:regime.id==='unknown'?'limitation':'evidence'}];
  if(contributors.length) {
    const c=contributors[0];
    diagnosis.push({title:'가장 큰 점수 기여',kind:'evidence',
      text:c.label+' '+c.value.toFixed(2)+c.unit+' ('+c.date+')의 과거 백분위는 '+c.percentile.toFixed(1)+'이며 해당 점수에 '+c.contribution.toFixed(1)+'점을 기여했습니다.'});
  }
  if(top) diagnosis.push({title:'요인 중복 점검',kind:'limitation',text:fmap.get(top.left).label+'와 '+fmap.get(top.right).label+
    '의 최근 252거래일 내 동일 관측일 '+top.n+'건 상관은 '+top.r.toFixed(2)+'입니다. 두 기여를 독립 신호로 해석하기 어렵습니다.'});
  if(!features.find(f=>f.id==='breadth60')?.date) diagnosis.push({title:'시장 폭 자료 부족',kind:'limitation',text:'당시 상장 종목 구성과 수정주가로 확인된 60일선 상회 비율이 없습니다. 지수 가격으로 대체하지 않습니다.'});
  const benchmark={id:source?.id??null,label:source?.line?.label??'코스피',asOf,source:source?.line?.source??null,
    points:options.includeHistory===false?[]:prices.filter((_,j)=>source.p[j].availableAt==null || localDay(source.p[j].availableAt)+1<=through)};
  const selectedSources={benchmark:benchmark.id,foreign20:fmap.get('foreign20').sourceIds[0]??null,
    institution20:fmap.get('institution20').sourceIds[0]??null};
  const dataVintage=dashboard?.generatedAt??null;
  const notes=[
    '사용한 자료 생성 시각 '+(dataVintage??'미확인')+' · 코스피 '+(selectedSources.benchmark??'미확보')+
      ' · 외국인 '+(selectedSources.foreign20??'미확보')+' · 기관 '+(selectedSources.institution20??'미확보')+
      '. 선택한 원천별 전 이력을 사용합니다. 이후 원천 선택이나 과거 수치 정정이 바뀌면 과거 연구 결과도 바뀔 수 있습니다.',
    '초기 가중치는 경제적 가설에 따른 설정값입니다. 점수는 선택 창의 과거 백분위 가중평균이며 학습된 확률이 아닙니다. 유효 가중치 60% 이상(설정값 이상)과 서로 다른 경제 요인 2개를 요구합니다.',
    '관측 기준일·공개 시점·수집 시각을 구분합니다. 실제 availableAt이 있으면 서울 현지 공표 다음 날짜부터, 없으면 보고일에 자료별 publicationLagDays 또는 expectedLagDays를 더한 후 첫 코스피 관측일에 사용합니다. 기본 하한은 일간 1·월간 35·분기 90일입니다. 원천 수정 전 빈티지는 없어 사후 재구성입니다.',
    '계산일 이전의 동일 정의 유효 관측 252·756·1,260개가 있어야 분위와 표본 Z를 산출합니다. 동점은 중간순위입니다. 5·20일 변화는 코스피 관측일 기준 원단위 차이이며 금액·거래량의 결측을 채우지 않습니다.',
    '최신 값을 유지할 수 있는 기간은 일별 자료 기준 max(7일, 가정 공표 지연+5일)입니다. 가격·금리·환율·수급의 개별 관측일이 다를 수 있어 각 기여 요인의 날짜를 표시합니다.',
    '신용잔고는 같은 날짜의 코스피·코스닥 잔액 합계입니다. 투자자 수급은 양 시장 20일 순매수 합계이며, 양 시장 동일 날짜 거래대금 20일 합계가 있고 정상화 백분위 창이 확보되면 그 비율을 점수에 우선 사용합니다.',
    '상관은 최근 252개 코스피 관측일의 같은 날짜 지표 수준을 사용합니다(최소 30쌍). 높은 절대상관은 중복 가능성의 점검 기준입니다. 방향성이나 인과 관계를 추정하지 않습니다.',
  ];
  const result={asOf,benchmark,features,scores,regime,previousRegime:regimes.at(-2)??{id:'unknown',label:REGIMES.unknown,date:null,reason:'직전 유효 관측이 없습니다.'},
    contributors,diagnosis,backtest:backtest(prices,days,decisions,source?.p.map(p=>observation(p,seriesLag(source.line)))??[],through),
    correlations:related,notes,config:cfg,dataVintage,selectedSources,stale,analysisThrough:finite(through)?iso(through):null};
  return {...result,conclusion:buildInterpretation(result)};
}
