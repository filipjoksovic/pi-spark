# pi-spark

This is a [pi](https://pi.dev) package for running Qwen3.8-Flash-Next on a DGX Spark through vLLM (I use the
[qwen3.8-Flash-DGX](https://github.com/blazux/qwen3.8-Flash-DGX) recipe). It registers the model as a `spark`
provider in pi and controls when Qwen thinks, which in my tests made agent tasks somewhere between a fifth and a third faster
without costing any correctness.

```bash
pi install git:github.com/filipjoksovic/pi-spark
```

## Why it exists

While benchmarking Qwen in pi, I noticed that changing pi's thinking level made no difference to how much
Qwen reasoned. It turns out pi sends the level as the OpenAI-style `reasoning_effort` field, which Qwen's chat
template simply doesn't read. The only switch Qwen listens to is `chat_template_kwargs.enable_thinking`, and
pi never sets it, so with a plain `models.json` setup Qwen thinks before every response regardless of what
you choose in pi.

That matters more than it sounds in an agent loop. A coding task easily takes 20 to 40 model requests, most
of them are routine steps like opening a file or running the tests, and on the Spark generating tokens is
the slow part, so reasoning through each of those steps adds up quickly.

## What it does

The package sets `enable_thinking` on every request using a hybrid approach: Qwen thinks on the first request
of each prompt so it can plan the task, on the request right after a tool call fails so it can work out what
went wrong, and on every 8th request so it can re-plan during longer tasks. The rest of the time it answers
directly. In one typical run Qwen ended up thinking on 7 of its 35 requests and still got everything right.

It also refuses further tool calls after 80 calls in a single prompt and asks the model to finish with what
it has, as a guard against runaway loops. If the model ignores that and makes 10 more calls, the prompt is
stopped. That second step matters for calls pi rejects before any extension sees them, like a call with a
missing argument, which a model can otherwise repeat forever.

Two smaller habits are steered as well, because on the Spark every token the model writes costs time. A note
in the system prompt asks Qwen to change files with `edit` instead of rewriting them and to check its work
through the project's tests rather than throwaway scripts, and a `write` that would replace an existing file
longer than 50 lines is refused with a request to edit instead. In a small test on a real task (five runs
each), this cut what Qwen wrote by about 30%, and three of five runs finished correctly within 15 minutes
against none without it. Qwen still ignores the part about tests most of the time. Other providers and models
are left alone.

## Results

I measured this on a single DGX Spark (GB10) running the NVFP4 build of Qwen3.8-Flash-Next on vLLM 0.31 with
MTP speculative decoding. There were three tasks: a multi-file Python change graded against tests the model
never saw plus a linter check, an investigation that traces a value through an Angular frontend and a Python
backend, and a small self-contained coding task with its own tests. Every setup ran each task three times,
one run at a time, with nothing else using the Spark.

| Median time | pi as-is (always thinking) | pi-spark (hybrid) |
|---|---|---|
| Multi-file change | 382 s | 250–304 s |
| Investigation | 150 s | 91–100 s |
| Small coding task | 71 s | 52–59 s |
| Correct runs | 9 of 9 | 18 of 18 |

The hybrid numbers are ranges because I measured it twice, a few hours apart, and the runs vary that much
from session to session. All 18 hybrid runs were correct.

I also tried switching thinking off completely. On the median it was about as fast as hybrid, but it wasn't
reliable: in one run it skipped a rule from the task description and shipped a change that its own tests
didn't catch, and in another the investigation wandered for 22 minutes and 404 turns before answering, when
its other runs took about a minute and a half. Hybrid kept nearly all of the speed without either problem.

A few other ideas didn't make it into the package because none of them beat the normal run-to-run variation:
capping how long each thinking step can be, putting the files a task mentions straight into the prompt, a
tool that reads several files and runs several commands in one call, returning test and lint results with
every edit, and a Skeleton-of-Thought style setup with parallel sub-agents, which was actually slower.

## Install and use

```bash
pi install git:github.com/filipjoksovic/pi-spark
```

Then pick "Qwen3.8 Flash Next (Spark)" in pi or start it with `pi --model spark/qwen3.8-flash-next`. You
don't need to add anything to `models.json`. To update, run `pi update --extensions`, and if you want to stay
on a fixed version, install `git:github.com/filipjoksovic/pi-spark@v1.2.0` instead.

The thinking mode follows pi's own thinking level, so you change it the same way as for any other model:

| pi thinking level | What Qwen does |
|---|---|
| `off` | never thinks |
| `minimal`, `low`, `medium` | hybrid, as described above (recommended) |
| `high`, `xhigh`, `max` | thinks on every request |

## Settings

Everything is optional. You can set these as environment variables or put them in `~/.pi/agent/spark.json`,
and if both are set the environment variable wins.

| Environment | `spark.json` | Default | Meaning |
|---|---|---|---|
| `SPARK_URL` | `url` | `http://localhost:18300/v1` | the server's OpenAI-compatible base URL |
| `SPARK_API_KEY` | `apiKey` | none | only needed if vLLM was started with `--api-key` |
| `SPARK_MODEL` | `model` | `qwen3.8-flash-next` | the served model name |
| `SPARK_CONTEXT` | `contextWindow` | `500000` | context window in tokens |
| `QWEN_THINKING` | `thinking` | follows pi | `off`, `on` or `hybrid`, ignoring pi's level |
| `QWEN_THINK_EVERY` | `thinkEvery` | `8` | how often hybrid mode re-plans, `0` to never |
| `QWEN_CALL_LIMIT` | `callLimit` | `80` | tool calls allowed per prompt, `0` for no limit |
| `QWEN_REWRITE_LIMIT` | `rewriteLimit` | `50` | refuse rewriting an existing file longer than this, `0` to allow |
| `QWEN_TEST_HINT` | `testHint` | `on` | `off` to drop the system prompt note about editing and testing |

I'd put the URL in `spark.json` rather than your shell profile, because pi started from scripts or other
apps often doesn't load the profile:

```json
{
  "url": "http://192.168.1.50:18300/v1"
}
```

## Reaching the Spark

On the same network you can point `url` straight at the Spark's address and the port vLLM is published on.
From elsewhere, either tunnel the port over SSH (for example `ssh -N -L 18300:localhost:18300 you@spark`) and
keep the default URL, or connect through a VPN such as Tailscale. Keep in mind that vLLM's API has no
authentication unless it was started with `--api-key`, so it shouldn't be reachable from networks you don't
trust.
