"""Browser Context Protocol helpers for the companion prototype."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

PROTOCOL_ID = "hermes.browser.context.v1"


@dataclass
class BrowserContextEnvelope:
    protocol: str = PROTOCOL_ID
    payload_hash: str = ""
    scope: str = "unknown"
    active_tab: dict[str, Any] = field(default_factory=dict)
    summary: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any] | None) -> "BrowserContextEnvelope":
        if not isinstance(payload, dict):
            return cls(scope="missing")
        return cls(
            protocol=str(payload.get("protocol") or payload.get("protocolId") or PROTOCOL_ID),
            payload_hash=str(payload.get("payloadHash") or payload.get("payload_hash") or ""),
            scope=str(payload.get("contextScope") or payload.get("scope") or "unknown"),
            active_tab=dict(payload.get("activeTab") or payload.get("active_tab") or {}),
            summary=dict(payload.get("summary") or {}),
        )

    def status(self) -> dict[str, Any]:
        return {
            "available": bool(self.payload_hash),
            "protocol": self.protocol,
            "payload_hash": self.payload_hash,
            "scope": self.scope,
        }
