import prisma from "@/utils/prisma";
import { ActionType, LogicalOperator, SystemType } from "@/generated/prisma";

const TARGET_EMAIL = "rebekah@trueocean.com";

// Old system-typed content rules to delete after new rules are seeded.
// Conversation rules (TO_REPLY, FYI, AWAITING_REPLY, ACTIONED) are NOT in this list — keep them.
const OLD_SYSTEM_TYPES_TO_DELETE: SystemType[] = [
  SystemType.COLD_EMAIL,
  SystemType.CALENDAR,
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
  SystemType.NOTIFICATION,
  SystemType.RECEIPT,
];

type ActionSpec = {
  type: ActionType;
  label?: string | null;
};

type RuleSpec = {
  name: string;
  instructions: string | null;
  from?: string | null;
  conditionalOperator: LogicalOperator;
  actions: ActionSpec[];
};

// 8 canonical Phase 3 classification rules (CONTEXT D-04, D-05, D-09, D-10, D-11).
// All have systemType=null to avoid @@unique([emailAccountId, systemType]) collision.
// CLASS-07 note: 2FA auto-delete after 24h requires a DELETE ActionType not present in
// the upstream schema. Implemented as LABEL+ARCHIVE for Phase 3; full delete deferred.
const PHASE3_RULES: RuleSpec[] = [
  {
    name: "Receipts",
    instructions:
      "Order confirmations, purchase receipts, payment confirmations, and transaction records from any retailer or service.",
    conditionalOperator: LogicalOperator.AND,
    actions: [
      { type: ActionType.LABEL, label: "Receipts" },
      { type: ActionType.ARCHIVE },
      { type: ActionType.DIGEST },
    ],
  },
  {
    name: "Deals",
    instructions:
      "Promotional emails offering discounts, sales, or limited-time offers on products or services.",
    conditionalOperator: LogicalOperator.AND,
    actions: [
      { type: ActionType.LABEL, label: "Deals" },
      { type: ActionType.ARCHIVE },
      { type: ActionType.DIGEST },
    ],
  },
  {
    name: "Newsletters",
    instructions:
      "Regular newsletter subscriptions, blog digests, curated content emails, and periodic updates from publications or content creators. Look for List-Unsubscribe headers as a strong signal.",
    conditionalOperator: LogicalOperator.AND,
    actions: [
      { type: ActionType.LABEL, label: "Newsletters" },
      { type: ActionType.ARCHIVE },
      { type: ActionType.DIGEST },
    ],
  },
  {
    name: "Marketing",
    instructions:
      "Promotional and marketing emails that don't offer specific deals — brand announcements, product launches, company updates, re-engagement campaigns, and general advertising.",
    conditionalOperator: LogicalOperator.AND,
    actions: [
      { type: ActionType.LABEL, label: "Marketing" },
      { type: ActionType.ARCHIVE },
      // no DIGEST per D-05 — too noisy
    ],
  },
  {
    name: "Urgent",
    instructions:
      "Emails requiring immediate attention or action: account security alerts, time-sensitive requests from real people, payment failures, service outages, or anything the recipient must act on today.",
    conditionalOperator: LogicalOperator.AND,
    actions: [
      { type: ActionType.LABEL, label: "Urgent" },
      // no ARCHIVE per D-09 — stays in inbox
      { type: ActionType.DIGEST },
    ],
  },
  {
    name: "2FA",
    instructions:
      "Two-factor authentication codes, one-time passwords (OTP), verification codes, and login confirmation emails. These are typically short, contain a numeric or alphanumeric code, and are time-sensitive.",
    conditionalOperator: LogicalOperator.AND,
    actions: [
      { type: ActionType.LABEL, label: "2FA" },
      { type: ActionType.ARCHIVE },
      // CLASS-07: auto-delete after 24h deferred — DELETE ActionType not in upstream schema.
      // Phase 4 will add DELETE + delayInMinutes: 1440 once the executor is wired up.
    ],
  },
  {
    name: "Uncertain",
    instructions:
      "Emails that don't clearly fit any of the other categories — ambiguous content, unclear sender intent, or mixed signals. Use this only when genuinely unsure; prefer other categories when any reasonable match exists.",
    conditionalOperator: LogicalOperator.AND,
    actions: [
      { type: ActionType.LABEL, label: "Uncertain" },
      // no ARCHIVE per D-09 — stays in inbox
      { type: ActionType.DIGEST },
    ],
  },
  {
    name: "Greers List",
    instructions: null, // D-10 — static from-match only; no AI instructions needed
    from: "greers@trueocean.com",
    conditionalOperator: LogicalOperator.OR, // OR so static `from` alone is sufficient
    actions: [
      { type: ActionType.LABEL, label: "Greers List" },
      { type: ActionType.ARCHIVE },
    ],
  },
];

