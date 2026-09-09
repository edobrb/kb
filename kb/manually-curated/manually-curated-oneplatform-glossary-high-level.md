---
source_id: "manually-curated:manually-curated-oneplatform-glossary-high-level"
source_type: manually-curated
unit_kind: documentation
title: OnePlatform Essential Glossary
authority: descriptive
version_hash: "sha256:ce29a6d6e083cc1f32b0efe970bb693b8be8b111b9747c501f4f6d5583f4d0f6"
body_hash: "sha256:96bced4031b7a39f61e6f295a2cd30af41d9413b116428b84428fc496eada838"
lang: en
source_langs: [en]
ingested_from: maintainer-curated
curated_by: maintainer
index_status: verified
delivered_at: "2026-07-29T22:11:01Z"
raw_origin: raw/manually-curated/oneplatform-glossary-high-level.md
taxonomy_origins: "authority=convention_default, lang=measured, source_type=index_folder, title=document, unit_kind=producer_admission"
---
# OnePlatform Essential Glossary

## Definition  <!-- REQUIRED · source-silence: cite-only -->

This page is the **essential subset** of the OnePlatform controlled vocabulary: a small, curated set of the **load-bearing platform concepts** — the ones you need to understand TeamSystem OnePlatform at all — each given **one canonical, dominant definition**. It is a two-tier layer over the [[OnePlatform Glossary]]: the full glossary is a lean **disambiguation index** — a slim canonical-name register plus the Confusables tables that pin every niche and named sense — while this page pins the ~18 structurally load-bearing concepts and states, for each confusable, the **default sense** an answer should assume. Neither page duplicates a description; both point to the typed wiki pages, the product catalog, and the CityMap for the full definition.

It is **derived**, exactly like the full register: a hand-maintained curation projected for retrieval and clarification, not itself a citable `source:`. Each essential definition carries the **same citation the full glossary entry carries** — most register rows trace to the typed wiki pages and are uncited at the register level, so most entries here mirror that; the two entries with an explicit source ([[OnePlatform Architecture and CityMap|OnePlatform]] itself and [[Item Registry]]) carry it verbatim.[^1][^2]

**The dominant-sense rule (why this page exists).** Several essential terms are glossary **confusables** — one brand or word covers a general concept plus two or three niche named instances. Flat treatment causes over-clarification: a user who types "bc" or "workspace" gets asked "which one?" and offered niche senses they did not mean. This page fixes that by declaring the **dominant/default sense** for each. An answer (or the clarify gate) resolves a bare confusable to the dominant sense stated here **without** clarifying; it escalates to the full glossary's `## Confusables` named senses only when a specific instance is genuinely signaled by the surrounding question. The specific named senses are never lost — they stay in the full register — they are just no longer the default.

## The Essential Concepts  <!-- the curated load-bearing set -->

Grouped as: the platform and its architecture · composition and the commercial model · the core services · the cross-cutting model vocabulary. Each entry gives the **dominant definition** and, where relevant, names the niche senses that stay in the full glossary.

### Platform and architecture

- **OnePlatform (1P)** — TeamSystem's "Platform as a Product": the modular, technology-agnostic foundation on which all TeamSystem offerings are composed from reusable Business Capabilities. `1P` is its standard acronym (1P Audit Log, Contratto Unico (1P)). Bare **"TS Digital"** (without "Platform"/"Digitale") is the legal/contract name of *current* OnePlatform — an alias, not the legacy portal.[^1] Full entry: [[OnePlatform Glossary]] · architecture: [[OnePlatform Architecture and CityMap]].
- **CityMap** — the published, continuously-evolving visual guide to OnePlatform's architecture: an **eight-layer stack** ordered from Layer 1 (SW Lifecycle, bottom) to Layer 8 (Commercial Offering, top). It is the functional taxonomy the catalogs realize; the map of Business Capabilities integrable into Commercial Suites.[^1] Full entry: [[OnePlatform Architecture and CityMap]].
- **Core Services (Layer 3)** — the shared platform services on which every application builds, grouped into **six groups**: **Foundation** (Item Registry, TS ID, Workspace, Policy Manager, Connections, Contract & Privacy, Notification & Communication), **Experience** (Application Frame, Launchpad, Powerboard, Design System, Smart Components, Federated Module Catalog — delivered through ICE), **TouchX** (an overlay across Experience and Monetization: My Value Center — formerly known as Personal Area — Onboarding, Engagement in SW, Trial), **Monetization** (Provisioning, Trial, User Telemetry, Metering, Licensing, Engagement in SW), **AI** (Agents, Models, Context, Governance, Services, AI Orchestrator, Memory, Harness — the foundation *beneath* the L6 agents), and **Support** (Back office, Knowledge base, Help desk).[^3] **TS ID and Workspace are mandatory for every application.**[^1] Lineage: the Business Capabilities Manifesto's vocabulary for this infrastructural stratum is **Platform Capability** — "Core Services" is the current canonical name for the canonical set within that umbrella. Full entry: [[OnePlatform Architecture and CityMap]]; the umbrella: [[Platform Capability]].
- **Platform Capability** — **dominant sense: the infrastructural umbrella, NOT a Business Capability** — the Manifesto's counterpart to a BC: non-commercial infrastructural components (integration, identity, data services, …) that provide the fundamental services and processes BCs are built on, and the ONLY dependency a BC may take. It **contains the Core Services** (the canonical set) but is role-defined and may hold other infrastructural capabilities beyond them. The term is used loosely — when someone says "Platform Capability", challenge back: *do you mean a Business Capability or a Core Service?* Full entry: [[Platform Capability]]; challenge-back: [[OnePlatform Glossary]] §Confusables.

