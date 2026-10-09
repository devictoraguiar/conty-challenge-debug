import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { seedIncident } from "../src/seed.ts";

type Approval = {
  ledger: { id: string; mission_id: string; amount_brl: number; idempotency_key: string };
  payout: { id: string; status: string };
};

describe("regressões do contrato e dos logs do incidente", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedIncident(db);
    app = createApp(db);
  });

  afterEach(() => db.close());

  function post(path: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it.each([
    ["2026-03-13T02:59:59.999Z", 201],
    ["2026-03-12T23:59:59.999-03:00", 201],
    ["2026-03-13T11:59:59.999+09:00", 201],
    ["2026-03-13T03:00:00.000Z", 409],
  ])("avalia %s pelo dia civil de São Paulo (HTTP %s)", async (approvedAt, status) => {
    const res = await post("/approvals", {
      mission_id: "msn_1842",
      approved_at: approvedAt,
      idempotency_key: "pay_boundary",
    });
    expect(res.status).toBe(status);
    const mission = await (await app.request("/missions/msn_1842")).json() as { ledger: unknown[] };
    expect(mission.ledger).toHaveLength(status === 201 ? 1 : 0);
  });

  it.each([
    [8000, 80],
    [14999, 149.99],
    [1, 0.01],
  ])("credita %s centavos como R$ %s", async (cents, reais) => {
    db.prepare("UPDATE missions SET amount_cents = ? WHERE id = ?").run(cents, "msn_2044");
    const res = await post("/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_amount",
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Approval;
    expect(body.ledger.amount_brl).toBe(reais);
    const mission = await (await app.request("/missions/msn_2044")).json() as { ledger: Approval["ledger"][] };
    expect(mission.ledger).toHaveLength(1);
    expect(mission.ledger[0].amount_brl).toBe(reais);
  });

  // O log de msn_2044 contém U+200B no fim de pay_7c1; trim() sozinho não o remove.
  it.each([
    ["pay_7c1", "pay_7c1\u200B"],
    ["pay_7c1\u200B", "pay_7c1"],
    ["pay_7c1 ", "pay_7c1"],
    [" \u200Bpay_7c1\u200B ", "pay_7c1"],
  ])("reutiliza o crédito para as chaves %j e %j", async (firstKey, secondKey) => {
    const payload = {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
    };
    const first = await post("/approvals", { ...payload, idempotency_key: firstKey });
    expect(first.status).toBe(201);
    const original = await first.json() as Approval;
    const second = await post("/approvals", { ...payload, idempotency_key: secondKey });
    expect(second.status).toBe(200);
    const replay = await second.json() as Approval;
    expect(replay.ledger.id).toBe(original.ledger.id);
    expect(replay.ledger.idempotency_key).toBe("pay_7c1");
    expect(replay.payout.id).toBe(original.payout.id);
    const mission = await (await app.request("/missions/msn_2044")).json() as { ledger: unknown[] };
    expect(mission.ledger).toHaveLength(1);
  });

  it("persiste CONFIRMED como pago sem criar outro crédito", async () => {
    const approval = await post("/approvals", {
      mission_id: "msn_2044",
      approved_at: "2026-03-12T21:05:00.000Z",
      idempotency_key: "pay_confirmed",
    });
    const { payout } = await approval.json() as Approval;
    for (let retry = 0; retry < 2; retry++) {
      const res = await post(`/payouts/${payout.id}/provider`, { provider_status: "CONFIRMED" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "paid", provider_status: "CONFIRMED" });
    }
    const mission = await (await app.request("/missions/msn_2044")).json() as {
      ledger: unknown[];
      payout: { status: string };
    };
    expect(mission.ledger).toHaveLength(1);
    expect(mission.payout.status).toBe("paid");
  });

  it("reutiliza o crédito da missão mesmo com outra chave e preserva o repasse pago", async () => {
    const payload = { mission_id: "msn_1900", approved_at: "2026-03-12T18:11:00.000Z" };
    const first = await post("/approvals", { ...payload, idempotency_key: "pay_a" });
    expect(first.status).toBe(201);
    const original = await first.json() as Approval;
    await post(`/payouts/${original.payout.id}/provider`, { provider_status: "RECEIVED" });

    const second = await post("/approvals", { ...payload, idempotency_key: "pay_b" });
    expect(second.status).toBe(200);
    const replay = await second.json() as Approval;
    expect(replay.ledger).toEqual(original.ledger);
    expect(replay.payout).toMatchObject({ id: original.payout.id, status: "paid" });
    const mission = await (await app.request("/missions/msn_1900")).json() as { ledger: Approval["ledger"][] };
    expect(mission.ledger).toEqual([original.ledger]);
  });

  it.each(["pay_shared", " PAY_SHARED\u200B "])("recusa a chave %j de outra missão sem devolver seu crédito", async (key) => {
    const approved_at = "2026-03-12T18:11:00.000Z";
    const first = await post("/approvals", { mission_id: "msn_1900", approved_at, idempotency_key: "pay_shared" });
    expect(first.status).toBe(201);
    const original = await first.json() as Approval;

    const collision = await post("/approvals", { mission_id: "msn_2044", approved_at, idempotency_key: key });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "chave de idempotência já utilizada por outra missão" });
    const untouched = await (await app.request("/missions/msn_2044")).json();
    expect(untouched).toMatchObject({ mission: { status: "open" }, ledger: [], payout: null });

    const own = await post("/approvals", { mission_id: "msn_2044", approved_at, idempotency_key: "pay_own" });
    expect(own.status).toBe(201);
    expect(await own.json()).toMatchObject({ ledger: { mission_id: "msn_2044", amount_brl: 80 } });
    const firstMission = await (await app.request("/missions/msn_1900")).json();
    expect(firstMission).toMatchObject({ ledger: [original.ledger] });
  });

  it.each(["   ", "\u200B", " \u200B "])("recusa chave vazia após normalizar %j sem criar crédito", async (key) => {
    const res = await post("/approvals", {
      mission_id: "msn_1900",
      approved_at: "2026-03-12T18:11:00.000Z",
      idempotency_key: key,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missão, data de aprovação e chave são obrigatórias" });
    const mission = await (await app.request("/missions/msn_1900")).json();
    expect(mission).toMatchObject({ mission: { status: "open" }, ledger: [], payout: null });
  });

  it("mantém um crédito com duas aprovações concorrentes no mesmo processo", async () => {
    const responses = await Promise.all(["pay_a", "pay_b"].map((key) => post("/approvals", {
      mission_id: "msn_1900", approved_at: "2026-03-12T18:11:00.000Z", idempotency_key: key,
    })));
    expect(responses.map((res) => res.status).sort()).toEqual([200, 201]);
    const bodies = await Promise.all(responses.map((res) => res.json() as Promise<Approval>));
    expect(bodies[0].ledger.id).toBe(bodies[1].ledger.id);
    expect(bodies[0].payout.id).toBe(bodies[1].payout.id);
    const mission = await (await app.request("/missions/msn_1900")).json();
    expect(mission).toMatchObject({ ledger: [bodies[0].ledger] });
  });
});
