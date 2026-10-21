# Video generation

The `Video` tool sends a prompt and optional project reference files to MiniMax and saves the generated MP4 in your project. Video generation is billable and sends those inputs to the configured provider.

## Set up

1. Run `/logins minimax` and connect a standard MiniMax Open Platform API key with pay-as-you-go access. An M Plan subscription alone does not establish H3 video access.
2. Add a named generator to `.mercury/settings.local.json` in your project, or to `settings.json` in your Mercury config home.

```json
{
  "videoProvider": {
    "studio": {
      "kind": "minimax",
      "model": "MiniMax-H3"
    }
  }
}
```

`baseUrl` is optional and defaults to `https://api.minimax.io`; an override must be an HTTPS origin without a path, query or credentials. HTTP is accepted only for a loopback provider. API keys are stored through `/logins` and never in this setting.

`Video` appears in the tool roster when at least one provider is configured. If you configure more than one, the call must select one with `provider`. Without a configured provider, the withheld-tool row points to `/logins minimax` and `videoProvider`.

## Ask for a video

> Generate a five-second, 16:9 video of a paper boat drifting across a quiet pond. Save it in renders/.

The model can call:

```json
{
  "prompt": "A paper boat drifts across a quiet pond, soft afternoon light, slow camera movement.",
  "duration": 5,
  "aspect": "16:9",
  "outputDir": "renders"
}
```

The permission prompt lists the provider endpoint, model, prompt, reference paths and output directory. If your permission mode or an allow rule already covers the call, it runs without prompting.

### Reference files and options

To animate a first-frame image, include `references: [{"path":"assets/boat.png","role":"first_frame"}]` and use `aspect: "adaptive"`. For reference-based creation, use `reference_image`, `reference_video` or `reference_audio`; omitting the role selects the matching reference role. Images, MP4/MOV clips and MP3/WAV audio must be inside the project. Reference paths and output directories cannot traverse symbolic links or leave the project.

First/last-frame images cannot be mixed with reference-mode inputs. MiniMax's media count, file size and total request limits apply; Base64 encoding increases the size of local references. The provider decides whether media dimensions, codecs and clip durations meet its requirements.

| Option | Meaning |
| --- | --- |
| `duration` | Integer seconds, default 5. H3 accepts 4–15; H3-Max accepts 5–15. |
| `aspect` or `ratio` | `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, or `adaptive`. Both must agree if supplied. Text-only defaults to `16:9`; references default to `adaptive`. First/last frames use their image aspect. |
| `resolution` | Default `768P`. H3 accepts `768P` and `2K`; H3-Max accepts `480P` and `768P`. |
| `extra.prompt_expansion_mode` | H3-Max option: `disabled`, `balanced`, or `quality`. |
| `callback_url` | Optional MiniMax callback destination; task updates are also sent there. It is disclosed in the permission request. |
| `outputDir` | Project-local destination, default `videos/`, created when saving the first result. |
| `timeoutSeconds` | Local waiting deadline, default 1200 seconds. |

### Results and failures

Mercury polls every ten seconds and downloads the MP4 when the job succeeds. The result lists the local file path, duration and MiniMax job ID. MiniMax returns metered usage fields such as `total_seconds` and `input_image_count` instead of a dollar amount, and Mercury displays those fields without estimating a price.

When `ffmpeg` is on `PATH`, Mercury extracts a PNG frame at the one-second mark beside the MP4 and links it in chat. Without `ffmpeg`, the MP4 download still succeeds and the result notes that frame extraction was skipped. Image-capable models receive that PNG preview, while the MP4 file itself stays out of model context.

A failed job returns MiniMax's error message verbatim. If a download URL expires, Mercury queries the same job ID for a fresh URL instead of submitting a new generation request. Cancelling locally or hitting the timeout does not cancel the job on MiniMax, so keep the returned job ID and avoid re-submitting the prompt automatically.

For a zero-code alternative, add [MiniMax's own MCP server](https://platform.minimax.io/docs/guides/mcp-guide) through `mercury mcp add` using the vendor's setup instructions.

See MiniMax's [generation guide](https://platform.minimax.io/docs/guides/video-generation), [V2 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create), [task query](https://platform.minimax.io/docs/api-reference/video-generation-v2-query) and [pricing](https://platform.minimax.io/docs/pricing/overview) for current provider requirements and rates.
