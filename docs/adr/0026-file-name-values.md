# ADR-0026：字段值是一个文件名时不算密钥

- 状态：Accepted（2026-11-01）
- 相关：`src/redact/checks.ts`（`fileNameValue`、`fieldAt`）、`src/redact/rules.ts`、ADR-0015、issue #1

## Context

issue #1：ComfyUI 的会话里，agent 用 PowerShell 打印工作流，形如：

```text
'18'=@{class_type='LatentUpscaleModelLoader';inputs=[ordered]@{$key='<模型文件名>.safetensors'}}
```

`$key` 被当成一个名为 `key` 的字段（`bareKey` 允许前面是 `$`），值是模型文件名 `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`：54 个字符、字母数字加 `_` 和 `.`、字母数字都有，正好满足 `secretValue`（≥16 字符、字母数字都有）。它被当成 SECRET 换了：那台机器开了 `shape`，模型看到的是同形的随机名字 `htlpymx_m8_qrpgjo_bgokyoak_8i_mvmy_x6_xu36.bjnoahbqisj`；统计卡里多出一条 SECRET 记录，同一个值在后续每轮都从值表里再换一次。

已有的判据都是「这是名字，不是值」：`pathValue`（路径）、`fileField`（字段名本身是文件名）、`namesASecret`（代码里给密钥起的名字）、`skillName`、`versionValue`。模型权重、图片、压缩包这类**文件名**属于同一类，之前没有覆盖。

## Decision

- `checks.ts` 新增 `fileNameValue(v)`：值只由文件名允许的字符（字母、数字、`.`、`_`、`-`）组成，且最后一个 `.` 之后是已知的、密钥不会被保存在其中的扩展名时，它不是密钥。扩展名按大类固定写死：
  - 模型权重与运行数据：`safetensors ckpt pt pth bin gguf ggml onnx sft h5 pb tflite mlmodel npz npy pkl msgpack engine plan trt`
  - 压缩包：`zip tar gz tgz bz2 xz zst 7z rar lz4 whl`
  - 图片、音频、视频：`png jpg jpeg webp gif bmp svg ico tif tiff avif heic mp4 mov mkv webm avi m4v wav mp3 flac ogg m4a`
  - 文档与数据：`txt md pdf doc docx xls xlsx ppt pptx csv tsv json jsonl yaml yml xml html toml ini cfg conf log sqlite db parquet`
- 这个判据放在 `fieldAt` 里，和 `pathValue`、`fileField`、`versionValue` 并列，因此对所有按字段名找值的 SECRET 规则（`password =`、`api_key:`、`"key":`）都生效。
- 只有「文件名形状 + 已知扩展名」同时成立才放行：`"key": "Qb2vN7kLp4wZ8tR1mX6c.y9d8"` 仍按密钥脱敏。

## Consequences

- `$key='…safetensors'`、`"token": "model.gguf"`、`password=models/vae.bin` 这类值不再脱敏，记录里也不再出现对应的 SECRET。
- 一条真密钥如果恰好以这些扩展名结尾（`a1b2c3.bin`），并且字段名就叫 `key`，会被当成文件名放行。这种形状的密钥不常见，而误脱敏模型文件名会让 agent 干不了活（issue #1 里就是模型看到一个乱码文件名）；取舍上宁可不脱敏。
- 新的文件类型出现时，在 `FILE_EXT` 里加一个词。清单不分大小写。
