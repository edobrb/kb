---
source_id: "manually-curated:manually-curated-oneplatform-design-principles"
source_type: manually-curated
unit_kind: documentation
title: OnePlatform R&D Principles
authority: normative
version_hash: "sha256:386a2c561be05b61af734f1dd8e56c430fa12de31d1bfcb8c2198f786860c6fe"
body_hash: "sha256:0acc9dabf44d1fedc498a5ece5a627097974899067bf5dbec874a3d472b53ff2"
lang: en
source_langs: [en]
ingested_from: maintainer-supplied
index_status: verified
delivered_at: "2026-07-29T22:11:01Z"
raw_origin: raw/manually-curated/oneplatform-design-principles.md
taxonomy_origins: "authority=document, lang=document, source_type=document, title=document, unit_kind=producer_admission"
---
# OnePlatform R&D Principles

The eight principles that govern how TeamSystem OnePlatform is designed and built,
grouped into **Technical Principles** (how the platform is engineered) and
**Functional Principles** (how it serves customers and the business).

## Technical Principles

### 1. Once only — high adoption of OnePlatform

- New services must be conceived "once only" — built once on the platform and reused,
  never re-implemented per product.
- Back-end services and "black-box" services.

### 2. Cybersecurity and Privacy by Design

OnePlatform services run through automated processes via **Biosphere**, and the
architectural-review process validates each stage of service development and
operation for compliance with cybersecurity and data-privacy policies.

- **Biosphere** — ensures 1P services automatically benefit from:
  - Static code analysis
  - Infrastructure-as-code
  - Centralized secret manager
  - Infrastructure policy manager
- **Security Engineering:**
  - Penetration-testing (WAPT) processes managed by Security Engineering
  - Dual WAPT certification (retest) through an external entity
  - Integration only through authorized channels (API Gateway, Integration Hub) and a
    firewall enforced by policy management
  - Continuous OWASP training for developers
- **Data Privacy:**
  - Continuous privacy-compliance analysis (GDPR, MOD231)
  - Continuous analysis of Risk-Management processes
  - Coordination and verification with the DPO on Privacy-by-Design principles

### 3. Collaborative platforms talking through APIs

- **Agility:**
  - Through standard patterns, they expose the functionality of other applications
    (any kind of entity, regardless of the underlying management system)
  - They simplify dialogue between applications, avoiding redundancy, code
    replication, and possible functional inconsistencies
  - They increase the speed of delivering new features
- **Business:**
  - Indispensable for making services available to the business
  - Enable the delivery of traditional services on digital devices and generate new
    forms of revenue
  - Reduce the impact of customizations on the standard
- **Collaboration:**
  - Extension of services through public APIs to partners and developers
- **UX:**
  - Provide a means to shield the user from complexity and from interventions on the
    underlying systems

### 4. Native SaaS, Multitenant, Multicloud, Mobile enabled

- Leverage the cloud — beyond storage and hosting — with elastic resource scaling and
  continuous updates. Automation.
- Composable, service-based architectures. Each component is pluggable, scalable, and
  replaceable, and can be continuously improved through agile development to meet
  ever-evolving business requirements.
- API at the center: all functionality exposed via API.

## Functional Principles

### 5. Digital first / AI embedded

- Design our software around the digital point of contact between the customer, their
  business, and their daily life.
- Predictive, proactive, shareable, capable of learning, and above all simple.

### 6. Design to: cost / onboard / retain / maintain

Integrate the key elements into product design to:

- Create an efficient, integrated customer experience that minimizes the customer's
  need to resort to Customer Support.
- Offer an easy, attractive path to onboard and learn to use the product.
- Stimulate proactive, tailored retention based on real usage, engaging the customer
  through features.
- Achieve an efficient architecture for updating and evolving the product.

### 7. Engagement in SW / Buy in SW

- To promote feature adoption
- To know more about users
- To improve user retention
- To boost cross-/up-selling

### 8. Enhance collaboration between stakeholders

- Integrate systems in order to integrate processes.
- Stimulate and enrich communication between the actors.
- Unified push-notification system.
- Real-time collaboration on documents and information.
- Anytime, anywhere, from any device.
- Digital interlocutors (bots and AI).
