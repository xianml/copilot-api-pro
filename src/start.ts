#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import process from "node:process"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { ensurePaths } from "./lib/paths"
import { PATHS } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  claudeCodeReset: boolean
  codex: boolean
  showToken: boolean
  proxyEnv: boolean
  daemon: boolean
}

interface PreparedDaemonEnv {
  [key: string]: string | undefined
}

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we lack permission to signal it
    // ESRCH means no such process
    // For any other error, assume not running.
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return true
    }
    return false
  }
}

async function baseSetup(options: RunServerOptions): Promise<string> {
  if (options.proxyEnv) initProxyFromEnv()
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken

  await ensurePaths()
  await cacheVSCodeVersion()

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`,
  )

  return `http://localhost:${options.port}`
}

async function selectClaudeModels(options: RunServerOptions) {
  invariant(state.models, "Models should be loaded by now")

  const storedConfig = await loadClaudeCodeConfig()
  const hasStored =
    storedConfig !== null
    && state.models.data.some((model) => model.id === storedConfig.model)
    && state.models.data.some((model) => model.id === storedConfig.smallModel)

  const useStored = hasStored && !options.claudeCodeReset

  const selectedModel =
    useStored ?
      storedConfig.model
    : await consola.prompt("Select a model to use with Claude Code", {
        type: "select",
        options: state.models.data.map((model) => model.id),
      })

  const selectedSmallModel =
    useStored ?
      storedConfig.smallModel
    : await consola.prompt("Select a small model to use with Claude Code", {
        type: "select",
        options: state.models.data.map((model) => model.id),
      })

  if (!useStored) {
    const config = { model: selectedModel, smallModel: selectedSmallModel }
    await saveClaudeCodeConfig(config)
    consola.info(
      `Saved Claude Code config to ${PATHS.CLAUDE_CODE_CONFIG_PATH}: model="${config.model}", small="${config.smallModel}"`,
    )
  }

  return { selectedModel, selectedSmallModel }
}

