import { describe, expect, test } from "bun:test";
import {
  canonicalizeJson,
  hashRawMessageBody,
  hashWagerPayload,
} from "../../../src/shared/domain/payload-hasher.ts";

describe("PayloadHasher (D12)", () => {
  test("canonicalizeJson sorts object keys lexicographically and omits undefined", () => {
    const a = canonicalizeJson({
      b: 1,
      a: { y: "2", x: "1", z: undefined },
      c: [true, null],
    });
    const b = canonicalizeJson({
      c: [true, null],
      a: { x: "1", y: "2" },
      b: 1,
    });

    expect(a).toBe('{"a":{"x":"1","y":"2"},"b":1,"c":[true,null]}');
    expect(a).toBe(b);
  });

  test("produces identical SHA-256 hash regardless of key order or null vs omitted referenceExternalTransactionId", () => {
    const hashOmitted = hashWagerPayload({
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      playerId: "player-1",
      walletId: "wallet-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    });

    const hashNull = hashWagerPayload({
      kind: "BET",
      money: { currency: "BRL", amount: "25.00" },
      gameId: "game-1",
      roundId: "round-1",
      walletId: "wallet-1",
      playerId: "player-1",
      externalTransactionId: "ext-1",
      providerId: "provider-a",
      referenceExternalTransactionId: null,
    });

    expect(hashOmitted).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOmitted).toBe(hashNull);
  });

  test("changes hash when any business field changes", () => {
    const base = {
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      playerId: "player-1",
      walletId: "wallet-1",
      roundId: "round-1",
      gameId: "game-1",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };

    const h1 = hashWagerPayload(base);
    const h2 = hashWagerPayload({
      ...base,
      money: { amount: "25.01", currency: "BRL" },
    });
    const h3 = hashWagerPayload({
      ...base,
      kind: "REFUND",
      referenceExternalTransactionId: "ext-0",
    });

    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });

  test("hashRawMessageBody hashes exact raw string", () => {
    const h1 = hashRawMessageBody('{"a":1}');
    const h2 = hashRawMessageBody('{"a": 1}');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(h2);
  });
});
