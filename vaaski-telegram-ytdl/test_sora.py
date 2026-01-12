from curl_cffi import requests
import sys
import re

url = "https://sora.chatgpt.com/p/s_69628dd9c6988191bcc77a22955ff547?psh=HXVzZXItNHFHc2puVUNiQlRFVjgxb01hMmFCb05j.7wJuIYlICNEc"

try:
    r = requests.get(url, impersonate="chrome120", timeout=30)
    if r.status_code == 200:
        # Search for mp4 links
        mp4_matches = re.findall(r'https?://[^"]+\.mp4', r.text)
        print(f"MP4 matches: {mp4_matches}", file=sys.stderr)
        
        # Search for video tags
        if "<video" in r.text:
             print("Video tag found", file=sys.stderr)
        
        # Dump content to file for analysis if needed (handled by caller)
        print(r.text)
    else:
        print(f"Status: {r.status_code}", file=sys.stderr)
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)