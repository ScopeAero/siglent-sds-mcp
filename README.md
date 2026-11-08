# siglent-sds-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that lets AI assistants control Siglent oscilloscopes over your local network. Connect Claude to your bench and measure, capture, and configure your scope through natural language.

## Overview

This MCP server communicates with Siglent SDS oscilloscopes via SCPI commands over TCP sockets (port 5025). No VISA drivers or NI-MAX installation required — just a network connection to your scope.

![Oscilloscope screenshot captured via MCP](docs/screenshot-scope.png)

*Oscilloscope display captured through the `screenshot` MCP tool.*

![MCP interaction in terminal](docs/screenshot-terminal.png)

*Natural-language scope control and measurement workflow in the terminal.*

**Key features:**

- 19 tools covering channels, timebase, triggers, measurements, waveform capture, CAN bus analysis, and screenshots
- Arm-and-wait single-shot capture of one or more channels from the same trigger, summarised server-side (full-resolution CSV on request)
- CAN bus bit-rate detection and frame decoding from the analog waveform, plus background monitoring sessions that return per-ID statistics instead of raw data
- Auto-connect on startup via environment variable
- Query queue serializes commands automatically — tools can safely run in parallel
- Waveform data returned as voltage/time arrays ready for analysis
- Screenshots captured and converted to PNG for inline display in Claude
- Raw SCPI escape hatch for any command not covered by the built-in tools

## Compatibility

| Status | Model |
|--------|-------|
| Tested | SDS1104X-E |
| Expected to work | SDS1000X-E series (SDS1202X-E, SDS1204X-E, etc.) |
| May work | Other Siglent SDS models with SCPI over TCP support |

