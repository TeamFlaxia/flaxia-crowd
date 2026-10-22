# Swarm peer link quality

Each WebRTC peer transport samples its adjacent DataChannels every 15 seconds while peer mode is active. It sends one small ping per neighbor per interval and reads `RTCPeerConnection.getStats()`. Sampling stops when relay mode is selected, a peer fails, or the swarm session closes.

The coordinator accepts at most two reports per message and four messages per node per minute. It checks the current task, session, attempt, authenticated socket attachment, and ring adjacency before keeping the latest sample for each directed link. Reports are limited to 4 KiB and expire after 60 seconds. A late or stale sample cannot replace a fresh snapshot.

The wire report keeps two sources separate:

| Group | Values | Meaning |
| --- | --- | --- |
| `webRtc` | `rttMs`, `sendMbps`, `receiveMbps` | Browser WebRTC statistics: selected candidate-pair RTT and available bitrate, with DataChannel counter rates as a fallback |
| `application` | `rttMs`, `jitterMs`, `sendMbps`, `receiveMbps` | Small DataChannel echo RTT and rates of completed hidden-state frames |

All rates use decimal Mbps. Every value carries its sample time and sample count. Missing measurements are `null` with a zero sample count; a measured zero remains `0`. DataChannels do not expose RTP packet jitter, so WebRTC jitter remains unavailable. Application jitter is the absolute change between successive echo RTT samples.

Five recent values are retained per metric. The report uses their median and drops unusually high spikes before smoothing. The measurements are self-reported by an authenticated node and describe a link estimate; they are not proof of peer identity, reserved bandwidth, or a scheduling guarantee.
