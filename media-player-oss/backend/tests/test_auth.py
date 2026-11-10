import time

import jwt
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

import app as app_module
import auth
import oss_store
from config import Settings
from tests.conftest import (
    AUTH_PASSWORD,
    AUTH_PASSWORD_HASH,
    AUTH_USERNAME,
    FakeBucket,
    bearer,
    issue_token,
)

PROTECTED = [
    ("GET", "/api/config"),
    ("GET", "/api/tracks"),
    ("GET", "/api/stream?key=media/a.mp3"),
    ("PUT", "/api/tracks/meta"),
]
PUBLIC = ["/healthz", "/api/auth/status"]


@pytest.fixture(autouse=True)
def clear_login_rate_limit():
    auth.reset_rate_limit()
    yield
    auth.reset_rate_limit()


@pytest.fixture
def bucket(monkeypatch):
    fake = FakeBucket({"media/a.mp3": b"id3data", "media/b.flac": b"flac"})
    monkeypatch.setattr(oss_store, "get_bucket", lambda _settings: fake)
    return fake


@pytest.fixture
def app_settings(settings, tmp_path):
    build = tmp_path / "dist"
    (build / "assets").mkdir(parents=True)
    (build / "index.html").write_text("<!doctype html><html></html>", encoding="utf-8")
    return Settings(
        _env_file=None,
        **(
            settings.model_dump()
            | {"library_file": str(tmp_path / "library.json"), "frontend_dist": str(build)}
        ),
    )


@pytest.fixture
def client(bucket, app_settings):
    with TestClient(app_module.create_app(app_settings), base_url="http://127.0.0.1:8767") as test:
        yield test


@pytest.fixture
def unconfigured_client(bucket, app_settings):
    app_settings.auth_password_hash = SecretStr("")
    with TestClient(app_module.create_app(app_settings), base_url="http://127.0.0.1:8767") as test:
        yield test


