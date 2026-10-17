"""Compare generated Markdown links to the supplied evidence URLs."""
import html
import re
from urllib.parse import urlsplit, urlunsplit


def canonical_url(value: str) -> str:
    value = html.unescape(value).replace(r"\(", "(").replace(r"\)", ")")
    try:
        url = urlsplit(value)
        if url.scheme.lower() not in ("http", "https") or not url.hostname or url.username or url.password:
            return ""
        host = url.hostname.lower()
        if ":" in host:
            host = f"[{host}]"
        if url.port and (url.scheme.lower(), url.port) not in (("http", 80), ("https", 443)):
            host += f":{url.port}"
        # Fragments locate a section within the same source, not a new source.
        return urlunsplit((url.scheme.lower(), host, url.path.rstrip("/"), url.query, ""))
    except ValueError:
        return ""


def unsupported_links(content: str, sources: set[str]) -> list[str]:
    allowed = {canonical_url(url) for url in sources} - {""}
    invalid = []
    for match in re.finditer(r"https?://[^\s<>\"']+", content, re.I):
        value = match.group()
        candidates = [value]
        while value:
            if value[-1] in ".,，。；;：:！!？?`":
                value = value[:-1]
            elif value[-1] in ")]}":
                closing = value[-1]
                opening = {")": "(", "]": "[", "}": "{"}[closing]
                if value.count(closing) <= value.count(opening):
                    break
                value = value[:-1]
            else:
                break
            candidates.append(value)
        if not any(canonical_url(candidate) in allowed for candidate in candidates):
            invalid.append(value)
    return list(dict.fromkeys(invalid))