### Composition and the commercial model

- **Business Capability (BC)** — **dominant sense: the general concept** — a **reusable functional product domain** (e.g. Warehouse, Accounting, Invoicing, MES, Timesheet): a software aggregate implementing a specific domain functional competency, designed as an autonomous, cohesive, reusable unit built ON the platform's core services / Platform Capabilities. The **buildable** unit — not necessarily sold on its own — that declares *capability*, not commercial limits or prices; BCs must not depend directly on other BCs (their only allowed dependency is a Platform Capability). This is what "BC" means unless a specific instance is signaled. The three niche named lenses — **Metering BC** (commercial domain), **IAM Capability** (authZ migration unit, `domain.subdomain`), and **ICE Business Capability** (a CityMap feature realized as Modules) — are the *same concept seen through three lenses* and live in the full glossary `## Confusables`; do not clarify to them by default. Full entry: [[Business Capability]] (in [[Commercial Offer and Business Capability]]); charter: [[Business Capabilities Manifesto]]; named senses: [[OnePlatform Glossary]] §Confusables.
- **Commercial Offer / Commercial Offering** — what the customer actually buys: **one or more Business Capabilities combined with Platform Capabilities, packaged and SOLD** — the **sellable** unit (vs the BC, the buildable unit); e.g. an enterprise suite bundles Warehouse + Accounting + Invoicing capabilities that are not sold individually. In the current (M3) model it is a structured, dynamically-composable object (tiers, add-ons, coupons) built from Business Capabilities via the Capability Catalog; it evolves the legacy M1 **Family**. Full entry: [[Commercial Offer and Business Capability]].
- **Family** — the high-level commercial container / technical name of a commercial offer (`UPPERCASE_WITH_UNDERSCORE`); the M1-era technical offer that Commercial Offer succeeds. Full entry: [[The Monetization Model: Business Capability, Family, BBS]]; register row: [[OnePlatform Glossary]].
- **Feature** — the minimal unit of monetization: a functionality activated / deactivated / set read-only per customer, identified by `serviceId` ("servizio" in M1, "feature" in M3). A Business Capability is composed of features. Full entry: [[The Monetization Model: Business Capability, Family, BBS]]; register row: [[OnePlatform Glossary]].
- **Module** — the **technical realization** of a Business Capability in the frontend: auto-contained federated software (project name + `remoteEntry.js` container URL + route), registered in the Modules Catalog. The BC is the *functional* unit; the Module is its ICE *technical* form — never merge the two. Full entry: [[Modules Catalog]]; register row: [[OnePlatform Glossary]].

### The core services

