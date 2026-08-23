# langchain-groundlink

A [LangChain](https://python.langchain.com/) tool that grounds AI answers with
**verified, cited web-search results** from the [Groundlink API](https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app/docs).
Give it a factual query and it returns results with `title`, `url`, `snippet`
and `source` — so your agent can answer from evidence and cite its sources
instead of hallucinating.

Groundlink combines **Wikipedia** and **DuckDuckGo** results. Each API key
includes **100 free test queries**; after that usage is metered
(**$0.001 / query**).

- Live API docs: https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app/docs
- Pricing & credits: https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app/pricing

## Install

```bash
pip install langchain-groundlink
```

## Quickstart

You need a Groundlink API key (`glk_...`). Get a free trial key from the
[documentation page](https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app/docs),
or ask the Groundlink operator for one. Set it as `GROUNDLINK_API_KEY` or pass
it to the tool.

```python
from langchain_groundlink import GroundlinkSearchTool

tool = GroundlinkSearchTool()  # reads GROUNDLINK_API_KEY, or pass api_key="glk_..."

result = tool.invoke({"query": "Who was Ada Lovelace?"})
print(result)
```

Passing the key explicitly:

```python
tool = GroundlinkSearchTool(api_key="glk_your_key_here")
result = tool.invoke({"query": "What is the capital of Japan?", "max_results": 3})
```

Using it with an agent (via LangGraph or LangChain's agent executor):

```python
from langchain_groundlink import GroundlinkSearchTool
from langchain.agents import create_react_agent, AgentExecutor
from langchain_openai import ChatOpenAI

tools = [GroundlinkSearchTool()]       # or: [GroundlinkSearchTool(api_key="glk_...")]
# ... build your agent with `tools`, letting the LLM call groundlink_search
# whenever it needs real, citable sources.
```

### Output

The tool returns readable lines, one per result:

```
1. Ada Lovelace
   URL: https://en.wikipedia.org/wiki/Ada_Lovelace
   Snippet: Augusta Ada King, Countess of Lovelace (née Byron; 10 December 1815 – ...)
   Source: wikipedia
```

## Getting a trial key programmatically (opt-in)

`get_trial_key()` mints a fresh 100-query trial key from the live API. Use it
only when you explicitly want a throwaway test key — **not** in production or
inside a request/serving path (trial keys are rate-limited and capped). For
real use, always supply your own key.

```python
from langchain_groundlink import GroundlinkSearchTool

resp = GroundlinkSearchTool.get_trial_key()
tool = GroundlinkSearchTool(api_key=resp["key"])
```

## Configuration

| Argument / env var | Meaning |
| --- | --- |
| `api_key` or `GROUNDLINK_API_KEY` | Groundlink API key (`glk_...`). Required (one of the two). |
| `base_url` | Override the API base URL (for testing or a compatible deployment). Defaults to the live Groundlink URL. |
| `timeout` | Request timeout in seconds (default 30). |

## Errors

A non-200 response raises `GroundlinkAPIError` with helpful message and
`status_code`:

- **401** — invalid/missing API key
- **402** — no credits left (free allowance exhausted, no prepaid balance)
- **400** — bad request (empty query, invalid `max_results`)
- **502** — Groundlink search sources temporarily unavailable

```python
from langchain_groundlink import GroundlinkSearchTool, GroundlinkAPIError

tool = GroundlinkSearchTool(api_key="glk_bad")
try:
    tool.invoke({"query": "test"})
except GroundlinkAPIError as exc:
    print(exc.status_code, exc)  # 401 Invalid or missing API key...
```

## Development

```bash
pip install -e ".[dev]"
pytest
```

## License

MIT. See [LICENSE](LICENSE).
