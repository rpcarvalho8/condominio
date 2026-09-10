import { describe, expect, test } from "bun:test";
import {
  applyTechnicalInterrupt,
  assertSingleReuniao,
  createOpenReuniao,
  endMeeting,
  resumeRecording,
  segmentCount,
  isMeetingOpen,
} from "./reuniao-recording";

describe("Reuniao + RecordingSegment", () => {
  test("1 — gravação normal: 1 reunião, 1 segmento", () => {
    let s = createOpenReuniao("R1", 1_000);
    expect(segmentCount(s)).toBe(1);
    s = endMeeting(s, 2_000);
    expect(s.lifecycle).toBe("ended");
    expect(segmentCount(s)).toBe(1);
    expect(s.segments[0]!.reasonEnded).toBe("user_end_meeting");
    expect(assertSingleReuniao([s])).toBe("R1");
  });

  test("2 — interrupção + retoma: 1 reunião, 2 segmentos", () => {
    let s = createOpenReuniao("R1", 1_000);
    s = applyTechnicalInterrupt(s, 40 * 60_000);
    expect(s.lifecycle).toBe("in_progress");
    expect(isMeetingOpen(s)).toBe(true);
    expect(s.segments[0]!.reasonEnded).toBe("technical_interrupt");

    s = resumeRecording(s, 40 * 60_000 + 1);
    expect(segmentCount(s)).toBe(2);
    expect(s.reuniaoId).toBe("R1");

    s = endMeeting(s, 50 * 60_000);
    expect(s.lifecycle).toBe("ended");
    expect(segmentCount(s)).toBe(2);
    expect(assertSingleReuniao([s])).toBe("R1");
  });

  test("3 — várias interrupções: ainda 1 reunião", () => {
    let s = createOpenReuniao("R123", 1);
    for (let i = 0; i < 3; i++) {
      s = applyTechnicalInterrupt(s, 10_000 * (i + 1));
      s = resumeRecording(s, 10_000 * (i + 1) + 1);
    }
    expect(segmentCount(s)).toBe(4);
    expect(s.reuniaoId).toBe("R123");
    s = endMeeting(s, 99_000);
    expect(s.lifecycle).toBe("ended");
    expect(segmentCount(s)).toBe(4);
  });

  test("4 — falha de rede: segmento persistido, reunião aberta, retoma", () => {
    let s = createOpenReuniao("R-net", 1);
    s = applyTechnicalInterrupt(s, 5_000);
    expect(s.segments[0]!.status).toBe("closed");
    expect(isMeetingOpen(s)).toBe(true);
    s = resumeRecording(s, 6_000);
    expect(s.segments[1]!.ordinal).toBe(2);
    expect(s.segments[1]!.status).toBe("open");
    expect(s.reuniaoId).toBe("R-net");
  });

  test("5 — browser fecha: estado recuperável na mesma reunião", () => {
    // Simula estado durable após crash: segmento fechado por technical_interrupt
    let s = createOpenReuniao("R-crash", 1);
    s = applyTechnicalInterrupt(s, 2_000);
    // Reabrir app = mesmo reuniaoId + resume
    expect(isMeetingOpen(s)).toBe(true);
    s = resumeRecording(s, 3_000);
    expect(segmentCount(s)).toBe(2);
    expect(s.reuniaoId).toBe("R-crash");
  });

  test("6 — só Terminar reunião passa a ended; falha técnica não", () => {
    let s = createOpenReuniao("R-end", 1);
    s = applyTechnicalInterrupt(s, 2_000);
    expect(s.lifecycle).toBe("in_progress");
    expect(s.lifecycle).not.toBe("ended");

    s = endMeeting(s, 3_000);
    expect(s.lifecycle).toBe("ended");

    expect(() => resumeRecording(s, 4_000)).toThrow(/terminada/);
  });

  test("falha técnica nunca cria segunda reunião", () => {
    const a = createOpenReuniao("SAME", 1);
    const b = applyTechnicalInterrupt(a, 2);
    const c = resumeRecording(b, 3);
    expect(assertSingleReuniao([a, b, c])).toBe("SAME");
  });
});
