import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildInterpretation} from '../lib/interpretation.mjs';

// Frozen 2026-11-26 observations: daily data refreshes must not change these regression cases.
const actual = JSON.parse(readFileSync(new URL('./fixtures/interpretation-20261126.json',import.meta.url),'utf8'));
const clone = value=>structuredClone(value);
function scenario({h=21,s=62.5,m=12.2,ret=-12.26,ma60=-21.24,ma200=-25.36,regime='unknown'}={}) {
  const research = clone(actual);
  research.asOf='2026-11-26';research.stale=false;
  research.regime={id:regime,date:research.asOf};
  for (const [id,value] of Object.entries({overheat:h,stress:s,momentum:m}))
    research.scores[id]={value,coveragePct:100,contributors:[{id,value,date:'2026-11-20'}]};
  for (const [id,value] of Object.entries({momentum20:ret,disparity60:ma60,trend200:ma200})) {
    const f = research.features.find(f=>f.id===id);
    f.value=value;f.date='2026-11-20';
  }
  return research;
}
function deepFreeze(value) {
  if (value && typeof value==='object') {Object.freeze(value);for(const child of Object.values(value))deepFreeze(child);}
  return value;
}

test('the actual snapshot produces an evidence-based weak-trend conclusion without changing its unknown regime',()=>{
  const before=JSON.stringify(actual);
  const c=buildInterpretation(deepFreeze(clone(actual)));
  assert.equal(c.headline,'추세 약세 · 회복 확인 우선');
  assert.equal(c.tone,'caution');
  assert.match(c.stance,/회복을 확인한 뒤 검토/);
  assert.match(c.summary,/20일 수익률 -12\.26%/);
  assert.match(c.summary,/60·200일 평균 아래/);
  assert.match(c.basisNote,/2026-11-26.*2026-11-19 ~ 2026-11-20/);
  assert.match(c.scoreLabels.stress.text,/65점.*60점/);
  assert.match(c.limitations.join(' '),/75%/);
  assert.equal(c.evidence.length,4);
  assert.ok(c.evidence.some(e=>/외국인/.test(e.label)));
  assert.ok(c.evidence.every(e=>e.date<=c.asOf && Number.isFinite(e.value)));
  assert.doesNotMatch(JSON.stringify(c),/판단 보류|used|4\/4/);
  assert.equal(actual.regime.id,'unknown');
  assert.equal(JSON.stringify(actual),before);
});

test('historical comparison matches the actual threshold and preserves frequency, intervals and horizon',()=>{
  const c=buildInterpretation(actual), source=actual.backtest.groups.find(g=>g.id==='lowMomentum').horizons.find(h=>h.horizon===20);
  assert.equal(c.backtest.condition,'모멘텀 점수 ≤ 25');
  assert.ok(actual.scores.momentum.value<=25);
  assert.ok(actual.scores.stress.value<75);
  assert.equal(c.backtest.horizon,20);
  for(const key of ['n','upProbability','mean','baselineMean','excess'])assert.equal(c.backtest[key],source[key]);
  assert.deepEqual(c.backtest.upCi,source.upCi);
  assert.match(c.backtest.note,/미래 상승 확률이 아닙니다/);
  assert.match(c.backtest.note,/세 점수의 조합 전체를 검증한 결과가 아닙니다/);
  assert.match(c.backtest.note,/20일 조건의 시점 외 검증 표본이 충분하지/);
  assert.match(c.backtest.note,/별도 참고: 5일 시점 외 검증 71건/);
  assert.match(c.backtest.note,/0\.2541.*0\.2531/);
  assert.match(c.backtest.note,/예측 오차가 개선되지 않았습니다/);
});

test('a balanced bullish observation uses the established rising-trend thresholds',()=>{
  const c=buildInterpretation(scenario({h:40,s:45,m:60,ret:5,ma60:3,ma200:8,regime:'stable'}));
  assert.equal(c.tone,'positive');
  assert.equal(c.headline,'상승 흐름 · 지속 여부 확인');
  assert.match(c.summary,/기존 안정적 상승 조건을 충족/);
  assert.match(c.stance,/검토할 여건/);
  assert.doesNotMatch(c.stance,/매수하|매도하/);
});

test('stress threshold remains risk 65 rather than historical highStress 75',()=>{
  const r=scenario({s:65,m:50}), c=buildInterpretation(r);
  assert.equal(c.headline,'위험 부담 확대 · 방어적 점검 우선');
  assert.equal(c.backtest,null);
  assert.match(c.watch.find(w=>w.label==='악화 확인').text,/65점.*2026-11-20/);
  assert.match(c.limitations.join(' '),/현재 점수에 맞는 사전 정의 비교 조건이 없어/);
  const high=buildInterpretation(scenario({s:75,m:50}));
  assert.equal(high.backtest.condition,'스트레스 점수 ≥ 75');
});

test('mixed signs do not force a named regime or borrow unmatched bullish statistics',()=>{
  const r=scenario({h:45,s:61,m:45,ret:2,ma60:-1,ma200:1});
  const c=buildInterpretation(r);
  assert.equal(c.headline,'신호 혼재 · 방향 확인 필요');
  assert.equal(c.tone,'neutral');
  assert.equal(c.backtest,null);
  assert.match(c.summary,/상승 추세와 부담 완화가 함께/);
  assert.equal(r.regime.id,'unknown');
});

