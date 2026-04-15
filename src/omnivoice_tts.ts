import { convertWavToPcmWithFfmpeg } from "./gradio_tts";

export const DEFAULT_OMNIVOICE_API_BASE_URL = "http://127.0.0.1:8000";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type EnvLike = Record<string, string | undefined>;

interface OmniVoiceTtsDeps {
  fetch: FetchLike;
  convertWavToPcm: (wavBytes: Buffer) => Promise<Buffer>;
  env: EnvLike;
}

function getApiBaseUrl(env: EnvLike): string {
  const rawValue = env.OMNIVOICE_API_BASE_URL?.trim();
  const value = rawValue && rawValue.length > 0 ? rawValue : DEFAULT_OMNIVOICE_API_BASE_URL;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) {
    return value;
  }
  return `http://${value}`;
}

export function createOmniVoiceTtsTransport(overrides: Partial<OmniVoiceTtsDeps> = {}) {
  const deps: OmniVoiceTtsDeps = {
    fetch,
    convertWavToPcm: convertWavToPcmWithFfmpeg,
    env: process.env,
    ...overrides,
  };

  async function synthesizeReadoutPcm(text: string, referenceAudio: Buffer): Promise<Buffer> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error("text is required");
    }
    if (referenceAudio.length === 0) {
      throw new Error("referenceAudio is empty");
    }

    const baseUrl = getApiBaseUrl(deps.env);
    const url = `${baseUrl.replace(/\/+$/, "")}/generate`;

    const form = new FormData();
    form.append("ref_audio", new Blob([referenceAudio], { type: "audio/wav" }), "ref.wav");
    form.append("text", normalizedText);

    const response = await deps.fetch(url, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Omni-Voice API error: HTTP ${response.status}`);
    }

    const wavBytes = Buffer.from(await response.arrayBuffer());
    return deps.convertWavToPcm(wavBytes);
  }

  return { synthesizeReadoutPcm };
}

export const synthesizeReadoutWithOmniVoice = createOmniVoiceTtsTransport().synthesizeReadoutPcm;
