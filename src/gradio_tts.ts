import { spawn } from "node:child_process";

import { Client } from "@gradio/client";

export const DEFAULT_IRODORI_API_BASE_URL = "http://127.0.0.1:7860/";
export const RUN_GENERATION_ENDPOINT = "/_run_generation";
export const WAV_MIME_TYPE = "audio/wav";
export const DEFAULT_NUM_CANDIDATES = 1;

type ConnectedGradioClient = Awaited<ReturnType<typeof Client.connect>>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type EnvLike = Record<string, string | undefined>;
type FileLikeRecord = {
  path?: string;
  url?: string;
  value?: unknown;
};

export interface GradioApiParameter {
  parameter_name: string;
  parameter_has_default?: boolean;
  parameter_default?: unknown;
}

export interface GradioApiInfo {
  named_endpoints?: Record<
    string,
    {
      parameters?: GradioApiParameter[];
    }
  >;
}

export interface GradioClientLike {
  config?: {
    root: string;
  };
  api_prefix: ConnectedGradioClient["api_prefix"];
  predict(
    endpoint: string | number,
    data?: unknown[] | Record<string, unknown>,
  ): Promise<{ data: unknown }>;
  view_api(): Promise<GradioApiInfo>;
}

interface GradioTtsDeps {
  connect: (baseUrl: string) => Promise<GradioClientLike>;
  fetch: FetchLike;
  convertWavToPcm: (wavBytes: Buffer) => Promise<Buffer>;
  env: EnvLike;
}

function connectToGradio(baseUrl: string): Promise<GradioClientLike> {
  return Client.connect(baseUrl);
}

async function convertWavToPcmWithFfmpeg(wavBytes: Buffer): Promise<Buffer> {
  const child = spawn("ffmpeg", [
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const exitPromise = new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
      rejectPromise(new Error(stderr || `ffmpeg exited with status ${code ?? "unknown"}`));
    });
  });

  child.stdin.end(wavBytes);
  await exitPromise;
  return Buffer.concat(stdoutChunks);
}

function getApiBaseUrl(env: EnvLike): string {
  const rawValue = env.IRODORI_API_BASE_URL?.trim();
  const value = rawValue && rawValue.length > 0 ? rawValue : DEFAULT_IRODORI_API_BASE_URL;
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) {
    return value;
  }
  return `http://${value}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function extractEndpointDefaults(
  apiInfo: GradioApiInfo,
  endpoint = RUN_GENERATION_ENDPOINT,
): Record<string, unknown> {
  const endpointInfo = apiInfo.named_endpoints?.[endpoint];
  if (!endpointInfo?.parameters) {
    throw new Error(`Gradio endpoint metadata not found for ${endpoint}`);
  }

  const defaults: Record<string, unknown> = {};
  for (const parameter of endpointInfo.parameters) {
    if (parameter.parameter_has_default) {
      defaults[parameter.parameter_name] = parameter.parameter_default;
    }
  }
  return defaults;
}

export function buildRunGenerationPayload(
  defaults: Record<string, unknown>,
  text: string,
  referenceAudio: Buffer,
): Record<string, unknown> {
  return {
    ...defaults,
    text,
    uploaded_audio: new Blob([referenceAudio], { type: WAV_MIME_TYPE }),
    num_candidates: DEFAULT_NUM_CANDIDATES,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function findFirstFileLike(value: unknown): string | FileLikeRecord | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findFirstFileLike(item);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  if ("value" in value) {
    const nested = findFirstFileLike(value.value);
    if (nested) {
      return nested;
    }
  }

  if (typeof value.path === "string" || typeof value.url === "string") {
    return value as FileLikeRecord;
  }

  return null;
}

export function resolveFileUrl(
  fileValue: string | FileLikeRecord,
  rootUrl: string,
  apiPrefix: string,
): string {
  if (typeof fileValue === "string") {
    if (/^https?:\/\//.test(fileValue)) {
      return fileValue;
    }
    const root = ensureTrailingSlash(rootUrl);
    const prefix = apiPrefix.replace(/^\/+|\/+$/g, "");
    const filePath = prefix ? `${prefix}/file=${fileValue}` : `file=${fileValue}`;
    return new URL(filePath, root).toString();
  }

  if (typeof fileValue.url === "string" && fileValue.url.length > 0) {
    if (/^https?:\/\//.test(fileValue.url)) {
      return fileValue.url;
    }
    return new URL(fileValue.url, ensureTrailingSlash(rootUrl)).toString();
  }

  if (typeof fileValue.path === "string" && fileValue.path.length > 0) {
    return resolveFileUrl(fileValue.path, rootUrl, apiPrefix);
  }

  throw new Error("Gradio response did not contain a downloadable audio file");
}

async function downloadFileBuffer(fetchImpl: FetchLike, url: string): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to download generated audio: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export function createGradioTtsTransport(overrides: Partial<GradioTtsDeps> = {}) {
  const deps: GradioTtsDeps = {
    connect: connectToGradio,
    fetch,
    convertWavToPcm: convertWavToPcmWithFfmpeg,
    env: process.env,
    ...overrides,
  };

  let cachedBaseUrl: string | null = null;
  let clientPromise: Promise<GradioClientLike> | null = null;
  let defaultsPromise: Promise<Record<string, unknown>> | null = null;

  async function getClientAndDefaults(): Promise<{
    baseUrl: string;
    client: GradioClientLike;
    defaults: Record<string, unknown>;
  }> {
    const baseUrl = getApiBaseUrl(deps.env);
    if (cachedBaseUrl !== baseUrl || !clientPromise || !defaultsPromise) {
      cachedBaseUrl = baseUrl;
      clientPromise = deps.connect(baseUrl).catch((error) => {
        clientPromise = null;
        defaultsPromise = null;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to connect to Irodori Gradio API at ${baseUrl}: ${detail}`);
      });
      defaultsPromise = clientPromise.then(async (client) => {
        const apiInfo = await client.view_api();
        return extractEndpointDefaults(apiInfo);
      }).catch((error) => {
        clientPromise = null;
        defaultsPromise = null;
        throw error;
      });
    }

    const [client, defaults] = await Promise.all([clientPromise, defaultsPromise]);
    return { baseUrl, client, defaults };
  }

  async function synthesizeReadoutPcm(text: string, referenceAudio: Buffer): Promise<Buffer> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error("text is required");
    }
    if (referenceAudio.length === 0) {
      throw new Error("referenceAudio is empty");
    }

    const { baseUrl, client, defaults } = await getClientAndDefaults();
    const payload = buildRunGenerationPayload(defaults, normalizedText, referenceAudio);
    const prediction = await client.predict(RUN_GENERATION_ENDPOINT, payload);
    const fileValue = findFirstFileLike(prediction.data);
    if (!fileValue) {
      throw new Error("Gradio response did not include generated audio");
    }

    const rootUrl = client.config?.root ?? baseUrl;
    const fileUrl = resolveFileUrl(fileValue, rootUrl, client.api_prefix);
    const wavBytes = await downloadFileBuffer(deps.fetch, fileUrl);
    return deps.convertWavToPcm(wavBytes);
  }

  return {
    synthesizeReadoutPcm,
  };
}

export const synthesizeReadoutWithGradio = createGradioTtsTransport().synthesizeReadoutPcm;
