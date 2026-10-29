import importlib
import json
import os
import socket
from copy import deepcopy
from unittest.mock import Mock

import httpx
import pytest
from pydantic_settings import BaseSettings


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    # config constructs Settings at import time: prevent both dotenv and process-env reads.
    monkeypatch.setattr(os, "environ", {})
    original_init = BaseSettings.__init__

    def init_without_dotenv(self, **kwargs):
        kwargs["_env_file"] = None
        original_init(self, **kwargs)

    monkeypatch.setattr(BaseSettings, "__init__", init_without_dotenv)

    def forbidden(*args, **kwargs):
        raise AssertionError("Tests must not use real DNS or network connections")

    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)


@pytest.fixture
def ai_module():
    return importlib.import_module("ai")


@pytest.fixture
def settings(ai_module):
    return ai_module.Settings(
        _env_file=None,
        ai_base_url="https://ai.example/v1",
        ai_api_key="dummy-ai-key",
        ai_model="dummy-model",
    )


@pytest.fixture
def candidates():
    return [
        {
            "id": "1",
            "title": "Video https://private.example/?token=dummy-title-secret",
            "kind": "video",
            "url": "https://media.example/video.mp4?token=dummy-video-secret",
            "extra": "not-for-ai",
        },
        {
            "id": "2",
            "title": "音频\n标题",
            "kind": "audio",
            "url": "https://media.example/audio.mp3?token=dummy-audio-secret",
        },
        {
            "id": "3",
            "title": "Another track",
            "kind": "unknown",
            "url": "https://media.example/stream?token=dummy-stream-secret",
        },
    ]


@pytest.fixture
def api_response(monkeypatch, ai_module):
    real_client = httpx.Client

    def install(*, ids=None, content=None, envelope=None, status=200, error=None, raw=None):
        requests = []
        if envelope is None:
            if content is None:
                content = json.dumps({"ids": ids if ids is not None else ["2", "1", "3"]})
            envelope = {"choices": [{"message": {"content": content}}]}

        def respond(request):
            requests.append(request)
            if error is not None:
                raise error
            if raw is not None:
                return httpx.Response(status, content=raw)
            return httpx.Response(status, json=envelope)

        client = Mock(
            side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs)
        )
        monkeypatch.setattr(ai_module.httpx, "Client", client)
        return requests, client

    return install


def test_ai_receives_only_sanitized_id_title_kind(settings, candidates, ai_module, api_response):
    requests, client = api_response()
    original = deepcopy(candidates)
    ranked, used, warning = ai_module.rank_candidates(candidates, settings)

    assert used is True and warning is None
    assert [candidate["id"] for candidate in ranked] == ["2", "1", "3"]
    assert ranked[0] is candidates[1]
    assert candidates == original
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST"
    assert str(request.url) == "https://ai.example/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer dummy-ai-key"
    body = json.loads(request.content)
    assert body["model"] == "dummy-model"
    assert body["response_format"] == {"type": "json_object"}
    assert body["temperature"] == 0
    payload = json.loads(body["messages"][1]["content"])
    assert payload == [
        {"id": "1", "title": "Video [链接]", "kind": "video"},
        {"id": "2", "title": "音频 标题", "kind": "audio"},
        {"id": "3", "title": "Another track", "kind": "unknown"},
    ]
    serialized = request.content.decode()
    for private in (
        "https://",
        "dummy-title-secret",
        "dummy-video-secret",
        "dummy-audio-secret",
        "dummy-stream-secret",
        "not-for-ai",
        "dummy-ai-key",
    ):
        assert private not in serialized
    client.assert_called_once_with(timeout=20, trust_env=False)


@pytest.mark.parametrize(
    "content",
    [
        "not JSON",
        '```json\n{"ids":["2","1","3"]}\n```',
        "null",
        "[]",
        "{}",
        '{"ids":null}',
        '{"ids":"123"}',
        '{"ids":{}}',
        '{"ids":[1,2,3]}',
        '{"ids":[true,"2","3"]}',
        '{"ids":[]}',
        '{"ids":["1","2"]}',
        '{"ids":["1","1","3"]}',
        '{"ids":["1","2","unknown"]}',
        '{"ids":["1","2","3","3"]}',
        '{"ids":["1","2","https://attacker.example/"]}',
    ],
)
def test_invalid_duplicate_or_unknown_ids_fall_back(content, settings, candidates, ai_module, api_response):
    api_response(content=content)
    original = deepcopy(candidates)
    ranked, used, warning = ai_module.rank_candidates(candidates, settings)
    assert ranked is candidates
    assert candidates == original
    assert used is False
    assert warning and "规则" in warning
    assert "https://" not in warning


@pytest.mark.parametrize(
    "envelope",
    [
        {},
        {"choices": []},
        {"choices": None},
        {"choices": [{}]},
        {"choices": [{"message": None}]},
        {"choices": [{"message": {"content": 42}}]},
    ],
)
def test_malformed_response_envelopes_fall_back(envelope, settings, candidates, ai_module, api_response):
    api_response(envelope=envelope)
    ranked, used, warning = ai_module.rank_candidates(candidates, settings)
    assert ranked is candidates and used is False and warning


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_http_errors_fall_back_without_leaking_credentials(
    status, settings, candidates, ai_module, api_response
):
    api_response(status=status, raw=b"dummy-ai-key https://private.example/?token=dummy-secret")
    ranked, used, warning = ai_module.rank_candidates(candidates, settings)
    assert ranked is candidates and used is False
    assert warning and "dummy" not in warning and "https://" not in warning


@pytest.mark.parametrize("error_type", [httpx.ReadTimeout, httpx.ConnectError, httpx.RemoteProtocolError])
def test_network_errors_fall_back(error_type, settings, candidates, ai_module, api_response):
    api_response(error=error_type("dummy-ai-key https://private.example/?token=dummy-secret"))
    ranked, used, warning = ai_module.rank_candidates(candidates, settings)
    assert ranked is candidates and used is False
    assert warning and "dummy" not in warning


def test_oversized_response_falls_back(settings, candidates, ai_module, api_response):
    content = json.dumps({"ids": ["2", "1", "3"]})
    api_response(envelope={"choices": [{"message": {"content": content}}], "padding": "x" * 65536})
    ranked, used, warning = ai_module.rank_candidates(candidates, settings)
    assert ranked is candidates and used is False and warning


@pytest.mark.parametrize("missing", ["ai_base_url", "ai_api_key", "ai_model", "all"])
def test_unconfigured_ai_never_constructs_client(missing, settings, candidates, ai_module, api_response):
    values = settings.model_dump()
    for field in ("ai_base_url", "ai_api_key", "ai_model") if missing == "all" else (missing,):
        values[field] = ""
    disabled = ai_module.Settings(_env_file=None, **values)
    requests, client = api_response()
    ranked, used, warning = ai_module.rank_candidates(candidates, disabled)
    assert ranked is candidates and used is False and warning is None
    assert requests == []
    client.assert_not_called()


@pytest.mark.parametrize("count", [0, 1])
def test_fewer_than_two_candidates_never_calls_ai(count, settings, candidates, ai_module, api_response):
    requests, client = api_response()
    selected = candidates[:count]
    ranked, used, warning = ai_module.rank_candidates(selected, settings)
    assert ranked is selected and used is False and warning is None
    assert requests == []
    client.assert_not_called()
