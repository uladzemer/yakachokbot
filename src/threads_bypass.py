import sys
import json
import re
import html
import os
from curl_cffi import requests

def resolve_threads(url):
    COOKIE_FILE = "/app/storage/cookies.txt"
    
    # Normalize URL
    url = url.replace("threads.com", "threads.net")
    if "/post/" in url and "/t/" not in url:
        # Some tools prefer the /t/ format
        match = re.search(r'/post/([^/?]+)', url)
        if match:
            url = f"https://www.threads.net/t/{match.group(1)}"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
    }

    try:
        # Load cookies if available
        session = requests.Session()
        if os.path.exists(COOKIE_FILE):
            # Simple Netscape cookie parser for requests
            with open(COOKIE_FILE, 'r') as f:
                for line in f:
                    if not line.startswith('#') and line.strip():
                        parts = line.split('\t')
                        if len(parts) >= 7:
                            session.cookies.set(parts[5], parts[6].strip(), domain=parts[0])

        r = session.get(url, impersonate="chrome120", headers=headers, timeout=30)
        
        if r.status_code != 200:
            return {"error": f"HTTP {r.status_code}"}

        # 1. Look for og:video
        match = re.search(r'property="og:video" content="(.*?)"', r.text)
        if match:
            return {"video_url": html.unescape(match.group(1)), "title": "Threads Video"}

        # 2. Look for any fbcdn .mp4 links (the ones you saw in DevTools)
        # They are often inside JSON-like strings in the HTML
        mp4_links = re.findall(r'https?://[^\s"\'\\]+?\.mp4[^\s"\'\\]*', r.text)
        if mp4_links:
            # Filter for Meta CDN
            meta_links = [l for l in mp4_links if "fbcdn.net" in l or "instagram" in l]
            if meta_links:
                # Take the first one and clean it
                video_url = meta_links[0].replace("\/", "/")
                # Remove extra escaping if it's inside a JSON string
                video_url = video_url.replace("\u0026", "&")
                return {"video_url": html.unescape(video_url), "title": "Threads Video (CDN)"}

        return {"error": "Could not find video link in Threads page. Please ensure you uploaded valid cookies."}

    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)
    
    print(json.dumps(resolve_threads(sys.argv[1])))
