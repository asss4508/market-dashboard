import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import Mock

from collect import ecos_observations
from data_pipeline import CollectionError, Dashboard, KST
from derivatives import derive_monthly_turnover_pcr


class DerivativesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.dashboard = Dashboard(Path(temporary.name), datetime(2026, 11, 27, 18, tzinfo=KST))

    def client(self, table, item, unit, value, time="202610"):
        client = Mock()
        client.get.return_value = json.dumps({"StatisticSearch": {
            "list_total_count": 1,
            "row": [{"STAT_CODE": table, "ITEM_CODE1": item, "UNIT_NAME": unit,
                     "TIME": time, "DATA_VALUE": value}],
        }}).encode()
        return client

    def test_official_monthly_values_keep_units_and_frequency(self):
        # Values/units independently checked against the October 2026 ECOS rows.
        for key, table, item, unit, raw, expected in (
            ("index_futures_daily_average_monthly", "901Y057", "S25B", "계약", "161429", 161429),
            ("index_futures_notional_monthly", "901Y057", "S25C", "백만원", "757579273", 757.579273),
            ("index_option_call_daily_average_monthly", "901Y058", "S26BB", "계약", "97118", 97118),
            ("index_option_put_daily_average_monthly", "901Y058", "S26CB", "계약", "65920", 65920),
            ("index_option_call_turnover_monthly", "901Y058", "S26BC", "백만원", "2291591", 2.291591),
            ("index_option_put_turnover_monthly", "901Y058", "S26CC", "백만원", "2630211", 2.630211),
        ):
            with self.subTest(key=key):
                client = self.client(table, item, unit, raw)
                points = ecos_observations(client, key, "mock", date(2026, 10, 1), date(2026, 11, 27))
                self.assertEqual(points, [("2026-10-31", expected)])
                self.assertIn(f"/{table}/M/202610/202611/{item}", client.get.call_args.args[1])
                self.dashboard.success(key, points)
                series = self.dashboard.write()["series"][key]
                self.assertEqual(series["frequency"], "monthly")
                self.assertEqual(len(series["points"]), 1)
        # Monthly publications do not fill daily KOSPI 200 or position series.
        result = self.dashboard.write()
        for key in ("futures_price", "futures_oi", "futures_volume", "futures_net_foreign", "vkospi"):
            self.assertEqual(result["series"][key]["points"], [])
            self.assertEqual(result["series"][key]["status"], "missing")

    def test_option_amount_rejects_contract_units(self):
        client = self.client("901Y058", "S26BC", "계약", "2291591")
        with self.assertRaises(CollectionError) as raised:
            ecos_observations(client, "index_option_call_turnover_monthly", "mock",
                              date(2026, 10, 1), date(2026, 11, 27))
        self.assertEqual(raised.exception.code, "unexpected_unit")

    def test_missing_value_is_not_published_as_zero(self):
        client = self.client("901Y058", "S26BC", "백만원", "-")
        self.assertEqual(ecos_observations(client, "index_option_call_turnover_monthly", "mock",
                                          date(2026, 10, 1), date(2026, 11, 27)), [])

    def test_turnover_ratio_uses_matching_months_and_never_fills_missing_calls(self):
        self.dashboard.success("index_option_put_turnover_monthly", [
            ("2026-08-31", 2.55232), ("2026-09-30", 2.052315), ("2026-10-31", 2.630211),
        ])
        self.dashboard.success("index_option_call_turnover_monthly", [
            ("2026-09-30", 0), ("2026-10-31", 2.291591),
        ])
        derive_monthly_turnover_pcr(self.dashboard)
        observations = self.dashboard.observations["index_option_turnover_pcr_monthly"]
        self.assertEqual(set(observations), {"2026-10-31"})
        self.assertAlmostEqual(observations["2026-10-31"]["value"], 2630211 / 2291591, places=6)

        # Revised denominator zero cannot leave the older, now invalid ratio.
        self.dashboard.success("index_option_call_turnover_monthly", [("2026-10-31", 0)])
        derive_monthly_turnover_pcr(self.dashboard)
        self.assertEqual(self.dashboard.observations["index_option_turnover_pcr_monthly"], {})

    def test_negative_volume_and_amount_are_rejected(self):
        for key in ("index_futures_daily_average_monthly", "index_futures_notional_monthly",
                    "index_option_call_turnover_monthly", "index_option_put_turnover_monthly"):
            with self.subTest(key=key), self.assertRaises(CollectionError) as raised:
                self.dashboard.success(key, [("2026-10-31", -1)])
            self.assertEqual(raised.exception.code, "invalid_value")


if __name__ == "__main__":
    unittest.main()
