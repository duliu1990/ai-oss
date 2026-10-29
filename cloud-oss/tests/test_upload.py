import pytest


def test_upload_small_file(client, fake_bucket):
    response = client.post(
        "/api/files/upload",
        files={"file": ("hello.txt", b"hello world", "text/plain")},
    )

    assert response.status_code == 201
    assert response.json() == {"key": "drive/hello.txt", "size": 11}
    assert fake_bucket.objects["drive/hello.txt"] == b"hello world"


def test_upload_to_directory(client, fake_bucket):
    response = client.post(
        "/api/files/upload",
        data={"prefix": "drive/docs/"},
        files={"file": ("guide.pdf", b"pdf-data", "application/pdf")},
    )

    assert response.status_code == 201
    assert response.json()["key"] == "drive/docs/guide.pdf"
    assert fake_bucket.objects["drive/docs/guide.pdf"] == b"pdf-data"


def test_frontend_root_relative_key_is_scoped_for_direct_upload(client, fake_bucket):
    response = client.post(
        "/api/files/upload",
        data={"key": "root.txt"},
        files={"file": ("root.txt", b"root-data", "text/plain")},
    )

    assert response.status_code == 201
    assert response.json()["key"] == "drive/root.txt"
    assert fake_bucket.objects["drive/root.txt"] == b"root-data"


def test_upload_empty_file(client, fake_bucket):
    response = client.post(
        "/api/files/upload",
        files={"file": ("empty.bin", b"", "application/octet-stream")},
    )

    assert response.status_code == 201
    assert response.json()["size"] == 0
    assert fake_bucket.objects["drive/empty.bin"] == b""


def test_multipart_init_returns_upload_id(client, fake_bucket):
    response = client.post(
        "/api/files/upload/init",
        json={"filename": "large.bin", "prefix": "drive/uploads/", "size": 12},
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload == {"upload_id": "upload-1", "key": "drive/uploads/large.bin"}
    assert fake_bucket.multipart["upload-1"]["key"] == "drive/uploads/large.bin"


def test_frontend_root_relative_key_is_scoped_for_multipart_upload(client, fake_bucket):
    response = client.post(
        "/api/files/upload/init",
        json={"key": "large.bin", "size": 12},
    )

    assert response.status_code == 201
    assert response.json() == {"upload_id": "upload-1", "key": "drive/large.bin"}
    assert fake_bucket.multipart["upload-1"]["key"] == "drive/large.bin"


def test_multipart_upload_and_complete(client, fake_bucket):
    initialized = client.post(
        "/api/files/upload/init",
        json={"key": "drive/large.bin", "size": 11, "content_type": "application/octet-stream"},
    ).json()
    upload_id = initialized["upload_id"]

    first = client.put(f"/api/files/upload/{upload_id}/1", content=b"hello ")
    second = client.put(f"/api/files/upload/{upload_id}/2", content=b"world")
    completed = client.post(
        f"/api/files/upload/{upload_id}/complete",
        json={
            "parts": [
                {"part_number": 1, "etag": first.json()["etag"]},
                {"part_number": 2, "etag": second.json()["etag"]},
            ]
        },
    )

    assert first.status_code == 200
    assert first.json()["part_number"] == 1
    assert second.status_code == 200
    assert completed.status_code == 200
    assert completed.json() == {"key": "drive/large.bin", "size": 11}
    assert fake_bucket.objects["drive/large.bin"] == b"hello world"
    assert upload_id not in fake_bucket.multipart


def test_abort_multipart_cleans_state(client, fake_bucket):
    upload_id = client.post(
        "/api/files/upload/init",
        json={"key": "drive/cancel.bin", "size": 3},
    ).json()["upload_id"]

    response = client.delete(f"/api/files/upload/{upload_id}")

    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert upload_id not in fake_bucket.multipart


@pytest.mark.parametrize("part_number", [0, 10001])
def test_invalid_part_number_is_rejected(client, part_number):
    upload_id = client.post(
        "/api/files/upload/init",
        json={"key": "drive/large.bin"},
    ).json()["upload_id"]

    response = client.put(f"/api/files/upload/{upload_id}/{part_number}", content=b"part")

    assert response.status_code == 422


def test_invalid_upload_id_is_rejected(client):
    response = client.put("/api/files/upload/unknown-upload/1", content=b"part")

    assert response.status_code == 400
    assert response.json() == {"detail": "Unknown or expired multipart upload."}


@pytest.mark.parametrize(
    "key",
    ["../escape.bin", "/drive/escape.bin", "drive\\escape.bin", "outside/escape.bin"],
)
def test_upload_key_escape_attempt_is_rejected(client, key):
    response = client.post("/api/files/upload/init", json={"key": key})

    assert response.status_code in {400, 422}


def test_empty_multipart_part_is_rejected(client):
    upload_id = client.post(
        "/api/files/upload/init",
        json={"key": "drive/large.bin"},
    ).json()["upload_id"]

    response = client.put(f"/api/files/upload/{upload_id}/1", content=b"")

    assert response.status_code == 400
    assert response.json() == {"detail": "Upload part must not be empty."}


def test_text_json_body_limit_does_not_apply_to_upload_parts(client, fake_bucket):
    upload_id = client.post(
        "/api/files/upload/init",
        json={"key": "drive/large.bin"},
    ).json()["upload_id"]
    body = b"x" * (7 * 1024 * 1024 + 1)

    response = client.put(f"/api/files/upload/{upload_id}/1", content=body)

    assert response.status_code == 200
    assert fake_bucket.multipart[upload_id]["parts"][1] == body
