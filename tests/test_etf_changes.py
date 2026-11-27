import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import collect_etf as etf


DAY = date(2026, 11, 26)
NEXT = date(2026, 11, 27)


class BasketTests(unittest.TestCase):
    def test_price_drift_threshold_and_membership(self):
        def sample(day, values):
            rows = [etf.holding(code, code, qty, 42, weight) for code, qty, weight in values]
            return etf.snapshot(day, rows, len(rows), "first")
        before = sample(DAY, [("A", 10, 45), ("B", 20, 20), ("C", 2, 20), ("D", 4, 15)])
        after = sample(NEXT, [("A", 10, 45.01), ("B", 20, 20.009), ("E", 2, 20), ("D", 4, 14.981)])
        result = etf.compare(before, after)
        self.assertEqual(result["counts"], dict(entry=1, increase=1, decrease=1, exit=1, unchanged=1))
        changes = {c["code"]: c for c in result["changes"]}
        self.assertEqual(changes["A"]["quantityChange"], 0)
        self.assertEqual(changes["A"]["deltaPp"], .01)
        self.assertEqual(changes["E"]["previousWeight"], 0)
        self.assertEqual(changes["C"]["newWeight"], 0)
        self.assertTrue(all(c["priceEffectUnknown"] for c in changes.values()))
        after["complete"] = False
        self.assertIsNone(etf.compare(before, after))

    def test_rejects_truncated_duplicate_and_missing_weight(self):
        r = etf.holding("000001", "주식", 1, 2, 100)
        for rows, n in (([r], 2), ([r, r], 2), ([dict(r, weightPct=95)], 1)):
            with self.assertRaises(etf.InvalidBasket):
                etf.snapshot(DAY, rows, n, "at")
        with self.assertRaises(etf.InvalidBasket):
            etf.holding("000001", "주식", 1, 2, None)
        cash = etf.holding("", "원화현금", 4, 4, None)
        self.assertEqual(cash["assetType"], "cash")
        snap = etf.snapshot(DAY, [r, cash], 2, "at")
        self.assertEqual(len(etf.compare(snap, snap)["changes"]), 1)

    def test_archived_observation_preserves_timestamp_and_revisions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            first = etf.snapshot(DAY, [etf.holding("A", "A", 1, 2, 100)], 1, "first")
            etf.archive(path, first)
            fetched = etf.archive(path, dict(first, collectedAt="retry"))
            self.assertEqual(fetched["collectedAt"], "first")
            revised = etf.snapshot(DAY, [etf.holding("A", "A", 1, 3, 100)], 1, "revision")
            etf.archive(path, revised)
            files = [json.loads(f.read_bytes()) for f in path.glob("*/*.json")]
            self.assertEqual({f["revisionHash"] for f in files}, {first["revisionHash"], revised["revisionHash"]})

    def test_source_failure_preserves_prior_observations(self):
        fund = etf.FUNDS["koact"]
        def outage(*args):
            raise requests.ConnectionError("example error excluded from public payload")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for day in (DAY, NEXT):
                observation = etf.snapshot(day, [etf.holding("A", "A", 1, 2, 100)], 1, "original")
                etf.archive(root / "data/etf-history" / fund[0], observation)
            with patch.dict(etf.FUNDS, {"koact": fund}, clear=True), patch.dict(etf.ADAPTERS, {"koact": outage}):
                report = etf.collect(root, NEXT, "retry", None)
            record = report["etfs"][0]
            self.assertEqual(record["status"], "delayed")
            self.assertEqual(record["latest"]["collectedAt"], "original")
            self.assertEqual(record["comparison"]["from"], DAY.isoformat())
            self.assertEqual(report["errors"][0]["code"], "connection_error")
            self.assertNotIn("example error", json.dumps(report))

    def test_link_only_fund_skips_network_and_ignores_previous_archives(self):
        fund = etf.FUNDS["midas"]
        class NoFetch:
            def get(self, *args, **kwargs):
                raise AssertionError("link-only fund requested data")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = etf.snapshot(DAY, [etf.holding("A", "A", 1, 2, 100)], 1, "original")
            etf.archive(root / "data/etf-history" / fund[0], existing)
            with patch.dict(etf.FUNDS, {"midas": fund}, clear=True):
                report = etf.collect(root, NEXT, "retry", NoFetch())
            record = report["etfs"][0]
            self.assertEqual(record["status"], "link_only")
            self.assertTrue(record["statusReason"])
            self.assertTrue(record["sourceUrl"].startswith("https://midasasset.com/"))
            self.assertTrue(all(record[k] is None for k in ("latest", "previous", "comparison")))
            self.assertEqual(report["errors"], [])

    def test_fund_diagnostic_preserves_http_status_without_response_details(self):
        response = requests.Response()
        response.status_code = 403
        error = requests.HTTPError("secret-url", response=response)
        diag = etf.diagnostic("tiger", DAY, None, error)
        self.assertEqual((diag["code"], diag["httpStatus"]), ("http_error", 403))
        self.assertNotIn("secret-url", json.dumps(diag))
        self.assertEqual(etf.diagnostic("koact", DAY, None, requests.exceptions.SSLError())["code"], "tls_error")

    def test_tiger_requires_exact_issuer_valuation_date(self):
        class Issuer:
            def get(self, fund, day, url, params):
                if url == etf.TIGER_CHART:
                    return json.dumps({"rtnData": [{
                        "ksdFund": "KR70204S0006", "wkdate": "20261124",
                        "memItemname": "주식", "memItemcode": "000001",
                        "stockQty": 1, "stockPrc": 10, "stockRate": 100,
                    }]}).encode()
                return b"<table><tr><td>1</td><td>000001</td><td>A</td><td>1</td><td>10</td><td>100</td><td>-</td></tr></table>"
        with patch.object(etf, "time_table", return_value=[object()]):
            with self.assertRaisesRegex(etf.InvalidBasket, "date cross-check"):
                etf.tiger(Issuer(), NEXT, "at")
        with patch.object(etf, "time_table", return_value=[]):
            self.assertIsNone(etf.tiger(Issuer(), NEXT, "at"))


if __name__ == "__main__":
    unittest.main()
