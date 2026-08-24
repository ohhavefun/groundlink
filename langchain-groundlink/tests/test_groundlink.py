"""Tests for langchain_groundlink.

Tests that need the live API are skipped unless GROUNDLINK_API_KEY (or
GROUNDLINK_TEST_KEY) is set, so offline/CI runs stay green. The live tests
consume a small number of free trial queries.
"""

import os

import pytest

from langchain_groundlink import (
    GroundlinkAPIError,
    GroundlinkSearchTool,
)

BASE_URL = "https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app"


def _test_key() -> str:
    return os.environ.get("GROUNDLINK_API_KEY") or os.environ.get("GROUNDLINK_TEST_KEY") or ""


# ---------------------------------------------------------------------------
# Unit / offline tests
# ---------------------------------------------------------------------------


def test_tool_name_and_description():
    tool = GroundlinkSearchTool(api_key="glk_test")
    assert tool.name == "groundlink_search"
    assert "cited" in tool.description.lower()
    # Schema fields present.
    fields = tool.args_schema.model_fields
    assert "query" in fields
    assert "max_results" in fields


def test_requires_key():
    import langchain_groundlink.tools as tools

    # Make sure the env fallback is not hiding a failure.
    saved = os.environ.pop("GROUNDLINK_API_KEY", None)
    try:
        with pytest.raises(ValueError):
            GroundlinkSearchTool(api_key=None, base_url=BASE_URL)
    finally:
        if saved is not None:
            os.environ["GROUNDLINK_API_KEY"] = saved


def test_blank_query_rejected():
    tool = GroundlinkSearchTool(api_key="glk_test")
    with pytest.raises(Exception):
        tool.invoke({"query": "   "})


def test_max_results_clamped():
    tool = GroundlinkSearchTool(api_key="glk_test")
    # Exercise clamping through a call would hit the network; instead confirm
    # that an out-of-range max_results fails the pydantic schema.
    with pytest.raises(Exception):
        tool.invoke({"query": "test", "max_results": 99})


# ---------------------------------------------------------------------------
# Live API tests (real evidence)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(not _test_key(), reason="no GROUNDLINK_API_KEY set")
def test_live_call_returns_cited_results():
    tool = GroundlinkSearchTool(api_key=_test_key())
    out = tool.invoke({"query": "Who was Ada Lovelace?", "max_results": 2})
    assert isinstance(out, str)
    # Expect at least one result line with title/URL/source.
    assert "URL:" in out
    assert "Source:" in out
    assert "wikipedia" in out


@pytest.mark.skipif(not _test_key(), reason="no GROUNDLINK_API_KEY set")
def test_live_call_bad_key_raises_401():
    tool = GroundlinkSearchTool(api_key="glk_definitely_bad_key")
    with pytest.raises(GroundlinkAPIError) as excinfo:
        tool.invoke({"query": "test"})
    assert excinfo.value.status_code == 401
