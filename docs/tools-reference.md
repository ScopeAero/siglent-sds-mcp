# Tools Reference

## Connection

### `connect`

Connect to a Siglent oscilloscope over TCP. Returns device identification on success.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `host` | string | No | `SIGLENT_IP` env var | IP address of the oscilloscope |
| `port` | number | No | `5025` | TCP port |

### `disconnect`

Disconnect from the oscilloscope. No parameters.

### `identify`

Query the oscilloscope identification (`*IDN?`). Returns manufacturer, model, serial number, and firmware version. No parameters.

---

## Channel

### `get_channel`

Query the full configuration of an analog channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to query |

Returns: volts/div, offset, coupling, bandwidth limit, trace on/off, probe attenuation, and unit.

### `configure_channel`

Configure an analog channel. Only specified parameters are changed — omitted parameters are left untouched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to configure |
| `vdiv` | string | No | Volts per division with unit (e.g. `500mV`, `1V`, `2V`). Range: 500uV–10V |
| `offset` | string | No | Vertical offset with unit (e.g. `0V`, `-500mV`, `1.5V`) |
| `coupling` | enum | No | Coupling mode (see table below) |
| `bandwidth_limit` | boolean | No | Enable (`true`) or disable (`false`) 20 MHz bandwidth limit |
| `trace` | boolean | No | Turn channel display on (`true`) or off (`false`) |
| `probe` | number | No | Probe attenuation factor (1, 10, 100, 1000) |

**Coupling modes:**

| Value | Description |
|-------|-------------|
| `A1M` | AC, 1 MOhm |
| `A50` | AC, 50 Ohm |
| `D1M` | DC, 1 MOhm |
| `D50` | DC, 50 Ohm |
| `GND` | Ground |

---

## Acquisition

### `configure_acquisition`

Control the acquisition state and configure timebase, trigger, memory depth and acquisition mode. All parameters are optional — combine as needed in a single call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | enum | No | `run` (ARM), `stop`, `single`, `auto` |
| `timebase` | string | No | Time per division with unit (e.g. `1US`, `500NS`, `10MS`). Range: 1NS–100S |
| `trigger_mode` | enum | No | `AUTO`, `NORM`, `SINGLE`, `STOP` |
| `trigger_source` | enum | No | `C1`, `C2`, `C3`, `C4`, `EX`, `EX5` |
| `trigger_level` | string | No | Trigger level voltage (e.g. `1.5V`, `500mV`) |
| `trigger_slope` | enum | No | `POS` (rising), `NEG` (falling), `WINDOW` |
| `trigger_delay` | string | No | Horizontal position (e.g. `0S`, `-4.8US`) |
| `memory_depth` | string | No | Maximum memory depth (`MSIZ`): `14K`, `140K`, `1.4M`, `14M` (or `7K`…`7M` with one channel per ADC). Deeper means a longer record at a higher sample rate, but a slower download |
| `acquire_mode` | enum | No | `SAMPLING` (normal), `PEAK_DETECT`, `AVERAGE`, `HIGH_RES` |
| `average_count` | number | No | Averages for `AVERAGE` mode: 4, 16, 32, 64, 128, 256, … |

### `get_acquisition_status`

Query the current acquisition state. No parameters.

Returns: acquisition status, sample rate, memory depth, acquisition mode, timebase, trigger delay, trigger mode, trigger select, trigger level, and trigger slope.

---

## Measurement

### `measure`

Install a measurement on a channel and read the result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to measure |
| `parameter` | enum | Yes | Measurement type (see table below) |

### `measure_statistics`

Control measurement statistics — enable, disable, reset, or read statistical values (current, mean, min, max, std-dev, count).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel to measure |
| `parameter` | enum | Yes | Measurement type |
| `action` | enum | Yes | `on`, `off`, `reset`, `read` |

**Measurement types:**

| Value | Description |
|-------|-------------|
| `PKPK` | Peak-to-peak voltage |
| `MAX` | Maximum voltage |
| `MIN` | Minimum voltage |
| `AMPL` | Amplitude |
| `TOP` | Top voltage |
| `BASE` | Base voltage |
| `MEAN` | Mean voltage |
| `CMEAN` | Cycle mean |
| `RMS` | RMS voltage |
| `CRMS` | Cycle RMS |
| `OVSN` | Negative overshoot |
| `OVSP` | Positive overshoot |
| `FPRE` | Fall preshoot |
| `RPRE` | Rise preshoot |
| `FREQ` | Frequency |
| `PER` | Period |
| `PWID` | Positive pulse width |
| `NWID` | Negative pulse width |
| `RISE` | Rise time |
| `FALL` | Fall time |
| `WID` | Width |
| `DUTY` | Positive duty cycle |
| `NDUTY` | Negative duty cycle |
| `ALL` | All measurements |

---

## Waveform

### `get_waveform`

Download waveform data from a channel. Returns reconstructed voltage and time arrays.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | — | Channel to download from |
| `max_points` | number | No | `1000` | Maximum data points to return. Higher values give more detail but use more context. |

Returns a JSON object with:
- `total_points` / `returned_points` — raw count vs. downsampled count
- `sample_rate`, `timebase`, `volts_per_div`, `offset` — acquisition parameters
- `time_range` — start/end times
- `voltage_range` — min/max voltages
- `data` — array of `{time, voltage}` objects

### `screenshot`

Capture the oscilloscope screen as a PNG image. Returns a base64-encoded image that Claude can display inline. No parameters.

---

## Capture

### `capture`

