import { EventEmitter } from "node:events";
import { PassThrough, Transform } from "node:stream";

import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  RECORDING_SECONDS,
  VoiceCloneService,
  type AudioPlayerLike,
  type GuildVoiceRuntime,
  type VoiceChannelLike,
  type VoiceConnectionLike,
  type VoiceReceiverLike,
} from "../src/index";

class MockReceiver implements VoiceReceiverLike {
  readonly speaking = new EventEmitter();
  readonly subscribe = mock((_userId: string) => new PassThrough());
}

class MockConnection extends EventEmitter implements VoiceConnectionLike {
  readonly receiver = new MockReceiver();
  subscribe = mock((_player: AudioPlayerLike) => undefined);
  destroy = mock(() => undefined);
  state = {
    status: VoiceConnectionStatus.Ready,
  };

  constructor(
    readonly joinConfig: {
      channelId: string;
      guildId: string;
    },
  ) {
    super();
  }
}

class MockAudioPlayer extends EventEmitter implements AudioPlayerLike {
  play = mock((_resource: unknown) => undefined);
  stop = mock((_force?: boolean) => true);
  state = {
    status: AudioPlayerStatus.Idle,
  };
}

function createVoiceChannel(id: string, guildId = "guild-1"): VoiceChannelLike {
  return {
    id,
    guild: {
      id: guildId,
      voiceAdapterCreator: {},
    },
  };
}

function createRuntime(
  guildId: string,
  channelId: string,
): {
  runtime: GuildVoiceRuntime;
  connection: MockConnection;
  player: MockAudioPlayer;
} {
  const connection = new MockConnection({ guildId, channelId });
  const player = new MockAudioPlayer();
  return {
    runtime: {
      connection,
      player,
      channelId,
      segmentTimer: setInterval(() => undefined, RECORDING_SECONDS * 1_000),
      segmentChunks: new Map(),
      recordingStreams: new Map(),
      cleanupCallbacks: [],
      destroyed: false,
    },
    connection,
    player,
  };
}

