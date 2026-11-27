/** Plain-language reading of existing research; never recalculates scores or forecasts. */
const finite = Number.isFinite;
const DAY = 86_400_000;
const GROUPS = ['overheat', 'stress', 'momentum'];
const SCORE_NAMES = {overheat:'과열', stress:'스트레스', momentum:'모멘텀'};
const REGIME_NAMES = {stable:'안정적 상승', hot:'과열 상승', slowing:'상승 둔화', risk:'위험 확대',
  liquidation:'디레버리징·반대매매', bottom:'바닥 형성 후보', recovery:'회복 초기'};
const format = (n, digits=1)=>finite(n)?n.toFixed(digits):'미확인';
function day(value) {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const t = Date.parse(value);
  return finite(t) && new Date(t).toISOString().slice(0,10)===value?t/DAY:NaN;
}
function dateRange(dates) {
  const ordered = [...new Set(dates.filter(d=>finite(day(d))))].sort();
  return ordered.length?(ordered[0]===ordered.at(-1)?ordered[0]:`${ordered[0]} ~ ${ordered.at(-1)}`):'관측일 미확인';
}
function usable(item, asOf) {
  if (!item || !finite(item.value) || !finite(day(item.date)) || !finite(day(asOf))) return false;
  if (item.date>asOf) return false;
  // Mirror the research's daily retention floor; longer declared lags remain explicit.
  const maxAge = finite(item.maxAge)?Math.max(7,item.maxAge):7;
  if (day(asOf)-day(item.date)>maxAge) return false;
  if (item.availableAt!=null) {
    const release = Date.parse(item.availableAt);
    if (!finite(release) || Math.floor((release+9*3600_000)/DAY)+1>day(asOf)) return false;
  }
  return true;
}
function describeScores(values) {
  const {overheat:h, stress:s, momentum:m} = values;
  return {
    overheat:{label:!finite(h)?'과열 자료 확인 필요':h>=75?'과열 높음':h<=25?'과열 낮음':'과열 중간',
      text:!finite(h)?'과열을 계산할 자료가 충분하지 않습니다.':
        h>=75?'과열 점수가 기존의 75점 기준 이상입니다.':
          '과열의 상대적 수준입니다. 낮은 점수만으로 바닥이나 매수 시점을 확인할 수 없습니다.'},
    stress:{label:!finite(s)?'스트레스 자료 확인 필요':s>=75?'스트레스 높음':s>=65?'위험 확대 기준 도달':s>=60?'스트레스 부담 잔존':'스트레스 부담 낮음',
      text:!finite(s)?'시장 부담을 계산할 자료가 충분하지 않습니다.':s>=65?
        '기존 위험 확대 기준인 65점 이상입니다.':s>=60?
          '위험 확대 기준 65점에는 못 미치지만 안정적 상승 조건의 60점 미만도 아닙니다.':
          '안정적 상승 조건의 스트레스 기준인 60점 미만입니다. 다른 추세 조건도 함께 확인합니다.'},
    momentum:{label:!finite(m)?'모멘텀 자료 확인 필요':m<=25?'추세·수급 약세':m>=75?'추세·수급 강세':m>=50?'회복 기준 이상':'회복력 부족',
      text:!finite(m)?'추세와 수급을 계산할 자료가 충분하지 않습니다.':m<=25?
        '사전 정의한 낮은 모멘텀 조건인 25점 이하입니다. 반등을 예고하는 확률은 아닙니다.':
        m>=50?'기존 회복·안정적 상승 규칙의 모멘텀 기준인 50점 이상입니다.':
          '기존 회복·안정적 상승 규칙의 모멘텀 기준인 50점에 못 미칩니다.'},
  };
}
function validationNote(oos, horizon) {
  if (!oos || !finite(oos.brier) || !finite(oos.baselineBrier) || oos.n<5)
    return `${horizon}일 조건의 시점 외 검증 표본이 충분하지 않아 예측력을 확인할 수 없습니다.`;
  return `${horizon}일 시점 외 검증 ${oos.n}건의 Brier 오차는 ${format(oos.brier,4)}, 비교 기준은 ${format(oos.baselineBrier,4)}입니다(낮을수록 좋음). `+
    (oos.brier>=oos.baselineBrier?'비교 기준보다 예측 오차가 개선되지 않았습니다.':'이 표본에서는 오차가 작았지만 지속적인 예측 우위가 입증된 것은 아닙니다.');
}
function matchedBacktest(research, values, limitations) {
  const {overheat:h, stress:s, momentum:m} = values;
  const regime = research.regime?.id;
  // Fixed priority and horizons. Neither returns nor probabilities decide which row appears.
  const matches = [
    ...(REGIME_NAMES[regime]?[{id:regime,label:REGIME_NAMES[regime],condition:`사전 정의한 ${REGIME_NAMES[regime]} 국면`}]:[]),
    ...(s>=75?[{id:'highStress',label:'높은 스트레스',condition:'스트레스 점수 ≥ 75'}]:[]),
    ...(h>=75?[{id:'highHeat',label:'높은 과열',condition:'과열 점수 ≥ 75'}]:[]),
    ...(m<=25?[{id:'lowMomentum',label:'낮은 모멘텀',condition:'모멘텀 점수 ≤ 25'}]:[]),
    ...(m>=75?[{id:'highMomentum',label:'강한 모멘텀',condition:'모멘텀 점수 ≥ 75'}]:[]),
  ];
  const groups = Array.isArray(research.backtest?.groups)?research.backtest.groups:[];
  let chosen;
  for (const horizon of [20,5]) {
    for (const match of matches) {
      const group = groups.find(g=>g.id===match.id);
      const row = group?.horizons?.find(r=>r.horizon===horizon && r.n>=30 &&
        finite(r.upProbability) && r.upProbability>=0 && r.upProbability<=100 && finite(r.mean));
      if (row) {chosen={match,group,row};break;}
    }
    if (chosen) break;
  }
  if (!chosen) {
    limitations.push(matches.length?
      `현재 맞는 조건(${matches.map(x=>x.label).join('·')})의 20일·5일 통계에 30건 이상 유효 표본이 없어 과거 상승 빈도를 제시하지 않습니다.`:
      '현재 점수에 맞는 사전 정의 비교 조건이 없어 과거 상승 빈도를 제시하지 않습니다. 다른 조건의 높은 수익률을 가져오지 않습니다.');
    return null;
  }
  const {match,group,row} = chosen;
  const note = [
    '현재 해당하는 사전 조건 하나의 과거 사례입니다. 현재 세 점수의 조합 전체를 검증한 결과가 아닙니다.',
    '과거 상승 빈도는 미래 상승 확률이 아닙니다. 표본 30건 이상의 20일 통계를 먼저, 없으면 5일 통계를 사용합니다.',
    validationNote(row.oos,row.horizon),
  ];
  const fiveDay = group.horizons.find(r=>r.horizon===5);
  if (row.horizon===20 && finite(fiveDay?.oos?.brier) && finite(fiveDay?.oos?.baselineBrier))
    note.push('별도 참고: '+validationNote(fiveDay.oos,5)+' 이 검증을 20일 결과에 적용할 수 없습니다.');
  return {label:match.label,condition:match.condition,horizon:row.horizon,n:row.n,
    upProbability:row.upProbability,upCi:Array.isArray(row.upCi)&&row.upCi.length===2&&row.upCi.every(finite)?[...row.upCi]:null,
    mean:row.mean,baselineMean:finite(row.baselineMean)?row.baselineMean:null,excess:finite(row.excess)?row.excess:null,
    oos:row.oos?{...row.oos}:null,note:note.join(' ')};
}

