"""Publish intraday availability without changing the legacy snapshot."""

from data_pipeline import DATA, atomic_json, read_json


def main():
    result = {
        "schemaVersion": 1,
        "status": "missing",
        "observations": {},
        "message": "원천 관측 시각과 공개 이용 범위를 확인할 수 있는 장중 출처가 연결되면 제공됩니다. 일별 계열의 관측일은 지표별로 표시합니다.",
    }
    path = DATA / "intraday-status.json"
    if read_json(path, {}) != result:
        atomic_json(path, result)
    print(result["message"])


if __name__ == "__main__":
    main()
