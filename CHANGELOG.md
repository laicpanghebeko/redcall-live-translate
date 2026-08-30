# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

## [1.6.0] - 2026-08-28

### Added

- Generic translated listening for user-selected Chrome tabs.
- Bidirectional browser audio for Google Meet, Zoom Web, and Telegram Web.
- PKCE account connection and rotating RedCall device sessions.
- Offscreen Web Audio processing and scoped LiveKit transport.
- Fail-closed microphone replacement and explicit original-track restoration.
- Automatic ducking between original and translated tab audio.

### Security

- Kept translation-provider credentials on the server.
- Restricted browser sessions to temporary rooms and named audio tracks.
- Added explicit cleanup for media tracks, audio contexts, timers, and rooms.
