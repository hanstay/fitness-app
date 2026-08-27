// Shared input validation for createGroup and updateGroup — same fields,
// same rules, so a leader editing a group later can't submit something the
// creation form wouldn't have accepted.
import { z } from "zod";
import { groupEventInputSchema, groupFixedSessionInputSchema } from "../lib/schemas";

export const groupDetailsInputSchema = z.object({
  name: z.string().trim().max(100).optional(),
  goal: z.string().trim().min(1).max(1000),
  events: z.array(groupEventInputSchema).max(10).optional(),
  daysPerWeek: z.number().int().min(1).max(7),
  fixedSessions: z.array(groupFixedSessionInputSchema).max(7).optional(),
});
