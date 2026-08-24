"""GroundlinkSearchTool — a LangChain tool that returns verified, cited web-search results.

Thin wrapper around the Groundlink API (``POST /api/v1/ground``). Groundlink
combines Wikipedia + DuckDuckGo results and returns each result with a
``title``, ``url``, ``snippet`` and ``source`` so an LLM can answer from
evidence instead of guessing.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Type

import requests
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, field_validator

DEFAULT_BASE_URL = "https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app"
GROUND_ENDPOINT = "/api/v1/ground"
TRIAL_ENDPOINT = "/api/v1/trial"
DEFAULT_MAX_RESULTS = 5
MAX_RESULTS_CAP = 10
DEFAULT_TIMEOUT_SECONDS = 30


class GroundlinkSearchInput(BaseModel):
    """Schema for the Groundlink search tool arguments."""

    query: str = Field(description="The search query to ground. Ask for factual, "
                                   "verifiable information; the tool returns cited sources.")
    max_results: Optional[int] = Field(
        default=None,
        description="Maximum number of cited results to return (1-10). Defaults to 5.",
        ge=1,
        le=10,
    )

    @field_validator("query")
    @classmethod
    def _query_not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("query must be a non-empty string")
        return v.strip()


class GroundlinkAPIError(RuntimeError):
    """Raised when the Groundlink API returns a non-200 status.

    Attributes:
        status_code: the HTTP status returned by the API.
        code: the machine-readable error code from the API body (if any).
    """

    def __init__(self, status_code: int, message: str, code: Optional[str] = None):
        self.status_code = status_code
        self.code = code
        super().__init__(message)


class GroundlinkSearchTool(BaseTool):
    """A LangChain tool that returns verified, cited results for a query.

    Uses the Groundlink API. Every result carries ``title``, ``url``,
    ``snippet`` and ``source``. Results are returned as readable text lines so
    an agent can cite the URLs in its answer.

    Provide an API key via the ``api_key`` argument or the ``GROUNDLINK_API_KEY``
    environment variable. Each key starts with 100 free test queries; after that
    usage is metered (standard $0.001/query).
    """

    name: str = "groundlink_search"
    description: str = (
        "Search the web and return verified, cited results (title, url, snippet, "
        "source) to ground a factual answer. Use this for any question where you "
        "should give an answer backed by real sources and URLs rather than "
        "guessing. Input: a query string, optionally a max_results (1-10)."
    )
    args_schema: Type[BaseModel] = GroundlinkSearchInput

    api_key: str = Field(description="Groundlink API key.")
    base_url: str = Field(default=DEFAULT_BASE_URL, description="Groundlink base URL (override for testing).")
    timeout: int = Field(default=DEFAULT_TIMEOUT_SECONDS, ge=1)

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: Optional[int] = None,
        **kwargs: Any,
    ) -> None:
        """Initialize the tool.

        Args:
            api_key: Groundlink API key (``glk_...``). Falls back to the
                ``GROUNDLINK_API_KEY`` environment variable. Exactly one must
                be available.
            base_url: Override the Groundlink endpoint (for testing or a
                compatible deployment). Defaults to the live Groundlink URL.
            timeout: Request timeout in seconds.
        """
        resolved_key = api_key or os.environ.get("GROUNDLINK_API_KEY")
        if not resolved_key:
            raise ValueError(
                "No Groundlink API key provided. Pass api_key=... or set the "
                "GROUNDLINK_API_KEY environment variable. Get a free trial key "
                "for testing via GroundlinkSearchTool.get_trial_key() or the "
                "live /docs page."
            )
        kwargs.setdefault("api_key", resolved_key)
        if base_url is not None:
            kwargs.setdefault("base_url", base_url.rstrip("/"))
        if timeout is not None:
            kwargs.setdefault("timeout", timeout)
        super().__init__(**kwargs)

    def _run(self, query: str, max_results: Optional[int] = None) -> str:
        """Execute a search and return a readable list of cited results."""
        url = self.base_url + GROUND_ENDPOINT
        payload: Dict[str, Any] = {"query": query}
        if max_results is not None:
            payload["max_results"] = max(
                1, min(MAX_RESULTS_CAP, int(max_results))
            )
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=self.timeout)
        except requests.RequestException as exc:  # network/timeout
            raise GroundlinkAPIError(0, f"Network error calling Groundlink: {exc}") from exc

        if resp.status_code != 200:
            self._raise_for_status(resp)

        data = resp.json()
        results: List[Dict[str, Any]] = data.get("results", [])
        if not results:
            return "No results found."

        lines = []
        for i, item in enumerate(results, start=1):
            title = item.get("title", "").strip()
            url = item.get("url", "").strip()
            snippet = (item.get("snippet") or "").strip()
            source = (item.get("source") or "").strip()
            entry = f"{i}. "
            if title:
                entry += title
            if url:
                entry += f"\n   URL: {url}"
            if snippet:
                entry += f"\n   Snippet: {snippet}"
            if source:
                entry += f"\n   Source: {source}"
            lines.append(entry)
        return "\n\n".join(lines)

    async def _arun(self, query: str, max_results: Optional[int] = None) -> str:
        """Async variant of :meth:`_run`. Groundlink calls are short; the sync
        implementation is reused to avoid double network connections."""
        import asyncio
        return await asyncio.to_thread(self._run, query, max_results)

    def _raise_for_status(self, resp: requests.Response) -> None:
        """Build a clear, actionable error for non-200 responses."""
        status = resp.status_code
        code = None
        message = None
        try:
            body = resp.json()
            err = body.get("error", {}) if isinstance(body, dict) else {}
            code = err.get("code")
            message = err.get("message")
        except Exception:
            pass

        if status == 401:
            message = message or "Invalid or missing API key. Check your GROUNDLINK_API_KEY."
        elif status == 402:
            message = (
                message
                or "Insufficient credits: the free allowance is exhausted and no "
                "prepaid credits remain. Add credits to continue."
            )
        elif status == 400:
            message = message or "Invalid request (bad query or max_results)."
        elif status == 502:
            message = message or "Groundlink search sources are temporarily unavailable."
        else:
            message = message or f"Groundlink API returned HTTP {status}."

        raise GroundlinkAPIError(status, message or f"Groundlink API error (HTTP {status}).", code)

    @classmethod
    def get_trial_key(cls, base_url: Optional[str] = None, timeout: Optional[int] = None) -> Dict[str, Any]:
        """Opt-in helper: mint a free trial key from the live API.

        Only call this if you explicitly want a fresh 100-query trial key. In
        production you should provide your own key (constructor / env var).
        There are per-IP and global caps on trial keys, so do not call this in
        a loop or inside a serving path.
        """
        url = (base_url or DEFAULT_BASE_URL).rstrip("/") + TRIAL_ENDPOINT
        try:
            resp = requests.post(url, timeout=timeout or DEFAULT_TIMEOUT_SECONDS)
        except requests.RequestException as exc:
            raise GroundlinkAPIError(0, f"Network error requesting trial key: {exc}") from exc
        if resp.status_code != 200:
            try:
                body = resp.json()
                err = body.get("error", {}) if isinstance(body, dict) else {}
                code = err.get("code")
                message = err.get("message")
            except Exception:
                code, message = None, None
            raise GroundlinkAPIError(resp.status_code, message or f"Trial key request failed (HTTP {resp.status_code}).", code)
        return resp.json()


TrialKeyResponse = Dict[str, Any]


__all__ = [
    "DEFAULT_BASE_URL",
    "GroundlinkAPIError",
    "GroundlinkSearchInput",
    "GroundlinkSearchTool",
]
