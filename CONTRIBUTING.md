# Contributing

Thank you for helping improve RedCall Live Translate.

## Development workflow

1. Create a focused branch from the current default branch.
2. Keep runtime code dependency-light and compatible with Chrome Manifest V3.
3. Run `npm ci` once, then `npm run validate` before each pull request.
4. Test listen mode on a generic audio tab.
5. If WebRTC interception changed, test Google Meet and each affected beta adapter separately.
6. Document user-visible or security-relevant changes in `CHANGELOG.md`.

## Pull-request expectations

- Explain the problem and the chosen trade-offs.
- Include manual test evidence for browser media changes.
- Do not include access tokens, account data, transcripts, recordings, or private backend source.
- Preserve the fail-closed invariant: while bidirectional mode is active, a raw microphone track
  must never be restored automatically.
- Keep new hosts and permissions narrowly scoped and justify them in the pull request.

Security reports must follow [SECURITY.md](SECURITY.md) and must not be submitted through a public
issue.