test('one missing score and all missing scores produce specific data explanations, not trading conclusions',()=>{
  const partial=buildInterpretation(scenario({h:null}));
  assert.equal(partial.tone,'data');
  assert.equal(partial.backtest,null);
  assert.match(partial.summary,/과열 점수의 유효 자료가 부족/);
  assert.doesNotMatch(partial.stance,/위험 노출/);
  const empty=buildInterpretation();
  assert.equal(empty.headline,'최신 자료 확인 필요');
  assert.match(empty.summary,/유효한 코스피 기준일과 점수 자료가 없습니다/);
  assert.equal(empty.backtest,null);
  assert.deepEqual(empty.evidence,[]);
});

test('explicit stale snapshots and expired contributors cannot retain a current directional conclusion',()=>{
  const r=scenario();r.stale=true;
  const c=buildInterpretation(r);
  assert.equal(c.headline,'최신 자료 확인 필요');
  assert.equal(c.tone,'data');
  assert.match(c.summary,/최신 종가가 지연/);
  assert.equal(c.backtest,null);
  assert.equal(c.scoreLabels.overheat.label,'과열 자료 확인 필요');
  const expired=scenario();expired.asOf='2026-12-15';
  const e=buildInterpretation(expired);
  assert.equal(e.tone,'data');
  assert.deepEqual(e.evidence,[]);
  assert.match(e.summary,/유효 기간/);
});

test('future observations and observations not yet public never contribute evidence or score interpretations',()=>{
  const r=scenario();
  r.features.find(f=>f.id==='momentum20').date='2026-11-27';
  r.features.find(f=>f.id==='disparity60').availableAt='2026-11-26T15:30:00+09:00';
  r.scores.momentum.contributors[0].date='2026-11-27';
  const c=buildInterpretation(r);
  assert.equal(c.tone,'data');
  assert.equal(c.backtest,null);
  assert.ok(!c.evidence.some(e=>e.label==='코스피 20일 수익률'||e.label==='60일 평균 대비 이격률'));
  assert.ok(c.evidence.every(e=>e.date<=r.asOf));
  assert.match(c.limitations.join(' '),/기준일 이후·공개 전 자료/);
});

test('history and wall-clock generation timestamps do not leak into a historical interpretation',()=>{
  const r=scenario(), before=buildInterpretation(r);
  r.generatedAt='2099-12-31T18:00:00+09:00';r.dataVintage=r.generatedAt;
  r.benchmark={points:[{date:'2099-12-31',value:99999}]};
  r.features.forEach(f=>{f.history=[{date:'2099-12-31',value:99999}];});
  assert.deepEqual(buildInterpretation(r),before);
});

test('fixed condition and horizon selection never follows the best historical probability',()=>{
  const r=scenario({h:80,s:80,m:80,ret:3,ma60:2,ma200:1});
  r.backtest.groups.reverse();
  for(const group of r.backtest.groups)for(const row of group.horizons){
    row.upProbability=group.id==='highStress'?11:99;
    if(row.horizon===20)row.n=50;
  }
  const c=buildInterpretation(r);
  assert.equal(c.backtest.condition,'스트레스 점수 ≥ 75');
  assert.equal(c.backtest.horizon,20);
  assert.equal(c.backtest.upProbability,11);
  const low=scenario();
  const group=low.backtest.groups.find(g=>g.id==='lowMomentum');
  group.horizons.find(h=>h.horizon===20).n=29;
  assert.equal(buildInterpretation(low).backtest.horizon,5);
  group.horizons.find(h=>h.horizon===5).n=29;
  const scarce=buildInterpretation(low);
  assert.equal(scarce.backtest,null);
  assert.match(scarce.limitations.join(' '),/30건 이상 유효 표본이 없어/);
  assert.equal(scarce.headline,'추세 약세 · 회복 확인 우선');
});

test('missing return and trend evidence cannot be promoted to a confirmed rising trend',()=>{
  const r=scenario({h:40,s:40,m:60});
  r.features=r.features.filter(f=>!['momentum20','disparity60','trend200'].includes(f.id));
  const c=buildInterpretation(r);
  assert.equal(c.tone,'neutral');
  assert.doesNotMatch(c.summary,/안정적 상승 조건을 충족/);
  assert.match(c.watch.find(w=>w.label==='가격 확인').text,/자료를 확보/);
});

test('existing transition regimes keep their priority over static risk and rising-trend checks',()=>{
  const bottom=buildInterpretation(scenario({h:20,s:70,m:24,regime:'bottom'}));
  assert.equal(bottom.headline,'초기 개선 · 추세 회복 확인');
  assert.match(bottom.summary,/바닥 확정.*뜻하지는 않습니다/);
  const recovery=buildInterpretation(scenario({h:40,s:45,m:55,ret:4,ma60:2,ma200:1,regime:'recovery'}));
  assert.equal(recovery.headline,'회복 초기 · 지속 여부 확인');
  const slowing=buildInterpretation(scenario({h:40,s:45,m:51,ret:4,ma60:2,ma200:1,regime:'slowing'}));
  assert.equal(slowing.headline,'추세 둔화 · 회복 확인 필요');
});

test('the engine declared retention period accepts an eight-day observation when maxAge is eleven',()=>{
  const r=scenario();
  for(const score of Object.values(r.scores))for(const c of score.contributors){
    c.date='2026-11-18';c.maxAge=11;
  }
  for(const f of r.features)if(Number.isFinite(f.value)){
    f.date='2026-11-18';f.maxAge=11;
  }
  const c=buildInterpretation(r);
  assert.equal(c.headline,'추세 약세 · 회복 확인 우선');
  assert.equal(c.evidence.length,4);
  assert.ok(c.evidence.every(e=>e.date==='2026-11-18'));
  assert.match(c.basisNote,/2026-11-18/);
  assert.ok(c.backtest);
  assert.doesNotMatch(c.limitations.join(' '),/허용 기간이 지난/);
});
