# ccdbg

Local analyzer for Claude Code session data. Ingests your `~/.claude` session logs and serves a web UI showing token usage, cache efficiency, cost trends, and context growth across all your projects.

## Install

**curl installer:**
```sh
curl -fsSL https://raw.githubusercontent.com/jondot/ccdbg/main/install.sh | sh
```

**npm:**
```sh
npm install -g @ccdbg/cli
```

**cargo:**
```sh
cargo install ccdbg
```

## Usage

```sh
ccdbg          # ingest + launch web UI at http://localhost:6677
ccdbg web      # same as above
ccdbg index    # ingest + print insight summary, no UI
ccdbg export out.json  # write full JSON bundle

ccdbg --reindex  # force full re-scan (skip incremental cache)
```

## What it shows

- **Sessions** — all Claude Code sessions, grouped by project, with token counts and cost
- **Detail** — per-session tool call table with context size, model, token cost per turn
- **Profile** — daily usage heatmap, cache hit rate, spending trends
- **Issues** — flagged inefficiencies: cache waste, context bloat, loop detection, model drift

## Data

Reads `~/.claude` (or `$CLAUDE_HOME`). Nothing is uploaded or sent anywhere. All analysis runs locally.

## License

MIT
