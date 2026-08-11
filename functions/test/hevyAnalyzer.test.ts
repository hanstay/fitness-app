import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";
import {
  groupRowsBySession,
  generateSessionId,
  rowsToStrengthSession,
  parseHevyCsvToSessions,
} from "../src/lib/hevyAnalyzer";

const FIXTURE_PATH = join(__dirname, "fixtures", "hevy-sample.csv");

describe("hevyAnalyzer", () => {
  describe("groupRowsBySession", () => {
    it("groups rows with same (title, start_time, end_time) together", () => {
      const rows = [
        { title: "Legs", start_time: "Aug 10, 7:00 PM", end_time: "Aug 10, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "normal", weight_kg: "85", reps: "6" } as any,
        { title: "Legs", start_time: "Aug 10, 7:00 PM", end_time: "Aug 10, 8:30 PM", exercise_title: "Deadlift", set_index: "0", set_type: "normal", weight_kg: "100", reps: "5" } as any,
        { title: "Push", start_time: "Aug 12, 6:30 PM", end_time: "Aug 12, 7:45 PM", exercise_title: "Bench", set_index: "0", set_type: "normal", weight_kg: "80", reps: "5" } as any,
      ];
      const grouped = groupRowsBySession(rows);
      expect(grouped.size).toBe(2);
      const groups = Array.from(grouped.values());
      expect(groups[0].length).toBe(2);
      expect(groups[1].length).toBe(1);
    });

    it("returns empty map for rows with missing session identifiers", () => {
      const rows = [
        { title: "", start_time: "Aug 10, 7:00 PM", end_time: "Aug 10, 8:30 PM", exercise_title: "Squat" } as any,
        { title: "Legs", start_time: "", end_time: "Aug 10, 8:30 PM", exercise_title: "Squat" } as any,
      ];
      const grouped = groupRowsBySession(rows);
      expect(grouped.size).toBe(0);
    });
  });

  describe("generateSessionId", () => {
    it("generates consistent IDs for same input", () => {
      const id1 = generateSessionId("user123", "Aug 10, 2026, 7:00 PM", "Legs Session");
      const id2 = generateSessionId("user123", "Aug 10, 2026, 7:00 PM", "Legs Session");
      expect(id1).toBe(id2);
    });

    it("generates different IDs for different inputs", () => {
      const id1 = generateSessionId("user123", "Aug 10, 2026, 7:00 PM", "Legs Session");
      const id2 = generateSessionId("user123", "Aug 10, 2026, 7:00 PM", "Push Session");
      expect(id1).not.toBe(id2);
    });

    it("produces deterministic 16-char hex string", () => {
      const id = generateSessionId("user", "time", "title");
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe("rowsToStrengthSession", () => {
    it("returns null for empty rows", () => {
      const session = rowsToStrengthSession([], "user123");
      expect(session).toBeNull();
    });

    it("returns null for missing session identifiers", () => {
      const rows = [
        { title: "", start_time: "Aug 10, 7:00 PM", end_time: "Aug 10, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "normal", weight_kg: "85", reps: "6" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session).toBeNull();
    });

    it("creates StrengthSession with exercises array", () => {
      const rows = [
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "normal", weight_kg: "85", reps: "6" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session).toBeDefined();
      expect(session!.exercises).toBeInstanceOf(Array);
      expect(session!.exercises.length).toBe(1);
      expect(session!.exercises[0].name).toBe("Squat");
    });

    it("includes warmup and normal sets", () => {
      const rows = [
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "warmup", weight_kg: "20", reps: "10" } as any,
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "1", set_type: "normal", weight_kg: "85", reps: "6" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session!.exercises[0].sets.length).toBe(2);
      expect(session!.exercises[0].sets[0].type).toBe("warmup");
      expect(session!.exercises[0].sets[1].type).toBe("normal");
    });

    it("converts lbs to kg", () => {
      const rows = [
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Deadlift", set_index: "0", set_type: "normal", weight_lbs: "220", reps: "5" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session!.exercises[0].sets[0].weight_kg).toBeCloseTo(99.8, 1);
    });

    it("handles null weight", () => {
      const rows = [
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Pull Up", set_index: "0", set_type: "normal", weight_kg: "", reps: "8" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session!.exercises[0].sets[0].weight_kg).toBeNull();
    });

    it("includes distance_km and duration_seconds", () => {
      const rows = [
        { title: "Conditioning", start_time: "Aug 5, 2026, 5:45 PM", end_time: "Aug 5, 2026, 6:15 PM", exercise_title: "Running", set_index: "0", set_type: "normal", distance_km: "0.5", duration_seconds: "240" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session!.exercises[0].sets[0].distance_km).toBe(0.5);
      expect(session!.exercises[0].sets[0].duration_seconds).toBe(240);
    });

    it("includes rpe when present", () => {
      const rows = [
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "normal", weight_kg: "85", reps: "6", rpe: "8" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session!.exercises[0].sets[0].rpe).toBe(8);
    });

    it("sets index field correctly", () => {
      const rows = [
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "warmup", weight_kg: "20", reps: "10" } as any,
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "1", set_type: "normal", weight_kg: "85", reps: "6" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session!.exercises[0].sets[0].index).toBe(0);
      expect(session!.exercises[0].sets[1].index).toBe(1);
    });

    it("skips rows with missing exercise_title", () => {
      const rows = [
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "normal", weight_kg: "85", reps: "6" } as any,
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "", set_index: "1", set_type: "normal", weight_kg: "90", reps: "5" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session!.exercises.length).toBe(1);
    });

    it("has correct session metadata", () => {
      const rows = [
        { title: "Legs", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "normal", weight_kg: "85", reps: "6" } as any,
      ];
      const session = rowsToStrengthSession(rows, "user123");
      expect(session!.title).toBe("Legs");
      expect(session!.date).toBe("2026-08-10");
      expect(session!.start_time).toBe("Aug 10, 2026, 7:00 PM");
      expect(session!.end_time).toBe("Aug 10, 2026, 8:30 PM");
      expect(session!.source).toBe("hevy");
      expect(session!.createdAt).toBeDefined();
    });

    it("generates deterministic session ID", () => {
      const rows = [
        { title: "Test", start_time: "Aug 10, 2026, 7:00 PM", end_time: "Aug 10, 2026, 8:30 PM", exercise_title: "Squat", set_index: "0", set_type: "normal", weight_kg: "85", reps: "6" } as any,
      ];
      const session1 = rowsToStrengthSession(rows, "user123");
      const session2 = rowsToStrengthSession(rows, "user123");
      expect(session1!.id).toBe(session2!.id);
    });
  });

  describe("parseHevyCsvToSessions", () => {
    it("parses real Hevy CSV fixture", () => {
      const csv = readFileSync(FIXTURE_PATH, "utf8");
      const sessions = parseHevyCsvToSessions(csv, "testuser");
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.length).toBeLessThanOrEqual(10);
    });

    it("end-to-end CSV parsing produces correct structure", () => {
      const csv = readFileSync(FIXTURE_PATH, "utf8");
      const sessions = parseHevyCsvToSessions(csv, "testuser");
      for (const session of sessions) {
        expect(session.id).toBeDefined();
        expect(session.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(session.title).toBeTruthy();
        expect(session.start_time).toBeTruthy();
        expect(session.end_time).toBeTruthy();
        expect(session.exercises).toBeInstanceOf(Array);
        expect(session.createdAt).toBeDefined();
        expect(session.source).toBe("hevy");
        for (const exercise of session.exercises) {
          expect(exercise.name).toBeTruthy();
          expect(exercise.sets).toBeInstanceOf(Array);
          for (const set of exercise.sets) {
            expect(typeof set.index).toBe("number");
            expect(typeof set.type).toBe("string");
            expect(set.weight_kg === null || typeof set.weight_kg === "number").toBe(true);
            expect(set.reps === null || typeof set.reps === "number").toBe(true);
            expect(set.distance_km === null || typeof set.distance_km === "number").toBe(true);
            expect(set.duration_seconds === null || typeof set.duration_seconds === "number").toBe(true);
            expect(set.rpe === null || typeof set.rpe === "number").toBe(true);
          }
        }
      }
    });

    it("correctly parses Legs Session", () => {
      const csv = readFileSync(FIXTURE_PATH, "utf8");
      const sessions = parseHevyCsvToSessions(csv, "testuser");
      const legsSession = sessions.find((s) => s.title === "Legs Session");
      expect(legsSession).toBeDefined();
      expect(legsSession!.date).toBe("2026-08-10");
      const squat = legsSession!.exercises.find((e) => e.name === "Squat (Barbell)");
      expect(squat).toBeDefined();
      expect(squat!.sets.length).toBeGreaterThan(0);
    });

    it("parses conditioning with distance and duration", () => {
      const csv = readFileSync(FIXTURE_PATH, "utf8");
      const sessions = parseHevyCsvToSessions(csv, "testuser");
      const condSession = sessions.find((s) => s.title === "Conditioning");
      expect(condSession).toBeDefined();
      const running = condSession!.exercises.find((e) => e.name === "Running");
      expect(running).toBeDefined();
      expect(running!.sets[0].distance_km).toBe(0.5);
      expect(running!.sets[0].duration_seconds).toBe(240);
    });

    it("handles empty or missing optional fields", () => {
      const csv = [
        "title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe",
        '"Test","Aug 10, 2026, 7:00 PM","Aug 10, 2026, 8:30 PM","Bench",0,"normal","85","5","","",""',
      ].join("\n");
      const sessions = parseHevyCsvToSessions(csv, "user");
      expect(sessions.length).toBe(1);
      expect(sessions[0].exercises[0].sets[0].distance_km).toBeNull();
      expect(sessions[0].exercises[0].sets[0].duration_seconds).toBeNull();
      expect(sessions[0].exercises[0].sets[0].rpe).toBeNull();
    });

    it("returns empty array for empty CSV", () => {
      const csv = "title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps";
      const sessions = parseHevyCsvToSessions(csv, "user");
      expect(sessions.length).toBe(0);
    });

    it("groups multiple exercises into one session", () => {
      const csv = [
        "title,start_time,end_time,exercise_title,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe",
        '"Session A","Aug 10, 2026, 7:00 PM","Aug 10, 2026, 8:30 PM","Exercise 1",0,"normal","50","10","","",""',
        '"Session A","Aug 10, 2026, 7:00 PM","Aug 10, 2026, 8:30 PM","Exercise 2",0,"normal","60","8","","",""',
      ].join("\n");
      const sessions = parseHevyCsvToSessions(csv, "user");
      expect(sessions.length).toBe(1);
      expect(sessions[0].exercises.length).toBe(2);
    });

    it("generates deterministic IDs for re-uploads", () => {
      const csv = readFileSync(FIXTURE_PATH, "utf8");
      const sessions1 = parseHevyCsvToSessions(csv, "testuser");
      const sessions2 = parseHevyCsvToSessions(csv, "testuser");
      expect(sessions1.length).toBe(sessions2.length);
      for (let i = 0; i < sessions1.length; i++) {
        expect(sessions1[i].id).toBe(sessions2[i].id);
      }
    });
  });
});
