import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "../src/config.js";

type Provider = "BOUNCER" | "HUNTER";
type ReviewStatus = "APPROVED" | "ACTION_REQUIRED" | "PENDING" | "REJECTED" | "UNKNOWN" | "NO_UPDATE";
type ReviewSignal = "API_ACCESS" | "EMAIL_CONFIRMATION" | "MANUAL_REVIEW" | "SUPPORT_ACK" | "WELCOME";

const providerDomains: Record<Provider, readonly string[]> = {
  BOUNCER: ["usebouncer.com"],
  HUNTER: ["hunter.io"],
};

function providerForAddress(address: string): Provider | null {
  const domain = address.trim().toLowerCase().split("@").at(-1) ?? "";
  for (const [provider, domains] of Object.entries(providerDomains) as Array<[Provider, readonly string[]]>) {
    if (domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))) return provider;
  }
  return null;
}

function classify(text: string): ReviewStatus {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  if (/declin|reject|cannot approve|can't approve|suspend|not eligible/.test(normalized)) return "REJECTED";
  if (/approved|account (?:is |has been )?(?:active|activated)|access (?:is )?granted|review (?:is )?complete/.test(normalized)) {
    return "APPROVED";
  }
  if (/additional information|more information|please (?:provide|reply|complete)|action required|linkedin|captcha/.test(normalized)) {
    return "ACTION_REQUIRED";
  }
  if (/under review|manual review|being reviewed|reviewing your account|pending review/.test(normalized)) {
    return "PENDING";
  }
  if (/thank you for contact|thanks for contact|request (?:was |has been )?received|ticket (?:was |has been )?(?:created|received)|we(?:'ve| have) received/.test(normalized)) {
    return "PENDING";
  }
  return "UNKNOWN";
}

function signals(text: string): ReviewSignal[] {
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const matched: ReviewSignal[] = [];
  if (/api key|api access|developer access|credits?/.test(normalized)) matched.push("API_ACCESS");
  if (/confirm (?:your )?email|verify (?:your )?email/.test(normalized)) matched.push("EMAIL_CONFIRMATION");
  if (/manual review|under review|reviewing your account|account review/.test(normalized)) matched.push("MANUAL_REVIEW");
  if (/thank you for contact|thanks for contact|request (?:was |has been )?received|ticket (?:was |has been )?(?:created|received)|we(?:'ve| have) received/.test(normalized)) {
    matched.push("SUPPORT_ACK");
  }
  if (/welcome to (?:email )?bouncer|welcome to hunter/.test(normalized)) matched.push("WELCOME");
  return matched;
}

if (!config.IMAP_HOST || !config.IMAP_USER || !config.IMAP_PASSWORD) {
  throw new Error("IMAP configuration is incomplete");
}

const client = new ImapFlow({
  host: config.IMAP_HOST,
  port: config.IMAP_PORT,
  secure: true,
  auth: { user: config.IMAP_USER, pass: config.IMAP_PASSWORD },
  logger: false,
});

const findings = new Map<Provider, Array<{
  date: Date | null;
  status: ReviewStatus;
  signals: ReviewSignal[];
}>>([
  ["BOUNCER", []],
  ["HUNTER", []],
]);

try {
  await client.connect();
  await client.mailboxOpen("INBOX", { readOnly: true });
  const uids = await client.search({ since: new Date(Date.now() - 30 * 86_400_000) }, { uid: true });
  if (uids && uids.length > 0) {
    const recentUids = uids.slice(-500);
    const messages = await client.fetchAll(
      recentUids,
      { uid: true, envelope: true, source: { maxLength: 250_000 } },
      { uid: true },
    );
    for (const message of messages) {
      const addresses = message.envelope?.from?.map((entry) => entry.address ?? "") ?? [];
      const provider = addresses.map(providerForAddress).find((value): value is Provider => value !== null);
      if (!provider || !message.source) continue;
      const parsed = await simpleParser(message.source);
      const material = `${parsed.subject ?? ""}\n${parsed.text ?? ""}`.slice(0, 200_000);
      findings.get(provider)?.push({
        date: parsed.date ?? message.envelope?.date ?? null,
        status: classify(material),
        signals: signals(material),
      });
    }
  }
} finally {
  try {
    await client.logout();
  } catch {
    client.close();
  }
}

const result = Object.fromEntries(
  (["BOUNCER", "HUNTER"] as const).map((provider) => {
    const messages = findings.get(provider) ?? [];
    messages.sort((left, right) => (right.date?.getTime() ?? 0) - (left.date?.getTime() ?? 0));
    return [provider.toLowerCase(), {
      messages: messages.length,
      latestAt: messages[0]?.date?.toISOString() ?? null,
      status: messages[0]?.status ?? "NO_UPDATE",
      signals: messages[0]?.signals ?? [],
    }];
  }),
);

process.stdout.write(`${JSON.stringify({ emailSent: false, ...result }, null, 2)}\n`);
