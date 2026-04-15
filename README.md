# voice-clone-bot

## Gradio API 経由で起動する

1. `Irodori-TTS` 側の API サーバーを起動します。

```bash
cd Irodori-TTS
uv run python gradio_app.py --server-name 127.0.0.1 --server-port 7860
```

2. 必要なら Bot 側で接続先を指定します。

```bash
export IRODORI_API_BASE_URL=http://127.0.0.1:7860/
```

3. Bot を起動します。

```bash
bun run src/index.ts
```

Bot は `/_run_generation` を Gradio API 経由で呼び出し、返ってきた WAV を `ffmpeg` で `48kHz / stereo / s16le` PCM に変換して Discord に流します。
