import { describe, it, expect } from "vitest";
import { dropOn, movesOf } from "../../public/js/week-order.js";
import { readMoves } from "../src/lib/moveDay";

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const none = WEEK.map(() => false);
const saturdayFixed = WEEK.map((d) => d === "Saturday");

describe("dropOn", () => {
  it("drops a session on a later day, shifting the days in between up one", () => {
    expect(dropOn(WEEK, none, 0, 3)).toEqual(["Tuesday", "Wednesday", "Thursday", "Monday", "Friday", "Saturday", "Sunday"]);
  });

  it("drops a session on an earlier day, shifting the days in between down one", () => {
    expect(dropOn(WEEK, none, 4, 1)).toEqual(["Monday", "Friday", "Tuesday", "Wednesday", "Thursday", "Saturday", "Sunday"]);
  });

  it("steps over a fixed day, which stays put", () => {
    expect(dropOn(WEEK, saturdayFixed, 4, 6)).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Sunday", "Saturday", "Friday"]);
    expect(dropOn(WEEK, saturdayFixed, 0, 5)).toBe(WEEK); // not onto it
    expect(dropOn(WEEK, saturdayFixed, 5, 0)).toBe(WEEK); // nor off it
  });

  it("doesn't change the order it's given", () => {
    const order = WEEK.slice();
    dropOn(order, none, 0, 6);
    expect(order).toEqual(WEEK);
  });
});

describe("movesOf", () => {
  it("lists only the days that move, as the server reads them", () => {
    const moves = movesOf(dropOn(WEEK, none, 0, 3));
    expect(moves).toEqual({ Tuesday: "Monday", Wednesday: "Tuesday", Thursday: "Wednesday", Monday: "Thursday" });
    expect(readMoves(moves)).toEqual(moves);
    expect(movesOf(WEEK)).toEqual({});
  });
});