function buildClaudeCommand(
  serverUrl: string,
  model: string,
  smallModel: string,
) {
  return generateEnvScript(
    {
      ANTHROPIC_BASE_URL: serverUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: smallModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    "claude",
  )
}

function buildCodexCommand(serverUrl: string, model: string): string {
  return [
    "codex",
    `-c model_providers.copilot-api.name=copilot-api`,
    `-c model_providers.copilot-api.base_url=${serverUrl}/v1`,
    `-c model_providers.copilot-api.wire_api=responses`,
    `-c model_provider=copilot-api`,
    `-c model_reasoning_effort=high`,
    `-m ${model}`,
  ].join(" ")
}
async function prepareDaemon(
  options: RunServerOptions,
): Promise<PreparedDaemonEnv> {
  const serverUrl = await baseSetup(options)
  const envExtras: PreparedDaemonEnv = {}

  if (options.claudeCodeReset) {
    await clearClaudeCodeConfig()
    consola.info("Resetting stored Claude Code config; re-selecting models.")
  }

  if (options.claudeCode) {
    const { selectedModel, selectedSmallModel } =
      await selectClaudeModels(options)
    envExtras.COPILOT_API_CLAUDE_MODEL = selectedModel
    envExtras.COPILOT_API_CLAUDE_SMALL_MODEL = selectedSmallModel

    const command = buildClaudeCommand(
      serverUrl,
      selectedModel,
      selectedSmallModel,
    )

    try {
      clipboard.writeSync(command)
      consola.success("Copied Claude Code command to clipboard!")
    } catch {
      consola.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      consola.log(command)
    }
  }

  if (options.codex) {
    invariant(state.models, "Models should be loaded by now")
    const selectedModel = await consola.prompt(
      "Select a model to use with Codex",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    envExtras.COPILOT_API_CODEX_MODEL = selectedModel

    const codexCommand = buildCodexCommand(serverUrl, selectedModel)

    try {
      clipboard.writeSync(codexCommand)
      consola.success("Copied Codex command to clipboard!")
    } catch {
      consola.warn("Failed to copy Codex command. Here it is:")
      consola.log(codexCommand)
    }
  }

  return envExtras
}

type ClaudeConfig = { model: string; smallModel: string }

function getEnvClaudeConfig(): ClaudeConfig | null {
  if (
    process.env.COPILOT_API_CLAUDE_MODEL
    && process.env.COPILOT_API_CLAUDE_SMALL_MODEL
  ) {
    return {
      model: process.env.COPILOT_API_CLAUDE_MODEL,
      smallModel: process.env.COPILOT_API_CLAUDE_SMALL_MODEL,
    }
  }
  return null
}

async function maybeClearStoredClaude(options: RunServerOptions) {
  if (!options.claudeCodeReset) return
  await clearClaudeCodeConfig()
  consola.info("Resetting stored Claude Code config; re-selecting models.")
}

function logStoredClaude(storedConfig: ClaudeConfig | null) {
  if (!storedConfig) return
  consola.info(
    `Claude Code config: model="${storedConfig.model}", small="${storedConfig.smallModel}", path=${PATHS.CLAUDE_CODE_CONFIG_PATH}`,
  )
}

function hasValidClaudeConfig(
  config: ClaudeConfig | null,
  models: Array<{ id: string }>,
): config is ClaudeConfig {
  return Boolean(
    config
      && models.some((model) => model.id === config.model)
      && models.some((model) => model.id === config.smallModel),
  )
}

// eslint-disable-next-line max-params
async function chooseClaudeModels(
  options: RunServerOptions,
  envConfig: ClaudeConfig | null,
  storedConfig: ClaudeConfig | null,
  models: Array<{ id: string }>,
): Promise<{ config: ClaudeConfig; shouldPersist: boolean }> {
  const candidate = options.claudeCodeReset ? null : (envConfig ?? storedConfig)
  if (hasValidClaudeConfig(candidate, models)) {
    return { config: candidate, shouldPersist: false }
  }

  const model = await consola.prompt("Select a model to use with Claude Code", {
    type: "select",
    options: models.map((m) => m.id),
  })
  const smallModel = await consola.prompt(
    "Select a small model to use with Claude Code",
    {
      type: "select",
      options: models.map((m) => m.id),
    },
  )

  return { config: { model, smallModel }, shouldPersist: true }
}

function copyClaudeCommand(command: string) {
  try {
    clipboard.writeSync(command)
    consola.success("Copied Claude Code command to clipboard!")
  } catch {
    consola.warn(
      "Failed to copy to clipboard. Here is the Claude Code command:",
    )
    consola.log(command)
  }
}

async function handleClaudeCode(options: RunServerOptions, serverUrl: string) {
  invariant(state.models, "Models should be loaded by now")
  const models = state.models.data

  const envConfig = getEnvClaudeConfig()
  const storedConfig = await loadClaudeCodeConfig()

  logStoredClaude(storedConfig)
  await maybeClearStoredClaude(options)

  const { config, shouldPersist } = await chooseClaudeModels(
    options,
    envConfig,
    storedConfig,
    models,
  )

  if (shouldPersist || options.claudeCodeReset) {
    await saveClaudeCodeConfig(config)
    consola.info(
      `Saved Claude Code config to ${PATHS.CLAUDE_CODE_CONFIG_PATH}: model="${config.model}", small="${config.smallModel}"`,
    )
  }

  const command = buildClaudeCommand(serverUrl, config.model, config.smallModel)
  copyClaudeCommand(command)
}

async function handleCodex(options: RunServerOptions, serverUrl: string) {
  invariant(state.models, "Models should be loaded by now")

  const envCodexModel =
    options.claudeCodeReset ? null : process.env.COPILOT_API_CODEX_MODEL

  const selectedModel =
    envCodexModel
    ?? (await consola.prompt("Select a model to use with Codex", {
      type: "select",
      options: state.models.data.map((model) => model.id),
    }))

  const codexCommand = buildCodexCommand(serverUrl, selectedModel)

  if (!options.daemon || !envCodexModel) {
    try {
      clipboard.writeSync(codexCommand)
      consola.success("Copied Codex command to clipboard!")
    } catch {
      consola.warn("Failed to copy Codex command. Here it is:")
      consola.log(codexCommand)
    }
  } else {
    consola.info("Using preselected Codex model from daemon setup.")
  }
}

export async function runServer(options: RunServerOptions): Promise<void> {
  const serverUrl = await baseSetup(options)

  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  if (options.claudeCode) {
    await handleClaudeCode(options, serverUrl)
  }

  if (options.codex) {
    await handleCodex(options, serverUrl)
  }

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    reset: {
      type: "boolean",
      default: false,
      description:
        "Force re-select Claude Code models and overwrite stored config",
    },
    codex: {
      type: "boolean",
      default: false,
      description:
        "Generate a command to use Codex CLI with Copilot API (responses wire)",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    daemon: {
      type: "boolean",
      default: false,
      description: "Run the server in the background",
    },
  },
  async run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    const options = {
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      claudeCodeReset: args.reset,
      codex: args.codex,
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      daemon: args.daemon || process.env.COPILOT_API_IS_DAEMON === "1",
    }

    if (args.daemon && process.env.COPILOT_API_IS_DAEMON !== "1") {
      const envExtras = await prepareDaemon(options)

      // Check for existing running daemon
      const pidRaw = (
        await fs.readFile(PATHS.PID_PATH, "utf8").catch(() => "")
      ).trim()
      const existingPid = Number.parseInt(pidRaw, 10)
      if (!Number.isNaN(existingPid) && isProcessRunning(existingPid)) {
        consola.error(
          `A Copilot API daemon is already running (pid ${existingPid}). Stop it first: copilot-api-pro stop`,
        )
        process.exit(1)
      }

      const child = spawn(process.argv[0], process.argv.slice(1), {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, COPILOT_API_IS_DAEMON: "1", ...envExtras },
      })

      await fs.writeFile(PATHS.PID_PATH, String(child.pid))
      consola.info(
        `Copilot API server is starting in the background (pid ${child.pid}).`,
      )
      child.unref()
      // Ensure parent process exits after spawning daemon
      process.exit(0)
    }

    return runServer(options)
  },
})

interface ClaudeCodeConfig {
  model: string
  smallModel: string
}

const loadClaudeCodeConfig = async (): Promise<ClaudeCodeConfig | null> => {
  try {
    const content = await fs.readFile(PATHS.CLAUDE_CODE_CONFIG_PATH, "utf8")
    if (!content) return null
    return JSON.parse(content) as ClaudeCodeConfig
  } catch {
    return null
  }
}

const saveClaudeCodeConfig = async (config: ClaudeCodeConfig) => {
  await fs.writeFile(
    PATHS.CLAUDE_CODE_CONFIG_PATH,
    JSON.stringify(config, null, 2),
  )
}

const clearClaudeCodeConfig = async () => {
  try {
    await fs.unlink(PATHS.CLAUDE_CODE_CONFIG_PATH)
  } catch {
    // ignore
  }
}
