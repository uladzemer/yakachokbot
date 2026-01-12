import sys
import json
import re
import html
from curl_cffi import requests

def resolve_xfree(url):
    result = {"video_url": None, "title": "Xfree Video"}
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    }
    try:
        r = requests.get(url, impersonate="chrome120", headers=headers, timeout=30)
        
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}"}

        # Search for MP4 links in og:video first
        video_match = re.search(r'<meta[^>]*?property="og:video"[^>]*?content="(.*?)"', r.text)
        if video_match:
            result["video_url"] = html.unescape(video_match.group(1))
        else:
            # Fallback to general MP4 search
            mp4_matches = re.findall(r'https?://[^\s"\'<>]+?\.mp4[^\s"\'<>]*', r.text)
            if mp4_matches:
                result["video_url"] = html.unescape(mp4_matches[0])
            
        # Try to find title in meta tags
        title_match = re.search(r'<meta[^>]*?property="og:title"[^>]*?content="(.*?)"', r.text)
        if title_match:
            result["title"] = html.unescape(title_match.group(1))
        elif not title_match:
            title_match = re.search(r'<title>(.*?)</title>', r.text)
            if title_match:
                result["title"] = html.unescape(title_match.group(1))
            
        if result["video_url"]:
            return result
            
        return {"error": "No video URL found in HTML"}

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)
        
    url = sys.argv[1]
    result = resolve_xfree(url)
    print(json.dumps(result))