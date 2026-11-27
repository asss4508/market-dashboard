import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from check_refresh import KST, REQUIRED_SERIES, dispatch_check, refresh_check


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 27, 22, 47, tzinfo=KST)

    def payload(self, stamp='2026-11-27T19:23:00+09:00'):
        return {'generatedAt': '2026-11-27T22:40:00+09:00', 'series': {
            key: {'lastAttemptAt': stamp, 'asOf': '2026-11-25', 'error': None}
            for key in REQUIRED_SERIES
        }, 'diagnostics': []}

    def failure(self, payload, code, message='', at='2026-11-27T19:23:00+09:00', key='usdkrw'):
        payload['series'][key] = {'lastAttemptAt': at, 'error': message or code}
        payload['diagnostics'].append({'id': key, 'code': code, 'message': message, 'at': at})
        return payload

    def test_regenerated_file_does_not_hide_a_missed_collection(self):
        payload = self.payload('2026-11-27T07:41:00+09:00')
        self.assertEqual(refresh_check(payload, self.now)['reason'], 'scheduled_collection_missed')
        for key in REQUIRED_SERIES:
            with self.subTest(key=key):
                payload = self.payload()
                payload['series'][key]['lastAttemptAt'] = '2026-11-27T07:41:00+09:00'
                self.assertTrue(refresh_check(payload, self.now)['needsRetry'])
        self.assertTrue(refresh_check({'generatedAt': self.now.isoformat()}, self.now)['needsRetry'])

    def test_actual_attempts_count_even_when_values_do_not_change_on_a_holiday(self):
        payload = self.payload('2026-11-27T07:17:00Z')
        payload['generatedAt'] = None
        payload['series']['monthly'] = {'asOf': '2026-09-30', 'frequency': 'monthly'}
        self.assertFalse(refresh_check(payload, self.now)['needsRetry'])
        self.assertEqual(refresh_check(payload, self.now)['lastAttemptAt'], '2026-11-27T16:17:00+09:00')

    def test_absent_invalid_future_and_previous_day_attempts_are_retried(self):
        for stamp in (None, '', '2026-11-27T19:23:00', '2026-11-26T23:30:00+09:00',
                      '2026-11-28T19:23:00+09:00', '9999-12-31T23:59:59Z'):
            with self.subTest(stamp=stamp):
                self.assertTrue(refresh_check(self.payload(stamp), self.now)['needsRetry'])
        for malformed in (None, [], {'series': []}, {'series': {'kospi_ecos': 'invalid'}}):
            with self.subTest(payload=malformed):
                self.assertTrue(refresh_check(malformed, self.now)['needsRetry'])

    def test_morning_window_and_utc_midnight_use_korean_calendar(self):
        morning = datetime(2026, 11, 27, 9, 13, tzinfo=KST)
        self.assertFalse(refresh_check(self.payload('2026-11-26T22:41:00Z'), morning)['needsRetry'])
        self.assertTrue(refresh_check(self.payload('2026-11-26T14:59:00Z'), morning)['needsRetry'])

    def test_current_transient_errors_are_retried_including_monthly_requests(self):
        for code, message in (('timeout', ''), ('connection_error', ''), ('incomplete_response', ''),
                              ('http_error', '공식 출처가 HTTP 429 응답을 반환했습니다.'),
                              ('http_error', '공식 출처가 HTTP 503 응답을 반환했습니다.')):
            with self.subTest(code=code, message=message):
                payload = self.failure(self.payload(), code, message, key='kr_m2')
                payload['series']['kr_m2']['frequency'] = 'monthly'
                payload['series']['kr_m2']['asOf'] = '2026-09-30'
                result = refresh_check(payload, self.now)
                self.assertTrue(result['needsRetry'])
                self.assertEqual(result['reason'], 'transient_source_failure')

    def test_permanent_errors_and_old_monthly_observations_do_not_trigger_retry(self):
        for code, message in (('missing_key', ''), ('authorization_error', ''), ('no_observations', ''),
                              ('invalid_value', ''), ('http_error', '공식 출처가 HTTP 403 응답을 반환했습니다.')):
            with self.subTest(code=code):
                payload = self.failure(self.payload(), code, message, key='kr_m2')
                payload['series']['kr_m2']['asOf'] = '2026-09-30'
                self.assertFalse(refresh_check(payload, self.now)['needsRetry'])

    def test_stale_or_resolved_diagnostics_do_not_override_a_later_attempt(self):
        for stamp in ('2026-11-26T19:23:00+09:00', '2026-11-27T07:41:00+09:00', 'invalid'):
            payload = self.failure(self.payload(), 'timeout', at=stamp, key='kr_m2')
            self.assertFalse(refresh_check(payload, self.now)['needsRetry'])
        payload = self.failure(self.payload(), 'timeout')
        payload['series']['usdkrw']['lastAttemptAt'] = '2026-11-27T20:00:00+09:00'
        payload['series']['usdkrw']['error'] = None
        self.assertFalse(refresh_check(payload, self.now)['needsRetry'])

    def test_active_collector_blocks_a_duplicate_dispatch(self):
        for status in ('queued', 'in_progress', 'waiting', 'pending', 'requested'):
            result = dispatch_check({'workflow_runs': [{'status': 'completed'}, {'status': status}]})
            self.assertFalse(result['canDispatch'])
            self.assertFalse(result['checkFailed'])
        self.assertTrue(dispatch_check({'workflow_runs': []})['canDispatch'])
        self.assertTrue(dispatch_check({'workflow_runs': [{'status': 'completed', 'conclusion': 'failure'}]})['canDispatch'])

    def test_failed_or_changed_workflow_status_response_never_dispatches(self):
        for payload in (None, [], {}, {'message': 'unavailable'}, {'workflow_runs': None},
                        {'workflow_runs': [None]}, {'workflow_runs': [{'status': 'unknown'}]}):
            with self.subTest(payload=payload):
                result = dispatch_check(payload)
                self.assertFalse(result['canDispatch'])
                self.assertTrue(result['checkFailed'])

    def test_cli_emits_only_allowlisted_result_and_fails_closed_on_bad_runs_response(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'response.json'
            output = Path(directory) / 'github-output'
            source.write_text(json.dumps({'message': 'private-placeholder', 'workflow_runs': None}), encoding='utf-8')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('check_refresh.py')),
                                     str(source), '--check-runs', '--github-output', str(output)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('private-placeholder', result.stdout + result.stderr)
            self.assertEqual(output.read_text(encoding='utf-8'), 'can_dispatch=false\n')


if __name__ == '__main__':
    unittest.main()
