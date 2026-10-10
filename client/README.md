# Orbit client

Orbit is a native Qt client built from a pinned Moonlight engine. It uses the engine's existing device certificate pairing, hardware video decoding, input transport, and audio. It does not embed a browser or Electron.

`../scripts/apply-client.py` applies Orbit's interface and defaults to `../vendor/moonlight`. Changes are kept as reproducible overlays in this directory rather than silently modifying the upstream submodule. Run the script after initializing recursive submodules. The private repository contains all Orbit modifications; upstream license notices remain intact.

The initial stream profile requests 1080p / 120 fps with automatic hardware decoding. Actual performance depends on the host, display refresh rate and network. Settings remain adjustable. One monitor streams at a time. Switch host displays using Ctrl+Alt+Shift+F1 through F12 (Mac: Control+Option+Shift+F-key, optionally Fn). Simultaneous monitor streams are not implemented.
