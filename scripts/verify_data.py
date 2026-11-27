"""Validate public artifacts without printing payloads or credentials."""
import argparse
import json
import math
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def verify():
    dashboard = json.loads((ROOT / 'data/dashboard.json').read_text(encoding='utf-8'))
    count = 0
    for key, series in dashboard['series'].items():
        assert series['id'] == key, f'{key}: identity'
        assert series['source']['url'].startswith('https://'), f'{key}: source'
        previous = ''
        for point in series['points']:
            current = point['date']
            date.fromisoformat(current)
            assert previous < current, f'{key}: duplicate or unsorted date'
            assert isinstance(point['value'], (int, float)) and math.isfinite(point['value']), f'{key}: invalid number'
            previous = current
            count += 1
        assert series['asOf'] == (previous or None), f'{key}: asOf'
    etfs = json.loads((ROOT / 'data/etf-changes.json').read_text(encoding='utf-8'))
    comparable = 0
    for etf in etfs['etfs']:
        for snapshot in (etf.get('previous'), etf.get('latest')):
            if not snapshot:
                continue
            assert snapshot['totalRows'] == len(snapshot['holdings']), f"{etf['id']}: rows"
            assert len({h['code'] for h in snapshot['holdings']}) == len(snapshot['holdings']), f"{etf['id']}: duplicate code"
            for h in snapshot['holdings']:
                for field in ('weightPct', 'quantity', 'marketValue'):
                    value = h.get(field)
                    assert value is None or math.isfinite(value), f"{etf['id']}: nonfinite {field}"
        comparison = etf.get('comparison')
        if not comparison:
            continue
        assert etf['previous']['complete'] and etf['latest']['complete'], f"{etf['id']}: incomplete comparison"
        assert comparison['from'] < comparison['to'], f"{etf['id']}: dates"
        counts = {k: 0 for k in ('entry', 'increase', 'decrease', 'exit', 'unchanged')}
        for change in comparison['changes']:
            counts[change['kind']] += 1
            if all(change.get(k) is not None for k in ('previousWeight', 'newWeight', 'deltaPp')):
                assert abs(change['newWeight'] - change['previousWeight'] - change['deltaPp']) < 0.0001, f"{etf['id']}: weight identity"
            assert change['priceEffectUnknown'] is True
        assert counts == comparison['counts'], f"{etf['id']}: counts"
        comparable += 1
    return {'registeredSeries': len(dashboard['series']), 'availableSeries': sum(bool(s['points']) for s in dashboard['series'].values()), 'observations': count, 'funds': len(etfs['etfs']), 'comparableFunds': comparable}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--markdown', action='store_true')
    args = parser.parse_args()
    result = verify()
    print('\n'.join(f'- {k}: {v}' for k, v in result.items()) if args.markdown else json.dumps(result))
