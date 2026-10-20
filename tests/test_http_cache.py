from fastapi.testclient import TestClient
from backend.server import app

client = TestClient(app)


def test_index_etag_caching():
    # GET / -> 200 with ETag
    res = client.get("/")
    assert res.status_code == 200
    etag = res.headers.get("ETag")
    assert etag is not None and len(etag) > 0
    assert "Content-Security-Policy" in res.headers
    assert "X-Content-Type-Options" in res.headers

    # GET / with If-None-Match -> 304, empty body, no content-length header
    res304 = client.get("/", headers={"If-None-Match": etag})
    assert res304.status_code == 304
    assert res304.content == b""
    assert "content-length" not in res304.headers
    assert res304.headers.get("ETag") == etag
    assert "Content-Security-Policy" in res304.headers
