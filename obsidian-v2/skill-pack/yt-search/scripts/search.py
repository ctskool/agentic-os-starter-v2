#!/usr/bin/env python3
"""YouTube search via the YouTube Data API v3, with structured output and views/subs ratio.

search.list finds the videos (100 quota units per page of up to 50), videos.list and
channels.list fill in views, duration and subscriber counts (1 unit per 50).

Fails loudly. A missing key or an API/quota error exits 1. Zero results exits 3 with
a message saying so, because the old yt-dlp version printed nothing and exited 0
when YouTube's bot check blocked it.

Key lookup: process env first, then ~/.claude/.env (YOUTUBE_API_KEY).
"""

import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Force UTF-8 output on Windows to handle emoji in video titles
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

BASE = "https://www.googleapis.com/youtube/v3"
ORDERS = ("relevance", "date", "viewCount", "rating")
USAGE = ("Usage: search.py <query> [--count N] [--months N] [--days N] [--no-date-filter]\n"
         "                 [--order relevance|date|viewCount|rating] [--json]\n"
         "Example: search.py claude code tutorial --count 5 --days 14 --order viewCount")


def die(msg, code=1):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def parse_args(argv):
    """Parse query and flags (--count, --months, --days, --order, --lang, --no-shorts, --json) from argv."""
    args = argv[1:]
    count = 20
    months = 6
    days = None  # If set, overrides months
    order = "relevance"
    lang = None
    no_shorts = False
    as_json = False
    query_parts = []
    i = 0

    def int_arg(flag):
        try:
            return int(args[i + 1])
        except (IndexError, ValueError):
            die(f"{flag} requires an integer\n{USAGE}", 2)

    while i < len(args):
        if args[i] == "--count":
            count = int_arg("--count")
            i += 2
        elif args[i] == "--months":
            months = int_arg("--months")
            i += 2
        elif args[i] == "--days":
            days = int_arg("--days")
            i += 2
        elif args[i] == "--order":
            if i + 1 >= len(args) or args[i + 1] not in ORDERS:
                die(f"--order must be one of {', '.join(ORDERS)}", 2)
            order = args[i + 1]
            i += 2
        elif args[i] == "--lang":
            if i + 1 >= len(args):
                die("--lang requires a language code like en", 2)
            lang = args[i + 1]
            i += 2
        elif args[i] == "--no-shorts":
            no_shorts = True
            i += 1
        elif args[i] == "--no-date-filter":
            months = 0
            i += 1
        elif args[i] == "--json":
            as_json = True
            i += 1
        else:
            query_parts.append(args[i])
            i += 1
    query = " ".join(query_parts)
    if not query:
        die(USAGE, 2)
    if count < 1:
        die("--count must be at least 1", 2)
    return query, count, months, days, order, lang, no_shorts, as_json


def env(name):
    if os.environ.get(name):
        return os.environ[name]
    env_file = Path.home() / ".claude" / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def api(endpoint, **params):
    key = env("YOUTUBE_API_KEY")
    if not key:
        die("YOUTUBE_API_KEY is not set (process env or ~/.claude/.env).")
    url = f"{BASE}/{endpoint}?{urllib.parse.urlencode({**params, 'key': key})}"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=30) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            reason, message = "", ""
            try:
                err = json.loads(e.read().decode("utf-8"))["error"]
                message = err.get("message", "")
                reason = err["errors"][0]["reason"]
            except Exception:
                pass
            if reason in ("quotaExceeded", "dailyLimitExceeded"):
                die(f"YouTube API quota exhausted ({reason}). It resets at midnight Pacific.")
            if (e.code == 429 or e.code >= 500) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            die(f"YouTube API {endpoint} failed: HTTP {e.code} {reason} {message}".strip())
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            die(f"YouTube API {endpoint} unreachable: {e}")


def chunks(seq, n=50):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def parse_duration(iso):
    """ISO 8601 duration (PT1H2M3S) to seconds."""
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", iso or "")
    if not m:
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def format_subscribers(n):
    """Format subscriber count as human-readable (e.g., 45.2K, 1.2M)."""
    if n is None:
        return "N/A"
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def format_views(n):
    """Format view count with commas."""
    if n is None:
        return "N/A"
    return f"{n:,}"


