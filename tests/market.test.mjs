import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFlow, comparisonLabel } from '../ui/market.mjs';

function line(id, date, extra={}) {
  return {id, unit:'억원', scope:'코스피+코스닥', frequency:'daily',
    points:[{date, value:7}], ...extra};
}

test('daily foreign flows select the recent complete ECOS source without changing the archive',()=>{
  const old=line('foreign_net','2026-10-14'), recent=line('foreign_net_ecos','2026-11-26');
  old.points.unshift({date:'2020-01-02',value:9});
  const dashboard={series:{foreign_net:old,foreign_net_ecos:recent}};
  const before=JSON.stringify(dashboard);
  assert.equal(selectFlow(dashboard,'foreign_net'),'foreign_net_ecos');
  assert.equal(JSON.stringify(dashboard),before);
});

test('source selection never replaces aggregate daily won flows with monthly, one-market or quantity observations',()=>{
  for(const extra of [{frequency:'monthly'},{scope:'코스피'},{unit:'계약'},{points:[]}]) {
    const dashboard={series:{foreign_net:line('foreign_net','2026-10-14'),
      foreign_net_ecos:line('foreign_net_ecos','2026-11-26',extra)}};
    assert.equal(selectFlow(dashboard,'foreign_net'),'foreign_net');
  }
  assert.equal(selectFlow({series:{}},'institution_net'),'institution_net');
});

test('comparison labels identify real previous observations including missing months and year transitions',()=>{
  assert.equal(comparisonLabel('2026-11-26','2026-11-25','daily'),'11.25 대비');
  assert.equal(comparisonLabel('2026-01-02','2025-12-30','daily'),'2025.12.30 대비');
  assert.equal(comparisonLabel('2026-10-31','2026-09-30','monthly'),'전월 대비');
  assert.equal(comparisonLabel('2026-10-31','2026-08-31','monthly'),'2026.08 대비');
});
