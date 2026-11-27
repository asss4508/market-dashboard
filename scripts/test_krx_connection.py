import io
import json
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import patch, Mock

from check_krx_connection import classify_response, try_login, main, end_diagnostic_session


class SafeLoginTest(unittest.TestCase):
    def setUp(self):
        cleanup = patch('check_krx_connection.end_diagnostic_session')
        self.cleanup_mock = cleanup.start()
        self.addCleanup(cleanup.stop)

    def test_code_does_not_prove_password_change(self):
        safe, failure = classify_response({'_error_code': 'CD010'})
        self.assertEqual(failure, 'login_rejected')
        self.assertFalse(safe['messageHints']['passwordChangeNotice'])
        self.assertEqual(safe['serverCode'], 'CD010')

    def test_message_hints_are_distinct_and_do_not_leak_echoed_values(self):
        examples = (
            ('아이디 또는 비밀번호가 일치하지 않습니다.', 'credentialMismatch'),
            ('비밀번호 변경이 필요합니다.', 'passwordChangeNotice'),
            ('기존 개인회원은 회원 전환 절차를 진행해 주세요.', 'memberTransition'),
            ('새 약관에 동의해 주세요.', 'termsConsent'),
            ('로그인 제한 횟수를 초과했습니다.', 'attemptLimit'),
            ('보안문자를 입력하세요.', 'securityChallenge'),
        )
        for message, hint in examples:
            with self.subTest(hint=hint):
                safe, failure = classify_response({'_error_code': 'CD010',
                    '_error_message': message + ' account=fixture-person password=fixture-secret',
                    'cookie': 'private-cookie-fixture'})
                self.assertTrue(safe['messageHints'][hint])
                serialized = json.dumps(safe)
                self.assertNotIn('fixture', serialized)
                self.assertEqual(failure, 'login_rejected')

    def test_success_requires_recognized_success_code(self):
        for code, expected in [('CD001', None), ('CD011', 'duplicate_session'),
                               ('CD010', 'login_rejected'), ('CD010 private-value', 'unexpected_login_response')]:
            self.assertEqual(classify_response({'_error_code': code})[1], expected)

    def test_failed_and_duplicate_responses_send_only_one_post(self):
        for code in ('CD010', 'CD011', 'CD001'):
            with self.subTest(code=code):
                response = Mock(status_code=200)
                response.json.return_value = {'_error_code': code, '_error_message': 'fixture-secret'}
                def official_login(identifier, password, session):
                    result = session.post('https://data.krx.co.kr/login', data={'id': identifier, 'pw': password})
                    if result.json()['_error_code'] == 'CD011':
                        session.post('https://data.krx.co.kr/login', data={'id': identifier, 'pw': password})
                    return result.json()['_error_code'] == 'CD001'
                diagnostic = {}
                with patch('check_krx_connection.load_auth', return_value=SimpleNamespace(login_krx=official_login)), \
                     patch('requests.Session.post', return_value=response) as post:
                    failure = try_login(None, 'fixture-person', 'fixture-secret', diagnostic)
                self.assertEqual(post.call_count, 1)
                self.assertEqual(diagnostic['loginAttempts'], 1)
                self.assertEqual(failure, {'CD001': None, 'CD010': 'login_rejected', 'CD011': 'duplicate_session'}[code])
                self.assertNotIn('fixture', json.dumps(diagnostic))

    def test_main_suppresses_library_output_and_sets_strict_exit_status(self):
        def fake_report(**kwargs):
            print('fixture-person fixture-secret')
            return {'loginSucceeded': False, 'failure': 'login_rejected'}
        output = io.StringIO()
        with patch('check_krx_connection.report', side_effect=fake_report), \
             patch('sys.argv', ['diagnostic', '--strict']), redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                main()
        self.assertEqual(raised.exception.code, 1)
        self.assertNotIn('fixture', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['failure'], 'login_rejected')

    def test_optional_resume_only_retries_duplicate_and_caps_requests(self):
        for codes, failure, count in ((['CD011', 'CD001'], None, 2),
                                     (['CD011', 'CD011'], 'duplicate_session', 2),
                                     (['CD010'], 'login_rejected', 1),
                                     (['CD001'], None, 1)):
            with self.subTest(codes=codes):
                replies = []
                for code in codes:
                    response = Mock(status_code=200)
                    response.json.return_value = {'_error_code': code}
                    replies.append(response)
                def official_login(identifier, password, session):
                    payload = {'mbrId': identifier, 'pw': password}
                    response = session.post('https://data.krx.co.kr/login', data=payload)
                    if response.json()['_error_code'] == 'CD011':
                        payload['skipDup'] = 'Y'
                        response = session.post('https://data.krx.co.kr/login', data=payload)
                    return response.json()['_error_code'] == 'CD001'
                diagnostic = {}
                with patch('check_krx_connection.load_auth', return_value=SimpleNamespace(login_krx=official_login)), \
                     patch('requests.Session.post', side_effect=replies) as post:
                    actual = try_login(None, 'fixture-person', 'fixture-secret', diagnostic, resume_session=True)
                self.assertEqual(actual, failure)
                self.assertEqual(post.call_count, count)
                self.assertEqual(diagnostic['serverCodes'], codes)
                self.assertNotIn('fixture', json.dumps(diagnostic))

    def test_resume_cannot_send_credentials_to_a_different_endpoint(self):
        response = Mock(status_code=200)
        response.json.return_value = {'_error_code': 'CD011'}
        def login(identifier, password, session):
            data = {'mbrId': identifier, 'pw': password}
            session.post('https://data.krx.co.kr/login', data=data)
            session.post('https://unexpected.invalid/login', data={**data, 'skipDup': 'Y'})
        with patch('check_krx_connection.load_auth', return_value=SimpleNamespace(login_krx=login)), \
             patch('requests.Session.post', return_value=response) as post:
            failure = try_login(None, 'fixture-person', 'fixture-secret', resume_session=True)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(failure, 'additional_login_required')

    def test_cleanup_uses_current_session_without_credential_fields(self):
        session = Mock()
        auth = SimpleNamespace(USER_AGENT='fixture-agent', LOGIN_PAGE='https://data.krx.co.kr/login')
        diagnostic = {}
        with patch('requests.Session.post', return_value=Mock(status_code=200)) as post:
            end_diagnostic_session(session, auth, diagnostic)
        self.assertIs(post.call_args.args[0], session)
        self.assertEqual(post.call_args.args[1], 'https://data.krx.co.kr/contents/MDC/MAIN/main/removeSession.cmd')
        self.assertFalse(post.call_args.kwargs['allow_redirects'])
        self.assertNotIn('data', post.call_args.kwargs)
        self.assertEqual(diagnostic['sessionCleanupStatus'], 'request_succeeded')


if __name__ == '__main__':
    unittest.main()
