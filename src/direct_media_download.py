import os
import subprocess
import sys

from curl_cffi import requests


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

CONNECT_TIMEOUT = 20
READ_TIMEOUT = 60
MAX_TOTAL_SECONDS = 180
MIN_VALID_BYTES = 1024


def _safe_remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _download_with_curl(url: str, output_path: str, referer: str) -> None:
    cmd = [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "--retry-all-errors",
        "--connect-timeout",
        str(CONNECT_TIMEOUT),
        "--max-time",
        str(MAX_TOTAL_SECONDS),
        "--user-agent",
        USER_AGENT,
        "--header",
        "Accept: */*",
    ]
    if referer:
        cmd.extend(["--referer", referer])
    cmd.extend(["--output", output_path, url])

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"curl failed ({result.returncode}): {stderr[:500]}")


def _download_with_curl_cffi(url: str, output_path: str, referer: str) -> None:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
    }
    if referer:
        headers["Referer"] = referer

    session = requests.Session()
    if referer:
        try:
            session.get(
                referer,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
                impersonate="chrome120",
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            )
        except Exception:
            pass

    response = session.get(
        url,
        headers=headers,
        impersonate="chrome120",
        stream=True,
        timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
    )
    if response.status_code >= 400:
        raise RuntimeError(f"HTTP {response.status_code}")

    with open(output_path, "wb") as file:
        for chunk in response.iter_content(chunk_size=1024 * 256):
            if chunk:
                file.write(chunk)


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: direct_media_download.py <url> <output_path> [referer]", file=sys.stderr)
        return 2

    url = sys.argv[1]
    output_path = sys.argv[2]
    referer = sys.argv[3] if len(sys.argv) > 3 else ""

    parent = os.path.dirname(output_path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    errors = []
    for downloader in (_download_with_curl, _download_with_curl_cffi):
        _safe_remove(output_path)
        try:
            downloader(url, output_path, referer)
            if os.path.exists(output_path) and os.path.getsize(output_path) >= MIN_VALID_BYTES:
                return 0
            raise RuntimeError("downloaded file is too small")
        except Exception as exc:
            errors.append(f"{downloader.__name__}: {exc}")

    _safe_remove(output_path)
    print("; ".join(errors), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
