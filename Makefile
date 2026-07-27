# Thin wrapper over package.json scripts — `make` is the entry point.
.PHONY: dev build check test lint

dev:
	bun run dev

build:
	bun run build

check:
	bun run check

test:
	bun run test

lint:
	bun run lint