The server uses standard SCPI commands from the [SDS1000X-E Programming Guide](https://siglentna.com/wp-content/uploads/dlm_uploads/2017/10/ProgrammingGuide_forSDS-1702.pdf). Other Siglent models that support the same command set over port 5025 should work with little or no modification.

## Quick Start

You need a Siglent oscilloscope accessible on your network (TCP port 5025). Pick one of the three options below and add the config to your `.mcp.json` (in your project directory, or `~/.claude/.mcp.json` for global access).

Replace `192.168.1.126` with your scope's IP address.

> **Note:** This is the [ScopeAero fork](https://github.com/ScopeAero/siglent-sds-mcp). The published Docker image and npm package in options A and B come from the [upstream project](https://github.com/MagnusJohansson/siglent-sds-mcp) and don't include this fork's additions (capture, CAN tools). Use **Option C**, or build the Docker image locally (see [Development](#docker-local-build)).

### Option A: Docker (recommended)

No Node.js installation required. Works on Linux, macOS, and Windows (via WSL2 or Docker Desktop).

```json
{
  "mcpServers": {
    "siglent-sds": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "ghcr.io/magnusjohansson/siglent-sds-mcp:latest"
      ]
    }
  }
}
```

### Option B: npx

Requires Node.js 20+. Downloads and runs the package automatically.

```json
{
  "mcpServers": {
    "siglent-sds": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "siglent-sds-mcp"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

### Option C: Clone and build

```bash
git clone https://github.com/ScopeAero/siglent-sds-mcp.git
cd siglent-sds-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "siglent-sds": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/siglent-sds-mcp/build/index.js"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

Replace `/path/to/siglent-sds-mcp` with the actual path to your clone.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SIGLENT_IP` | No | — | Oscilloscope IP address for auto-connect on startup |
| `SIGLENT_PORT` | No | `5025` | TCP port (only change if your setup differs) |
| `SIGLENT_IDLE_TIMEOUT` | No | `0` (never) | Seconds of inactivity after which the scope connection is released. The next tool call reconnects automatically. |

### Auto-Connect Behavior

If `SIGLENT_IP` is set, the server attempts to connect to the scope immediately after starting. This runs in the background and does **not** block the MCP server — Claude can start using other tools right away. If the scope is offline or unreachable, the server logs a warning and you can connect manually later using the `connect` tool.

If `SIGLENT_IP` is not set, the server starts without a scope connection. Use the `connect` tool to connect when ready.

If the connection is closed (by the idle timeout, or the scope restarting), the next tool call reconnects automatically to the last host. An explicit `disconnect` turns this off until `connect` is called again.

### One Client at a Time

The scope serves a single TCP client on port 5025. A second client can open the socket but gets no replies, so the server reports that the scope is probably in use by another program. If more than one MCP client uses the same scope, set `SIGLENT_IDLE_TIMEOUT` (e.g. `60`) in each so an idle server releases the scope for the other.

## Using with Other AI Clients

The Quick Start examples above use Claude Code's `.mcp.json` format, which includes a `"type": "stdio"` field. Other AI clients use the same JSON structure but **without** the `"type"` field and with different config file locations.

### Claude Desktop

Edit `claude_desktop_config.json`:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

#### Docker

```json
{
  "mcpServers": {
    "siglent-sds": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "ghcr.io/magnusjohansson/siglent-sds-mcp:latest"
      ]
    }
  }
}
```

#### npx

```json
{
  "mcpServers": {
    "siglent-sds": {
      "command": "npx",
      "args": ["-y", "siglent-sds-mcp"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

> **Note:** You must fully restart Claude Desktop after changing the config file.

### Cursor

Edit one of:

- **User-level:** `~/.cursor/mcp.json` (available across all projects)
- **Project-level:** `.cursor/mcp.json` (shared with your team via version control)

You can also add servers through the UI: **Settings > Cursor Settings > MCP > Add new global MCP server**.

#### Docker

```json
{
  "mcpServers": {
    "siglent-sds": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "ghcr.io/magnusjohansson/siglent-sds-mcp:latest"
      ]
    }
  }
}
```

#### npx

```json
{
  "mcpServers": {
    "siglent-sds": {
      "command": "npx",
      "args": ["-y", "siglent-sds-mcp"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

### Windsurf

Edit `mcp_config.json`:

- **Windows:** `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- **macOS/Linux:** `~/.codeium/windsurf/mcp_config.json`

You can also configure servers through the UI: **Cascade panel > MCP icon > Manage MCP Servers > View raw config**.

#### Docker

```json
{
  "mcpServers": {
    "siglent-sds": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "ghcr.io/magnusjohansson/siglent-sds-mcp:latest"
      ]
    }
  }
}
```

#### npx

```json
{
  "mcpServers": {
    "siglent-sds": {
      "command": "npx",
      "args": ["-y", "siglent-sds-mcp"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

### Google Antigravity

Configuration is managed through the IDE's UI:

1. Open the **Agent pane** on the right side of the workspace
2. Click the **`...`** button at the top
3. Select **MCP Servers**
4. Click **Manage MCP Servers**
5. Click **View raw config**
6. Add the configuration below and save

#### Docker

```json
{
  "mcpServers": {
    "siglent-sds": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "ghcr.io/magnusjohansson/siglent-sds-mcp:latest"
      ]
    }
  }
}
```

#### npx

```json
{
  "mcpServers": {
    "siglent-sds": {
      "command": "npx",
      "args": ["-y", "siglent-sds-mcp"],
      "env": {
        "SIGLENT_IP": "192.168.1.126"
      }
    }
  }
}
```

Replace `192.168.1.126` with your scope's IP address in all examples above.

### ChatGPT Desktop

ChatGPT Desktop only supports remote HTTPS MCP servers (called "connectors"), not local stdio servers. Since this MCP server uses stdio transport, it is not directly compatible with ChatGPT Desktop.

## Tools

19 tools across 8 categories. See [docs/tools-reference.md](docs/tools-reference.md) for full parameter details.

| Category | Tool | Description |
|----------|------|-------------|
| Connection | `connect` | Connect to oscilloscope over TCP |
| | `disconnect` | Close the connection |
| | `identify` | Query device ID (manufacturer, model, serial, firmware) |
| Channel | `get_channel` | Read channel configuration (vdiv, offset, coupling, etc.) |
| | `configure_channel` | Set vdiv, offset, coupling, bandwidth limit, trace, probe |
| Acquisition | `get_acquisition_status` | Read timebase, sample rate, memory depth, acquisition mode, trigger settings |
| | `configure_acquisition` | Set timebase, trigger, memory depth, acquisition mode, run/stop/single |
| Measurement | `measure` | Read a measurement (frequency, Vpp, RMS, etc.) |
| | `measure_statistics` | Enable/read/reset measurement statistics |
| Waveform | `get_waveform` | Download voltage/time data arrays |
| | `screenshot` | Capture scope screen as PNG |
| Capture | `capture` | Arm a single shot, wait for the trigger, summarise one or more channels (optional CSV) |
| CAN | `detect_can_baud` | Measure the bus bit rate and match it to a standard rate |
| | `can_decode` | Decode CAN 2.0A/B frames from one capture |
| | `can_monitor_start` | Start a background capture-and-decode session |
| | `can_monitor_status` | Per-ID summary (count, period, data, changing bytes) of the session |
| | `can_monitor_stop` | Stop the session, restore the trigger, return the final summary |
| SCPI | `scpi_query` / `scpi_command` | Send arbitrary SCPI commands |

## Example Conversations

### Read a channel configuration

> **You:** What's the current setup on channel 1?
>
> Claude calls `get_channel` with `channel: "C1"` and returns the volts/div, offset, coupling, and other settings.

### Measure a signal

> **You:** Measure the frequency and peak-to-peak voltage on channel 2.
>
> Claude calls `measure` twice — once with `parameter: "FREQ"` and once with `parameter: "PKPK"` on channel C2 — and reports both values.

### Capture and analyze a waveform

> **You:** Download the waveform from channel 1 and tell me what you see.
>
> Claude calls `get_waveform` on C1, receives voltage/time data, and analyzes the signal shape, frequency, amplitude, and any anomalies.

### Take a screenshot

> **You:** Show me what the scope screen looks like right now.
>
> Claude calls `screenshot`, receives a base64 BMP image, and displays it inline.

### Capture two channels from the same trigger

> **You:** Grab a single shot of C1 and C2 and save it so I can look at it in Python.
>
> Claude calls `capture` with `channels: ["C1","C2"]` and `save_csv: "capture.csv"`, gets back min/max/mean/RMS per channel, and the full-resolution data lands in the CSV.

### Identify an unknown CAN bus

> **You:** There's a CAN bus on C2 (CAN_H). What's the bit rate, and what's on it?
>
> Claude calls `can_monitor_start` with `channel: "C2"`, waits, then calls `can_monitor_status`. The server has measured the bit rate (e.g. 500 kbit/s, +0.03%) and decoded the traffic into a table of IDs with counts, periods, latest data and which bytes change. `can_monitor_stop` ends the session and restores the trigger settings.

### Configure the scope for a specific measurement

> **You:** Set up channel 1 for a 3.3V logic signal — DC coupling, 1V/div, trigger on the rising edge at 1.6V.
>
> Claude calls `configure_channel` (setting vdiv, coupling) and `configure_acquisition` (setting trigger source, level, slope) in sequence.

## CAN Bus Analysis

The SDS1000X-E's protocol decoder can't return decoded frames over SCPI, so the CAN tools work from the raw analog waveform instead. Probe CAN_H, CAN_L, or the differential signal on any analog channel.

- **Bit-rate detection** times every edge, then fits a bit time to the intervals between edges of the *same* polarity. Those intervals are always a whole number of bits and cancel the skew from CAN's slow passive dominant→recessive edge. The result is the actual rate (e.g. 126.25 kbit/s for a node running 1% fast), matched to the nearest standard rate within ±2% (10k, 20k, 33.333k, 50k, 62.5k, 83.333k, 100k, 125k, 250k, 500k, 800k, 1M).
- **Decoding** handles 11-bit and 29-bit IDs, remote frames, bit destuffing and CRC-15 checking, and reports stuff, form and CRC errors. CAN FD frames are detected but not decoded.
- **Monitoring sessions** run inside the server: arm → wait for a start-of-frame → download → measure → decode → accumulate, repeated until stopped. The AI only sees the summary. The session sets an edge trigger on the channel (rising for CAN_H/differential, falling for CAN_L) and restores the previous trigger settings when it stops.

**Setup tips:** choose a timebase that fits several frames in one capture (1–2 ms/div is a good start) with at least ~10 samples per bit (10 MSa/s for 1 Mbit/s). Monitoring samples the bus rather than logging it losslessly — traffic is missed while each capture downloads. `live_time_fraction` in the summary reports how much bus time was observed, and message periods are measured only between frames inside the same capture, so they're accurate even though counts are partial.

## Architecture

```
Claude Code <-- stdio/JSON-RPC --> siglent-sds-mcp <-- TCP/SCPI --> Oscilloscope:5025
```

- **Transport:** MCP over stdio (JSON-RPC 2.0)
- **Protocol:** SCPI commands over raw TCP sockets, newline-terminated
- **Query Queue:** All SCPI queries are serialized through an internal queue. The oscilloscope processes one command at a time, so even when tools issue parallel requests (via `Promise.all`), the queue ensures they're sent sequentially.
- **Binary Block Parsing:** Waveform and screenshot data use IEEE 488.2 definite-length block format (`#9XXXXXXXXX` + data bytes + `\n\n`). The connection layer detects and parses these automatically.
- **Voltage Reconstruction:** Raw ADC codes are converted to voltages: `code * (vdiv / 25) - offset`, with two's complement handling for signed values.

## Development

```bash
npm run build       # Compile TypeScript
npm run watch       # Watch mode — recompile on changes
npm run dev         # Build and run
npm run inspector   # Launch with MCP Inspector for debugging
```

### Docker (local build)

Build the image locally:

```bash
docker build -t siglent-sds-mcp .
```

Then use the local image in your `.mcp.json`:

```json
{
  "mcpServers": {
    "siglent-sds": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "SIGLENT_IP=192.168.1.126",
        "siglent-sds-mcp"
      ]
    }
  }
}
```

### Project Structure

```
src/
  index.ts              # Entry point, MCP server setup
  connection.ts         # TCP socket manager with query queue
  tools/
    connection.ts       # connect, disconnect, identify
    channel.ts          # get_channel, configure_channel
    acquisition.ts      # configure_acquisition, get_acquisition_status
    measure.ts          # measure, measure_statistics
    waveform.ts         # get_waveform, screenshot, captureWaveform helper
    capture.ts          # capture (arm-and-wait, multi-channel)
    can.ts              # detect_can_baud, can_decode, can_monitor_*
    scpi.ts             # scpi_query, scpi_command
  acquire.ts            # armAndWait: single-shot arm and trigger wait
  can-monitor.ts        # Background CAN monitoring session
  analysis/
    can-baud.ts         # Edge extraction, bit-rate estimation, standard-rate matching
    can-decode.ts       # CAN 2.0A/B frame decoder
```

## Troubleshooting

### "Not connected to oscilloscope"

The scope isn't connected yet. Either set `SIGLENT_IP` in your `.mcp.json` env for auto-connect, or use the `connect` tool manually.

### Connection timeout

- Verify the scope's IP address (check the scope's Utility > Interface menu)
- Ensure port 5025 is accessible (try `telnet <scope-ip> 5025` from your machine)
- Check that no firewall is blocking the connection
- The scope only accepts one TCP connection at a time — close any other SCPI clients

### Query timeout

Some SCPI queries can take a few seconds, especially on slower scope models. The default timeout is 5 seconds. For `scpi_query`, you can increase the timeout with the `timeout_ms` parameter.

### Docker: can't reach the oscilloscope

By default, Docker containers can reach LAN devices via the bridge network (NAT). If the container can't connect to your scope:

- Verify the scope is reachable from your host: `telnet 192.168.1.126 5025`
- On Linux, try adding `--network host` to the Docker args:
  ```json
  "args": ["run", "--rm", "-i", "--network", "host", "-e", "SIGLENT_IP=192.168.1.126", "ghcr.io/magnusjohansson/siglent-sds-mcp:latest"]
  ```
  Note: `--network host` does not work on macOS or Windows Docker Desktop.

### Docker: wrong architecture / exec format error

The published image supports `linux/amd64` and `linux/arm64`. Docker should pull the correct one automatically. If you see an exec format error, pull explicitly:

```bash
docker pull --platform linux/amd64 ghcr.io/magnusjohansson/siglent-sds-mcp:latest
```

### "CHDR" appears in responses

This shouldn't happen — the server sets `CHDR OFF` on connect. If you see command headers in responses, try disconnecting and reconnecting.

## License

MIT — see [LICENSE](LICENSE) for details.
