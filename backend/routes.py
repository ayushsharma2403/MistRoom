"""REST endpoints for MistRoom."""
import io
import socket
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from backend.config import PORT
from backend.state import db_pool

try:
    import segno
except ImportError:
    segno = None

router = APIRouter()


def get_lan_ip() -> str:
    candidates = ["8.8.8.8", "1.1.1.1", "10.255.255.255"]
    for host in candidates:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(0.5)
                s.connect((host, 80))
                ip = s.getsockname()[0]
                if not ip.startswith("127."):
                    return ip
        except OSError:
            continue
    return "localhost"


LAN_URL = f"http://{get_lan_ip()}:{PORT}"


@router.get("/qr.svg")
def get_qr_svg(request: Request):
    host_header = request.headers.get("host")
    if host_header:
        scheme = request.url.scheme or "http"
        target_url = f"{scheme}://{host_header}"
    else:
        target_url = LAN_URL

    if segno:
        buf = io.BytesIO()
        segno.make(target_url).save(buf, kind="svg", scale=6, border=1)
        return Response(buf.getvalue(), media_type="image/svg+xml")
    svg_fallback = f'''<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
        <rect width="100%" height="100%" fill="#eee"/>
        <text x="50%" y="45%" text-anchor="middle" font-size="12" fill="#333" font-family="sans-serif">Connect on Wi-Fi:</text>
        <text x="50%" y="60%" text-anchor="middle" font-size="10" fill="#2F7F86" font-family="sans-serif">{target_url}</text>
    </svg>'''
    return Response(svg_fallback, media_type="image/svg+xml")


@router.get("/reset-cache")
def reset_cache():
    """Wipes all browser cache, service workers, and storage for this origin."""
    response = Response(
        content='''<!DOCTYPE html><html><head><meta http-equiv="refresh" content="1;url=/"><title>Resetting Cache...</title></head><body style="font-family:sans-serif;background:#0B132B;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;"><h2>Clearing Browser Cache & Service Workers...</h2><p>Redirecting to fresh MistRoom in 1 second...</p></div></body></html>''',
        media_type="text/html"
    )
    response.headers["Clear-Site-Data"] = '"cache", "cookies", "storage"'
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@router.get("/api/info")
def get_info():
    return JSONResponse({"url": LAN_URL, "db_active": db_pool is not None})
