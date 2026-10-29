import json
import logging
import sys
from pathlib import Path

import truststore

from config import settings
from logs import describe_error, redact
from security import UserError, safe_error

log = logging.getLogger("worker")


def emit(event: dict):
    print(json.dumps(event, ensure_ascii=False), flush=True)


class EventLogHandler(logging.Handler):
    """Forward worker log records to the parent over the stdout JSON protocol."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = redact(record.getMessage())
            if record.exc_info and record.exc_info[1] is not None:
                message += " | " + describe_error(record.exc_info[1])
            emit({"event": "log", "level": record.levelname, "name": record.name, "message": message})
        except Exception:
            self.handleError(record)


def setup_worker_logging() -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(EventLogHandler())
    root.setLevel(settings.log_level)
    for name in ("httpx", "httpcore", "urllib3", "oss2"):
        logging.getLogger(name).setLevel(logging.WARNING)


def main():
    operation = "?"
    try:
        request = json.load(sys.stdin)
        operation = request["operation"]
        log.debug("子进程开始执行 %s", operation)
        if operation == "analyze":
            from extract import analyze

            result = analyze(request["url"], settings)
        elif operation == "download":
            from media import download

            result = download(request["url"], request["mode"], Path(request["directory"]), emit, settings)
        elif operation == "upload":
            from oss_store import record_upload, upload_file

            result = upload_file(Path(request["path"]), request["key"], emit, settings)
            # The object is already stored: a catalog failure only downgrades to a warning.
            try:
                record_upload(result["object_key"], request.get("info") or {}, settings)
                result["catalog"] = True
            except UserError:
                result["catalog"] = False
        else:
            raise UserError("未知操作。")
        log.debug("子进程完成 %s", operation)
        emit({"event": "result", "result": result})
    except Exception as exc:
        # Modules log the raw cause before wrapping it; this catches anything they did not.
        if not isinstance(exc, UserError):
            log.error("子进程 %s 异常：%s", operation, describe_error(exc))
        emit({"event": "error", "error": safe_error(exc)})
        sys.exit(1)


if __name__ == "__main__":
    truststore.inject_into_ssl()
    setup_worker_logging()
    main()
