import { synthesizeReadoutWithGradio } from "./gradio_tts";
import { synthesizeReadoutWithOmniVoice } from "./omnivoice_tts";

type SynthesizeFn = (text: string, referenceAudio: Buffer) => Promise<Buffer>;

const backend = (process.env.TTS_BACKEND ?? "irodori").trim().toLowerCase();

let synthesizeReadoutPcm: SynthesizeFn;

switch (backend) {
  case "irodori":
    synthesizeReadoutPcm = synthesizeReadoutWithGradio;
    break;
  case "omnivoice":
    synthesizeReadoutPcm = synthesizeReadoutWithOmniVoice;
    break;
  default:
    throw new Error(`Unknown TTS_BACKEND: "${backend}" (expected "irodori" or "omnivoice")`);
}

export { synthesizeReadoutPcm };
