# OpenClaw ↔ Hermes Bridge

HTTP bridge server that connects the OpenClaw AI Assistant framework with the Hermes runtime environment.

## Overview

This service acts as a communication bridge, exposing an HTTP API for task dispatching and result retrieval between OpenClaw agents and Hermes subprocesses.

## Quick Start

```bash
# Set environment variables (optional)
export HERMES_BRIDGE_PORT=3002
export HERMES_BIN=$HOME/.local/bin/hermes
export HERMES_BRIDGE_TIMEOUT_MS=600000

# Start the bridge
node server.cjs
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /task | Submit a new task to Hermes |
| GET | /task/:id | Get task status and result |
| GET | /tasks | List all tasks |
| DELETE | /task/:id | Cancel a running task |
| GET | /health | Health check |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HERMES_BRIDGE_PORT` | `3002` | HTTP server port |
| `HERMES_BIN` | `~/.local/bin/hermes` | Path to Hermes binary |
| `HERMES_BRIDGE_TIMEOUT_MS` | `600000` (10 min) | Default task timeout |

## Architecture

- **Task Queue**: Tasks are stored as JSON files in `shared-tasks/`
- **Logging**: Request/response logs written to `logs/`
- **Hermes Communication**: Spawns Hermes as a child process, communicates via stdin/stdout
- **No External Dependencies**: Pure Node.js, no npm packages required

## Files

- `server.cjs` — Main HTTP server and bridge logic
- `package.json` — Project metadata (no external dependencies)
- `.gitignore` — Excludes logs and task data
