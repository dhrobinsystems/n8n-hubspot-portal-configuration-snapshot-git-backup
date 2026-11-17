# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (**n8n-hubspot-portal-configuration-snapshot-git-backup**) are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts. That includes incomplete, outdated, or corrupted backups; failed or partial restores; lost or overwritten CRM configuration; overwritten or rewritten Git history; exposed repositories or tokens; and business disruption of any kind.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules, sample payloads, and documentation are provided "AS IS", without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement. Nothing in this repository guarantees that a snapshot captures every setting in a HubSpot portal, that a snapshot can be restored, or that HubSpot API responses, endpoints, or scopes will stay unchanged.

**Not a Complete Disaster-Recovery Solution:** This pipeline exports *configuration metadata* only: custom object schemas, property definitions and groups, pipelines and stages, and workflow metadata (IDs, names, type, status, revision). It does **not** back up CRM records, associations data, workflow action logic or enrollment criteria, emails, forms, lists, reports, dashboards, permissions, or integrations. Treat it as one layer of a wider backup and change-management strategy, never as the only one. Restoring configuration is a manual, human-reviewed process; this repository contains no automated restore and should not be modified to write to HubSpot without independent review.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a HubSpot developer test account or sandbox and a throwaway private Git repository, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live HubSpot or Git credentials. Review the Dry-Run Preview before you set `GIT_COMMITS_ENABLED=true`, and verify at least one restore drill against a test portal before relying on any snapshot.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot, GitHub (or any other Git host), Slack, n8n, and any connected services. That includes keeping the backup repository **private** and access-controlled, scoping tokens to the minimum required permissions and rotating them, recognising that HubSpot's `automation` scope grants write as well as read access to workflows, confirming that configuration metadata (property labels, picklist values, descriptions, pipeline and workflow names) contains no personal data before it is committed, honouring any data-residency or retention rules that apply to repository contents, and reviewing every automatically created commit.

The full disclaimer is also available in [DISCLAIMER.md](DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 DH Robin (dhRobin Systems) · Provided as-is, see the disclaimer.