export function buildInterpretation(research={}) {
  research ??= {};
  const asOf = finite(day(research.asOf))?research.asOf:null;
  const allFeatures = Array.isArray(research.features)?research.features:[];
  const features = new Map(allFeatures.filter(f=>usable(f,asOf)).map(f=>[f.id,f]));
  const feature = id=>features.get(id);
  const value = id=>feature(id)?.value;
  const limitations = [];
  const values = {}, contributors = [];
  let invalidScoreDate = false;
  for (const id of GROUPS) {
    const score = research.scores?.[id];
    const inputs = Array.isArray(score?.contributors)?score.contributors:[];
    const invalid = inputs.some(c=>!usable(c,asOf));
    invalidScoreDate ||= invalid && finite(score?.value);
    values[id] = !invalid && finite(score?.value) && score.value>=0 && score.value<=100?score.value:null;
    contributors.push(...inputs.filter(c=>usable(c,asOf)));
    if (finite(values[id]) && finite(score?.coveragePct) && score.coveragePct<100)
      limitations.push(`${SCORE_NAMES[id]} 점수는 설정 가중치의 ${format(score.coveragePct,0)}%에 해당하는 자료로 계산했습니다. 빠진 자료가 보완되면 달라질 수 있습니다.`);
  }
  const stale = research.stale===true || GROUPS.some(id=>/최신 종가가 지연/.test(research.scores?.[id]?.reason??''));
  const missing = GROUPS.filter(id=>!finite(values[id]));
  const scoreLabels = describeScores(stale?{}:values);
  const sourceDates = contributors.length?contributors.map(c=>c.date):[...features.values()].map(f=>f.date);
  const basisNote = asOf?
    `분석 기준일 ${asOf} · 점수에 반영한 관측일 ${dateRange(sourceDates)}. 공표 지연을 반영하므로 기준일의 종가·수급과 다를 수 있습니다.`:
    '유효한 코스피 기준일이 없어 현재 시장 상태를 산출할 수 없습니다.';
  const evidence = [];
  const add = (id, meaning)=>{
    const f = feature(id);
    if (f) evidence.push({label:f.label??id,value:f.value,unit:f.unit??'',date:f.date,meaning});
  };
  add('momentum20',value('momentum20')>0?'최근 20거래일 가격 흐름이 상승입니다.':value('momentum20')<0?'최근 20거래일 가격 흐름이 하락입니다.':'최근 20거래일 수익률이 보합입니다.');
  add('trend200',value('trend200')<0?'가격이 200일 평균 아래에 있습니다.':'가격이 200일 평균 이상입니다.');
  add('creditSpread','회사채와 국고채의 금리 차이로 신용 부담을 확인합니다.');
  const foreignId = feature('foreign20Turnover')?'foreign20Turnover':'foreign20';
  add(foreignId,value(foreignId)<0?'외국인의 최근 20거래일 합산 수급이 순매도입니다.':'외국인의 최근 20거래일 합산 수급이 순매수 또는 균형입니다.');
  if (allFeatures.some(f=>finite(f.value) && !usable(f,asOf)))
    limitations.push('기준일 이후·공개 전 자료 또는 허용 기간이 지난 관측값은 현재 해석에서 제외했습니다.');
  if (!feature('breadth60')) limitations.push('60일선 위에 있는 종목 비율이 없어 시장 전체의 회복 확산 여부는 확인되지 않았습니다.');
  if (!feature('institution20') && !feature('institution20Turnover')) limitations.push('기관의 20일 수급 자료가 없어 기관 매수의 뒷받침은 확인되지 않았습니다.');
  limitations.push('점수는 과거 백분위의 가중평균이며 학습된 확률이 아닙니다. 이 해석은 기존 규칙과 관측값의 요약입니다.');

  if (stale || !asOf || missing.length || invalidScoreDate) {
    const reason = stale?'코스피 최신 종가가 지연되어 과거 점수로 현재 방향을 판단할 수 없습니다.':
      !asOf?'유효한 코스피 기준일과 점수 자료가 없습니다.':invalidScoreDate?
        '점수에 포함된 자료의 관측일·공개 시점 또는 유효 기간을 확인해야 합니다.':
        `${missing.map(id=>SCORE_NAMES[id]).join('·')} 점수의 유효 자료가 부족합니다. 세 점수를 함께 비교할 수 없습니다.`;
    return {headline:'최신 자료 확인 필요',stance:'자료가 보완된 뒤 시장 방향을 다시 확인할 단계입니다.',summary:reason,tone:'data',
      asOf,evidence,watch:[{label:'자료 확인',text:reason}],backtest:null,limitations,basisNote,scoreLabels};
  }

  const {overheat:h,stress:s,momentum:m} = values;
  const ret = value('momentum20'), ma60 = value('disparity60'), ma200 = value('trend200');
  const rawWeak = finite(ret) && ret<0 && finite(ma60) && ma60<0 && finite(ma200) && ma200<0;
  const scoresText = `과열 ${format(h)}점 · 스트레스 ${format(s)}점 · 모멘텀 ${format(m)}점입니다.`;
  let headline='신호 혼재 · 방향 확인 필요',tone='neutral';
  let stance='위험 노출 확대를 검토하려면 추세와 스트레스가 같은 방향으로 개선되는지 확인할 단계입니다.';
  let summary=scoresText+' 상승 추세와 부담 완화가 함께 확인되는 기존 조건을 충족하지 않습니다.';
  // Preserve the engine's transition-rule priority; a snapshot alone cannot reconstruct the prior five days.
  if (research.regime?.id==='liquidation') {
    headline='강제 청산 부담 · 위험 점검 우선';tone='caution';
    stance='위험 노출을 늘리기 전에 반대매매 부담과 스트레스 완화를 확인할 단계입니다.';
    summary=scoresText+' 기존 규칙에서 높은 스트레스·약한 모멘텀과 반대매매 부담·신용잔고 감소가 함께 확인됐습니다.';
  } else if (research.regime?.id==='bottom') {
    headline='초기 개선 · 추세 회복 확인';
    summary=scoresText+' 기존 규칙에서 약한 모멘텀의 반등과 스트레스 완화가 확인됐지만 바닥 확정이나 상승 추세 확인을 뜻하지는 않습니다.';
  } else if (s>=65) {
    headline='위험 부담 확대 · 방어적 점검 우선';tone='caution';
    stance='위험 노출을 늘리기 전에 스트레스 완화와 추세 회복을 확인할 단계입니다.';
    summary=scoresText+' 스트레스가 기존 위험 확대 기준인 65점 이상입니다.'+(rawWeak?' 20일 수익률이 음수이고 가격도 60·200일 평균 아래에 있습니다.':'');
  } else if (rawWeak && m<=25) {
    headline='추세 약세 · 회복 확인 우선';tone='caution';
    stance='위험 노출 확대는 추세와 수급의 회복을 확인한 뒤 검토할 단계입니다.';
    summary=scoresText+` 20일 수익률 ${format(ret,2)}%와 60·200일 평균 아래의 가격이 약세를 뒷받침합니다. 낮은 과열 점수만으로 반등이나 바닥을 확인할 수 없습니다.`;
  } else if (h>=75 && m>=55 && finite(ret) && ret>0) {
    headline='상승 흐름 · 과열 부담 점검';tone='caution';
    stance='상승 흐름을 확인하되 위험 노출 확대에는 과열 완화 여부를 함께 볼 단계입니다.';
    summary=scoresText+' 20일 수익률이 양수이고 과열이 75점 이상으로 기존 과열 상승 조건에 해당합니다.';
  } else if (research.regime?.id==='recovery') {
    headline='회복 초기 · 지속 여부 확인';tone='positive';
    summary=scoresText+' 기존 규칙에서 모멘텀 회복과 스트레스 비악화가 함께 확인됐습니다. 추세 회복이 지속되는지 확인할 단계입니다.';
  } else if (research.regime?.id==='slowing' || (rawWeak && m<50)) {
    headline='추세 둔화 · 회복 확인 필요';tone='caution';
    summary=scoresText+(rawWeak?' 20일 수익률과 60·200일 평균 대비 가격이 모두 약세입니다.':' 기존 규칙에서 모멘텀 둔화와 최근 5일 가격 하락이 함께 확인됐습니다.');
  } else if (m>=50 && s<60 && h<75 && finite(ret) && ret>0) {
    headline='상승 흐름 · 지속 여부 확인';tone='positive';
    stance='위험 노출 확대를 검토할 여건이지만 추세 지속과 수급의 뒷받침을 함께 확인할 단계입니다.';
    summary=scoresText+' 20일 수익률이 양수이며 기존 안정적 상승 조건을 충족합니다.';
  } else if (m<=25) {
    headline='모멘텀 약세 · 가격 흐름 추가 확인';tone='caution';
    summary=scoresText+' 낮은 모멘텀 조건에 해당합니다. 가격 지표가 일치하지 않거나 부족해 하락 추세나 바닥을 단정하지 않습니다.';
  }
  const scoreDate = dateRange(sourceDates);
  const watch = [
    {label:'개선 확인',text:`모멘텀 50점 이상·스트레스 60점 미만·과열 75점 미만과 20일 수익률 양수가 함께 확인되면 기존 안정적 상승 조건에 해당합니다. 현재 점수 관측일 ${scoreDate}.`},
    {label:'악화 확인',text:`스트레스 65점 이상은 기존 위험 확대 기준입니다. 현재 ${format(s)}점(관측일 ${dateRange(research.scores.stress.contributors?.map(c=>c.date)??[])}).`},
    {label:'가격 확인',text:feature('momentum20')?
      `20일 수익률 0% 상회와 60·200일 평균 상회 여부를 함께 확인합니다(가격 관측일 ${feature('momentum20').date}). 이는 추세 점검 기준이며 최적 매매 시점을 검증한 규칙은 아닙니다.`:
      '20일 수익률과 60·200일 평균 대비 가격 자료를 확보해 점수와 실제 추세가 일치하는지 확인합니다.'},
  ];
  const backtest = matchedBacktest(research,values,limitations);
  return {headline,stance,summary,tone,asOf,evidence,watch,backtest,limitations,basisNote,scoreLabels};
}
