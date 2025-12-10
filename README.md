# Copilot API Pro

> [!NOTE]
>
> This project is a fork of [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api) by [ericc-ch](https://github.com/ericc-ch).

> [!NOTE]
>
> This is a reverse-engineered proxy of GitHub Copilot. It is unofficial and may break at any time.

<https://github.com/user-attachments/assets/b28e6205-32d9-4967-84f3-293086743489>

This project supports both Claude Code and Codex with additional features:
- support both Codex and Claude Code
- daemon-friendly start/stop
- persistent configuration for Claude Code and Codex
- more features to come...


## Prerequisites
- GitHub Copilot account. Please enable copilot models in [GitHub Copilot Settings](https://github.com/settings/copilot/features)
- [Claude Code](https://claude.com/product/claude-code) and [Codex](https://developers.openai.com/codex/cli/)

## Quick start

```sh
# setp 1: start in background with Codex or Claude Code
npx copilot-api-pro@latest start --codex|claude-code --daemon

# step 2: select the model you want to use if it is the first time you use it

# step 3: paste the auto generated command in you clipboard to your terminal and enjoy!
codex -c model_providers.copilot-api.name=copilot-api -c model_providers.copilot-api.base_url=http://localhost:4141/v1 -c model_providers.copilot-api.wire_api=responses -c model_provider=copilot-api -c model_reasoning_effort=high -m gpt-5

# step 4: stop the server if you want to stop it
npx copilot-api-pro@latest stop

# step 5: show usage
npx copilot-api-pro@latest check-usage
```

## Help

```sh
npx copilot-api-pro@latest --help

USAGE copilot-api-pro auth|start|stop|check-usage|debug

COMMANDS

         auth    Run GitHub auth flow without running the server             
        start    Start the Copilot API server                                
         stop    Stop the background Copilot API server started with --daemon
  check-usage    Show current GitHub Copilot usage/quota information         
        debug    Print debug information about the application               

Use copilot-api-pro <command> --help for more information about a command.
```
