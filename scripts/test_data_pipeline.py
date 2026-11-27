import json
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import Mock

from collect import (
    ecos_observations, fred_observations, kofia_observations,
    kofia_rows, kofia_total_observations, safely_collect,
)
from data_pipeline import Dashboard, KST, CollectionError, atomic_json, read_json


class DashboardTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def dashboard(self, day):
        return Dashboard(self.directory, datetime(2026, 11, day, 18, tzinfo=KST))

    def test_source_histories_are_separate_and_future_points_are_ignored(self):
        atomic_json(self.directory / "kospi_kosdaq.json", [
            {"date": "2026-10-14", "kospi": 6008.81, "kosdaq": 823.88},
            {"date": "2026-11-30", "kospi": 2000},
        ])
        dashboard = self.dashboard(27)
        dashboard.success("kospi_ecos", [("2026-11-26", 4711.21)])
        series = dashboard.write()["series"]
        self.assertEqual(series["kospi"]["asOf"], "2026-10-14")
        self.assertEqual(series["kospi_ecos"]["asOf"], "2026-11-26")
        self.assertEqual(len(series["kospi_ecos"]["points"]), 1)
        self.assertEqual(series["kospi"]["status"], "delayed")
        self.assertEqual(series["kospi200"]["status"], "missing")

    def test_failure_preserves_last_verified_value_and_timestamp(self):
        dashboard = self.dashboard(26)
        dashboard.success("kr3y", [("2026-11-26", 3.622)])
        original = dashboard.write()["series"]["kr3y"]
        failure = self.dashboard(27)
        failure.failure("kr3y", CollectionError("timeout", "응답 시간 초과"))
        failed_data = failure.write()
        failed = failed_data["series"]["kr3y"]
        self.assertEqual(failed["points"], original["points"])
        self.assertEqual(failed["collectedAt"], original["collectedAt"])
        self.assertNotEqual(failed["lastAttemptAt"], original["lastAttemptAt"])
        self.assertEqual(failed["status"], "delayed")
        self.assertEqual(failed_data["diagnostics"][0]["code"], "timeout")

        recovery = self.dashboard(28)
        recovery.success("kr3y", [("2026-11-26", 3.622)])
        recovered = recovery.write()
        self.assertEqual(recovered["series"]["kr3y"]["status"], "closed")
        self.assertEqual(recovered["series"]["kr3y"]["collectedAt"], original["collectedAt"])
        self.assertEqual(recovered["diagnostics"], [])

    def test_spread_compares_only_dates_with_both_official_values(self):
        dashboard = self.dashboard(27)
        dashboard.success("kr3y", [("2026-11-24", 3.63), ("2026-11-26", 3.622)])
        dashboard.success("kr10y", [("2026-11-25", 3.78), ("2026-11-26", 3.79)])
        dashboard.combine("kr_term_spread", "kr10y", "kr3y", lambda left, right: (left - right) * 100)
        points = dashboard.write()["series"]["kr_term_spread"]["points"]
        self.assertEqual([(point["date"], point["value"]) for point in points], [("2026-11-26", 16.8)])

    def test_invalid_or_conflicting_last_row_cannot_replace_history(self):
        dashboard = self.dashboard(26)
        dashboard.success("kospi_ecos", [("2026-11-26", 4711.21)])
        original = dashboard.write()["series"]["kospi_ecos"]["points"]
        for invalid, code in (
            (("2026-11-27", 0), "invalid_value"),
            (("2026-11-26", 4800), "ambiguous_rows"),
        ):
            with self.subTest(code=code):
                attempt = self.dashboard(27)
                safely_collect(attempt, ["kospi_ecos"], lambda: {"kospi_ecos": [
                    ("2026-11-26", 4700), invalid,
                ]})
                result = attempt.write()
                self.assertEqual(result["series"]["kospi_ecos"]["points"], original)
                self.assertEqual(result["diagnostics"][0]["code"], code)
                self.assertEqual(result["series"]["kospi_ecos"]["status"], "delayed")

    def test_zero_and_negative_values_allowed_for_yields_and_flows(self):
        dashboard = self.dashboard(27)
        for key in ("us10y", "foreign_net_kospi"):
            dashboard.success(key, [("2026-11-26", -1), ("2026-11-27", 0)])
            self.assertEqual(dashboard.observations[key]["2026-11-27"]["value"], 0)
        dashboard.success("forced_sales", [("2026-11-27", 0)])
        with self.assertRaises(CollectionError) as raised:
            dashboard.success("forced_sales", [("2026-11-27", -1)])
        self.assertEqual(raised.exception.code, "invalid_value")
        self.assertEqual(dashboard.observations["forced_sales"]["2026-11-27"]["value"], 0)

    def test_description_changes_preserve_history_but_source_transition_does_not(self):
        dashboard = self.dashboard(27)
        dashboard.success("kospi_ecos", [("2026-11-26", 4711.21)])
        dashboard.write()
        path = self.directory / "dashboard.json"
        stored = read_json(path, {})
        series = stored["series"]["kospi_ecos"]
        series["source"]["license"] = "이용 안내 문구 수정"
        series["source"]["access"] = "접근 안내 문구 수정"
        atomic_json(path, stored)
        self.assertEqual(self.dashboard(27).observations["kospi_ecos"]["2026-11-26"]["value"], 4711.21)
        series["definition"] = "다른 기준으로 산정한 지수"
        atomic_json(path, stored)
        self.assertEqual(self.dashboard(27).observations["kospi_ecos"], {})


