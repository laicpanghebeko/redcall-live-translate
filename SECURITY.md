# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to **support@redcall.tech** with:

- the affected version;
- reproduction steps;
- the expected and observed behavior;
- any proof of concept or relevant logs;
- the potential impact.

Do not open a public GitHub issue for authentication bypasses, token exposure, microphone or
tab-capture issues, cross-origin messaging problems, or dependency vulnerabilities.

## Supported version

Security fixes are applied to the latest published version. This portfolio repository currently
documents version 1.6.x.

## Security assumptions

- The RedCall API must enforce PKCE, one-time authorization codes, device binding, refresh-token
  rotation, and revocation.
- LiveKit tokens must have minimal TTLs and room/track grants.
- The token supplied to `site-adapter.js` must be subscribe-only because it runs in the meeting
  page's main JavaScript world.
- Translation providers and their API keys must remain behind the RedCall service boundary.
- Production deployments must use HTTPS/WSS and validate allowed origins server-side.

## Out of scope

- Vulnerabilities in meeting providers or Chrome itself.
- Social engineering and denial-of-service reports without a security impact.
- Issues that require a deliberately modified browser or disabled Chrome security controls.
