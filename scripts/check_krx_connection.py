"""Report a single KRX Data Marketplace login attempt without printing secrets."""

import importlib.util
import argparse
import io
import json
import logging
import os
import re
import sys
from contextlib import redirect_stderr, redirect_stdout
from importlib import metadata


class LoginResult(Exception):
    """Carry a fixed diagnostic classification only."""


def classify_response(body):
    """Return only allowlisted codes/boolean hints, never server text or values."""
    if not isinstance(body, dict):
        return {"serverCode": None, "messageHints": {}}, "unexpected_login_response"
    code = body.get("_error_code")
    code = code if isinstance(code, str) and re.fullmatch(r"CD\d{3}", code) else None
    value = body.get("_error_message")
    message = value[:4096] if isinstance(value, str) else ""
    normalized = re.sub(r"\s+", " ", message)
    hints = {
        "messagePresent": bool(message),
        "credentialMismatch": bool(re.search(r"(?:아이디|비밀번호|패스워드).{0,50}(?:일치하지|일치하지않|잘못되|틀렸|틀립니다|존재하지)", normalized)),
        "passwordChangeNotice": bool(re.search(r"(?:비밀번호|패스워드).{0,35}(?:변경이 필요|변경하여야|변경해야|만료되|유효기간.{0,10}(?:경과|만료))", normalized)),
        "memberTransition": any(word in normalized for word in ("회원전환", "회원 전환", "기존 개인회원", "추가 정보", "통합회원", "통합 회원")),
        "termsConsent": "약관" in normalized and "동의" in normalized,
        "duplicateSession": "중복" in normalized,
        "attemptLimit": bool(re.search(r"(?:횟수|회 이상|회이상|잠금|잠겼|로그인 제한)", normalized)),
        "securityChallenge": any(word in normalized for word in ("보안문자", "자동입력", "자동 입력", "캡차", "인증번호")),
    }
    safe = {"serverCode": code, "messageHints": hints}
    if code == "CD001":
        return safe, None
    if code == "CD011":
        return safe, "duplicate_session"
    if code is None:
        return safe, "unexpected_login_response"
    # Upstream labels CD010 as password-change, but this has not been confirmed
    # by a published KRX code specification. Do not infer a cause from it alone.
    return safe, "login_rejected"


def load_auth(package):
    # Importing the package normally initializes a separate login session.
    auth_path = package.locate_file("pykrx/website/comm/auth.py")
    spec = importlib.util.spec_from_file_location("_krx_diagnostic_auth", auth_path)
    if spec is None or spec.loader is None:
        raise LoginResult("unsupported_pykrx")
    auth = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = auth
    try:
        spec.loader.exec_module(auth)
    finally:
        sys.modules.pop(spec.name, None)
    if not callable(getattr(auth, "login_krx", None)):
        raise LoginResult("unsupported_pykrx")
    return auth


def try_login(package, login_id, login_pw, diagnostic=None):
    if diagnostic is None:
        diagnostic = {}
    try:
        import requests
    except ImportError:
        return "unsupported_pykrx"

    class SingleAttemptSession(requests.Session):
        attempted = False

        def get(self, url, **kwargs):
            response = super().get(url, **kwargs)
            response.raise_for_status()
            return response

        def post(self, url, **kwargs):
            if self.attempted:
                raise LoginResult("additional_login_required")
            self.attempted = True
            diagnostic["loginAttempts"] = 1
            kwargs["allow_redirects"] = False
            response = super().post(url, **kwargs)
            if 300 <= response.status_code < 400:
                raise LoginResult("login_redirect")
            response.raise_for_status()
            try:
                body = response.json()
            except ValueError:
                raise LoginResult("unexpected_login_response") from None
            safe, failure = classify_response(body)
            diagnostic.update(safe)
            if failure:
                raise LoginResult(failure)
            return response

    try:
        auth = load_auth(package)
        with SingleAttemptSession() as session:
            return None if auth.login_krx(login_id, login_pw, session) else "login_rejected"
    except LoginResult as result:
        return str(result)
    except requests.exceptions.Timeout:
        return "network_timeout"
    except requests.exceptions.HTTPError as error:
        status = error.response.status_code if error.response is not None else None
        return {401: "http_unauthorized", 403: "http_forbidden", 429: "http_rate_limited"}.get(
            status, "http_error"
        )
    except requests.exceptions.RequestException:
        return "network_error"
    except (ImportError, FileNotFoundError, AttributeError, TypeError):
        return "unsupported_pykrx"
    except Exception:
        return "diagnostic_error"


def report():
    login_id = os.environ.get("KRX_ID", "")
    login_pw = os.environ.get("KRX_PW", "")
    result = {
        "idPresent": bool(login_id),
        "passwordPresent": bool(login_pw),
        "idHasEdgeWhitespace": login_id != login_id.strip(),
        "passwordHasEdgeWhitespace": login_pw != login_pw.strip(),
        "pykrxVersion": None,
        "loginSucceeded": False,
        "failure": None,
        "serverCode": None,
        "messageHints": {},
        "loginAttempts": 0,
    }
    try:
        package = metadata.distribution("pykrx")
    except metadata.PackageNotFoundError:
        package = None
    if package and re.fullmatch(r"[0-9][0-9A-Za-z.+!_-]{0,63}", package.version or ""):
        result["pykrxVersion"] = package.version
    if not login_id.strip() or not login_pw.strip():
        result["failure"] = "missing_credentials"
    elif package is None:
        result["failure"] = "pykrx_not_installed"
    else:
        result["failure"] = try_login(package, login_id, login_pw, result)
        result["loginSucceeded"] = result["failure"] is None
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="fail the diagnostic job when login is not acknowledged")
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    with io.StringIO() as discarded, redirect_stdout(discarded), redirect_stderr(discarded):
        result = report()
    print(json.dumps(result, separators=(",", ":")))
    if args.strict and not result["loginSucceeded"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
