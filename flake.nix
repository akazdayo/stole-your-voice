{
  inputs = {
    nixpkgs.url = "nixpkgs";
    self.submodules = true;
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, utils }:
    utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;

        relativeTo = root: path:
          let
            rootString = toString root;
            pathString = toString path;
          in
          if pathString == rootString then
            ""
          else
            lib.removePrefix "${rootString}/" pathString;

        topLevel = relPath:
          if relPath == "" then
            ""
          else
            builtins.head (lib.splitString "/" relPath);

        botSource = builtins.path {
          path = ./.;
          name = "voice-clone-bot-src";
          filter = path: type:
            let
              relPath = relativeTo ./. path;
              top = topLevel relPath;
            in
            relPath == ""
            || builtins.elem relPath [
              "README.md"
              "bun.lock"
              "package.json"
              "tsconfig.json"
            ]
            || top == "src";
        };

        irodoriSource = builtins.path {
          path = ./Irodori-TTS;
          name = "irodori-tts-src";
          filter = path: type:
            let
              relPath = relativeTo ./Irodori-TTS path;
              baseName = baseNameOf (toString path);
            in
            relPath == ""
            || !(builtins.elem baseName [
              ".git"
              ".venv"
              "__pycache__"
              ".pytest_cache"
              ".ruff_cache"
              "gradio_outputs"
            ]);
        };

        botSourceTree = pkgs.runCommand "voice-clone-bot-image-root" { } ''
          mkdir -p "$out/opt"
          cp -R ${botSource} "$out/opt/voice-clone-bot-src"
        '';

        irodoriSourceTree = pkgs.runCommand "irodori-tts-image-root" { } ''
          mkdir -p "$out/opt"
          cp -R ${irodoriSource} "$out/opt/irodori-tts-src"
        '';

        botRuntimePackages = with pkgs; [
          bash
          bun
          cacert
          coreutils
          ffmpeg
          rsync
        ];

        irodoriRuntimePackages = with pkgs; [
          bash
          cacert
          cmake
          coreutils
          curl
          ffmpeg
          gcc
          git
          gnumake
          libsndfile
          pkg-config
          python311
          rsync
          stdenv.cc.cc.lib
          uv
        ];

        voiceCloneBotEntrypoint = pkgs.writeShellApplication {
          name = "voice-clone-bot-entrypoint";
          runtimeInputs = botRuntimePackages;
          text = ''
            set -euo pipefail

            source_dir="/opt/voice-clone-bot-src"
            app_dir="/work/voice-clone-bot"
            stamp_file="$app_dir/.deps-stamp"

            mkdir -p "$app_dir"
            rsync -a --delete \
              --exclude '.deps-stamp' \
              --exclude 'node_modules' \
              "$source_dir/" "$app_dir/"

            cd "$app_dir"

            dependency_stamp="$(sha256sum package.json bun.lock | sha256sum | cut -d' ' -f1)"
            if [ ! -f "$stamp_file" ] || [ "$(cat "$stamp_file")" != "$dependency_stamp" ]; then
              rm -rf node_modules
              bun install --frozen-lockfile
              printf '%s\n' "$dependency_stamp" > "$stamp_file"
            fi

            : "''${DISCORD_TOKEN:?DISCORD_TOKEN is required}"
            export IRODORI_API_BASE_URL="''${IRODORI_API_BASE_URL:-http://irodori-tts:7860/}"

            exec bun run src/index.ts "$@"
          '';
        };

        irodoriTtsEntrypoint = pkgs.writeShellApplication {
          name = "irodori-tts-entrypoint";
          runtimeInputs = irodoriRuntimePackages;
          text = ''
            set -euo pipefail

            source_dir="/opt/irodori-tts-src"
            app_dir="/work/irodori-tts"
            stamp_file="$app_dir/.deps-stamp"

            mkdir -p "$app_dir" /work/hf-home /work/uv-cache
            rsync -a --delete \
              --exclude '.deps-stamp' \
              --exclude '.venv' \
              --exclude 'gradio_outputs' \
              "$source_dir/" "$app_dir/"

            cd "$app_dir"

            export HF_HOME="/work/hf-home"
            export UV_CACHE_DIR="/work/uv-cache"
            export UV_PYTHON_DOWNLOADS=never

            dependency_stamp="$(sha256sum pyproject.toml uv.lock | sha256sum | cut -d' ' -f1)"
            if [ ! -f "$stamp_file" ] || [ "$(cat "$stamp_file")" != "$dependency_stamp" ]; then
              rm -rf .venv
              uv sync --locked --no-dev --python "$(command -v python3)"
              printf '%s\n' "$dependency_stamp" > "$stamp_file"
            fi

            exec uv run --python "$(command -v python3)" python gradio_app.py --server-name 0.0.0.0 --server-port 7860 "$@"
          '';
        };

        voiceCloneBotRoot = pkgs.buildEnv {
          name = "voice-clone-bot-container-root";
          paths = botRuntimePackages ++ [
            botSourceTree
            voiceCloneBotEntrypoint
          ];
          pathsToLink = [
            "/bin"
            "/etc/ssl/certs"
            "/opt"
          ];
        };

        irodoriTtsRoot = pkgs.buildEnv {
          name = "irodori-tts-container-root";
          paths = irodoriRuntimePackages ++ [
            irodoriSourceTree
            irodoriTtsEntrypoint
          ];
          pathsToLink = [
            "/bin"
            "/etc/ssl/certs"
            "/lib"
            "/opt"
          ];
        };

        voiceCloneBotImage = pkgs.dockerTools.buildImage {
          name = "voice-clone-bot";
          tag = "local";
          copyToRoot = voiceCloneBotRoot;
          config = {
            Entrypoint = [ "/bin/voice-clone-bot-entrypoint" ];
            Env = [
              "HOME=/work"
              "PATH=/bin"
              "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
            ];
            WorkingDir = "/work/voice-clone-bot";
          };
        };

        irodoriTtsImage = pkgs.dockerTools.buildImage {
          name = "irodori-tts";
          tag = "local";
          copyToRoot = irodoriTtsRoot;
          config = {
            Entrypoint = [ "/bin/irodori-tts-entrypoint" ];
            Env = [
              "HF_HOME=/work/hf-home"
              "HOME=/work"
              "LD_LIBRARY_PATH=/lib"
              "PATH=/bin"
              "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
              "UV_CACHE_DIR=/work/uv-cache"
            ];
            WorkingDir = "/work/irodori-tts";
          };
        };

        loadVoiceCloneBotImage = pkgs.writeShellApplication {
          name = "load-voice-clone-bot-image";
          runtimeInputs = [ pkgs.docker ];
          text = ''
            docker load -i ${voiceCloneBotImage}
          '';
        };

        loadIrodoriTtsImage = pkgs.writeShellApplication {
          name = "load-irodori-tts-image";
          runtimeInputs = [ pkgs.docker ];
          text = ''
            docker load -i ${irodoriTtsImage}
          '';
        };

        loadAllImages = pkgs.writeShellApplication {
          name = "load-all-images";
          runtimeInputs = [ pkgs.docker ];
          text = ''
            docker load -i ${irodoriTtsImage}
            docker load -i ${voiceCloneBotImage}
          '';
        };
      in
      {
        devShell = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            docker
            ffmpeg
            nodejs_24
            rsync
            uv
          ];
        };

        packages = {
          default = voiceCloneBotImage;
          irodori-tts-image = irodoriTtsImage;
          voice-clone-bot-image = voiceCloneBotImage;
        };

        apps = {
          load-all-images = {
            type = "app";
            program = "${loadAllImages}/bin/load-all-images";
          };

          load-irodori-tts-image = {
            type = "app";
            program = "${loadIrodoriTtsImage}/bin/load-irodori-tts-image";
          };

          load-voice-clone-bot-image = {
            type = "app";
            program = "${loadVoiceCloneBotImage}/bin/load-voice-clone-bot-image";
          };
        };
      }
    );
}