class SourcesTest(unittest.TestCase):
    def test_monthly_investor_amounts_keep_their_own_frequency_and_history(self):
        client = Mock()
        client.get.return_value = json.dumps({"StatisticSearch": {"list_total_count": 1, "row": [{
            "STAT_CODE": "901Y055", "ITEM_CODE1": "S22CA", "ITEM_CODE2": "VA",
            "UNIT_NAME": "백만원", "TIME": "202610", "DATA_VALUE": "4729682",
        }]}}).encode()
        points = ecos_observations(client, "institution_net_monthly", "mock",
                                   date(2026, 6, 1), date(2026, 11, 27))
        self.assertEqual(points, [("2026-10-31", 47296.82)])
        self.assertTrue(client.get.call_args.args[1].endswith("/901Y055/M/202606/202611/S22CA/VA"))
        with tempfile.TemporaryDirectory() as temporary:
            dashboard = Dashboard(Path(temporary), datetime(2026, 11, 27, 18, tzinfo=KST))
            dashboard.success("institution_net", [("2026-10-14", 111)])
            dashboard.success("institution_net_monthly", points)
            series = dashboard.write()["series"]
            self.assertEqual(series["institution_net"]["asOf"], "2026-10-14")
            self.assertEqual(series["institution_net"]["points"][0]["value"], 111)
            self.assertEqual(series["institution_net_monthly"]["frequency"], "monthly")
            self.assertEqual(len(series["institution_net_monthly"]["points"]), 1)
            self.assertEqual(series["institution_net_monthly"]["scope"], "ECOS 투자자별 주식거래 공표 범위")

    def test_monthly_investor_volume_cannot_be_mistaken_for_amount(self):
        for field, invalid, expected in (("ITEM_CODE2", "VO", "unexpected_series"),
                                         ("UNIT_NAME", "천주", "unexpected_unit")):
            row = {"STAT_CODE": "901Y055", "ITEM_CODE1": "S22CB", "ITEM_CODE2": "VA",
                   "UNIT_NAME": "백만원", "TIME": "202610", "DATA_VALUE": "100"}
            row[field] = invalid
            client = Mock()
            client.get.return_value = json.dumps({"StatisticSearch": {"list_total_count": 1, "row": [row]}}).encode()
            with self.subTest(field=field), self.assertRaises(CollectionError) as raised:
                ecos_observations(client, "individual_net_monthly", "mock",
                                  date(2026, 10, 1), date(2026, 11, 27))
            self.assertEqual(raised.exception.code, expected)

    def test_monthly_investor_missing_and_unfinished_periods_are_not_zero_or_current_daily_values(self):
        client = Mock()
        client.get.return_value = json.dumps({"StatisticSearch": {"list_total_count": 3, "row": [
            {"STAT_CODE": "901Y055", "ITEM_CODE1": "S22CC", "ITEM_CODE2": "VA",
             "UNIT_NAME": "백만원", "TIME": month, "DATA_VALUE": value}
            for month, value in (("202609", "-"), ("202610", "-12000"), ("202611", "300"))
        ]}}).encode()
        points = ecos_observations(client, "foreign_net_monthly", "mock",
                                   date(2026, 9, 1), date(2026, 11, 27))
        self.assertEqual(points, [("2026-10-31", -120)])

    def test_ecos_monthly_period_uses_period_end_and_preserves_unit(self):
        client = Mock()
        client.get.return_value = json.dumps({"StatisticSearch": {"list_total_count": 1, "row": [{
            "STAT_CODE": "161Y006", "ITEM_CODE1": "BBHA00", "UNIT_NAME": "십억원",
            "TIME": "202609", "DATA_VALUE": "4278834.3",
        }]}}).encode()
        observations = ecos_observations(client, "kr_m2", "mock", date(2026, 1, 1), date(2026, 11, 27))
        self.assertEqual(observations, [("2026-09-30", 4278.8343)])
        self.assertTrue(client.get.call_args.args[1].endswith("/161Y006/M/202601/202611/BBHA00"))

    def test_ecos_rejects_out_of_range_observations(self):
        client = Mock()
        client.get.return_value = json.dumps({"StatisticSearch": {"list_total_count": 1, "row": [{
            "STAT_CODE": "802Y001", "ITEM_CODE1": "0001000",
            "TIME": "20261120", "DATA_VALUE": "4711.21",
        }]}}).encode()
        with self.assertRaises(CollectionError) as raised:
            ecos_observations(client, "kospi_ecos", "mock", date(2026, 11, 23), date(2026, 11, 27))
        self.assertEqual(raised.exception.code, "invalid_date")

    def test_kofia_pagination_uses_documented_exclusive_end(self):
        client = Mock()
        client.get.side_effect = [
            json.dumps({"response": {"header": {"resultCode": "00"}, "body": {
                "totalCount": 2, "items": {"item": {"basDt": day, "invrDpsgAmt": amount}},
            }}}).encode()
            for day, amount in [("20261124", "82050000000000"), ("20261123", "81000000000000")]
        ]
        first, last = date(2026, 11, 23), date(2026, 11, 24)
        rows = kofia_rows(client, "source", "mock", first, last, {})
        self.assertEqual(client.get.call_args.args[2]["pageNo"], 2)
        self.assertEqual(client.get.call_args.args[2]["endBasDt"], "20261125")
        self.assertEqual(
            kofia_observations(rows, "invrDpsgAmt", 1e12, first, last),
            [("2026-11-24", 82.05), ("2026-11-23", 81)],
        )

    def test_fred_missing_holiday_is_not_zero(self):
        client = Mock()
        client.get.return_value = b"observation_date,DGS10\n2026-11-24,4.91\n2026-11-25,.\n"
        points = fred_observations(client, "us10y", date(2026, 11, 24), date(2026, 11, 25))
        self.assertEqual(points, [("2026-11-24", 4.91)])

    def test_mmf_includes_only_verified_aggregate_or_both_components(self):
        rows = [
            {"ctg": category, "tstMthdCtg": group, "basDt": day, "nPptTotAmt": value * 1e12}
            for day, category, group, value in [
                ("20261124", "단기금융", "공모", 100), ("20261124", "단기금융", "사모", 10),
                ("20261125", "단기금융", "공모", 105),
                ("20261126", "단기금융", "합계", 120), ("20261126", "단기금융", "공모", 105),
                ("20261125", "합계", "사모", 800),
            ]
        ]
        client = Mock()
        client.get.return_value = self.kofia_response(rows)
        self.assertEqual(
            kofia_total_observations(client, "mmf", "mock", date(2026, 11, 24), date(2026, 11, 26)),
            [("2026-11-24", 110), ("2026-11-26", 120)],
        )
        self.assertTrue(client.get.call_args.args[1].endswith("/getFundTotalNetEssetInfo"))
        self.assertEqual(client.get.call_args.args[2]["ctg"], "단기금융")

    def test_cma_counts_only_same_day_individual_and_institution_all_products(self):
        rows = [
            {"mngInvTgt": product, "invrCtg": group, "basDt": day, "actBal": value}
            for day, product, group, value in [
                ("20261125", "합계", "기관", 11909166105649),
                ("20261125", "합계", "개인", 87795015722292),
                ("20261125", "RP형", "개인", 5e12),
                ("20261125", "합계", "합계", 150e12),
                ("20261124", "합계", "개인", 87e12),
                ("20261126", "합계", "기관", 12e12),
            ]
        ]
        client = Mock()
        client.get.return_value = self.kofia_response(rows)
        self.assertEqual(
            kofia_total_observations(client, "cma", "mock", date(2026, 11, 24), date(2026, 11, 26)),
            [("2026-11-25", 99.7)],
        )
        self.assertTrue(client.get.call_args.args[1].endswith("/getCMAStatus"))
        self.assertEqual(client.get.call_args.args[2]["mngInvTgt"], "합계")
        self.assertNotIn("invrCtg", client.get.call_args.args[2])

    @staticmethod
    def kofia_response(rows):
        return json.dumps({"response": {"header": {"resultCode": "00"}, "body": {
            "totalCount": len(rows), "items": {"item": rows},
        }}}).encode()


if __name__ == "__main__":
    unittest.main()
