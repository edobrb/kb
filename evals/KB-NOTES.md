# Knowledge-base notes from building the benchmark

Issues found in `kb/` while writing `questions.jsonl` (September 2026). They matter when a case fails for a
"wrong" reason: the system retrieved a near-duplicate page, or answered from a document that contradicts the
expected one. Fix them upstream in the source (Confluence / repo) or in the export, then re-run `npm run eval:validate`.

## Contradictions between documents

| Topic | Documents | What differs |
|---|---|---|
| Waste vs Waste 360 | `manually-curated-teamsystem-product-catalog`, `glossary-full` vs `glossary-high-level` | Catalog and full glossary: two distinct products (decision 2026-07-23). High-level glossary still says "one product". |
| TSID lockout threshold | `confluence …1023246350-en-teamsystem-id-v-3-user-manual` vs `…1188757581-tsid-log-on-grafana` | Manual: blocked after **5** wrong passwords. Grafana log page: lockout after **3**. |
| Correlation header | `adr0014-business-capability-standardization` vs `adr0017-trace-context` | ADR0014 still names `X-Request-Id`; ADR0017 replaces it with `traceparent`. |
| Fragment policy prefix (IAM) | `…iam…call-authorizer` vs `…iam…partial-evaluation` | `fragment.` vs `fragments.` package prefix. |
| Hermes topic naming | `hermes-2-0…record-schema-definition` vs data-platform `hermes-on-boarding` / `hermes-producer` | Old `com.teamsystem.<business>.<domain>…` convention vs new `<audience>.com.teamsystem.streaming.<domain>…`. |
| `isNecessaryTestEnv` flag | `…solution-witboost-hermes-producer` vs `…data-platform-environments` | Active flag vs "removed". |
| Ticket Tinder skill matrix updates | `…ticket-tinder-config-api` (same page) | "Operators not included are not altered" vs "no partial updates supported". |
| M3 slot cooldown | legacy `consumptions.md` vs `slots-flow.md` | "6 months" vs "configured in Service Catalog (`cooldownTtl`, days)". |
| M3 transfer status label | `…core-features-transfer-flow` | Same status called `422 U. Content` and `422 Conflict`. |
| Removal of managed-org permissions (PM) | `…1467678966-pm-management-of-affiliation-policy-opc-6904` vs `…1554120757-pm-remove-user…opc-7502`, `…1577975809` | OPC-6904 keeps permissions (open point); OPC-7502 treats total removal as target. |
| Connection initial state | `…core-connections…create-connection` | `UNVERIFIED` vs `PENDING_REQUEST` in two sections. |

## Near-duplicate pages (retrieval may return either)

* Policy Manager overview set (`overview`, `architecture`, `authorization-model`, `integration-patterns`, `glossary`,
  `tenancy-scope`) restate PEP/PDP/PAP/PIP, I-A-R-C, `identity.id = TSID` on 5–6 pages.
* PM FAQ (`…1618313409`) repeats verbatim the FAQ blocks of PM Overview, invitation flows and modify-permissions pages.
* `…1457881117-capability-integration-status…` ≈ `…1338703891-pm-identify-the-lifecycle-of-policies…`.
* Delegation Token U2M: `…1283686531` (OPC-7313) and `…1325400251` (spec) share sections 6–7 and the diagrams.
* Hermes compatibility tables duplicated in `record-schema-definition` and `adr-suggest-schema-compatibility-mode`.
* Two Hermes trees: `repo-tsdigital-oneplatform-hermes-docs-*` (1.x, stubs) and `…hermes-2-0-docs-*`.
* M3: every service has a `*-readme.md` and `*-docs-index.md` with overlapping text; ~10 readmes are template copies.
* AI: `ai-cowork-ai-shared-api…web-connectors` / `welcome-messages` duplicated across two repos; two different
  LiteLLM gateways (`ai-litellm` vs cowork `llm-gateway-*`) with different hosts and headers.
* Manually curated: catalog ⊆ full glossary, high-level glossary ⊆ full glossary by design.
* `…985563249-tsid-inboud-user-migration` contains the whole questionnaire twice.

## Export / formatting problems that hurt lexical retrieval

* **Escaped underscores** in tables: `READONLY\_DATE\_LIMIT\_REACHED`, `subject\_token`, `SELF\_EMPLOYED\_WORKER`, `TSH\_GOV\_APP`…
  Identifiers are unescaped in prose but escaped in tables, so BM25 sees two different tokens. Normalise `\_` → `_` at ingest.
* Machine-translated pages (`translation_workflow: claude-code/renormalize`) contain unidiomatic phrasing ("expansive cost").
* Agyo wrapper docs are labelled Italian (slugs) but their bodies are English.
* Leftover LLM text in `…tsid-inboud-user-migration` ("If you'd like, I can now…").
* Auto-generated "Faithfulness" audit blocks in both glossaries are noise.

## Truncated, stub or template-only documents (skipped by the benchmark)

* ADR0005 and ADR0012 end at a bare `## Details` heading; ADR0004 is mostly boilerplate. No ADR0009 exists.
* M3 ADR00001/ADR00002 keep template placeholder text.
* Confluence stubs: `…1115258970-pm-human-readable…` (title only), `…1225195639-organizations-filter`, `…1584857257-pm-define-affiliation-rules…` (two links + "REGOLA"),
  `…pm-affilitation-attribute`, `…1565949986-summary`, `…1618673787-policy-manager-functional-guide`, `…1651081261-rimozione-utente`, `…1460469790-gdprlog-faq` (one line),
  `…1104314473-technical-federation-form` (blank checklist). Auth0 PoC implementation MFA section is truncated.
* git-md stubs: `iam …common-issues` (TOC only), ICE `migration-ice-migration-agent`, AI `general-knowledge-base-index`, `regulatory-knowledge-base-index`,
  `international-apis`, `account-confirmation-retriever`; M3 `capability-catalog`, `service-manager`, `wallet-management`, `price-list-management`, `metering-links`;
  data-platform `aibi-*`, `witboost-introduction`, `dev-journey-6`.
* `…semantic-search-service-details` has unresolved placeholders ("Host: [Info mancante]", `!!! todo`).

## Content flagged for the owners

* `…pet-developer…healthcheck-enpoint` lists DEV/STAGE/PROD `X-API-KEY` values in plaintext.
* `…core-registry…item-validation` documents an unhandled state transition ("Missing Mapping").
* `record-schema-definition` example schema: `"format": "data-time"` typo and invalid `required` entry.
* `ticket-tinder-config-api` example has two clusters named `PROF_MULTI_1` and a department mismatch (`PRO` vs `MULTI`).
* ADR0016 lists "ADR0015 HTTP Methods & Status Codes" as related, but ADR0015 is REST API versioning.
* ADR0023 has `status: Permanent` (not a workflow state) and an empty `confluence-page-id`.
* Drafts relied on by questions: `token-exchange-flow` (Delegation Token section), `delegation-flow`, `delegation-token-light`, `tsid-session-logout-managment-draft`.