Arm a single-shot acquisition, wait for the trigger, and download one or more channels from that same acquisition, so they're time-aligned. Returns per-channel statistics rather than raw points, which keeps responses small. Leaves the scope stopped on the captured record.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channels` | array of `C1`–`C4` | Yes | — | Channels to download, e.g. `["C1","C2"]` |
| `arm` | boolean | No | `true` | Arm a new single acquisition and wait for it. `false` reads the record already in memory |
| `timeout_s` | number | No | `5` | How long to wait for a trigger. On timeout the scope is stopped and an error returned |
| `save_csv` | string | No | — | Write `time_s` plus one column per channel, at full resolution, to this new `.csv` file. Existing files are never overwritten |

Returns `sample_rate`, `points`, `time_start_s`/`time_end_s` (relative to the trigger), and for each channel `min`, `max`, `pkpk`, `mean` and `rms`. When `save_csv` is set, `csv` holds the absolute path written.

Triggering is detected from `INR?` bit 0 (new acquisition), or `SAST?` returning to `Stop` after being armed.

---

## CAN Bus

These tools analyse CAN traffic from the analog waveform on a channel probing CAN_H, CAN_L, or the differential signal. The SDS1000X-E's own decoder can't return frames over SCPI. Set the timebase so a capture holds several frames (1–2 ms/div is a good start) with at least ~10 samples per bit.

### `detect_can_baud`

Measure the bus bit rate from edge timing and match it to a standard rate (10k, 20k, 33.333k, 50k, 62.5k, 83.333k, 100k, 125k, 250k, 500k, 800k, 1M; matched within ±2%).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | Channel probing the bus |
| `arm` | boolean | No | Arm a fresh single acquisition first (default: analyse the record in memory) |
| `apply_to_decoder` | `B1` \| `B2` | No | Configure this scope decode bus (already set to CAN) for the channel at the detected rate and turn decode on |

Returns `measured_baud`, `standard_baud` and `error_from_standard_pct`, plus:
- `confidence` (`high`/`medium`/`low`), `residual_bits_rms`, `samples_per_bit`, `frames_seen`
- signal levels, and `probable_signal` (CAN_H/differential if the bus idles low, CAN_L if it idles high)
- `warnings` (e.g. too few samples per bit or too few frames)

### `can_decode`

Decode classic CAN 2.0A/B frames (11- and 29-bit IDs, remote frames, CRC check) from one capture.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | — | Channel probing the bus |
| `baud` | number | No | measured | Known bit rate (5000–1000000) |
| `arm` | boolean | No | `false` | Arm a fresh single acquisition first |
| `max_frames` | number | No | `50` | Frames to list; the counts cover all of them |

Returns the bit rate used, frame and error counts, a count per ID, and a list of frames: `t_ms` (relative to the trigger), `id`, `dlc` and `data`. Frames also carry `rtr`, `acked: false` or `error` where they apply. Error kinds are `stuff`, `form`, `crc`, `fd` (CAN FD, not decoded) and `truncated` (cut off at the record boundary).

### `can_monitor_start`

Start a background monitoring session. The server repeatedly arms a single shot, waits for a start-of-frame, downloads the record, measures the bit rate, decodes frames, and accumulates per-ID statistics. Only one session runs at a time.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `channel` | `C1` \| `C2` \| `C3` \| `C4` | Yes | — | Channel probing the bus |
| `signal` | `CAN_H` \| `CAN_L` \| `DIFF` | No | `CAN_H` | What the probe measures; sets the trigger slope (rising/falling/rising) and level (3.0 V / 2.0 V / 0.9 V) |
| `baud` | number | No | measured | Known bit rate; otherwise the median of per-capture estimates is used |
| `duration_s` | number | No | — | Stop automatically after this long |
| `max_captures` | number | No | — | Stop automatically after this many captures |
| `trigger_timeout_s` | number | No | `2` | How long each capture waits for traffic before re-arming |
| `trigger_level` | string | No | per `signal` | Trigger level override, e.g. `3.2V` |
| `configure_trigger` | boolean | No | `true` | Set an edge trigger on the channel, with the trigger one division from the left so most of the record follows it. Previous settings are restored on stop. `false` keeps your trigger |
| `log_csv` | string | No | — | Write every decoded frame to this new `.csv` file (`capture,time_s,id_hex,extended,rtr,dlc,data_hex,crc_ok,acked,error`). Existing files are never overwritten |

### `can_monitor_status`

Return the current summary of a session.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | No | active/latest | Session id (e.g. `can-1`) |
| `recent_frames` | number | No | `0` | Also return the last N decoded frames (max 200) |

The summary contains:
- **Session progress:** `state`, `captures`, `trigger_timeouts`, `live_time_fraction` (share of elapsed time actually captured)
- **`baud`:** measured, matched standard, and percent error
- **`frames`:** decoded OK, errors by kind, unacknowledged, and cut at a capture edge
- **`ids` table:** one row per ID with `count`, `dlc`, latest `data`, `changing` (`X` marks bytes that have changed since first seen) and `period_ms`, the median interval between frames of that ID within the same capture

### `can_monitor_stop`

Stop a session, restore the trigger settings, and return the final summary.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `session` | string | No | active/latest | Session id |

> Monitoring samples the bus rather than logging it losslessly: traffic is missed while each record downloads and is analysed. Counts are therefore partial, but periods are accurate because they're measured within a capture.

---

## SCPI Escape Hatch

For commands not covered by the built-in tools, send arbitrary SCPI directly.

### `scpi_query`

Send a SCPI query and return the response.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | string | Yes | — | SCPI query (e.g. `*IDN?`, `C1:VDIV?`, `SARA?`) |
| `timeout_ms` | number | No | `2000` | Response timeout in milliseconds |

> Note: `CHDR` is set to `OFF` on connect, so responses contain only values (no command headers).

### `scpi_command`

Send a SCPI command with no response expected.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | Yes | SCPI command (e.g. `*RST`, `ARM`, `C1:VDIV 500mV`) |
