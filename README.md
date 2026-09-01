# pi-modelscope

Pi extension for [ModelScope](https://modelscope.cn/)'s OpenAI-compatible inference API. It registers the `modelscope` provider, supports streaming chat completions and multimodal `text` + `image` messages, refreshes the available model catalog from `/v1/models` in the background, and provides commands for inspecting models, capabilities, and session usage.

## Install

```bash
pi install npm:pi-modelscope
```

For a local checkout:

```bash
pi -e .
```

## Configuration

Set a ModelScope Token before starting pi:

```bash
export MODELSCOPE_API_KEY="ms-..."
```

- **Base URL:** `https://api-inference.modelscope.cn/v1`
- **Provider id:** `modelscope`
- **Auth:** `MODELSCOPE_API_KEY` (sent as `Authorization: Bearer <token>`)

The token is read from the environment and is not included in this package. Do not commit a real token to source control.

## Usage

The documented multimodal seed model is available immediately:

```bash
pi --model modelscope/Qwen/Qwen3.8-Flash-Next "你好，介绍一下你自己"
```

ModelScope's OpenAI-compatible API also accepts image parts. In pi, attach an image to a message while using a model whose catalog entry advertises image input; the extension passes the resulting OpenAI-compatible message to ModelScope.

Equivalent API usage outside pi:

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api-inference.modelscope.cn/v1",
    api_key="ms-your-token",
)

response = client.chat.completions.create(
    model="Qwen/Qwen3.8-Flash-Next",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "描述这幅图"},
            {
                "type": "image_url",
                "image_url": {
                    "url": "https://modelscope.oss-cn-beijing.aliyuncs.com/demo/images/audrey_hepburn.jpg",
                },
            },
        ],
    }],
    stream=True,
)

for chunk in response:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
```

## Commands

The extension registers the following commands:

| Command | Description |
|---|---|
| `/modelscope-models [image\|vision\|audio\|video\|reasoning\|tools]` | List ModelScope models with capabilities, context/output limits; an optional filter narrows the table. |
| `/modelscope-usage` | Show token/cost usage accumulated in the current Pi process. |

Examples:

```text
/modelscope-models
/modelscope-models vision
/modelscope-usage
```

`/modelscope-usage` is based on `message_end` usage reported by completed assistant messages and is therefore local to the current Pi process. ModelScope's OpenAI-compatible API does not expose a uniform account-level billing/usage endpoint through this provider, so this command is not an account invoice.

## Model discovery

`Qwen/Qwen3.8-Flash-Next` is registered synchronously as a seed model, so the provider remains usable during startup and when the network is unavailable. Pi subsequently calls `https://api-inference.modelscope.cn/v1/models`; a successful result replaces the seed list and is persisted for later offline starts. Failed or empty discovery falls back to the cached catalog or the seed model.

## Development

```bash
npm test
```

The extension uses pi-ai's `openai-completions` API and resolves both the newer lazy subpath and the older bare-package export for compatibility with different pi versions.

## Release to npm

The GitHub Actions workflow in `.github/workflows/publish.yml` publishes on tags matching `v*` and also supports manual dispatch. It runs `npm ci`, `npm test`, and publishes with npm provenance:

```bash
npm version patch
# or: npm version minor / npm version major
git push origin main --follow-tags
```

Before the first release, configure npm Trusted Publishing for the `pgciq/pi-modelscope` repository and the `Publish to npm` workflow. The workflow uses GitHub OIDC (`id-token: write`) and does not store an npm token in the repository.
