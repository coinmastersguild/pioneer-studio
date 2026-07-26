import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// @ts-expect-error — plain .mjs dev plugin, no types worth writing for it
import { studioMcp } from './scripts/mcp-plugin.mjs'

// Pioneer Studio intentionally has no environment-variable configuration.
// Every contributor runs the same client against the public Pioneer API, and
// each user authenticates at runtime with their own wallet or API key.
export default defineConfig({ plugins: [react(), studioMcp()] })
