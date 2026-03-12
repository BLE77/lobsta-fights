import { describe, expect, it } from "vitest";

import rumbleEngineIdl from "../lib/idl/rumble_engine.json";

describe("rumble engine IDL coverage", () => {
  it("includes the combat instructions required by the worker", () => {
    const instructionNames = new Set(rumbleEngineIdl.instructions.map(instruction => instruction.name));

    expect(instructionNames.has("start_combat")).toBe(true);
    expect(instructionNames.has("open_turn")).toBe(true);
    expect(instructionNames.has("resolve_turn")).toBe(true);
    expect(instructionNames.has("advance_turn")).toBe(true);
  });
});
