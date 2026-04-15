import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { Readable, Transform } from "node:stream";

import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Message,
  SlashCommandBuilder,
} from "discord.js";
import prism from "prism-media";

import { synthesizeReadoutWithGradio } from "./gradio_tts";

export const RECORDING_SECONDS = 180;
export const VOICE_CONNECTION_TIMEOUT_MS = 5_000;
export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 2;
export const PCM_BYTES_PER_SAMPLE = 2;
export const RECEIVE_END_BEHAVIOR = {
  behavior: EndBehaviorType.AfterSilence,
  duration: 1_000,
} as const;

const JOIN_COMMAND = new SlashCommandBuilder()
  .setName("join")
  .setDescription("Bind this text channel and join a voice channel.")
  .addChannelOption((option) =>
    option
      .setName("vc")
      .setDescription("The voice channel to join. Defaults to your current channel.")
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
  );

export interface QueuedReadout {
  generation: number;
  text: string;
}

export interface VoiceChannelLike {
  id: string;
  guild: {
    id: string;
    voiceAdapterCreator: unknown;
  };
}

export interface VoiceReceiverLike {
  speaking: EventEmitter;
  subscribe(
    userId: string,
    options?: {
      end?: {
        behavior: EndBehaviorType;
        duration?: number;
      };
    },
  ): Readable;
}

export interface VoiceConnectionLike extends EventEmitter {
  state: {
    status: string;
  };
  joinConfig: {
    channelId: string;
    guildId: string;
  };
  receiver: VoiceReceiverLike;
  subscribe(player: AudioPlayerLike): unknown;
  destroy(): void;
}

export interface AudioPlayerLike extends EventEmitter {
  state: {
    status: string;
  };
  play(resource: unknown): void;
  stop(force?: boolean): boolean;
}

type TimerHandle = ReturnType<typeof setInterval>;

interface ActiveRecordingStream {
  destroy(): void;
}

export interface GuildVoiceRuntime {
  connection: VoiceConnectionLike;
  player: AudioPlayerLike;
  channelId: string;
  segmentTimer: TimerHandle;
  segmentChunks: Map<string, Buffer[]>;
  recordingStreams: Map<string, ActiveRecordingStream>;
  cleanupCallbacks: Array<() => void>;
  destroyed: boolean;
}

export interface GuildSession {
  boundTextChannelId: string | null;
  bindingGeneration: number;
  queue: QueuedReadout[];
  queueWaiters: Array<(item: QueuedReadout) => void>;
  pendingReadouts: number;
  idleWaiters: Array<() => void>;
  workerPromise: Promise<void> | null;
  workerAbortController: AbortController | null;
  recordings: Map<string, Buffer>;
  voiceRuntime: GuildVoiceRuntime | null;
}

type LoggerLike = Pick<Console, "error" | "warn">;

interface JoinInteractionLike {
  guildId: string | null;
  guild?: {
    id: string;
  } | null;
  channelId: string | null;
  member?: unknown;
  options?: {
    getChannel?: (name: string, required?: boolean) => unknown;
  } | null;
  user?: {
    id: string;
  } | null;
  deferReply?: () => Promise<unknown>;
  reply?: (payload: { content: string }) => Promise<unknown>;
  editReply?: (payload: { content: string }) => Promise<unknown>;
}

interface MessageLike {
  guildId: string | null;
  channelId: string;
  cleanContent: string;
  author?: {
    bot?: boolean;
  } | null;
}

interface VoiceCloneServiceDeps {
  createVoiceConnection: (channel: VoiceChannelLike) => VoiceConnectionLike;
  waitForConnectionReady: (connection: VoiceConnectionLike) => Promise<void>;
  createAudioPlayer: () => AudioPlayerLike;
  createAudioResourceFromPcm: (pcm: Buffer) => unknown;
  waitForPlayerIdle: (player: AudioPlayerLike) => Promise<void>;
  createOpusDecoder: () => Transform;
  synthesizeReadoutPcm: (text: string, referenceAudio: Buffer) => Promise<Buffer>;
  setRepeatingTimer: (callback: () => void, intervalMs: number) => TimerHandle;
  clearRepeatingTimer: (timer: TimerHandle) => void;
  random: () => number;
  logger: LoggerLike;
}

