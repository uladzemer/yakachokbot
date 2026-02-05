import json
import re
import sys
from urllib.parse import urlparse, urlunparse

from yt_dlp import YoutubeDL
from yt_dlp.extractor.tiktok import TikTokIE


class QuietLogger:
    def debug(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        pass


def normalize_tiktok_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        path = parsed.path or ""
        path = re.sub(r"/photo/", "/video/", path)
        return urlunparse(parsed._replace(path=path))
    except Exception:
        return url


def read_file_trim(path: str | None) -> str:
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read().strip()
    except Exception:
        return ""


def extract_images(url: str, cookiefile: str | None, proxy: str | None):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "logger": QuietLogger(),
        "cookiefile": cookiefile or None,
        "proxy": proxy or None,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
        },
    }

    with YoutubeDL(opts) as ydl:
        ie = TikTokIE(ydl)
        ie.initialize()
        video_id = url.rstrip("/").split("/")[-1]
        video_data, _status = ie._extract_web_data_and_status(url, video_id, fatal=True)
        if not isinstance(video_data, dict):
            return None

        image_post = (
            video_data.get("imagePost")
            or video_data.get("image_post")
            or video_data.get("imagePostInfo")
            or video_data.get("image_post_info")
            or {}
        )
        images = image_post.get("images") or []
        urls: list[str] = []
        for image in images:
            if not isinstance(image, dict):
                continue
            image_url = (
                image.get("imageURL")
                or image.get("imageUrl")
                or image.get("image_url")
                or image.get("displayImage")
                or image.get("display_image")
            )
            if isinstance(image_url, dict):
                url_list = image_url.get("urlList") or image_url.get("url_list") or []
                if url_list:
                    urls.append(url_list[0])
            elif isinstance(image_url, list):
                if image_url:
                    urls.append(image_url[0])
            elif isinstance(image_url, str):
                urls.append(image_url)

        author = video_data.get("author") or {}
        return {
            "photo_urls": urls,
            "author_name": author.get("nickname") or author.get("uniqueId"),
            "author_username": author.get("uniqueId"),
        }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        return

    url = sys.argv[1]
    cookiefile = sys.argv[2] if len(sys.argv) > 2 else None
    proxy_file = sys.argv[3] if len(sys.argv) > 3 else None
    proxy_value = read_file_trim(proxy_file)

    normalized = normalize_tiktok_url(url)

    result = None
    error = None

    # Try without proxy first to avoid region-notfound responses
    try:
        result = extract_images(normalized, cookiefile, None)
    except Exception as exc:
        error = str(exc)

    if not result or not result.get("photo_urls"):
        if proxy_value:
            try:
                result = extract_images(normalized, cookiefile, proxy_value)
            except Exception as exc:
                error = str(exc)

    if result and result.get("photo_urls"):
        print(json.dumps(result, ensure_ascii=False))
        return

    print(json.dumps({"error": error or "No images found"}))


if __name__ == "__main__":
    main()
