import path from "node:path";

import { describe, expect, test } from "vitest";

import { PersistedConfigSchema } from "../persisted-config.js";
import { resolveSpeechConfig } from "./speech-config-resolver.js";

describe("resolveSpeechConfig", () => {
  test("resolves local-first defaults without env overrides", () => {
    const rockyHome = "/tmp/rocky-home";
    const persisted = PersistedConfigSchema.parse({});
    const env = {} as NodeJS.ProcessEnv;

    const result = resolveSpeechConfig({
      rockyHome,
      env,
      persisted,
    });

    expect(result.openai).toBeUndefined();
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: false,
      enabled: true,
    });
    expect(result.speech.local).toEqual({
      modelsDir: path.join(rockyHome, "models", "local-speech"),
      models: {
        dictationStt: "parakeet-tdt-0.6b-v2-int8",
        voiceStt: "parakeet-tdt-0.6b-v2-int8",
        voiceTts: "kokoro-en-v0_19",
        voiceTtsSpeakerId: 0,
      },
    });
    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceTts).toBe("kokoro-en-v0_19");
    expect(result.speech.local?.models.voiceTtsSpeakerId).toBe(0);
    expect(result.speech.sttLanguages).toEqual({
      dictation: "en",
      voice: "en",
    });
  });

  test("resolves feature-scoped local speech settings", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        voiceMode: {
          turnDetection: { provider: "local" },
          stt: { provider: "openai", model: "gpt-4o-transcribe" },
        },
      },
      providers: {
        openai: { apiKey: "persisted-key" },
      },
    });
    const env = {
      ROCKY_DICTATION_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
      ROCKY_VOICE_LOCAL_STT_MODEL: "parakeet-tdt-0.6b-v2-int8",
      ROCKY_VOICE_LOCAL_TTS_MODEL: "kokoro-en-v0_19",
      ROCKY_VOICE_LOCAL_TTS_SPEAKER_ID: "5",
      ROCKY_VOICE_LOCAL_TTS_SPEED: "1.35",
      ROCKY_DICTATION_LANGUAGE: "es",
      ROCKY_VOICE_LANGUAGE: "pt",
      ROCKY_LOCAL_MODELS_DIR: "/tmp/models",
      OPENAI_API_KEY: "env-key",
      ROCKY_VOICE_STT_PROVIDER: "openai",
      ROCKY_DICTATION_STT_PROVIDER: "local",
      ROCKY_VOICE_TTS_PROVIDER: "local",
    } as NodeJS.ProcessEnv;

    const result = resolveSpeechConfig({
      rockyHome: "/tmp/rocky-home",
      env,
      persisted,
    });

    expect(result.speech.local).toEqual({
      modelsDir: "/tmp/models",
      models: {
        dictationStt: "parakeet-tdt-0.6b-v2-int8",
        voiceStt: "parakeet-tdt-0.6b-v2-int8",
        voiceTts: "kokoro-en-v0_19",
        voiceTtsSpeakerId: 5,
        voiceTtsSpeed: 1.35,
      },
    });
    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "openai",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: true,
      enabled: true,
    });
    expect(result.speech.local?.models.dictationStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceStt).toBe("parakeet-tdt-0.6b-v2-int8");
    expect(result.speech.local?.models.voiceTts).toBe("kokoro-en-v0_19");
    expect(result.speech.local?.models.voiceTtsSpeakerId).toBe(5);
    expect(result.speech.local?.models.voiceTtsSpeed).toBe(1.35);
    expect(result.speech.sttLanguages).toEqual({
      dictation: "es",
      voice: "pt",
    });
    expect(result.openai?.apiKey).toBe("env-key");
    expect(result.openai?.stt?.model).toBe("gpt-4o-transcribe");
  });

  test("resolves STT language from env, settings, and voice-to-dictation fallback", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: {
          stt: {
            language: "fr",
          },
        },
        voiceMode: {
          stt: {
            language: "de",
          },
        },
      },
    });

    const result = resolveSpeechConfig({
      rockyHome: "/tmp/rocky-home",
      env: {
        ROCKY_DICTATION_LANGUAGE: "es",
        ROCKY_VOICE_LANGUAGE: "  ",
      } as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.sttLanguages).toEqual({
      dictation: "es",
      voice: "es",
    });
  });

  test("respects disabled dictation and voice mode feature flags", () => {
    const persisted = PersistedConfigSchema.parse({
      features: {
        dictation: { enabled: false },
        voiceMode: { enabled: false },
      },
    });

    const result = resolveSpeechConfig({
      rockyHome: "/tmp/rocky-home",
      env: {} as NodeJS.ProcessEnv,
      persisted,
    });

    expect(result.speech.providers.dictationStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceTurnDetection).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceStt).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
    expect(result.speech.providers.voiceTts).toEqual({
      provider: "local",
      explicit: false,
      enabled: false,
    });
  });
});
