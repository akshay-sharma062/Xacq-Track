/**
 * G4 cleanup: delete ONLY the ingest rows the g4-replay harness created
 * (identified by its phone numbers + g4* gateway txn ids), so a re-run starts
 * from a clean leads/events/payments/outbound baseline. It NEVER touches the
 * G1 / D-04 pull rows (AdAccount / AdCampaign / AdSet / Ad / Creative / Spend /
 * FxRate) — those live in separate tables this script doesn't reference.
 */
import { PrismaClient } from "@prisma/client";

const PHONES = ["+919812340990", "+919812340991", "+919812340993"];

async function main() {
  const p = new PrismaClient();
  // Payment first (FK to lead), then outbound (FK to lead), events, webhooklog, leads.
  const payments = await p.payment.deleteMany({
    where: { OR: [{ gatewayTxnId: { startsWith: "g4" } }, { leadId: { in: [] } }] },
  });
  // Find the harness-created leads (by phone) to scope the cascade deletes.
  const leads = await p.lead.findMany({ where: { phoneNormalized: { in: PHONES } }, select: { id: true, clientId: true } });
  const leadIds = leads.map((l) => l.id);
  const clients = [...new Set(leads.map((l) => l.clientId))];

  // Outbound CAPI rows created for these leads.
  const out = await p.outboundEvent.deleteMany({ where: { leadId: { in: leadIds } } });
  // Events (timeline + stage_changed) for these leads.
  const ev = await p.event.deleteMany({ where: { leadId: { in: leadIds } } });
  // Payments for these leads (the g4* txns).
  const pay = await p.payment.deleteMany({ where: { leadId: { in: leadIds } } });
  // Webhook logs (client-scoped; the harness's rawPayload carries the g4 txn ids).
  const wh = await p.webhookLog.deleteMany({ where: { clientId: { in: clients }, rawPayload: { contains: "g4" } } });
  // The leads themselves.
  const ld = await p.lead.deleteMany({ where: { id: { in: leadIds } } });

  console.log(
    JSON.stringify({ payments: pay.count, paymentsByTxn: payments.count, leads: ld.count, events: ev.count, outbound: out.count, webhookLogs: wh.count, clients }, null, 2)
  );
  await p.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
