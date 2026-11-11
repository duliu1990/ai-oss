"""Authentication feature tests."""

import time

import jwt

from tests.conftest import TEST_AUTH_PASSWORD, TEST_AUTH_USERNAME, TEST_JWT_SECRET, auth_header


class TestLogin:
    """Login endpoint tests."""

    def test_login_success(self, auth_client):
        """Correct credentials successfully log in."""
        res = auth_client.post(
            "/api/auth/login",
            json={
                "username": TEST_AUTH_USERNAME,
                "password": TEST_AUTH_PASSWORD,
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert "token" in data
        assert "expires_in" in data
        assert data["expires_in"] > 0
        payload = jwt.decode(data["token"], TEST_JWT_SECRET, algorithms=["HS256"])
        assert payload["sub"] == TEST_AUTH_USERNAME

    def test_login_wrong_password(self, auth_client):
        """An incorrect password returns 401."""
        res = auth_client.post(
            "/api/auth/login",
            json={
                "username": TEST_AUTH_USERNAME,
                "password": "wrongpassword",
            },
        )
        assert res.status_code == 401

    def test_login_wrong_username(self, auth_client):
        """An incorrect username returns 401."""
        res = auth_client.post(
            "/api/auth/login",
            json={
                "username": "wronguser",
                "password": TEST_AUTH_PASSWORD,
            },
        )
        assert res.status_code == 401

    def test_login_empty_fields(self, auth_client):
        """Empty fields return 422."""
        res = auth_client.post(
            "/api/auth/login",
            json={
                "username": "",
                "password": "",
            },
        )
        assert res.status_code == 422


class TestAuthProtection:
    """Protected route authentication tests."""

    def test_no_token_returns_401(self, auth_client):
        """A protected endpoint returns 401 without a token."""
        res = auth_client.get("/api/files")
        assert res.status_code == 401

    def test_invalid_token_returns_401(self, auth_client):
        """An invalid token returns 401."""
        res = auth_client.get("/api/files", headers=auth_header("invalid-token"))
        assert res.status_code == 401

    def test_expired_token_returns_401(self, auth_client):
        """An expired token returns 401."""
        payload = {
            "sub": TEST_AUTH_USERNAME,
            "iat": int(time.time()) - 7200,
            "exp": int(time.time()) - 3600,
        }
        expired_token = jwt.encode(payload, TEST_JWT_SECRET, algorithm="HS256")
        res = auth_client.get("/api/files", headers=auth_header(expired_token))
        assert res.status_code == 401

    def test_valid_token_allows_access(self, auth_client, auth_token):
        """A valid token permits access to a protected endpoint."""
        res = auth_client.get("/api/files", headers=auth_header(auth_token))
        assert res.status_code == 200

    def test_token_in_query_param(self, auth_client, auth_token):
        """A token in the query parameters is also accepted."""
        res = auth_client.get(f"/api/files?token={auth_token}")
        assert res.status_code == 200

    def test_notes_protected(self, auth_client):
        """The notes endpoint is protected."""
        res = auth_client.get("/api/notes")
        assert res.status_code == 401

    def test_notes_with_token(self, auth_client, auth_token):
        """A token permits access to the notes endpoint."""
        res = auth_client.get("/api/notes", headers=auth_header(auth_token))
        assert res.status_code == 200

    def test_login_endpoint_not_protected(self, auth_client):
        """The login endpoint itself does not require a token."""
        res = auth_client.post(
            "/api/auth/login",
            json={
                "username": "test",
                "password": "test",
            },
        )
        assert res.status_code == 401

    def test_healthz_not_protected(self, auth_client):
        """The health check does not require a token."""
        res = auth_client.get("/healthz")
        assert res.status_code == 200


class TestNoAuthConfig:
    """Behavior without authentication configuration."""

    def test_no_auth_config_allows_access(self, client):
        """Endpoints remain accessible without a token when auth is not configured."""
        res = client.get("/api/files")
        assert res.status_code == 200

    def test_login_returns_503_when_not_configured(self, client):
        """The login endpoint returns 503 when auth is not configured."""
        res = client.post(
            "/api/auth/login",
            json={
                "username": "test",
                "password": "test",
            },
        )
        assert res.status_code == 503