def format_duration(sec):
    if sec is None:
        return "N/A"
    hours, remainder = divmod(sec, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    return f"{minutes}:{seconds:02d}"


def get_cutoff(months, days=None):
    """Cutoff datetime (UTC). --days overrides --months. None = no filter."""
    if days is not None:
        return datetime.now(timezone.utc) - timedelta(days=days) if days > 0 else None
    if months <= 0:
        return None
    return datetime.now(timezone.utc) - timedelta(days=months * 30)


def main():
    query, count, months, days, order, lang, no_shorts, as_json = parse_args(sys.argv)
    # Shorts are dropped after lookup, so ask for extra hits to still fill --count.
    want = count * 2 if no_shorts else count
    cutoff = get_cutoff(months, days)

    if days is not None and days > 0:
        date_label = f", last {days} day{'s' if days != 1 else ''}"
    elif cutoff:
        date_label = f", last {months} months"
    else:
        date_label = ""
    pages = math.ceil(want / 50)
    print(f"Searching YouTube (Data API) for: \"{query}\" (top {count} by {order}{date_label}, "
          f"~{pages * 100 + 2 * pages} quota units)...\n", file=sys.stderr)

    ids, token = [], None
    while len(ids) < want:
        params = {"part": "id", "q": query, "type": "video", "order": order,
                  "maxResults": min(50, want - len(ids))}
        if lang:
            params["relevanceLanguage"] = lang
        if cutoff:
            params["publishedAfter"] = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
        if token:
            params["pageToken"] = token
        page = api("search", **params)
        ids += [it["id"]["videoId"] for it in page.get("items") or [] if it.get("id", {}).get("videoId")]
        token = page.get("nextPageToken")
        if not token:
            break
    ids = list(dict.fromkeys(ids))

    if not ids:
        window = date_label.lstrip(", ") or "any date"
        die(f"No results: the API returned 0 videos for \"{query}\" ({window}). "
            "This is a real empty result, not a fetch failure. Broaden the query or the window.", 3)

    videos = {}
    for batch in chunks(ids):
        for v in api("videos", part="snippet,statistics,contentDetails", id=",".join(batch)).get("items") or []:
            videos[v["id"]] = v
    channel_ids = list({v["snippet"]["channelId"] for v in videos.values()})
    subs = {}
    for batch in chunks(channel_ids):
        for c in api("channels", part="statistics", id=",".join(batch)).get("items") or []:
            st = c.get("statistics", {})
            subs[c["id"]] = None if st.get("hiddenSubscriberCount") else int(st.get("subscriberCount", 0))

    results = []
    for vid in ids:
        v = videos.get(vid)
        if not v:
            continue  # deleted or private between search and lookup
        sn, st = v["snippet"], v.get("statistics", {})
        if sn.get("liveBroadcastContent") == "upcoming":
            continue
        seconds = parse_duration(v["contentDetails"].get("duration"))
        if no_shorts and seconds is not None and seconds <= 180:
            continue
        views = int(st["viewCount"]) if "viewCount" in st else None
        ch_subs = subs.get(sn["channelId"])
        published = datetime.fromisoformat(sn["publishedAt"].replace("Z", "+00:00"))
        results.append({
            "title": sn["title"],
            "chars": len(sn["title"]),
            "channel": sn.get("channelTitle"),
            "channel_id": sn["channelId"],
            "subscribers": ch_subs,
            "views": views,
            "ratio": round(views / ch_subs, 2) if views is not None and ch_subs else None,
            "duration_seconds": seconds,
            "published": published.isoformat(),
            "age_days": round((datetime.now(timezone.utc) - published).total_seconds() / 86400, 1),
            "url": f"https://youtube.com/watch?v={vid}",
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
        })

    if not results:
        die(f"No results: {len(ids)} search hits but none survived lookup "
            f"(private, deleted, upcoming{', or Shorts' if no_shorts else ''}).", 3)
    results = results[:count]

    if as_json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return

    divider = "─" * 60
    for i, r in enumerate(results, 1):
        date = datetime.fromisoformat(r["published"]).strftime("%b %d, %Y")
        meta = (f"{r['channel']} ({format_subscribers(r['subscribers'])} subs)  ·  "
                f"{format_views(r['views'])} views  ·  {format_duration(r['duration_seconds'])}  ·  {date}")
        print(divider)
        print(f" {i:>2}. {r['title']}")
        print(f"     {meta}")
        if r["ratio"] is not None:
            print(f"     Engagement: {r['ratio']:.2f}x views/subs")
        print(f"     {r['url']}")
    print(divider)


if __name__ == "__main__":
    main()