function createDefaultVoiceConnection(channel: VoiceChannelLike): VoiceConnectionLike {
  return joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator as never,
    selfDeaf: false,
  }) as unknown as VoiceConnectionLike;
}

async function waitForDefaultConnectionReady(connection: VoiceConnectionLike): Promise<void> {
  await entersState(
    connection as never,
    VoiceConnectionStatus.Ready,
    VOICE_CONNECTION_TIMEOUT_MS,
  );
}

function createDefaultPlayer(): AudioPlayerLike {
  return createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  }) as unknown as AudioPlayerLike;
}

function createDefaultAudioResourceFromPcm(pcm: Buffer): unknown {
  return createAudioResource(Readable.from(pcm), {
    inputType: StreamType.Raw,
  });
}

async function waitForDefaultPlayerIdle(player: AudioPlayerLike): Promise<void> {
  if (player.state.status === AudioPlayerStatus.Idle) {
    return;
  }
  await entersState(player as never, AudioPlayerStatus.Idle, 30_000);
}

function createDefaultOpusDecoder(): Transform {
  return new prism.opus.Decoder({
    channels: PCM_CHANNELS,
    frameSize: 960,
    rate: PCM_SAMPLE_RATE,
  });
}

function createEmptyGuildSession(): GuildSession {
  return {
    boundTextChannelId: null,
    bindingGeneration: 0,
    queue: [],
    queueWaiters: [],
    pendingReadouts: 0,
    idleWaiters: [],
    workerPromise: null,
    workerAbortController: null,
    recordings: new Map(),
    voiceRuntime: null,
  };
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function encodePcmAsWav(pcm: Buffer): Buffer {
  const bytesPerFrame = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;
  const byteRate = PCM_SAMPLE_RATE * bytesPerFrame;
  const blockAlign = bytesPerFrame;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE * 8, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

export class VoiceCloneService {
  private readonly sessions = new Map<string, GuildSession>();
  private readonly deps: VoiceCloneServiceDeps;

  constructor(overrides: Partial<VoiceCloneServiceDeps> = {}) {
    this.deps = {
      createVoiceConnection: createDefaultVoiceConnection,
      waitForConnectionReady: waitForDefaultConnectionReady,
      createAudioPlayer: createDefaultPlayer,
      createAudioResourceFromPcm: createDefaultAudioResourceFromPcm,
      waitForPlayerIdle: waitForDefaultPlayerIdle,
      createOpusDecoder: createDefaultOpusDecoder,
      synthesizeReadoutPcm: synthesizeReadoutWithGradio,
      setRepeatingTimer: setInterval,
      clearRepeatingTimer: clearInterval,
      random: Math.random,
      logger: console,
      ...overrides,
    };
  }

  getGuildSession(guildId: string): GuildSession {
    let session = this.sessions.get(guildId);
    if (!session) {
      session = createEmptyGuildSession();
      this.sessions.set(guildId, session);
    }
    return session;
  }

  bindTextChannel(guildId: string, channelId: string): GuildSession {
    const session = this.getGuildSession(guildId);
    session.boundTextChannelId = channelId;
    session.bindingGeneration += 1;
    return session;
  }

  async handleJoin(interaction: JoinInteractionLike): Promise<void> {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const voiceChannel = this.extractVoiceChannel(interaction);

    if (!guildId || !channelId) {
      await this.respond(interaction, "サーバー内のテキストチャンネルで使ってね");
      return;
    }

    if (!voiceChannel) {
      await this.respond(interaction, "先にボイスチャンネルに入るか、`/join vc:<チャンネル>` を指定してね");
      return;
    }

    if (interaction.deferReply) {
      await interaction.deferReply();
    }

    const session = this.bindTextChannel(guildId, channelId);
    const runtime = session.voiceRuntime;
    const needsFreshRuntime = !runtime || runtime.channelId !== voiceChannel.id || runtime.destroyed;

    if (needsFreshRuntime) {
      if (runtime) {
        this.destroyVoiceRuntime(guildId);
      }
      session.voiceRuntime = await this.createVoiceRuntime(guildId, voiceChannel);
      this.ensureWorkerRunning(guildId, session);
      await this.respond(
        interaction,
        "3分ごとの録音を開始して、このチャンネルを読み上げ対象に設定したよ",
        true,
      );
      return;
    }

    await this.respond(interaction, "このチャンネルを読み上げ対象に設定したよ", true);
  }

  async handleMessage(message: MessageLike): Promise<void> {
    if (!message.guildId || message.author?.bot) {
      return;
    }

    const session = this.getGuildSession(message.guildId);
    if (!session.boundTextChannelId || session.boundTextChannelId !== message.channelId) {
      return;
    }

    const text = normalizeText(message.cleanContent);
    if (!text) {
      return;
    }

    this.enqueueReadout(message.guildId, {
      generation: session.bindingGeneration,
      text,
    });
  }

  enqueueReadout(guildId: string, item: QueuedReadout): void {
    const session = this.getGuildSession(guildId);
    session.queue.push(item);
    session.pendingReadouts += 1;

    this.ensureWorkerRunning(guildId, session);
    queueMicrotask(() => {
      this.ensureWorkerRunning(guildId, session);
    });
  }

  async waitForQueueDrained(guildId: string): Promise<void> {
    const session = this.getGuildSession(guildId);
    if (session.queue.length === 0 && session.pendingReadouts === 0) {
      return;
    }

    await new Promise<void>((resolvePromise) => {
      session.idleWaiters.push(resolvePromise);
    });
  }

  flushRecordingSegment(guildId: string): void {
    const session = this.getGuildSession(guildId);
    const runtime = session.voiceRuntime;
    if (!runtime) {
      return;
    }

    for (const [userId, chunks] of runtime.segmentChunks.entries()) {
      if (chunks.length === 0) {
        continue;
      }
      session.recordings.set(userId, encodePcmAsWav(Buffer.concat(chunks)));
    }

    runtime.segmentChunks.clear();
  }

  destroyVoiceRuntime(guildId: string): void {
    const session = this.getGuildSession(guildId);
    const runtime = session.voiceRuntime;
    if (!runtime) {
      return;
    }

    runtime.destroyed = true;
    this.flushRecordingSegment(guildId);
    this.deps.clearRepeatingTimer(runtime.segmentTimer);

    for (const cleanup of runtime.cleanupCallbacks.splice(0)) {
      cleanup();
    }

    for (const stream of runtime.recordingStreams.values()) {
      stream.destroy();
    }

    runtime.recordingStreams.clear();
    runtime.segmentChunks.clear();
    runtime.player.stop(true);
    runtime.connection.destroy();
    session.voiceRuntime = null;
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.workerAbortController?.abort();
    }

    await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.workerPromise).filter(Boolean),
    );

    for (const guildId of this.sessions.keys()) {
      this.destroyVoiceRuntime(guildId);
    }
  }

  private async runGuildWorker(guildId: string, session: GuildSession): Promise<void> {
    while (session.queue.length > 0) {
      if (session.workerAbortController?.signal.aborted) {
        break;
      }

      const item = session.queue.shift();
      if (!item) {
        break;
      }

      try {
        if (item.generation !== session.bindingGeneration) {
          continue;
        }
        await this.playReadout(guildId, item.text);
      } catch (error) {
        this.deps.logger.error(error);
      } finally {
        session.pendingReadouts = Math.max(0, session.pendingReadouts - 1);
        this.resolveIdleWaiters(session);
      }
    }
  }

  private ensureWorkerRunning(guildId: string, session: GuildSession): void {
    if (!session.voiceRuntime || session.workerPromise || session.queue.length === 0) {
      return;
    }

    session.workerAbortController = new AbortController();
    session.workerPromise = this.runGuildWorker(guildId, session).finally(() => {
      session.workerPromise = null;
      session.workerAbortController = null;
      this.resolveIdleWaiters(session);
    });
  }

  private async playReadout(guildId: string, text: string): Promise<void> {
    const session = this.getGuildSession(guildId);
    const runtime = session.voiceRuntime;
    const referenceAudio = this.pickReferenceAudio(session);

    if (!runtime || runtime.destroyed || !referenceAudio) {
      return;
    }

    const pcm = await this.deps.synthesizeReadoutPcm(text, referenceAudio);
    const resource = this.deps.createAudioResourceFromPcm(pcm);
    runtime.player.play(resource);
    await this.deps.waitForPlayerIdle(runtime.player);
  }

  private pickReferenceAudio(session: GuildSession): Buffer | null {
    const recordings = [...session.recordings.values()];
    if (recordings.length === 0) {
      return null;
    }

    const index = Math.min(recordings.length - 1, Math.floor(this.deps.random() * recordings.length));
    return recordings[index] ?? null;
  }

  private async createVoiceRuntime(
    guildId: string,
    voiceChannel: VoiceChannelLike,
  ): Promise<GuildVoiceRuntime> {
    const connection = this.deps.createVoiceConnection(voiceChannel);
    await this.deps.waitForConnectionReady(connection);

    const player = this.deps.createAudioPlayer();
    connection.subscribe(player);

    const runtime: GuildVoiceRuntime = {
      connection,
      player,
      channelId: voiceChannel.id,
      segmentTimer: this.deps.setRepeatingTimer(() => {
        this.flushRecordingSegment(guildId);
      }, RECORDING_SECONDS * 1_000),
      segmentChunks: new Map(),
      recordingStreams: new Map(),
      cleanupCallbacks: [],
      destroyed: false,
    };

    this.attachRecorder(guildId, runtime);
    return runtime;
  }

  private attachRecorder(guildId: string, runtime: GuildVoiceRuntime): void {
    const onSpeakingStart = (userId: string) => {
      if (runtime.destroyed || runtime.recordingStreams.has(userId)) {
        return;
      }

      const opusStream = runtime.connection.receiver.subscribe(userId, {
        end: RECEIVE_END_BEHAVIOR,
      });
      const decoder = this.deps.createOpusDecoder();
      const chunks = runtime.segmentChunks.get(userId) ?? [];
      runtime.segmentChunks.set(userId, chunks);

      const onData = (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
      };

      decoder.on("data", onData);
      opusStream.pipe(decoder);

      const cleanup = () => {
        decoder.off("data", onData);
        opusStream.unpipe(decoder);
        decoder.destroy();
        runtime.recordingStreams.delete(userId);
      };

      runtime.recordingStreams.set(userId, {
        destroy: cleanup,
      });

      opusStream.once("end", cleanup);
      opusStream.once("close", cleanup);
      opusStream.once("error", () => {
        cleanup();
        this.deps.logger.warn(`recording stream failed for guild ${guildId} user ${userId}`);
      });
      decoder.once("error", () => {
        cleanup();
        this.deps.logger.warn(`opus decode failed for guild ${guildId} user ${userId}`);
      });
    };

    runtime.connection.receiver.speaking.on("start", onSpeakingStart);
    runtime.cleanupCallbacks.push(() => {
      runtime.connection.receiver.speaking.off("start", onSpeakingStart);
    });
  }

  private resolveIdleWaiters(session: GuildSession): void {
    if (session.queue.length > 0 || session.pendingReadouts > 0) {
      return;
    }

    for (const waiter of session.idleWaiters.splice(0)) {
      waiter();
    }
  }

  private extractVoiceChannel(interaction: JoinInteractionLike): VoiceChannelLike | null {
    const selectedChannel = interaction.options?.getChannel?.("vc", false);
    if (this.isVoiceChannelLike(selectedChannel)) {
      return selectedChannel;
    }

    const member = interaction.member as { voice?: { channel?: VoiceChannelLike | null } } | null | undefined;
    return member?.voice?.channel ?? null;
  }

  private isVoiceChannelLike(channel: unknown): channel is VoiceChannelLike {
    return (
      !!channel &&
      typeof channel === "object" &&
      "id" in channel &&
      "guild" in channel &&
      typeof (channel as { id?: unknown }).id === "string"
    );
  }

  private async respond(
    interaction: JoinInteractionLike,
    content: string,
    preferEdit = false,
  ): Promise<void> {
    const payload = { content };
    if (preferEdit && interaction.editReply) {
      await interaction.editReply(payload);
      return;
    }
    if (interaction.reply) {
      await interaction.reply(payload);
      return;
    }
    if (interaction.editReply) {
      await interaction.editReply(payload);
      return;
    }
    throw new Error("Interaction has no reply method");
  }
}

export function createDiscordClient(service = new VoiceCloneService()): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once("clientReady", async () => {
    if (!client.application) {
      return;
    }
    await client.application.commands.set([JOIN_COMMAND.toJSON()]);
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "join") {
      return;
    }

    await service.handleJoin(interaction as ChatInputCommandInteraction);
  });

  client.on("messageCreate", async (message) => {
    await service.handleMessage(message as unknown as Message);
  });

  return client;
}

export async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN is not set.");
  }

  const client = createDiscordClient();
  await client.login(token);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