class TestLogin:
    def test_login_returns_a_usable_token(self, client, app_settings):
        response = client.post(
            "/api/auth/login",
            json={"username": AUTH_USERNAME, "password": AUTH_PASSWORD},
            headers={"X-Player-Client": "web"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["expires_in"] == app_settings.jwt_expire_minutes * 60
        payload = jwt.decode(
            body["token"], app_settings.jwt_secret_key.get_secret_value(), algorithms=["HS256"]
        )
        assert payload["sub"] == AUTH_USERNAME
        assert payload["exp"] > payload["iat"]
        # The issued token actually opens a protected route.
        authorized = client.get("/api/config", headers={"Authorization": f"Bearer {body['token']}"})
        assert authorized.status_code == 200

    def test_login_never_echoes_the_password_or_hash(self, client):
        response = client.post(
            "/api/auth/login",
            json={"username": AUTH_USERNAME, "password": AUTH_PASSWORD},
            headers={"X-Player-Client": "web"},
        )
        assert AUTH_PASSWORD not in response.text
        assert AUTH_PASSWORD_HASH not in response.text

    @pytest.mark.parametrize(
        ("username", "password"),
        [
            (AUTH_USERNAME, "wrong-password"),
            ("intruder", AUTH_PASSWORD),
            ("intruder", "wrong-password"),
        ],
    )
    def test_wrong_credentials_are_rejected(self, client, username, password):
        response = client.post(
            "/api/auth/login",
            json={"username": username, "password": password},
            headers={"X-Player-Client": "web"},
        )
        assert response.status_code == 401
        assert "token" not in response.json()

    def test_login_requires_the_write_marker(self, client):
        # local_guard applies to POST as well; a login without the marker never reaches auth.
        response = client.post(
            "/api/auth/login", json={"username": AUTH_USERNAME, "password": AUTH_PASSWORD}
        )
        assert response.status_code == 403

    @pytest.mark.parametrize(
        "payload",
        [{}, {"username": AUTH_USERNAME}, {"username": "", "password": AUTH_PASSWORD}, {"password": "x"}],
    )
    def test_malformed_login_bodies_are_422(self, client, payload):
        response = client.post(
            "/api/auth/login", json=payload, headers={"X-Player-Client": "web"}
        )
        assert response.status_code == 422

    def test_repeated_failures_are_rate_limited(self, client):
        body = {"username": AUTH_USERNAME, "password": "wrong-password"}
        for _ in range(5):
            assert client.post("/api/auth/login", json=body, headers={"X-Player-Client": "web"}).status_code == 401
        blocked = client.post("/api/auth/login", json=body, headers={"X-Player-Client": "web"})
        assert blocked.status_code == 429
        # The limiter counts failures, not identities: the correct password is blocked too.
        correct = client.post(
            "/api/auth/login",
            json={"username": AUTH_USERNAME, "password": AUTH_PASSWORD},
            headers={"X-Player-Client": "web"},
        )
        assert correct.status_code == 429
        auth.reset_rate_limit()
        assert client.post(
            "/api/auth/login",
            json={"username": AUTH_USERNAME, "password": AUTH_PASSWORD},
            headers={"X-Player-Client": "web"},
        ).status_code == 200


class TestProtectedRoutes:
    @pytest.mark.parametrize(("method", "path"), PROTECTED)
    def test_missing_token_is_rejected(self, client, method, path):
        response = client.request(method, path, json={"key": "media/a.mp3"}, headers={"X-Player-Client": "web"})
        assert response.status_code == 401

    @pytest.mark.parametrize(("method", "path"), PROTECTED)
    def test_valid_token_is_accepted(self, client, app_settings, method, path):
        headers = bearer(app_settings) | {"X-Player-Client": "web"}
        response = client.request(method, path, json={"key": "media/a.mp3"}, headers=headers)
        assert response.status_code == 200

    @pytest.mark.parametrize("path", PUBLIC)
    def test_public_routes_need_no_token(self, client, path):
        assert client.get(path).status_code == 200

    def test_index_and_assets_stay_public(self, client):
        # The login screen itself is served by the frontend bundle and must load unauthenticated.
        assert client.get("/").status_code == 200
        assert client.get("/assets/missing.js").status_code == 404

    @pytest.mark.parametrize(
        "header",
        ["", "token", "Bearer", "Bearer ", "Basic abc", "bearer lowercase-scheme"],
    )
    def test_malformed_authorization_headers_are_rejected(self, client, header):
        response = client.get("/api/config", headers={"Authorization": header})
        assert response.status_code == 401

    def test_expired_token_is_rejected_with_a_distinct_message(self, client, app_settings):
        expired = issue_token(app_settings, iat=int(time.time()) - 7200, exp=int(time.time()) - 3600)
        response = client.get("/api/config", headers=bearer(app_settings, expired))
        assert response.status_code == 401
        assert "过期" in response.json()["detail"]

    def test_token_signed_with_another_secret_is_rejected(self, client, app_settings):
        forged = jwt.encode(
            {"sub": AUTH_USERNAME, "iat": int(time.time()), "exp": int(time.time()) + 3600},
            "a-different-secret-key-of-sufficient-length",
            algorithm="HS256",
        )
        assert client.get("/api/config", headers=bearer(app_settings, forged)).status_code == 401

    def test_unsigned_token_is_rejected(self, client, app_settings):
        # alg=none must never be accepted; decode is pinned to HS256.
        none_alg = jwt.encode(
            {"sub": AUTH_USERNAME, "exp": int(time.time()) + 3600}, key="", algorithm="none"
        )
        assert client.get("/api/config", headers=bearer(app_settings, none_alg)).status_code == 401


class TestStreamQueryToken:
    """<audio> and native media players cannot set headers, so /api/stream accepts ?token=."""

    def test_query_token_opens_the_stream(self, client, app_settings):
        token = issue_token(app_settings)
        response = client.get("/api/stream", params={"key": "media/a.mp3", "token": token})
        assert response.status_code == 200
        assert response.content == b"id3data"

    def test_query_token_also_covers_range_requests(self, client, app_settings):
        token = issue_token(app_settings)
        response = client.get(
            "/api/stream",
            params={"key": "media/a.mp3", "token": token},
            headers={"Range": "bytes=0-2"},
        )
        assert response.status_code == 206
        assert response.content == b"id3"

    @pytest.mark.parametrize("token", ["", "not-a-jwt", "a.b.c"])
    def test_invalid_query_token_is_rejected(self, client, token):
        response = client.get("/api/stream", params={"key": "media/a.mp3", "token": token})
        assert response.status_code == 401

    def test_header_takes_precedence_over_a_broken_query_token(self, client, app_settings):
        response = client.get(
            "/api/stream",
            params={"key": "media/a.mp3", "token": "not-a-jwt"},
            headers=bearer(app_settings),
        )
        assert response.status_code == 200


class TestFailClosed:
    """Incomplete credentials must deny access, never fall back to anonymous reads."""

    @pytest.mark.parametrize(("method", "path"), PROTECTED)
    def test_unconfigured_auth_blocks_every_data_route(self, unconfigured_client, method, path):
        response = unconfigured_client.request(
            method, path, json={"key": "media/a.mp3"}, headers={"X-Player-Client": "web"}
        )
        assert response.status_code == 503
        assert "登录凭据" in response.json()["detail"]

    def test_unconfigured_auth_rejects_a_syntactically_valid_token(self, unconfigured_client, app_settings):
        # A token minted before the credentials were removed must stop working.
        response = unconfigured_client.get("/api/config", headers=bearer(app_settings))
        assert response.status_code == 503

    def test_unconfigured_login_reports_a_server_problem(self, unconfigured_client):
        response = unconfigured_client.post(
            "/api/auth/login",
            json={"username": AUTH_USERNAME, "password": AUTH_PASSWORD},
            headers={"X-Player-Client": "web"},
        )
        assert response.status_code == 503

    def test_status_reports_unready_so_clients_can_explain_it(self, unconfigured_client):
        assert unconfigured_client.get("/api/auth/status").json() == {
            "auth_required": True,
            "auth_ready": False,
        }

    def test_status_reports_ready_when_configured(self, client):
        assert client.get("/api/auth/status").json() == {"auth_required": True, "auth_ready": True}

    def test_health_stays_public_so_monitoring_survives_misconfiguration(self, unconfigured_client):
        assert unconfigured_client.get("/healthz").json() == {"status": "ok"}


class TestAuthSettings:
    def test_auth_missing_lists_each_absent_variable(self, settings):
        complete = settings.model_copy()
        assert complete.auth_configured is True
        assert complete.auth_missing == []
        blank = settings.model_copy(
            update={"auth_username": "", "jwt_secret_key": SecretStr("")}
        )
        assert blank.auth_configured is False
        assert blank.auth_missing == ["AUTH_USERNAME", "JWT_SECRET_KEY"]

    @pytest.mark.parametrize("secret", ["short", "x" * 31])
    def test_weak_jwt_secrets_are_refused(self, secret):
        with pytest.raises(ValidationError, match="32"):
            Settings(_env_file=None, jwt_secret_key=secret)

    def test_32_byte_secret_is_accepted(self):
        assert Settings(_env_file=None, jwt_secret_key="x" * 32).jwt_secret_key.get_secret_value()

    @pytest.mark.parametrize("minutes", [0, -1, 43201])
    def test_expiry_outside_the_supported_range_is_refused(self, minutes):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, jwt_expire_minutes=minutes)

    @pytest.mark.parametrize("username", ["a" * 101, "bad\nname"])
    def test_invalid_usernames_are_refused(self, username):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, auth_username=username)

    def test_secrets_are_not_printed_in_the_settings_repr(self, settings):
        rendered = repr(settings)
        assert AUTH_PASSWORD_HASH not in rendered
        assert settings.jwt_secret_key.get_secret_value() not in rendered