- **TS ID (TeamSystem ID)** — the centralized OIDC/OAuth2 identity and authentication hub (v3, built on Duende IdentityServer): single digital identity, SSO, and token issuance across products. **AuthN only** — authorization is Policy Manager. Full entry: [[TS ID Service]].
- **Policy Manager (PM)** — the OnePlatform **authorization** system (OPA/Rego, ABAC): decides whether an **Identity** may perform an **Action** on a **Resource** in a given **Context** (the I-A-R-C model); also the internal name of the "Utenti e Permessi" feature. AuthZ, not AuthN. Full entry: [[Policy Manager]]; the model: [[OnePlatform Authorization Model (ABAC / I-A-R-C)]].
- **Workspace** — **dominant sense: the master-data module/service** — the agnostic OnePlatform private registry storing the subjective/functional data of a client's stakeholders; the source of truth for configuration/preference data. The word carries three other named senses in the full glossary `## Confusables` — **WorkspaceID** (the default PM tenancy key), the **Workspace ICE context** dimension, and the **Workspace IAM service** (`/api/v2/workspaces`) — do not clarify to them by default. Full entry: [[Workspace]]; tenancy sense: [[Multi-Tenancy and Workspace Selection]]; named senses: [[OnePlatform Glossary]] §Confusables.
- **Item Registry** — the OnePlatform-native centralized **master-data registry** where every **Item** (company, studio, natural person, condominium) is recorded, searched, and ownership-managed. `item-registry` is the service-id form; **"Company Registry" is the older name** for the same service.[^2] Full entry: [[Item Registry]].
- **Hermes** — **dominant sense: Hermes 2** — the Kafka-based (Confluent Cloud) enterprise **streaming platform** for CloudEvents-wrapped, schema-validated business events and entity snapshots. Bare "Hermes" means Hermes 2 unless legacy evidence points otherwise. Never attribute Kafka/CloudEvents to **Hermes 1** (the legacy Azure Service Bus streaming it supersedes), and never fold in the **Integration Hub** (a separate point-to-point on-prem↔cloud bus, *not* a Hermes version). Full entry: [[Hermes 2 (Streaming Data Platform)]]; the separate bus: [[Integration Hub]].
- **Metering** — the OnePlatform system that activates/deactivates product features per customer and tracks per-package consumption — it *executes* what the commercial channels sell. **Dominant generation: M3** (Capability Catalog, Smartmeter, Wallet Manager, governed lifecycle), the current/target architecture; **M1** is the legacy generation still in production. M3 is not "M1 v3" — never merge the generations, and never merge either with the MongoDB Atlas M10/M30/M40 tiers (unrelated `M` collision). Full entry: [[Metering M3]]; domain overview: [[Metering & Monetization (Domain Overview)]].
- **ICE (Integrated Centralized Experience)** — **dominant sense: the current microfrontend platform** — the host shell that composes Business Capabilities via Module Federation and hosts the Experience services; successor to **OneFront** (the legacy frontend platform, 1F). Never fold OneFront content into ICE. Full entry: [[ICE (Integrated Centralized Experience) Microfrontend Platform]]; the legacy platform: [[OneFront (Legacy Frontend Platform)]].
- **One Back Office (OBO)** — **dominant sense: the federated back-office container of One Platform** — the platform in which each Business Capability team builds and integrates its OWN back-office module (consultation, monitoring, controlled write actions), under common profiling (permission sets: mandatory level + optional category), Policy Manager governance, and server-side fail-closed enforcement. NOT **Pandora** (the TS-ID-focused backoffice portal, currently serving as the TS ID back office) and NOT the legacy **"Back Office (BO)"** operator role — three distinct things, never merged. Full entry: [[One Back Office (OBO)]]; named senses: [[OnePlatform Glossary]] §Confusables.

### The product catalog and its short names

