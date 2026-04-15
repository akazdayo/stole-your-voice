# voice-clone-bot

## Docker Compose で起動する

前提:

- Docker と Docker Compose が使えること
- `nix` コマンドが使えること
- `Irodori-TTS` 用に NVIDIA Container Toolkit が入った Docker host を使うこと

1. `.env` を用意して、Discord Bot token を設定します。

```bash
cp .env.example .env
```

`.env`:

```dotenv
DISCORD_TOKEN=your-bot-token
```

2. Nix で Docker image をビルドします。

```bash
nix build .#irodori-tts-image .#voice-clone-bot-image
```

3. Docker に image を読み込みます。

```bash
nix run .#load-all-images
```

4. Compose を起動します。

```bash
docker compose up -d
```

`irodori-tts` は初回起動時に container 内で `uv sync --locked --no-dev` を実行し、`voice-clone-bot` は `bun install --frozen-lockfile` を実行します。依存は volume 上にキャッシュされるので、lockfile が変わらない限り再起動時には再解決しません。

Bot は `/_run_generation` を Gradio API 経由で呼び出し、返ってきた WAV を `ffmpeg` で `48kHz / stereo / s16le` PCM に変換して Discord に流します。

よく使うコマンド:

```bash
# 起動ログを見る
docker compose logs -f

# TTS だけログを見る
docker compose logs -f irodori-tts

# 停止する
docker compose down
```

依存やソースを更新したあとにやり直す場合:

```bash
nix build .#irodori-tts-image .#voice-clone-bot-image
nix run .#load-all-images
docker compose up -d
```

Compose は `voice-clone-bot:local` と `irodori-tts:local` を参照します。個別に読み込みたい場合は以下も使えます。

```bash
nix run .#load-voice-clone-bot-image
nix run .#load-irodori-tts-image
```

## ローカルで直接起動する

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
