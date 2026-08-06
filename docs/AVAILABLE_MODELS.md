# Available Models

> This table is an overlay, not the authority. The models a user may pick come from
> `GET /model-catalog`: what the homestead's Pi harness reports it can reach, intersected with the
> providers that user connected under **Settings > Provider credentials**. A model listed below that
> the harness does not know is refused at session creation. The table supplies product display
> names, descriptions, ordering, and preferred default reasoning effort.

OpenOutposts exposes these models in the model picker and integration preferences. Availability
depends on the installed Pi version and the credentials connected to the homestead session.

## Anthropic

| Model ID                      | Display name      | Description                        | Reasoning efforts             | Default effort |
| ----------------------------- | ----------------- | ---------------------------------- | ----------------------------- | -------------- |
| `anthropic/claude-haiku-4-5`  | Claude Haiku 4.5  | Fast and efficient                 | high, max                     | max            |
| `anthropic/claude-sonnet-4-5` | Claude Sonnet 4.5 | Balanced performance               | high, max                     | max            |
| `anthropic/claude-sonnet-4-6` | Claude Sonnet 4.6 | Latest balanced, fast coding       | low, medium, high, max        | high           |
| `anthropic/claude-opus-4-5`   | Claude Opus 4.5   | Most capable                       | high, max                     | max            |
| `anthropic/claude-opus-4-6`   | Claude Opus 4.6   | Most capable, adaptive thinking    | low, medium, high, max        | high           |
| `anthropic/claude-opus-4-7`   | Claude Opus 4.7   | Most capable, adaptive thinking    | low, medium, high, xhigh, max | high           |
| `anthropic/claude-opus-4-8`   | Claude Opus 4.8   | Most capable, adaptive thinking    | low, medium, high, xhigh, max | high           |
| `anthropic/claude-opus-5`     | Claude Opus 5     | Latest Opus, adaptive thinking     | low, medium, high, xhigh, max | high           |
| `anthropic/claude-fable-5`    | Claude Fable 5    | Most powerful, new tier above Opus | low, medium, high, xhigh, max | high           |

## OpenAI

OpenAI models require a supported credential configured under **Settings > Provider credentials**.

| Model ID                     | Display name        | Description                                  | Reasoning efforts              | Default effort |
| ---------------------------- | ------------------- | -------------------------------------------- | ------------------------------ | -------------- |
| `openai/gpt-5.4`             | GPT 5.4             | Flagship model                               | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.5`             | GPT 5.5             | Latest flagship model                        | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-sol`         | GPT 5.6 Sol         | Frontier model for complex professional work | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-terra`       | GPT 5.6 Terra       | Balanced, cost-efficient everyday work       | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.6-luna`        | GPT 5.6 Luna        | Fast, cost-efficient high-volume workloads   | none, low, medium, high, xhigh | Not set        |
| `openai/gpt-5.3-codex`       | GPT 5.3 Codex       | Latest codex                                 | low, medium, high, xhigh       | high           |
| `openai/gpt-5.3-codex-spark` | GPT 5.3 Codex Spark | Low-latency codex variant                    | low, medium, high, xhigh       | high           |

## OpenCode Zen

| Model ID                | Display name | Description   | Reasoning efforts | Default effort |
| ----------------------- | ------------ | ------------- | ----------------- | -------------- |
| `opencode/kimi-k2.5`    | Kimi K2.5    | Moonshot AI   | Not supported     | N/A            |
| `opencode/kimi-k2.6`    | Kimi K2.6    | Moonshot AI   | Not supported     | N/A            |
| `opencode/minimax-m2.5` | MiniMax M2.5 | MiniMax       | Not supported     | N/A            |
| `opencode/qwen3.7-max`  | Qwen3.7 Max  | Alibaba Cloud | Not supported     | N/A            |
| `opencode/glm-5`        | GLM 5        | Z.ai 744B MoE | Not supported     | N/A            |
| `opencode/glm-5.1`      | GLM 5.1      | Z.ai          | Not supported     | N/A            |

## Z.AI Coding Plan

Z.AI Coding Plan models require `ZHIPU_API_KEY` as a global or repository secret.

| Model ID                  | Display name | Description      | Reasoning efforts | Default effort |
| ------------------------- | ------------ | ---------------- | ----------------- | -------------- |
| `zai-coding-plan/glm-5.2` | GLM 5.2      | Z.AI Coding Plan | Not supported     | N/A            |

## DeepSeek

DeepSeek models require `DEEPSEEK_API_KEY` as a global or repository secret.

| Model ID                     | Display name      | Description  | Reasoning efforts | Default effort |
| ---------------------------- | ----------------- | ------------ | ----------------- | -------------- |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | Fast model   | Not supported     | N/A            |
| `deepseek/deepseek-v4-pro`   | DeepSeek V4 Pro   | Most capable | Not supported     | N/A            |
