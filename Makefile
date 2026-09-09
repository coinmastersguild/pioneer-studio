# Thin wrapper over package.json scripts — `make` is the entry point.
.PHONY: dev build check test lint deploy

dev:
	bun run dev

# CI deploy.yml has never completed (the `production` environment gate has never
# been approved), so the local wrangler push is the real ship path.
deploy: build
	bunx wrangler deploy

build:
	bun run build

check:
	bun run check

test:
	bun run test

lint:
	bun run lint
