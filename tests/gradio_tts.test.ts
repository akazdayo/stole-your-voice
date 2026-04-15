import { describe, expect, test } from "bun:test";

import {
  RUN_GENERATION_ENDPOINT,
  buildRunGenerationPayload,
  createGradioTtsTransport,
  extractEndpointDefaults,
  findFirstFileLike,
  resolveFileUrl,
} from "../src/gradio_tts";

describe("gradio_tts", () => {
  test("extractEndpointDefaults collects server-provided defaults", () => {
    const defaults = extractEndpointDefaults({
      named_endpoints: {
        [RUN_GENERATION_ENDPOINT]: {
          parameters: [
            {
              parameter_name: "checkpoint",
              parameter_has_default: true,
              parameter_default: "Aratako/Irodori-TTS-500M-v2",
            },
            {
              parameter_name: "text",
              parameter_has_default: false,
            },
            {
              parameter_name: "num_candidates",
              parameter_has_default: true,
              parameter_default: 4,
            },
          ],
        },
      },
    });

    expect(defaults).toEqual({
      checkpoint: "Aratako/Irodori-TTS-500M-v2",
      num_candidates: 4,
    });
  });

  test("buildRunGenerationPayload overrides text, audio, and num_candidates", async () => {
    const payload = buildRunGenerationPayload(
      {
        checkpoint: "checkpoint-a",
        num_candidates: 8,
      },
      "hello",
      Buffer.from("wav-data"),
    );

    expect(payload.checkpoint).toBe("checkpoint-a");
    expect(payload.text).toBe("hello");
    expect(payload.num_candidates).toBe(1);
    expect(payload.uploaded_audio).toBeInstanceOf(Blob);
    expect(await (payload.uploaded_audio as Blob).text()).toBe("wav-data");
  });

  test("findFirstFileLike unwraps gr.update style payloads", () => {
    const value = findFirstFileLike([
      {
        __type__: "update",
        value: {
          path: "/tmp/generated.wav",
        },
      },
      "ignored",
    ]);

    expect(value).toEqual({
      path: "/tmp/generated.wav",
    });
  });

  test("resolveFileUrl prefers direct url and falls back to Gradio file route", () => {
    expect(
      resolveFileUrl(
        {
          url: "/gradio_api/file=/tmp/generated.wav",
        },
        "http://127.0.0.1:7860/",
        "/gradio_api",
      ),
    ).toBe("http://127.0.0.1:7860/gradio_api/file=/tmp/generated.wav");

    expect(
      resolveFileUrl(
        {
          path: "/tmp/generated.wav",
        },
        "http://127.0.0.1:7860/",
        "/gradio_api",
      ),
    ).toBe("http://127.0.0.1:7860/gradio_api/file=/tmp/generated.wav");
  });

  test("transport builds payload from defaults and converts downloaded wav", async () => {
    const predictCalls: Array<Record<string, unknown>> = [];
    const transport = createGradioTtsTransport({
      env: {
        IRODORI_API_BASE_URL: "http://127.0.0.1:7860/",
      },
      connect: async (_baseUrl: string) => ({
        api_prefix: "/gradio_api",
        config: {
          root: "http://127.0.0.1:7860/",
        },
        view_api: async () => ({
          named_endpoints: {
            [RUN_GENERATION_ENDPOINT]: {
              parameters: [
                {
                  parameter_name: "checkpoint",
                  parameter_has_default: true,
                  parameter_default: "checkpoint-a",
                },
                {
                  parameter_name: "num_candidates",
                  parameter_has_default: true,
                  parameter_default: 3,
                },
              ],
            },
          },
        }),
        predict: async (_endpoint: string | number, data?: unknown[] | Record<string, unknown>) => {
          predictCalls.push(data as Record<string, unknown>);
          return {
            data: [
              {
                value: {
                  path: "/tmp/generated.wav",
                },
              },
            ],
          };
        },
      }),
      fetch: async (input: string | URL | Request) => {
        expect(String(input)).toBe("http://127.0.0.1:7860/gradio_api/file=/tmp/generated.wav");
        return new Response(Buffer.from("wav-output"));
      },
      convertWavToPcm: async (wavBytes: Buffer) => {
        expect(wavBytes.toString("utf-8")).toBe("wav-output");
        return Buffer.from("pcm-output");
      },
    });

    const pcm = await transport.synthesizeReadoutPcm("hello", Buffer.from("reference"));

    expect(pcm.toString("utf-8")).toBe("pcm-output");
    expect(predictCalls).toHaveLength(1);
    expect(predictCalls[0]?.checkpoint).toBe("checkpoint-a");
    expect(predictCalls[0]?.text).toBe("hello");
    expect(predictCalls[0]?.num_candidates).toBe(1);
    expect(predictCalls[0]?.uploaded_audio).toBeInstanceOf(Blob);
  });

  test("transport surfaces Gradio connection errors with base url", async () => {
    const transport = createGradioTtsTransport({
      env: {
        IRODORI_API_BASE_URL: "http://127.0.0.1:9999/",
      },
      connect: async (_baseUrl: string) => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    await expect(
      transport.synthesizeReadoutPcm("hello", Buffer.from("reference")),
    ).rejects.toThrow("Failed to connect to Irodori Gradio API at http://127.0.0.1:9999/: connect ECONNREFUSED");
  });

  test("transport normalizes base url without scheme", async () => {
    let connectedBaseUrl = "";
    const transport = createGradioTtsTransport({
      env: {
        IRODORI_API_BASE_URL: "127.0.0.1:7860",
      },
      connect: async (baseUrl: string) => {
        connectedBaseUrl = baseUrl;
        throw new Error("connect ECONNREFUSED");
      },
    });

    await expect(
      transport.synthesizeReadoutPcm("hello", Buffer.from("reference")),
    ).rejects.toThrow("Failed to connect to Irodori Gradio API at http://127.0.0.1:7860: connect ECONNREFUSED");
    expect(connectedBaseUrl).toBe("http://127.0.0.1:7860");
  });
});
