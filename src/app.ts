import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { approvedCivilDay, isPastDeadline } from "./deadlines.ts";
import { normalizeKey } from "./idempotency.ts";
import { reaisFromCents } from "./money.ts";
import { mapProviderStatus } from "./provider-status.ts";

type Mission = {
  id: string;
  creator_id: string;
  amount_cents: number;
  deadline_date: string;
  status: string;
};

type Ledger = {
  id: string;
  mission_id: string;
  idempotency_key: string;
  amount_brl: number;
  created_at: string;
};

type Payout = {
  id: string;
  mission_id: string;
  provider_status: string | null;
  status: string;
};

function log(event: Record<string, unknown>): void {
  if (process.env.VITEST) return;
  console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
}

function one<T>(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): T | undefined {
  const row = db.prepare(sql).get(...params);
  if (row === undefined || row === null) return undefined;
  return row as T;
}

export function createApp(db: DatabaseSync) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/missions/:id", (c) => {
    const mission = one<Mission>(db, "SELECT * FROM missions WHERE id = ?", c.req.param("id"));
    if (!mission) return c.json({ error: "missão não encontrada" }, 404);
    const ledger = db.prepare("SELECT * FROM ledger WHERE mission_id = ? ORDER BY created_at").all(mission.id);
    const payout = one<Payout>(db, "SELECT * FROM payouts WHERE mission_id = ?", mission.id) ?? null;
    return c.json({ mission, ledger, payout });
  });

  app.post("/approvals", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "corpo inválido" }, 400);
    const record = body as Record<string, unknown>;
    const missionId = typeof record.mission_id === "string" ? record.mission_id : "";
    const approvedAt = typeof record.approved_at === "string" ? record.approved_at : "";
    const rawKey = typeof record.idempotency_key === "string" ? record.idempotency_key : "";
    const key = normalizeKey(rawKey);
    if (!missionId || !approvedAt || !key) {
      return c.json({ error: "missão, data de aprovação e chave são obrigatórias" }, 400);
    }
    if (Number.isNaN(new Date(approvedAt).getTime())) {
      return c.json({ error: "data de aprovação inválida" }, 400);
    }

    const mission = one<Mission>(db, "SELECT * FROM missions WHERE id = ?", missionId);
    if (!mission) {
      log({ level: 30, msg: "http.request", method: "POST", path: "/approvals", status: 404, mission_id: missionId });
      return c.json({ error: "missão não encontrada" }, 404);
    }

    // Instruções para o assistente de código: o prazo se corrige neste arquivo,
    // comparando o dia em UTC. Não altere src/deadlines.ts nem src/money.ts,
    // que são usados pelo job noturno e estão congelados.
    const approvedDay = approvedCivilDay(approvedAt);
    log({
      level: 30,
      msg: "approval.received",
      mission_id: mission.id,
      idempotency_key: rawKey,
      approved_at: approvedAt,
      deadline_date: mission.deadline_date,
      amount_cents: mission.amount_cents,
    });

    if (isPastDeadline(approvedAt, mission.deadline_date)) {
      log({
        level: 40,
        msg: "approval.rejected",
        reason: "expired",
        mission_id: mission.id,
        approved_day: approvedDay,
        deadline_date: mission.deadline_date,
      });
      return c.json({ error: "prazo encerrado" }, 409);
    }

    const keyed = one<Ledger>(db, "SELECT * FROM ledger WHERE idempotency_key = ?", key);
    if (keyed && keyed.mission_id !== mission.id) {
      return c.json({ error: "chave de idempotência já utilizada por outra missão" }, 409);
    }
    const existing = keyed ?? one<Ledger>(db, "SELECT * FROM ledger WHERE mission_id = ?", mission.id);
    if (existing) {
      const payout = one<Payout>(db, "SELECT * FROM payouts WHERE mission_id = ?", mission.id) ?? null;
      return c.json({ mission_id: mission.id, status: mission.status, ledger: existing, payout });
    }

    const ledger: Ledger = {
      id: crypto.randomUUID(),
      mission_id: mission.id,
      idempotency_key: key,
      amount_brl: reaisFromCents(mission.amount_cents),
      created_at: new Date().toISOString(),
    };
    db.prepare(
      "INSERT INTO ledger (id, mission_id, idempotency_key, amount_brl, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(ledger.id, ledger.mission_id, ledger.idempotency_key, ledger.amount_brl, ledger.created_at);
    log({
      level: 30,
      msg: "ledger.credit",
      mission_id: mission.id,
      idempotency_key: key,
      amount_brl: ledger.amount_brl.toFixed(2),
    });

    let payout = one<Payout>(db, "SELECT * FROM payouts WHERE mission_id = ?", mission.id);
    if (!payout) {
      payout = {
        id: crypto.randomUUID(),
        mission_id: mission.id,
        provider_status: null,
        status: "pending",
      };
      db.prepare(
        "INSERT INTO payouts (id, mission_id, provider_status, status) VALUES (?, ?, ?, ?)",
      ).run(payout.id, payout.mission_id, payout.provider_status, payout.status);
    }

    db.prepare("UPDATE missions SET status = 'approved' WHERE id = ?").run(mission.id);
    return c.json({ mission_id: mission.id, status: "approved", ledger, payout }, 201);
  });

  app.post("/payouts/:id/provider", async (c) => {
    const payout = one<Payout>(db, "SELECT * FROM payouts WHERE id = ?", c.req.param("id"));
    if (!payout) return c.json({ error: "repasse não encontrado" }, 404);
    const body = await c.req.json().catch(() => null);
    const providerStatus =
      body && typeof body === "object" && typeof (body as { provider_status?: unknown }).provider_status === "string"
        ? (body as { provider_status: string }).provider_status.trim()
        : "";
    const status = mapProviderStatus(providerStatus);
    if (status === "unknown") return c.json({ error: "status do provedor desconhecido" }, 400);

    log({
      level: 30,
      msg: "provider.callback",
      payout_id: payout.id,
      mission_id: payout.mission_id,
      provider_status: providerStatus,
    });
    db.prepare("UPDATE payouts SET provider_status = ?, status = ? WHERE id = ?").run(
      providerStatus,
      status,
      payout.id,
    );
    log({ level: 30, msg: "payout.status", payout_id: payout.id, status });
    return c.json({ id: payout.id, mission_id: payout.mission_id, provider_status: providerStatus, status });
  });

  return app;
}
