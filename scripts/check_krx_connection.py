"""Report a single KRX Data Marketplace login attempt without printing secrets."""

import importlib.util
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


def try_login(package, login_id, login_pw):
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
            kwargs["allow_redirects"] = False
            response = super().post(url, **kwargs)
            if 300 <= response.status_code < 400:
                raise LoginResult("login_redirect")
            response.raise_for_status()
            try:
                body = response.json()
            except ValueError:
                raise LoginResult("unexpected_login_response") from None
            if not isinstance(body, dict) or not body.get("_error_code"):
                raise LoginResult("unexpected_login_response")
            if body["_error_code"] == "CD011":
                raise LoginResult("duplicate_session")
            if body["_error_code"] == "CD010":
                raise LoginResult("password_change_required")
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
        result["failure"] = try_login(package, login_id, login_pw)
        result["loginSucceeded"] = result["failure"] is None
    return result


def main():
    logging.disable(logging.CRITICAL)
    with io.StringIO() as discarded, redirect_stdout(discarded), redirect_stderr(discarded):
        result = report()
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
