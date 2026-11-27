"""Check actual source attempts; never use file generation as collection proof."""
import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
REQUIRED_SERIES = ('kospi_ecos', 'usdkrw', 'deposit')
TRANSIENT_CODES = {'timeout', 'connection_error', 'incomplete_response'}
ACTIVE_RUN_STATUSES = {'queued', 'in_progress', 'waiting', 'requested', 'pending'}


def attempt_time(value):
    try:
        if not isinstance(value, str) or len(value) > 128:
            return None
        stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return stamp.astimezone(KST) if stamp.tzinfo is not None else None
    except (AttributeError, TypeError, ValueError, OverflowError):
        return None


def refresh_check(payload, now=None, not_before_hour=16):
    now = (now or datetime.now(KST)).astimezone(KST)
    cutoff = now.replace(hour=not_before_hour, minute=0, second=0, microsecond=0)
    # Before the after-close window, only require today's scheduled collection.
    if now < cutoff:
        cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0)
    latest_allowed = now + timedelta(minutes=5)
    payload = payload if isinstance(payload, dict) else {}
    series = payload.get('series')
    series = series if isinstance(series, dict) else {}
    stamps = []
    for key in REQUIRED_SERIES:
        line = series.get(key)
        stamp = attempt_time(line.get('lastAttemptAt')) if isinstance(line, dict) else None
        if stamp is None:
            return {'needsRetry': True, 'reason': 'source_attempt_missing', 'lastAttemptAt': None}
        if stamp > latest_allowed:
            return {'needsRetry': True, 'reason': 'source_attempt_in_future', 'lastAttemptAt': None}
        stamps.append(stamp)
    oldest = min(stamps)
    result = {'needsRetry': oldest < cutoff,
              'reason': 'scheduled_collection_missed' if oldest < cutoff else 'collection_attempt_recorded',
              'lastAttemptAt': oldest.isoformat()}
    if result['needsRetry']:
        return result

    diagnostics = payload.get('diagnostics')
    for item in diagnostics if isinstance(diagnostics, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str):
            continue
        line = series.get(item['id'])
        if not isinstance(line, dict) or not line.get('error'):
            continue
        stamp = attempt_time(item.get('at'))
        # Historical diagnostics or failures predating the latest attempt cannot
        # turn a later successful collection into a retry request.
        if (stamp is None or not cutoff <= stamp <= latest_allowed
                or stamp != attempt_time(line.get('lastAttemptAt'))):
            continue
        code = item.get('code')
        message = item.get('message')
        transient_http = (code == 'http_error' and isinstance(message, str)
                          and re.search(r'\bHTTP\s+(?:408|425|429|5\d{2})\b', message[:512]))
        if (isinstance(code, str) and code in TRANSIENT_CODES) or transient_http:
            result.update(needsRetry=True, reason='transient_source_failure')
            break
    return result


def dispatch_check(payload):
    """A failed status query is unknown, not proof that no collector is running."""
    runs = payload.get('workflow_runs') if isinstance(payload, dict) else None
    if not isinstance(runs, list):
        return {'canDispatch': False, 'reason': 'workflow_status_unavailable', 'checkFailed': True}
    for run in runs:
        status = run.get('status') if isinstance(run, dict) else None
        if isinstance(status, str) and status in ACTIVE_RUN_STATUSES:
            return {'canDispatch': False, 'reason': 'collector_already_active', 'checkFailed': False}
        if status != 'completed':
            return {'canDispatch': False, 'reason': 'workflow_status_unavailable', 'checkFailed': True}
    return {'canDispatch': True, 'reason': 'collector_idle', 'checkFailed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('file', type=Path)
    parser.add_argument('--github-output', type=Path)
    parser.add_argument('--check-runs', action='store_true', help='validate the workflow-runs API response before dispatch')
    args = parser.parse_args()
    try:
        payload = json.loads(args.file.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        payload = {}
    result = dispatch_check(payload) if args.check_runs else refresh_check(payload)
    if args.github_output:
        with args.github_output.open('a', encoding='utf-8') as stream:
            output, field = ('can_dispatch', 'canDispatch') if args.check_runs else ('needs_retry', 'needsRetry')
            stream.write(output + '=' + str(result[field]).lower() + '\n')
    print(json.dumps(result))
    if result.get('checkFailed'):
        raise SystemExit(1)
