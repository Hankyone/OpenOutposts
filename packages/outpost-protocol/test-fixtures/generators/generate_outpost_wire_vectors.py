"""Generate the shared OpenOutposts protocol-version-5 wire vectors.

The fixture is an independent contract input for the TypeScript schemas and
the Go worker structs. It deliberately imports neither implementation. Run
from the repository root:

    python3 packages/outpost-protocol/test-fixtures/generators/generate_outpost_wire_vectors.py

Pass ``--check`` to verify that the checked-in fixture is current. The script
is deterministic and uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any


PROTOCOL_VERSION = 5
FIXTURE_PATH = Path(__file__).resolve().parents[1] / "outpost-wire-vectors.json"
REGENERATE_COMMAND = (
    "python3 packages/outpost-protocol/test-fixtures/generators/"
    "generate_outpost_wire_vectors.py"
)

# Live v5 inventory. Keep these closed lists aligned with the production
# TypeScript unions before adding or removing vectors. Homestead-only messages
# are intentionally excluded because the Go outpost worker never consumes them.
WORKER_TO_CONTROL_TYPES = {
    "outpost.register",
    "outpost.heartbeat",
    "lease.accepted",
    "lease.rejected",
    "tool.result",
    "context.result",
}
CONTROL_TO_WORKER_TYPES = {
    "outpost.registered",
    "outpost.heartbeat_ack",
    "outpost.error",
    "lease.offer",
    "lease.release",
    "tool.request",
    "tool.cancel",
    "context.request",
}
OPERATIONS = ("bash", "read", "write", "edit", "grep", "find", "ls")

# Live Go carrier inventory. The first five worker-originated message kinds use
# dedicated structs; every control-originated kind uses ServerMessage.
GO_TYPE_BY_MESSAGE = {
    "outpost.register": "Registration",
    "outpost.heartbeat": "Heartbeat",
    "lease.accepted": "LeaseAccepted",
    "lease.rejected": "LeaseRejected",
    "tool.result": "ToolResult",
    "context.result": "ContextResult",
    **{message_type: "ServerMessage" for message_type in CONTROL_TO_WORKER_TYPES},
}


def versioned(message_type: str, **fields: Any) -> dict[str, Any]:
    return {"type": message_type, "protocolVersion": PROTOCOL_VERSION, **fields}


TOOL_PAYLOADS: list[dict[str, Any]] = [
    {
        "name": "bash with cwd, timeout, escaping, and unicode",
        "operation": "bash",
        "requestMessageName": "bash tool request",
        "resultMessageName": "successful bash tool result",
        "input": {
            "command": "printf 'héllo \"wire\"\\n'",
            "cwd": "project dir",
            "timeoutMs": 4250,
        },
        "result": {
            "stdout": 'héllo "wire"\n',
            "stderr": "warning: C:\\temp\n",
            "exitCode": 0,
            "durationMs": 127,
            "truncated": False,
        },
    },
    {
        "name": "read with line window and complex content",
        "operation": "read",
        "requestMessageName": "read tool request",
        "resultMessageName": "successful read tool result",
        "input": {
            "path": 'src/naïve "file".txt',
            "offsetLines": 2,
            "limitLines": 40,
        },
        "result": {
            "content": 'first "quoted"\nsecond \\ path\ncafé',
            "totalLines": 12,
            "truncated": True,
        },
    },
    {
        "name": "write with unicode path and multiline content",
        "operation": "write",
        "requestMessageName": "write tool request",
        "resultMessageName": "successful write tool result",
        "input": {
            "path": "notes/こんにちは.txt",
            "content": '"quoted"\nC:\\workspace\\file\n',
        },
        "result": {"bytesWritten": 27, "created": True},
    },
    {
        "name": "edit with replace all",
        "operation": "edit",
        "requestMessageName": "edit tool request",
        "resultMessageName": "successful edit tool result",
        "input": {
            "path": "src/message.ts",
            "oldString": "hello\nworld",
            "newString": "bonjour\n世界",
            "replaceAll": True,
        },
        "result": {"replacements": 3},
    },
    {
        "name": "grep with path and match limit",
        "operation": "grep",
        "requestMessageName": "grep tool request",
        "resultMessageName": "successful grep tool result",
        "input": {"pattern": 'TODO\\("café"\\)', "path": "src", "maxMatches": 25},
        "result": {
            "matches": [
                {"path": "src/café.ts", "line": 27, "text": 'TODO("café") \\ check'}
            ],
            "truncated": False,
        },
    },
    {
        "name": "find with result limit",
        "operation": "find",
        "requestMessageName": "find tool request",
        "resultMessageName": "successful find tool result",
        "input": {"glob": "src/**/*.{ts,tsx}", "maxResults": 250},
        "result": {
            "paths": ["src/index.ts", "src/界面/panel.tsx"],
            "truncated": False,
        },
    },
    {
        "name": "ls with every entry kind and truncation",
        "operation": "ls",
        "requestMessageName": "ls tool request",
        "resultMessageName": "successful ls tool result",
        "input": {"path": "build output"},
        "result": {
            "entries": [
                {"name": "artifact.bin", "type": "file", "sizeBytes": 12345},
                {"name": "assets", "type": "dir"},
                {"name": "current", "type": "symlink"},
                {"name": "socket", "type": "other"},
            ],
            "truncated": True,
        },
    },
]


def message(
    vector_name: str, direction: str, message_type: str, **fields: Any
) -> dict[str, Any]:
    return {
        "name": vector_name,
        "direction": direction,
        "goType": GO_TYPE_BY_MESSAGE[message_type],
        "message": versioned(message_type, **fields),
    }


def build_messages() -> list[dict[str, Any]]:
    messages = [
        message(
            "worker registration with every capability",
            "workerToControl",
            "outpost.register",
            outpostId="workstation-01",
            name="Test workstation",
            workerVersion="1.2.3-test",
            capabilities={
                "platform": "darwin",
                "architecture": "arm64",
                "operations": list(OPERATIONS),
                "workspaceRoots": [
                    "/srv/openoutposts/workspaces",
                    "/srv/openoutposts/repositories",
                ],
            },
        ),
        message(
            "worker heartbeat",
            "workerToControl",
            "outpost.heartbeat",
            outpostId="workstation-01",
            sentAt="2026-08-18T12:34:56Z",
        ),
        message(
            "lease accepted",
            "workerToControl",
            "lease.accepted",
            leaseId="lease-001",
        ),
        message(
            "lease rejected with reason",
            "workerToControl",
            "lease.rejected",
            leaseId="lease-rejected",
            reason="workspace path is outside the configured roots",
        ),
        message(
            "successful context result",
            "workerToControl",
            "context.result",
            requestId="request-context",
            leaseId="lease-001",
            ok=True,
            files=[
                {
                    "path": "AGENTS.md",
                    "content": 'Use UTF-8. Preserve "quotes" and C:\\paths.\n',
                },
                {"path": "src/AGENTS.md", "content": "Répondre clairement.\n"},
            ],
        ),
        message(
            "registered acknowledgement with every field",
            "controlToWorker",
            "outpost.registered",
            outpostId="workstation-01",
            connectionId="connection-001",
            registeredAt="2026-08-18T12:35:00Z",
            heartbeatIntervalMs=15000,
        ),
        message(
            "heartbeat acknowledgement",
            "controlToWorker",
            "outpost.heartbeat_ack",
            outpostId="workstation-01",
            receivedAt="2026-08-18T12:35:15Z",
        ),
        message(
            "control plane error",
            "controlToWorker",
            "outpost.error",
            code="unsupported_message",
            message='unsupported message: \\"future.type\\"',
        ),
        message(
            "lease offer with offset timestamp and spaced workspace",
            "controlToWorker",
            "lease.offer",
            leaseId="lease-001",
            productSessionId="session-001",
            workspacePath="/srv/openoutposts/workspaces/project with spaces",
            expiresAt="2026-08-18T15:30:00+02:00",
        ),
        message(
            "lease release",
            "controlToWorker",
            "lease.release",
            leaseId="lease-001",
            reason="moved",
        ),
        message(
            "lease-wide tool cancellation",
            "controlToWorker",
            "tool.cancel",
            leaseId="lease-001",
        ),
        message(
            "request-scoped tool cancellation",
            "controlToWorker",
            "tool.cancel",
            leaseId="lease-001",
            requestId="request-bash",
        ),
        message(
            "context request",
            "controlToWorker",
            "context.request",
            requestId="request-context",
            leaseId="lease-001",
        ),
    ]

    for payload in TOOL_PAYLOADS:
        operation = payload["operation"]
        request_id = f"request-{operation}"
        messages.append(
            message(
                payload["requestMessageName"],
                "controlToWorker",
                "tool.request",
                requestId=request_id,
                leaseId="lease-001",
                operation=operation,
                input=payload["input"],
            )
        )
        messages.append(
            message(
                payload["resultMessageName"],
                "workerToControl",
                "tool.result",
                requestId=request_id,
                leaseId="lease-001",
                ok=True,
                output=payload["result"],
            )
        )

    messages.append(
        message(
            "failed tool result",
            "workerToControl",
            "tool.result",
            requestId="request-failed",
            leaseId="lease-001",
            ok=False,
            output=None,
            error="operation timed out after 4250ms",
            errorCode="timeout",
        )
    )
    return messages


def build_fixture() -> dict[str, Any]:
    return {
        "fixtureVersion": 1,
        "description": (
            "Deterministic cross-language OpenOutposts v5 wire contract. "
            f"Regenerate with `{REGENERATE_COMMAND}`."
        ),
        "protocolVersion": PROTOCOL_VERSION,
        "messages": build_messages(),
        "toolPayloads": TOOL_PAYLOADS,
    }


def require(condition: bool, detail: str) -> None:
    if not condition:
        raise ValueError(detail)


def validate_fixture(fixture: dict[str, Any]) -> None:
    messages = fixture["messages"]
    names = [vector["name"] for vector in messages]
    require(len(names) == len(set(names)), "message vector names must be unique")

    message_by_name: dict[str, dict[str, Any]] = {}
    covered_by_direction = {
        "workerToControl": set(),
        "controlToWorker": set(),
    }
    for vector in messages:
        direction = vector["direction"]
        require(direction in covered_by_direction, f"unknown direction: {direction}")
        wire_message = vector["message"]
        message_type = wire_message["type"]
        require(
            message_type
            in (
                WORKER_TO_CONTROL_TYPES
                if direction == "workerToControl"
                else CONTROL_TO_WORKER_TYPES
            ),
            f"{vector['name']}: {message_type} is not in the {direction} inventory",
        )
        require(
            vector["goType"] == GO_TYPE_BY_MESSAGE.get(message_type),
            f"{vector['name']}: wrong Go carrier for {message_type}",
        )
        require(
            wire_message.get("protocolVersion") == fixture["protocolVersion"],
            f"{vector['name']}: protocol version differs from fixture",
        )
        require(
            "goType" not in wire_message, f"{vector['name']}: goType leaked onto wire"
        )
        covered_by_direction[direction].add(message_type)
        message_by_name[vector["name"]] = vector

    require(
        covered_by_direction["workerToControl"] == WORKER_TO_CONTROL_TYPES,
        "worker-to-control message coverage does not match the live inventory",
    )
    require(
        covered_by_direction["controlToWorker"] == CONTROL_TO_WORKER_TYPES,
        "control-to-worker message coverage does not match the live inventory",
    )

    payloads = fixture["toolPayloads"]
    operations = [payload["operation"] for payload in payloads]
    require(
        len(operations) == len(set(operations)),
        "tool payload operations must be unique",
    )
    require(set(operations) == set(OPERATIONS), "tool payload coverage is incomplete")

    for payload in payloads:
        operation = payload["operation"]
        request = message_by_name.get(payload["requestMessageName"])
        result = message_by_name.get(payload["resultMessageName"])
        require(request is not None, f"{operation}: missing referenced tool request")
        require(result is not None, f"{operation}: missing referenced tool result")
        request_message = request["message"]
        result_message = result["message"]
        require(
            request_message["type"] == "tool.request", f"{operation}: bad request ref"
        )
        require(
            request_message["operation"] == operation,
            f"{operation}: request operation drift",
        )
        require(
            request_message["input"] == payload["input"],
            f"{operation}: request input drift",
        )
        require(result_message["type"] == "tool.result", f"{operation}: bad result ref")
        require(result_message["ok"] is True, f"{operation}: result must be successful")
        require(
            result_message["output"] == payload["result"],
            f"{operation}: result output drift",
        )
        require(
            request_message["requestId"] == result_message["requestId"],
            f"{operation}: request/result IDs differ",
        )

    failed_results = [
        vector["message"]
        for vector in messages
        if vector["message"]["type"] == "tool.result" and not vector["message"]["ok"]
    ]
    require(len(failed_results) >= 1, "at least one failed tool result is required")

    cancels = [
        vector["message"]
        for vector in messages
        if vector["message"]["type"] == "tool.cancel"
    ]
    require(
        any("requestId" in cancel for cancel in cancels)
        and any("requestId" not in cancel for cancel in cancels),
        "both request-scoped and lease-wide cancellation are required",
    )


def collapse_short_primitive_arrays(rendered: str) -> str:
    """Match Prettier's compact layout for short JSON primitive arrays."""

    lines = rendered.splitlines()
    output: list[str] = []
    index = 0
    while index < len(lines):
        opening = lines[index]
        if not opening.rstrip().endswith("["):
            output.append(opening)
            index += 1
            continue

        opening_indent = len(opening) - len(opening.lstrip())
        values: list[str] = []
        cursor = index + 1
        while cursor < len(lines):
            stripped = lines[cursor].strip()
            indent = len(lines[cursor]) - len(lines[cursor].lstrip())
            if indent == opening_indent and stripped in ("]", "],"):
                break
            if indent <= opening_indent or not stripped:
                values = []
                break
            encoded_value = stripped.removesuffix(",")
            try:
                decoded_value = json.loads(encoded_value)
            except json.JSONDecodeError:
                values = []
                break
            if isinstance(decoded_value, (dict, list)):
                values = []
                break
            values.append(encoded_value)
            cursor += 1

        if not values or cursor >= len(lines):
            output.append(opening)
            index += 1
            continue

        closing = lines[cursor].strip()
        candidate = (
            opening.rstrip()[:-1]
            + "["
            + ", ".join(values)
            + "]"
            + ("," if closing == "]," else "")
        )
        if len(candidate) > 100:
            output.append(opening)
            index += 1
            continue
        output.append(candidate)
        index = cursor + 1

    return "\n".join(output) + "\n"


def render_fixture() -> str:
    fixture = build_fixture()
    validate_fixture(fixture)
    rendered = json.dumps(fixture, ensure_ascii=False, indent=2) + "\n"
    return collapse_short_primitive_arrays(rendered)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if the checked-in fixture does not match the generator",
    )
    args = parser.parse_args()

    rendered = render_fixture()
    if args.check:
        if (
            not FIXTURE_PATH.exists()
            or FIXTURE_PATH.read_text(encoding="utf-8") != rendered
        ):
            print(
                f"{FIXTURE_PATH} is stale; regenerate with:\n  {REGENERATE_COMMAND}",
                file=sys.stderr,
            )
            return 1
        print(f"wire vectors are current: {FIXTURE_PATH}")
        return 0

    FIXTURE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE_PATH.write_text(rendered, encoding="utf-8")
    fixture = json.loads(rendered)
    print(
        f"wrote {len(fixture['messages'])} messages and "
        f"{len(fixture['toolPayloads'])} tool payloads to {FIXTURE_PATH}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