describe("VoiceCloneService", () => {
  const timers: Array<ReturnType<typeof setInterval>> = [];

  beforeEach(() => {
    timers.length = 0;
  });

  afterEach(() => {
    for (const timer of timers.splice(0)) {
      clearInterval(timer);
    }
  });

  test("handleJoin starts recording runtime and binds channel", async () => {
    const voiceChannel = createVoiceChannel("voice-1");
    const connection = new MockConnection({ guildId: "guild-1", channelId: voiceChannel.id });
    const createVoiceConnection = mock(() => connection);
    const service = new VoiceCloneService({
      createVoiceConnection,
      waitForConnectionReady: mock(async () => undefined),
      createAudioPlayer: mock(() => new MockAudioPlayer()),
      createAudioResourceFromPcm: mock((pcm: Buffer) => pcm),
      waitForPlayerIdle: mock(async () => undefined),
      createOpusDecoder: mock(
        () =>
          new Transform({
            transform(chunk, _encoding, callback) {
              callback(null, chunk);
            },
          }),
      ),
      synthesizeReadoutPcm: mock(async () => Buffer.alloc(0)),
      setRepeatingTimer: mock((callback: () => void, intervalMs: number) => {
        const timer = setInterval(callback, intervalMs);
        timers.push(timer);
        return timer;
      }),
      clearRepeatingTimer: clearInterval,
      random: () => 0,
      logger: console,
    });

    const deferReply = mock(async () => undefined);
    const editReply = mock(async (_content: unknown) => undefined);
    await service.handleJoin({
      guildId: "guild-1",
      guild: {
        id: "guild-1",
      },
      channelId: "text-1",
      member: {
        voice: {
          channel: voiceChannel,
        },
      },
      user: {
        id: "user-1",
      },
      deferReply,
      editReply,
    });

    const session = service.getGuildSession("guild-1");
    expect(session.boundTextChannelId).toBe("text-1");
    expect(session.bindingGeneration).toBe(1);
    expect(session.voiceRuntime?.channelId).toBe("voice-1");
    expect(createVoiceConnection).toHaveBeenCalledTimes(1);
    expect(connection.subscribe).toHaveBeenCalledTimes(1);
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledWith({
      content: "3分ごとの録音を開始して、このチャンネルを読み上げ対象に設定したよ",
    });

    await service.dispose();
  });

  test("handleJoin rebinds channel while recording without reconnecting", async () => {
    const service = new VoiceCloneService({
      createVoiceConnection: mock(() => {
        throw new Error("should not create a new connection");
      }),
      waitForConnectionReady: mock(async () => undefined),
      createAudioPlayer: mock(() => new MockAudioPlayer()),
      createAudioResourceFromPcm: mock((pcm: Buffer) => pcm),
      waitForPlayerIdle: mock(async () => undefined),
      createOpusDecoder: mock(
        () =>
          new Transform({
            transform(chunk, _encoding, callback) {
              callback(null, chunk);
            },
          }),
      ),
      synthesizeReadoutPcm: mock(async () => Buffer.alloc(0)),
      setRepeatingTimer: mock((callback: () => void, intervalMs: number) => {
        const timer = setInterval(callback, intervalMs);
        timers.push(timer);
        return timer;
      }),
      clearRepeatingTimer: clearInterval,
      random: () => 0,
      logger: console,
    });

    const existing = createRuntime("guild-1", "voice-1");
    service.getGuildSession("guild-1").voiceRuntime = existing.runtime;

    const editReply = mock(async (_content: unknown) => undefined);
    await service.handleJoin({
      guildId: "guild-1",
      guild: {
        id: "guild-1",
      },
      channelId: "text-2",
      member: {
        voice: {
          channel: createVoiceChannel("voice-1"),
        },
      },
      user: {
        id: "user-1",
      },
      deferReply: mock(async () => undefined),
      editReply,
    });

    const session = service.getGuildSession("guild-1");
    expect(session.boundTextChannelId).toBe("text-2");
    expect(session.bindingGeneration).toBe(1);
    expect(editReply).toHaveBeenCalledWith({
      content: "このチャンネルを読み上げ対象に設定したよ",
    });

    await service.dispose();
  });

  test("handleJoin joins explicitly selected voice channel", async () => {
    const selectedVoiceChannel = createVoiceChannel("voice-target");
    const connection = new MockConnection({
      guildId: "guild-1",
      channelId: selectedVoiceChannel.id,
    });
    const createVoiceConnection = mock(() => connection);
    const service = new VoiceCloneService({
      createVoiceConnection,
      waitForConnectionReady: mock(async () => undefined),
      createAudioPlayer: mock(() => new MockAudioPlayer()),
      createAudioResourceFromPcm: mock((pcm: Buffer) => pcm),
      waitForPlayerIdle: mock(async () => undefined),
      createOpusDecoder: mock(
        () =>
          new Transform({
            transform(chunk, _encoding, callback) {
              callback(null, chunk);
            },
          }),
      ),
      synthesizeReadoutPcm: mock(async () => Buffer.alloc(0)),
      setRepeatingTimer: mock((callback: () => void, intervalMs: number) => {
        const timer = setInterval(callback, intervalMs);
        timers.push(timer);
        return timer;
      }),
      clearRepeatingTimer: clearInterval,
      random: () => 0,
      logger: console,
    });

    const editReply = mock(async (_content: unknown) => undefined);
    await service.handleJoin({
      guildId: "guild-1",
      guild: {
        id: "guild-1",
      },
      channelId: "text-1",
      member: {},
      options: {
        getChannel: mock((name: string) => (name === "vc" ? selectedVoiceChannel : null)),
      },
      user: {
        id: "user-1",
      },
      deferReply: mock(async () => undefined),
      editReply,
    });

    const session = service.getGuildSession("guild-1");
    expect(session.boundTextChannelId).toBe("text-1");
    expect(session.voiceRuntime?.channelId).toBe("voice-target");
    expect(createVoiceConnection).toHaveBeenCalledWith(selectedVoiceChannel);
    expect(editReply).toHaveBeenCalledWith({
      content: "3分ごとの録音を開始して、このチャンネルを読み上げ対象に設定したよ",
    });

    await service.dispose();
  });

  test("handleMessage enqueues only bound channel messages", async () => {
    const service = new VoiceCloneService({
      logger: console,
    });
    const session = service.getGuildSession("guild-1");
    session.boundTextChannelId = "text-1";
    session.bindingGeneration = 3;

    await service.handleMessage({
      guildId: "guild-1",
      channelId: "other",
      cleanContent: "ignored",
      author: {
        bot: false,
      },
    });
    expect(session.queue).toHaveLength(0);

    await service.handleMessage({
      guildId: "guild-1",
      channelId: "text-1",
      cleanContent: "  hello   world  ",
      author: {
        bot: false,
      },
    });

    expect(session.queue).toEqual([
      {
        generation: 3,
        text: "hello world",
      },
    ]);
  });

  test("flushRecordingSegment stores user recordings as wav", () => {
    const service = new VoiceCloneService({
      logger: console,
    });
    const { runtime } = createRuntime("guild-1", "voice-1");
    runtime.segmentChunks.set("user-10", [Buffer.from([1, 2, 3, 4])]);
    runtime.segmentChunks.set("user-20", [Buffer.from([5, 6])]);
    service.getGuildSession("guild-1").voiceRuntime = runtime;

    service.flushRecordingSegment("guild-1");

    const recordings = service.getGuildSession("guild-1").recordings;
    expect(recordings.get("user-10")?.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(recordings.get("user-20")?.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(runtime.segmentChunks.size).toBe(0);

    service.destroyVoiceRuntime("guild-1");
  });

  test("worker skips stale items and preserves fifo for current generation", async () => {
    const played: string[] = [];
    const service = new VoiceCloneService({
      createAudioResourceFromPcm: mock((pcm: Buffer) => pcm),
      waitForPlayerIdle: mock(async () => undefined),
      synthesizeReadoutPcm: mock(async (text: string) => Buffer.from(text, "utf-8")),
      createVoiceConnection: mock(() => new MockConnection({ guildId: "guild-1", channelId: "voice-1" })),
      waitForConnectionReady: mock(async () => undefined),
      createAudioPlayer: mock(() => {
        const player = new MockAudioPlayer();
        player.play = mock((resource: unknown) => {
          played.push((resource as Buffer).toString("utf-8"));
        });
        return player;
      }),
      createOpusDecoder: mock(
        () =>
          new Transform({
            transform(chunk, _encoding, callback) {
              callback(null, chunk);
            },
          }),
      ),
      setRepeatingTimer: mock((callback: () => void, intervalMs: number) => {
        const timer = setInterval(callback, intervalMs);
        timers.push(timer);
        return timer;
      }),
      clearRepeatingTimer: clearInterval,
      random: () => 0,
      logger: console,
    });

    const session = service.bindTextChannel("guild-1", "text-1");
    session.bindingGeneration = 2;
    session.recordings.set("user-1", Buffer.from("ref"));
    const { runtime } = createRuntime("guild-1", "voice-1");
    runtime.player.play = mock((resource: unknown) => {
      played.push((resource as Buffer).toString("utf-8"));
    });
    session.voiceRuntime = runtime;

    service.enqueueReadout("guild-1", {
      generation: 1,
      text: "old",
    });
    service.enqueueReadout("guild-1", {
      generation: 2,
      text: "first",
    });
    service.enqueueReadout("guild-1", {
      generation: 2,
      text: "second",
    });

    await service.waitForQueueDrained("guild-1");

    expect(played).toEqual(["first", "second"]);
    await service.dispose();
  });

  test("worker sends selected reference audio to synthesis request and plays the result", async () => {
    const played: string[] = [];
    const requests: Array<{ text: string; referenceAudio: Buffer }> = [];
    const synthesizeReadoutPcm = mock(async (text: string, referenceAudio: Buffer) => {
      requests.push({
        text,
        referenceAudio: Buffer.from(referenceAudio),
      });
      return Buffer.from(`pcm:${text}`, "utf-8");
    });

    const service = new VoiceCloneService({
      createAudioResourceFromPcm: mock((pcm: Buffer) => Buffer.from(`resource:${pcm.toString("utf-8")}`, "utf-8")),
      waitForPlayerIdle: mock(async () => undefined),
      synthesizeReadoutPcm,
      setRepeatingTimer: mock((callback: () => void, intervalMs: number) => {
        const timer = setInterval(callback, intervalMs);
        timers.push(timer);
        return timer;
      }),
      clearRepeatingTimer: clearInterval,
      random: () => 0.99,
      logger: console,
    });

    const session = service.bindTextChannel("guild-1", "text-1");
    session.bindingGeneration = 1;
    session.recordings.set("user-1", Buffer.from("ref-a"));
    session.recordings.set("user-2", Buffer.from("ref-b"));
    const { runtime } = createRuntime("guild-1", "voice-1");
    runtime.player.play = mock((resource: unknown) => {
      played.push((resource as Buffer).toString("utf-8"));
    });
    session.voiceRuntime = runtime;

    service.enqueueReadout("guild-1", {
      generation: 1,
      text: "hello",
    });

    await service.waitForQueueDrained("guild-1");

    expect(synthesizeReadoutPcm).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      {
        text: "hello",
        referenceAudio: Buffer.from("ref-b"),
      },
    ]);
    expect(played).toEqual(["resource:pcm:hello"]);
    await service.dispose();
  });

  test("worker skips synthesis request when no reference audio is available", async () => {
    const synthesizeReadoutPcm = mock(async () => Buffer.from("unused"));
    const service = new VoiceCloneService({
      createAudioResourceFromPcm: mock((pcm: Buffer) => pcm),
      waitForPlayerIdle: mock(async () => undefined),
      synthesizeReadoutPcm,
      setRepeatingTimer: mock((callback: () => void, intervalMs: number) => {
        const timer = setInterval(callback, intervalMs);
        timers.push(timer);
        return timer;
      }),
      clearRepeatingTimer: clearInterval,
      random: () => 0,
      logger: console,
    });

    const session = service.bindTextChannel("guild-1", "text-1");
    session.bindingGeneration = 1;
    const { runtime } = createRuntime("guild-1", "voice-1");
    runtime.player.play = mock((_resource: unknown) => undefined);
    session.voiceRuntime = runtime;

    service.enqueueReadout("guild-1", {
      generation: 1,
      text: "hello",
    });

    await service.waitForQueueDrained("guild-1");

    expect(synthesizeReadoutPcm).not.toHaveBeenCalled();
    expect(runtime.player.play).not.toHaveBeenCalled();
    await service.dispose();
  });

  test("worker logs synthesis failures and continues with later requests", async () => {
    const played: string[] = [];
    const logger = {
      error: mock((_error: unknown) => undefined),
      warn: mock((_message: unknown) => undefined),
    };
    const synthesizeReadoutPcm = mock(async (text: string) => {
      if (text === "first") {
        throw new Error("synthesis failed");
      }
      return Buffer.from(text, "utf-8");
    });

    const service = new VoiceCloneService({
      createAudioResourceFromPcm: mock((pcm: Buffer) => pcm),
      waitForPlayerIdle: mock(async () => undefined),
      synthesizeReadoutPcm,
      setRepeatingTimer: mock((callback: () => void, intervalMs: number) => {
        const timer = setInterval(callback, intervalMs);
        timers.push(timer);
        return timer;
      }),
      clearRepeatingTimer: clearInterval,
      random: () => 0,
      logger,
    });

    const session = service.bindTextChannel("guild-1", "text-1");
    session.bindingGeneration = 1;
    session.recordings.set("user-1", Buffer.from("ref"));
    const { runtime } = createRuntime("guild-1", "voice-1");
    runtime.player.play = mock((resource: unknown) => {
      played.push((resource as Buffer).toString("utf-8"));
    });
    session.voiceRuntime = runtime;

    service.enqueueReadout("guild-1", {
      generation: 1,
      text: "first",
    });
    service.enqueueReadout("guild-1", {
      generation: 1,
      text: "second",
    });

    await service.waitForQueueDrained("guild-1");

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(synthesizeReadoutPcm).toHaveBeenCalledTimes(2);
    expect(played).toEqual(["second"]);
    await service.dispose();
  });
});