async function seedPhase3Rules({ dryRun }: { dryRun: boolean }) {
  const account = await prisma.emailAccount.findFirstOrThrow({
    where: { email: TARGET_EMAIL },
  });

  console.log(
    `[seed] target emailAccountId=${account.id} (${TARGET_EMAIL}) dryRun=${dryRun}`,
  );

  // Step 1: Upsert all 8 new rules and their actions BEFORE deleting old rules.
  // This preserves digest pipeline continuity — new Newsletters rule exists before
  // old Newsletter rule is removed (RESEARCH Risk 1).
  for (const spec of PHASE3_RULES) {
    if (dryRun) {
      console.log(
        `[seed:DRY] would upsert rule "${spec.name}" with ${spec.actions.length} actions`,
      );
      continue;
    }

    const rule = await prisma.rule.upsert({
      where: {
        name_emailAccountId: { name: spec.name, emailAccountId: account.id },
      },
      create: {
        name: spec.name,
        instructions: spec.instructions ?? null,
        from: spec.from ?? null,
        conditionalOperator: spec.conditionalOperator,
        enabled: true,
        systemType: null, // critical: avoid @@unique([emailAccountId, systemType]) collision
        emailAccountId: account.id,
      },
      update: {
        instructions: spec.instructions ?? null,
        from: spec.from ?? null,
        conditionalOperator: spec.conditionalOperator,
        enabled: true,
        systemType: null,
      },
    });

    // Replace actions wholesale for idempotency.
    await prisma.action.deleteMany({ where: { ruleId: rule.id } });
    await prisma.action.createMany({
      data: spec.actions.map((a) => ({
        ruleId: rule.id,
        emailAccountId: account.id,
        type: a.type,
        label: a.label ?? null,
      })),
    });

    console.log(
      `[seed] upserted "${spec.name}" id=${rule.id} actions=${spec.actions.length}`,
    );
  }

  // Step 2: Verify new Newsletters rule has DIGEST action BEFORE deleting old Newsletter rule.
  // Abort guard prevents digest starvation gap (RESEARCH Risk 1).
  const newsletters = await prisma.rule.findUnique({
    where: {
      name_emailAccountId: {
        name: "Newsletters",
        emailAccountId: account.id,
      },
    },
    include: { actions: true },
  });
  const newslettersHasDigest = newsletters?.actions.some(
    (a) => a.type === ActionType.DIGEST,
  );

  if (dryRun) {
    console.log(
      `[seed:DRY] would delete rules with systemType in: ${OLD_SYSTEM_TYPES_TO_DELETE.join(", ")}`,
    );
    return;
  }

  if (!newslettersHasDigest) {
    throw new Error(
      "ABORT: Newsletters rule does not have DIGEST action; refusing to delete old Newsletter rule.",
    );
  }
  console.log(
    `[seed] verified Newsletters rule has DIGEST action: ${newslettersHasDigest}`,
  );

  // Step 3: Delete old content rules (by systemType — conversation rules are safe,
  // they use systemTypes not in this list).
  const deleted = await prisma.rule.deleteMany({
    where: {
      emailAccountId: account.id,
      systemType: { in: OLD_SYSTEM_TYPES_TO_DELETE },
    },
  });
  console.log(`[seed] deleted ${deleted.count} old content rules`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  await seedPhase3Rules({ dryRun });
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { seedPhase3Rules };