- **Agents (which ones?)** — **dominant sense: the L6 AI Agents band** — the user-facing, task-specific agents (Doc, Knowledge, Action, Support, CCNL, HR Assistant, Data Analyst agents) that deliver concrete functionality.[^3] Two other senses stay in the full glossary: the **L3 AI group** (the foundation beneath — Models, Context, Memory, Harness, AI Orchestrator, runtime) and **Sales Agents (Agenti)**, the SCM commissions capability. An "agent runtime / orchestrator / memory" question is L3; an SCM/commissions/*agenti* question is the sales capability.
- **Product short names** — users query with short/partial product names: "Studio" (→ TS Studio Cloud vs the legacy TS Studio/TS Azienda stack vs Studio AI / Studio HR AI / Studio Legal AI — resolve by segment), "Alyante" (→ TSE Alyante, a legacy TeamSystem Enterprise edition), bare "Waste" (→ TeamSystem Waste; Waste 360 = Waste, one product). **TSE = TeamSystem Enterprise.** Full families + generation pairs: [[OnePlatform Glossary]] §Confusables.
- **The "?IC" abbreviation guard** — the "X in Cloud" family collides on leading letters. Ruled expansions: **FIC** = Fatture in Cloud (current/target), **DIC** = Dipendenti in Cloud, **COMIC** = Commercialisti in Cloud. Bare **CIC** (Cassa / Contabilità / Commercialisti claimants) and **AIC** (dropped former name of TS Waste) must **never be auto-expanded** — disambiguate from context or ask. Casing variants (FiC, fic, …) are the same surface — the parsing layer folds case. Full cluster: [[OnePlatform Glossary]] §Confusables.

### Cross-cutting model vocabulary

- **Tenancy** — the logical **data-isolation unit** where authorization is evaluated: `tenancy.type` (`WORKSPACE` or `ITEM`) plus `tenancy.id`, with **WorkspaceID the default**. It is the data context, never the subject — an Identity/TSID is explicitly *not* a tenancy. Distinguish from **Scope** (the authZ perimeter) and from the various **Tenant** senses (Workspace owner vs Contracts customer scope) in the full glossary `## Confusables`. Full entry: [[Multi-Tenancy and Workspace Selection]]; the authZ model: [[OnePlatform Authorization Model (ABAC / I-A-R-C)]].

## The CityMap at a Glance  <!-- the authoritative current map, condensed for orientation -->

The authoritative current CityMap (maintainer-verified rendering, 2026-07), top to bottom:[^3]

| Layer | Band | What sits there |
|---|---|---|
| **L8** | **Commercial Offering** | The sellable suites — **TS in Cloud** (Fatture / Condomini / Associazioni / Commercialisti / Cassa / Sportivi in Cloud, TS Hospitality, Wellness / Netlex in Cloud), **TS Studio Cloud** (TS Studio, TS Azienda), **TS Mid-Market Cloud** (TS Enterprise + TSE verticals) — plus horizontal offerings (TS HR, TS Extended CRM, Trust Services, Cybersecurity, TS Digital Finance, Clicdata). |
| **L7** | **Business Capabilities** | Finance, Tax, SCM, Manufacturing, HR services, Trust Services, Cybersecurity, Collaboration, FinTech, Data, Marketing, Compliance, eDocuments (E-invoicing / Telematici / E-receipt). |
| **L6** | **AI Agents** | Data Analyst, Doc, Knowledge, Action, Support, CCNL, and HR Assistant agents. |
| **L5** | **Integration** | Data Streaming ([[Hermes]]), API Gateway, [[Integration Hub]], Invoice/NSO Hub. |
| **L4** | **Data** | Document Storage, Processing & Transformation, Data Products & Knowledge graph, Visualization, Governance & Observability, Insights. |
| **L3** | **Core Services** | The shared platform services, in **six groups** — detailed below. |
| **L2** | **Infrastructure** | AWS / Azure / GCP, Kubernetes, Storage, IaaS, Disaster recovery, Security. |
| **L1** | **SW Lifecycle** | Quality, Observability, CI/CD, Product catalog, Dev Portal, Source Control, Deployment, Infra as Code (Terraform), Code Security. |

**Layer 3 — the six Core Services groups:**[^3]

| Group | Member services |
|---|---|
| **Foundation** | [[Item Registry]], IAM ([[TS ID]]), [[Workspace]], IAM ([[Policy Manager]]), Connections, Contract & Privacy, Notification & Communication. |
| **Experience** | Application Frame, Launchpad, Powerboard, Design System (Polar), Smart Components, Federated Module Catalog. |
| **TouchX** | My Value Center (formerly known as Personal Area), Onboarding, Engagement in SW, Trial — an overlay group spanning Experience and Monetization: the TouchX team **orchestrates** building blocks owned by the Experience/Monetization teams into end-to-end experiences, so the duplicated members are intentional. |
| **Monetization** | Engagement in SW, Provisioning, Trial, User telemetry, Metering, Licensing. |
| **AI** | Agents, Models, Context, Governance, Services, AI Orchestrator, Memory, Harness — the platform foundation beneath the L6 agents. |
| **Support** | Back office, Knowledge base, Help desk. |

Full narrative entry (layer semantics, how to use the map top-down, naming lineage): [[OnePlatform Architecture and CityMap]].

## Why It Matters On This Platform  <!-- REQUIRED · source-silence: cite-only -->

These ~eighteen concepts are the vocabulary in which every other OnePlatform answer is phrased. The compositional architecture is the reason: commercial offerings are not monolithic — a **Commercial Offer** bundles one or more **Business Capabilities** with the **Platform Capabilities** they run on, each developed once and reused; the **CityMap** organizes the **Core Services** they build on; **TS ID** and **Workspace** are mandatory for every application; **Policy Manager** governs who may act; **Hermes** streams the events; **Metering** counts what is consumed; **ICE** renders the experience; **One Back Office** is where the capability teams' own operational tooling federates.[^1] Understanding these — and defaulting to their dominant senses — is what lets a reader place any narrower term.

For the retrieval and clarification path the payoff is concrete: a bare confusable resolves to the dominant sense declared here **without a clarify round-trip**, and the full glossary's niche senses are consulted only when the question genuinely signals one. This is the two-tier design — precision at the essential layer, recall at the full layer — that keeps answering from over-clarifying while never losing a named sense.

## Common Misconceptions  <!-- OPTIONAL · source-silence: cite-only (when present) -->

- "Typing 'BC' means I have to pick between Metering BC, IAM Capability, and ICE Business Capability." → No. **Business Capability** has a dominant *general* sense (a reusable functional product domain built on core services); the three named lenses are the same concept seen from commercial, authZ, and frontend angles, and default answering assumes the general concept.
- "A Platform Capability is a Business Capability." → No — colloquial misuse. The Manifesto's authoritative sense is **infrastructural**: the umbrella of non-commercial components (containing the Core Services) that BCs are built on. When the term appears, challenge back: Business Capability or Core Service?
- "Workspace is a single thing." → **Workspace** defaults to the master-data module/service; WorkspaceID (PM tenancy), the ICE Workspace context, and the Workspace IAM service are distinct named senses, disambiguated only when signaled.
- "Hermes is Hermes." → Bare **Hermes** means Hermes 2 (Kafka/CloudEvents); Hermes 1 (Azure Service Bus) is the legacy generation and Integration Hub is a separate bus, not a Hermes version.
- "CIC means Cassa in Cloud." → Bare CIC has at least three claimants (Cassa / Contabilità / Commercialisti in Cloud) and is never auto-expanded; the same guard covers AIC. Only FIC, DIC and COMIC have ruled expansions.
- "Personal Area is a different thing from My Value Center." → Personal Area is the former name of My Value Center (a legacy alias); only "My Personal Area" (the monetization data-product consumer) is genuinely distinct.
- "This page replaces the full glossary." → It does not. It is the load-bearing subset; the [[OnePlatform Glossary]] remains the complete controlled vocabulary, and every niche/named sense lives there.

## Faithfulness

<!-- AUTO-GENERATED: tools/audit-claim-provenance.py; kb-v0.4.3; do not edit between markers -->
2 claim-citation faithfulness defects (as of kb-v0.4.3, model `claude-opus-4-8 (Claude Code workflow judge)`)
- `oneplatform-essential-glossary#claim1` — cited source `source:webpage:oneplatformmanifest-and-citymap — the OnePlatform manifest / TS CityMap that frames the platform's named capabilities and domains this register enumerates; the canonical names are reconciled against the typed wiki pages and projected by tools/glossary-derive.py.`
  - **Verdict:** neutral (IMPORTANT, confidence 0.90)
  - **Rationale:** 

- `oneplatform-essential-glossary#claim7` — cited source `source:webpage:oneplatformmanifest-and-citymap — the OnePlatform manifest / TS CityMap that frames the platform's named capabilities and domains this register enumerates; the canonical names are reconciled against the typed wiki pages and projected by tools/glossary-derive.py.`
  - **Verdict:** neutral (IMPORTANT, confidence 0.90)
  - **Rationale:**
<!-- /AUTO-GENERATED -->

## Sources & Provenance  <!-- REQUIRED — footnote definitions, no inference -->

This page is a **derived curation** of the [[OnePlatform Glossary]] — a reorganization of an existing typed page, not a new ingest. Each essential definition carries the citation its full-glossary entry carries (verbatim), and entries whose register rows are uncited (because per-term definitions trace to the typed wiki pages) mirror that. The first two footnotes below are carried unchanged from the full glossary; the third is the authoritative current CityMap, cited directly by the "CityMap at a Glance" section and the Core Services entry.

[^1]: source:webpage:oneplatformmanifest-and-citymap — the OnePlatform manifest / TS CityMap that frames the platform's named capabilities and domains this register enumerates; the canonical names are reconciled against the typed wiki pages and projected by `tools/glossary-derive.py`.
[^2]: source:git-md:item-registry — the Item Registry dev-portal documentation (KB 0.3.1): the centralized OnePlatform-native master-data registry for organizational entities; the source notes record that 'Item Registry' and 'Company Registry' are aliases of the same service ('Item Registry'/'Registry' current; 'Company Registry' the older name).
[^3]: source:confluence:citymap-teamsystem-authoritative-2026-07 §§"The eight bands (top → bottom)", "L3 — CORE SERVICES" — normative, last_modified 2026-07-15. (The authoritative current CityMap: maintainer-provided image, transcribed 2026-07-15; supersedes the 2025-09 deck's condensed 7-band rendering.)
