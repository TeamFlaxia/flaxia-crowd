# Mobile node lifecycle and load policy

The node follows browser lifecycle and network state while it has an active consent grant:

- A hidden tab, page hide, or offline event closes signaling and terminates the worker. A visible, restored, or online event reconnects only after the combined state is usable.
- Slow `2g` links and `Save-Data` reduce the CPU-load ceiling for new tasks to at most `0.45`. A low battery (25% or less while not charging) applies the same ceiling.
- The Battery Status API is optional. When available, critical charge (8% or less while not charging) suspends work; missing or rejected battery APIs do not block node startup.
- Consent revocation still disconnects the node and removes lifecycle listeners. A slow-network or low-battery change affects future task admission; a critical battery, page hide, or offline state stops current local execution and lets Coordinator retry/release its attempt.

These browser signals are local hints and vary by platform. They do not replace explicit model-download consent, resource probing, Coordinator deadlines, or task reservations. The repository tests simulate browser events and policy inputs; real iOS/Android background and battery behavior still needs device testing.
