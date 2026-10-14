# pi-spark

A [pi](https://pi.dev) package for **Qwen3.8-Flash-Next served by vLLM on a DGX Spark**
(for example with [qwen3.8-Flash-DGX](https://github.com/blazux/qwen3.8-Flash-DGX)). It does two things:

1. **Registers a `spark` provider** with the model, so there is nothing to add to `models.json`.
2. **Controls Qwen's thinking per request.** pi sends its thinking level as OpenAI-style
   `reasoning_effort`, which Qwen's chat template ignores, so without this Qwen thinks on every request
   whatever level you pick. This package sets `chat_template_kwargs.enable_thinking` instead.

## Install

```bash
pi install git:github.com/filipjoksovic/pi-spark
```

Update with `pi update --extensions`. Pin a release with `git:github.com/filipjoksovic/pi-spark@v1.0.0`.

Then pick the model in pi, or start it with `pi --model spark/qwen3.8-flash-next`.

## Thinking

The mode follows pi's normal thinking level:

| pi thinking level | Qwen |
|---|---|
| `off` | never thinks |
| `minimal`, `low`, `medium` | **hybrid**: thinks on the first request of each prompt, on the request after a failed tool call and on every 8th request; otherwise answers directly |
| `high`, `xhigh`, `max` | always thinks |

On three agent tasks (a multi-file change with tests, a code investigation and a small coding task),
3 runs each, hybrid was about 25–35% faster than always thinking, with every run correct. Never thinking was
faster still, but in the same runs it once made a wrong change that its own tests missed, and once looped for
22 minutes.

As a guard against loops, after 80 tool calls in one prompt further calls are refused and the model is told
to finish with what it has.

## Settings

All optional. Set them as environment variables or in `~/.pi/agent/spark.json`; the environment wins.

| Environment | `spark.json` | Default | Meaning |
|---|---|---|---|
| `SPARK_URL` | `url` | `http://localhost:18300/v1` | the server's OpenAI-compatible base URL |
| `SPARK_API_KEY` | `apiKey` | none | only if vLLM was started with `--api-key` |
| `SPARK_MODEL` | `model` | `qwen3.8-flash-next` | served model name |
| `SPARK_CONTEXT` | `contextWindow` | `500000` | context window in tokens |
| `QWEN_THINKING` | `thinking` | follows pi | `off`, `on` or `hybrid`, regardless of pi's level |
| `QWEN_THINK_EVERY` | `thinkEvery` | `8` | re-plan interval in hybrid mode, `0` = never |
| `QWEN_CALL_LIMIT` | `callLimit` | `80` | tool calls per prompt, `0` = no limit |

`spark.json` is the better place for the URL: pi started from scripts or other apps may not see your shell
profile. Example:

```json
{
  "url": "http://192.168.1.50:18300/v1"
}
```

## Reaching the Spark

- **Same network:** point `url` at the Spark's address and the port vLLM is published on.
- **Elsewhere:** tunnel the port over SSH, for example
  `ssh -N -L 18300:localhost:18300 you@spark`, and keep the default URL; or use a VPN such as Tailscale.

vLLM's API has no authentication unless it was started with `--api-key`. Do not expose the port beyond a
network you trust.
