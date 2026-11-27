import test from 'node:test';
import assert from 'node:assert/strict';
import {buildResearch,DEFAULT_CONFIG,macd,movingAverage,realizedVolatility,rsi,seriesPoints} from '../lib/analytics.mjs';

const day=n=>new Date(Date.UTC(2016,0,1+n)).toISOString().slice(0,10);
const near=(got,want,tol=1e-7)=>assert.ok(Number.isFinite(got)&&Math.abs(got-want)<tol,'actual '+got+', expected '+want);
function line(id,n,value,unit='pt',scope=id) {
  return {id,label:id,scope,unit,frequency:'daily',expectedLagDays:4,publicationLagDays:0,
    source:{name:id,url:'https://example.org/'},points:Array.from({length:n},(_,i)=>({date:day(i),value:value(i),availableAt:null}))};
}
function fixture(n) {
  const series={};
  function add(id,fn,unit,scope) {series[id]=line(id,n,fn,unit,scope);}
  add('kospi',i=>100+i*.015+5*Math.sin(i/7)+1.5*Math.cos(i/3),'pt','코스피');
  add('usdkrw',i=>1000*Math.exp(i*i/2e6),'원');
  add('forced_sales',i=>1+i,'억원');
  add('credit_kospi',i=>12+.1*Math.sin(i/12),'조원','코스피');
  add('credit_kosdaq',i=>4+.2*Math.cos(i/9),'조원','코스닥');
  add('deposit',i=>50+Math.cos(i/15),'조원');
  add('kr3y',i=>3+.1*Math.sin(i/11),'%');
  add('kr_aa3y',i=>4+.2*Math.cos(i/9),'%');
  add('foreign_net',i=>60*Math.sin(i/11),'억원','코스피+코스닥');
  add('institution_net',i=>35*Math.cos(i/7),'억원','코스피+코스닥');
  return {series,generatedAt:day(n-1)+'T18:00:00+09:00'};
}
const feature=(q,id)=>q.features.find(f=>f.id===id);
test('technical statistics have full warmups, correct units, no fill and Wilder/EMA initial conditions',()=>{
  const p=[100,101,100,103].map((v,i)=>({date:day(i),value:v}));
  assert.equal(movingAverage(p,3).length,2); near(movingAverage(p,3)[0].value,301/3);
  const rv=realizedVolatility(p,2);
  near(rv[0].value,Math.sqrt(2)*Math.log(1.01)*Math.sqrt(252)*100);
  near(rsi(p,2)[0].value,50); near(rsi(p,2)[1].value,87.5);
  const flat=line('kospi',40,()=>100).points;
  assert.equal(rsi(flat).at(-1).value,50);
  assert.equal(macd(flat)[0].date,day(25));assert.equal(macd(flat)[0].signal,null);
  assert.deepEqual(macd(flat).at(-1),{date:day(39),macd:0,signal:0,histogram:0});
  const conflicting=[...p,{date:p[1].date,value:200}];
  assert.deepEqual(movingAverage(conflicting,3),[]);
  assert.deepEqual(seriesPoints({series:{z:{points:[...p,p[1],{date:day(4),value:null}]}}},'z'),p);
});
test('benchmark takes one entire sufficiently long source and omits conflicts and unknown future revisions',()=>{
  const f=fixture(300);
  f.series.kospi_ecos=line('kospi_ecos',301,i=>500+i);
  let q=buildResearch(f);
  assert.equal(q.benchmark.id,'kospi_ecos');assert.equal(q.benchmark.points[0].value,500);
  f.series.kospi_ecos.points=f.series.kospi_ecos.points.slice(-20);
  assert.equal(buildResearch(f).benchmark.id,'kospi');
  f.series.kospi.points.push({date:day(8),value:1});
  assert.equal(buildResearch(f).benchmark.id,'kospi_ecos');
  f.series.kospi_ecos.points.at(-2).availableAt=day(310)+'T10:00:00+09:00';
  q=buildResearch(f);assert.equal(q.benchmark.asOf,day(298));
});
test('same-date and same-unit credit joins, source scope and zero-denominator handling',()=>{
  const f=fixture(340),i=339;
  f.series.credit_kosdaq.unit='억원';
  for(const p of f.series.credit_kosdaq.points)p.value*=10000;
  let q=buildResearch(f);
  const normalized=100*(f.series.credit_kospi.points[i].value+f.series.credit_kosdaq.points[i].value/10000)/f.series.deposit.points[i].value;
  near(feature(q,'creditDeposit').value,normalized);
  near(feature(q,'creditSpread').value,100*(f.series.kr_aa3y.points[i].value-f.series.kr3y.points[i].value));
  f.series.deposit.points[i].value=0;
  f.series.credit_kospi.points.pop(); f.series.foreign_net.scope='코스피';
  q=buildResearch(f);
  assert.equal(feature(q,'creditDeposit').date,day(i-1));assert.equal(feature(q,'foreign20').value,null);
  assert.equal(feature(q,'breadth60').value,null);assert.equal(feature(q,'foreign20Turnover').value,null);
});
test('exact matching aggregate turnover enables normalized flow only after a full separate percentile window',()=>{
  const f=fixture(330);
  f.series.kospi_turnover=line('kospi_turnover',330,()=>600,'억원','코스피');
  f.series.kosdaq_turnover=line('kosdaq_turnover',330,()=>400,'억원','코스닥');
  let q=buildResearch(f);
  near(feature(q,'foreign20Turnover').value,100*feature(q,'foreign20').value/(20*1000));
  const normalized=q.scores.momentum.contributors.find(c=>c.id==='foreign20Turnover');
  assert.ok(normalized);assert.deepEqual(normalized.sourceIds,['foreign_net','kospi_turnover','kosdaq_turnover']);
  assert.equal(normalized.sourceDefinitions[1].scope,'코스피');
  assert.equal(q.selectedSources.foreign20,'foreign_net');assert.equal(q.dataVintage,f.generatedAt);
  f.series.kosdaq_turnover.scope='다른 시장';q=buildResearch(f);
  assert.equal(feature(q,'foreign20Turnover').value,null);
  assert.ok(q.scores.momentum.contributors.some(c=>c.id==='foreign20'));
});
test('trailing midranks and sample Z use only prior observations in full 252/756/1260 windows',()=>{
  const f=fixture(1290);f.series.kospi=line('kospi',1290,i=>100+i);
  const q=buildResearch(f);
  const m=feature(q,'ma20');
  for(const n of [252,756,1260]) {
    assert.equal(m.ranks[n],100);
    near(m.zs[n],((n+1)/2)/Math.sqrt(n*(n+1)/12));
  }
  const flat=feature(q,'rsi');assert.equal(flat.ranks[1260],50);assert.equal(flat.zs[1260],null);
  assert.equal(m.change5,5);assert.equal(m.change20,20);
  const small=buildResearch(f,DEFAULT_CONFIG,{asOf:day(260)});
  assert.equal(feature(small,'ma20').ranks[252],null);
});
test('known late publication and metadata lag delay both the feature observations and their normalization inputs',()=>{
  const f=fixture(340);
  f.series.forced_sales.points[310].availableAt=day(350)+'T10:30:00+09:00';
  f.series.forced_sales.points[339].availableAt=day(339)+'T16:30:00+09:00';
  delete f.series.usdkrw.publicationLagDays;f.series.usdkrw.expectedLagDays=4;
  const q=buildResearch(f);
  const forced=feature(q,'forcedSales5');
  assert.equal(forced.date,day(338));assert.equal(forced.ranks[252],null);
  assert.equal(feature(q,'fxChange20').date,day(335));
  assert.ok(!q.scores.stress.contributors.some(c=>c.id==='forcedSales5'));
});
test('prefix replay is invariant to appending future prices, disclosures and events',()=>{
  const a=buildResearch(fixture(440),DEFAULT_CONFIG,{asOf:day(439),includeHistory:false});
  const b=buildResearch(fixture(500),DEFAULT_CONFIG,{asOf:day(439),includeHistory:false});
  assert.notEqual(a.dataVintage,b.dataVintage);
  const calculations=q=>({...q,dataVintage:undefined,notes:q.notes.slice(1)});
  assert.deepEqual(calculations(a),calculations(b));
});
test('improving ranks in a still-falling market cannot qualify as stable or overheated rising prices',()=>{
  const n=500,f=fixture(n);
  f.series.kospi=line('kospi',n,i=>1000-i+.0008*i*i);
  f.series.foreign_net=line('foreign_net',n,i=>i,'억원','코스피+코스닥');
  f.series.usdkrw=line('usdkrw',n,i=>1400*Math.exp(-i*i/2e6),'원');
  f.series.forced_sales=line('forced_sales',n,i=>1000-i,'억원');
  f.series.deposit=line('deposit',n,()=>80,'조원');
  f.series.credit_kosdaq=line('credit_kosdaq',n,()=>3,'조원');
  const cfg={...DEFAULT_CONFIG,weights:{
    overheat:{rsi:0,disparity60:50,creditGrowth20:0,creditDeposit:50},
    stress:{rv20:0,fxChange20:50,forcedSales5:50,creditDeposit:0,creditSpread:0},
    momentum:{trend200:0,momentum20:50,foreign20:50,institution20:0,breadth60:0},
  }};
  for(const direction of [1,-1]) {
    f.series.credit_kospi=line('credit_kospi',n,i=>20+direction*i*.005,'조원');
    const q=buildResearch(f,cfg);
    assert.ok(feature(q,'momentum20').value<0 && q.scores.momentum.value>=55 && q.scores.stress.value<60);
    assert.equal(q.scores.overheat.value>=75,direction===1);
    assert.ok(!['stable','hot'].includes(q.regime.id));
  }
});
test('scores require configured coverage and distinct drivers and suppress current judgment on a stale index',()=>{
  const f=fixture(360);
  const cfg={...DEFAULT_CONFIG,weights:{...DEFAULT_CONFIG.weights,overheat:{rsi:100,disparity60:50,creditGrowth20:0,creditDeposit:0}}};
  let q=buildResearch(f,cfg);
  assert.equal(q.scores.overheat.coveragePct,100); assert.equal(q.scores.overheat.value,null);
  const live=q.scores.stress;
  near(live.contributors.reduce((s,c)=>s+c.contribution,0),live.value);
  f.generatedAt=day(380)+'T12:00:00+09:00';
  q=buildResearch(f); assert.equal(q.scores.stress.value,null);assert.equal(q.regime.id,'unknown');assert.equal(q.contributors.length,0);
});
test('historical outcomes use the next close, disjoint holdings, path drawdowns and mature walk-forward baselines',()=>{
  const f=fixture(1100);
  f.series.kospi=line('kospi',1100,i=>i%5===0?60:100);
  const cfg={...DEFAULT_CONFIG,weights:{...DEFAULT_CONFIG.weights,stress:{rv20:0,fxChange20:50,forcedSales5:50,creditDeposit:0,creditSpread:0}}};
  const q=buildResearch(f,cfg,{includeHistory:false}), group=q.backtest.groups.find(g=>g.id==='highStress');
  const h=group.horizons.find(h=>h.horizon===5);
  // Both increasing signals first have a 252-observation prior window at index 272.
  // Entry is index 273. Every subsequent 5-close holding contains a 40% drawdown.
  assert.equal(h.n,Math.floor((1099-273)/5));assert.equal(h.baselineN,h.n);
  near(h.mean,0);near(h.maxDrawdown,-40);assert.equal(h.upProbability,0);assert.deepEqual(h.ci,[0,0]);
  assert.ok(h.oos.folds>1 && h.oos.n>=30); assert.equal(h.oos.brier,h.oos.baselineBrier);
});
