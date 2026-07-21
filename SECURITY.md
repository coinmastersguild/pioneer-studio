# Security policy

## Reporting a vulnerability

Do not open a public issue for vulnerabilities, leaked credentials, private user
data, billing bypasses, or authorization problems. Use GitHub's **Report a
vulnerability** button in this repository's Security tab to open a private
security advisory with the maintainers.

Include the affected path, impact, reproduction steps, and a minimal proof of
concept. Do not spend another user's credits, access data you do not own, or keep
testing after the issue is demonstrated.

## Supported version

Security fixes target the current `master` branch and the hosted application at
`https://studio.pioneers.dev`.

## Client security model

Pioneer Studio is a public browser client. Every browser, fork, and API caller is
untrusted. Authentication, authorization, ownership, rate limits, and credit
metering must be enforced by the Pioneer API. API credentials are supplied by the
user at runtime and stored only for the browser session.
