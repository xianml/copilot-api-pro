#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"
import fs from "node:fs/promises"
import process from "node:process"

import { PATHS, ensurePaths } from "./lib/paths"

export const stop = defineCommand({
  meta: {
    name: "stop",
    description: "Stop the background Copilot API server started with --daemon",
  },
  async run() {
    await ensurePaths()
    try {
      const pidRaw = await fs.readFile(PATHS.PID_PATH, "utf8")
      const pid = Number.parseInt(pidRaw, 10)

      if (Number.isNaN(pid)) {
        consola.warn("No running daemon found (pid file is empty).")
        return
      }

      process.kill(pid)
      consola.success(`Stopped Copilot API server (pid ${pid}).`)
      await fs.writeFile(PATHS.PID_PATH, "")
    } catch (error) {
      consola.warn("Failed to stop daemon. Is it running?", error)
    }
  },
})
