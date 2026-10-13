import { describe, expect, it } from "vitest";
import { cleanBody } from "../src/ingest/loader.js";
import { redact, redactSecrets } from "../src/secrets.js";

// Fake credentials are assembled at runtime so that no secret scanner flags this file on push.
const hex = (n: number) => "0123456789abcdef".repeat(8).slice(0, n);
const b64 = (n: number) => "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z".repeat(8).slice(0, n);
const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", b64(43)].join(".");

describe("redactSecrets", () => {
  it.each([
    ["sonarqube-token", `| Platform | ${"sqa"}_${hex(40)} |`],
    ["nexus-npm-token", `//nexus.example.com/repository/npm/:_authToken=${"NpmToken"}.${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`],
    ["npmrc-auth", `//npm.fontawesome.com/:_authToken=${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}`],
    ["jwt", `-H "Authorization: Bearer ${jwt}"`],
    ["jwt", `"token": "xxxxxxxxxxJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ3ZWJhcGkifQ.${b64(43)}"`],
    ["url-signature", `"webhook_url": "https://prod-03.westeurope.logic.azure.com:443/workflows/x/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers&sv=1.0&sig=${b64(43)}"`],
    ["azure-account-key", `Endpoint=sb://bus.servicebus.windows.net/;SharedAccessKeyName=w;SharedAccessKey=${b64(43)}=`],
    ["connection-string-password", `Server=db;Initial Catalog=crm;User Id=sa;Password=dui&${hex(4)}Xy!;Connect Timeout=30`],
    ["url-password", `mongodb+srv://admin:Zq${hex(10)}@cluster0.mongodb.net/db`],
    ["secret-assignment", `"signingSecret": "${hex(64)}"`],
    ["secret-assignment", `KAFKA_API_KEY=${b64(16)}`],
    ["secret-assignment", `PWD: {?FH${b64(10)})u8s^L`],
    ["secret-assignment", `curl -d "client_id=abc&client_secret=fVOj${b64(28)}"`],
    ["cookie", `"cookie":"session=${b64(40)}; apt.sid=AP-${b64(20)}"`],
    ["basic-auth", `curl -H 'Authorization: Basic ${b64(40)}='`],
    ["private-key", `-----BEGIN PRIVATE KEY-----\n${b64(120)}\n-----END PRIVATE KEY-----`],
  ])("finds %s", (rule, line) => {
    const { text, findings } = redactSecrets(line);
    expect(findings.map((f) => f.rule)).toContain(rule);
    expect(text).toContain(`[REDACTED:${rule}]`);
  });

  it("keeps the key and the rest of the line", () => {
    const line = `"webhook_url": "https://example.logic.azure.com/invoke?sp=x&sig=${b64(43)}",`;
    expect(redact(line)).toBe(`"webhook_url": "https://example.logic.azure.com/invoke?sp=x&sig=[REDACTED:url-signature]",`);
    expect(redact(`password: "Zq${hex(14)}!" # dev`)).toBe(`password: "[REDACTED:secret-assignment]" # dev`);
  });

  it("redacts a whole unquoted value, not a prefix of it", () => {
    const out = redact(`PWD: {?FH${b64(10)})u8s^L`);
    expect(out).toBe("PWD: [REDACTED:secret-assignment]");
  });

  it.each([
    "password: process.env.DB_PASSWORD",
    "apiKey: env.CASSETTO_API_KEY,",
    "HASURA_JWT_SECRET: envalid.str({ default: '' })",
    "jwtSecret: settings.hasura.jwtSecret",
    'HASURA_GRAPHQL_ADMIN_SECRET: "${HASURA_ADMIN_SECRET}"',
    '"access-token": "{{tsid-loginV1-access-token}}"',
    "api_key: os.environ/AZURE_API_KEY",
    "//nexus.ts-paas.com/:_authToken=YOUR_NEXUS_TOKEN",
    "administrator_password = \"changeme1234\"",
    "azure.storage.connection-string=UseDevelopmentStorage=true",
    "postgres://postgres:postgres@localhost:5432/db",
    "https://n.lastname:gitlab-token@biosphere.example.com/group/repo.git",
    "| `401` | Bearer missing/invalid/expired-or-revoked |",
    "DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD:-postgres}@db:5432/x",
    "absoluteRefreshToken: expires_after_30_days",
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    "Il client_secret va richiesto al team IAM.",
  ])("leaves alone: %s", (line) => {
    expect(redactSecrets(line).findings).toEqual([]);
  });

  it("previews a value without revealing it", () => {
    const [finding] = redactSecrets(`token: ${"sqa"}_${hex(40)}`).findings;
    expect(finding?.preview).toBe("sqa_… (44 chars)");
    expect(finding?.line).toBe(1);
  });
});

describe("cleanBody", () => {
  it("redacts in prose and in code alike", () => {
    const secret = `"signingSecret": "${hex(64)}"`;
    expect(cleanBody(`# Webhooks\n\n${secret}\n`)).not.toContain(hex(64));
    expect(cleanBody(`const cfg = { ${secret} };`, "code")).not.toContain(hex(64));
  });
});
