import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  OUTPOST_PROTOCOL_VERSION,
  controlToWorkerMessageSchema,
  outpostOperationSchema,
  toolInputSchemas,
  toolResultSchemas,
  workerToControlMessageSchema,
} from "./index";

const directionSchema = z.enum(["workerToControl", "controlToWorker"]);
const goTypeSchema = z.enum([
  "Registration",
  "Heartbeat",
  "LeaseAccepted",
  "LeaseRejected",
  "ToolResult",
  "ContextResult",
  "ServerMessage",
]);
const jsonObjectSchema = z.record(z.string(), z.unknown());

const messageVectorSchema = z
  .object({
    name: z.string().min(1),
    direction: directionSchema,
    goType: goTypeSchema,
    message: jsonObjectSchema,
  })
  .strict();

const toolPayloadVectorSchema = z
  .object({
    name: z.string().min(1),
    operation: outpostOperationSchema,
    requestMessageName: z.string().min(1),
    resultMessageName: z.string().min(1),
    input: jsonObjectSchema,
    result: jsonObjectSchema,
  })
  .strict();

const fixtureSchema = z
  .object({
    fixtureVersion: z.literal(1),
    description: z.string().min(1),
    protocolVersion: z.number().int().positive(),
    messages: z.array(messageVectorSchema).min(1),
    toolPayloads: z.array(toolPayloadVectorSchema).min(1),
  })
  .strict();

const fixturePath = fileURLToPath(
  new URL("../test-fixtures/outpost-wire-vectors.json", import.meta.url)
);
const fixture = fixtureSchema.parse(JSON.parse(readFileSync(fixturePath, "utf8")));

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe("shared outpost wire vectors", () => {
  it("pins the TypeScript protocol version and complete union coverage", () => {
    expect(fixture.protocolVersion).toBe(OUTPOST_PROTOCOL_VERSION);

    const fixtureTypes = {
      workerToControl: new Set<string>(),
      controlToWorker: new Set<string>(),
    };
    for (const vector of fixture.messages) {
      const messageType = vector.message.type;
      expect(typeof messageType, `${vector.name}: message type`).toBe("string");
      fixtureTypes[vector.direction].add(messageType as string);
    }

    const workerTypes = workerToControlMessageSchema.options.map(
      (schema) => schema.shape.type.value
    );
    const controlTypes = controlToWorkerMessageSchema.options.map(
      (schema) => schema.shape.type.value
    );
    expect(sorted(fixtureTypes.workerToControl)).toEqual(sorted(workerTypes));
    expect(sorted(fixtureTypes.controlToWorker)).toEqual(sorted(controlTypes));
    expect(sorted(fixture.toolPayloads.map((payload) => payload.operation))).toEqual(
      sorted(outpostOperationSchema.options)
    );
  });

  it.each(fixture.messages.map((vector) => [vector.name, vector] as const))(
    "parses and preserves the complete %s message",
    (_name, vector) => {
      const schema =
        vector.direction === "workerToControl"
          ? workerToControlMessageSchema
          : controlToWorkerMessageSchema;
      expect(schema.parse(vector.message)).toEqual(vector.message);
    }
  );

  it.each(fixture.toolPayloads.map((payload) => [payload.name, payload] as const))(
    "parses and preserves the complete %s tool payload",
    (_name, payload) => {
      expect(toolInputSchemas[payload.operation].parse(payload.input)).toEqual(payload.input);
      expect(toolResultSchemas[payload.operation].parse(payload.result)).toEqual(payload.result);

      const request = fixture.messages.find(
        (vector) => vector.name === payload.requestMessageName
      )?.message;
      const result = fixture.messages.find(
        (vector) => vector.name === payload.resultMessageName
      )?.message;
      expect(request?.type).toBe("tool.request");
      expect(request?.operation).toBe(payload.operation);
      expect(request?.input).toEqual(payload.input);
      expect(result?.type).toBe("tool.result");
      expect(result?.ok).toBe(true);
      expect(result?.output).toEqual(payload.result);
      expect(result?.requestId).toBe(request?.requestId);
    }
  );
});
