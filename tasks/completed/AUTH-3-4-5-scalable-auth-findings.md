# AUTH-3/4/5: Scalable Auth Investigation Findings

## Summary

At scale (1000s of agents), zero-human auth for capturing authenticated web pages requires **session cookie management**, not OAuth/FedCM automation. The three approaches investigated:

| Approach | Viable? | Best for |
|----------|---------|----------|
| API tokens (AUTH-3) | Partially | Apps with login API endpoints |
| Google service accounts (AUTH-4) | No | Google APIs only, not web UIs |
| Bot accounts (AUTH-5) | Yes | Most SaaS apps |

## Winner: Bot accounts + session persistence

The recommended architecture for sitecap at scale:

1. **Dedicated bot accounts** per SaaS app (e.g., `capture@yourcompany.com`)
2. **TOTP for MFA** — automatable with the shared secret, add `totp` step to auth-flow YAML
3. **Auth-flow YAML** handles login (fill email/password, generate TOTP, submit)
4. **Session persistence** — save cookies after login, reuse for 30-90 days (trusted device cookies)
5. **Re-auth on failure** — detect redirect-to-login, trigger auth flow, retry capture

## AUTH-3: API Token Injection

**Finding**: API tokens and session cookies are parallel auth systems. You can't inject an API key and get web UI access. The web UI checks for its own session cookie, not `Authorization` headers.

**What works**: Hit the login API endpoint programmatically → extract session cookie → inject into Playwright. Playwright's `storageState` is the standard pattern for this.

**sitecap already supports this** via `--auth <file>` which injects cookies from JSON.

## AUTH-4: Google Service Accounts

**Finding**: Domain-wide delegation gives API access, not browser sessions. The `aud` (audience) claim in tokens must match the SaaS app's own OAuth client ID — a service account token has the wrong audience. No Google API lets you mint tokens for third-party apps.

**Verdict**: Dead end for web UI capture. Only useful for Google's own APIs (Drive, Gmail, etc.).

## AUTH-5: Bot Accounts

**Finding**: Standard industry practice. Most SaaS apps don't detect automated logins from bot accounts.

**MFA handling**:
- TOTP: fully automatable (store shared secret, generate codes programmatically)
- SMS: avoid (hard to automate)
- Email codes: automatable if you control the inbox (poll via IMAP)
- Passkeys: possible via Playwright virtual authenticators but complex

**Obstacles by platform**:
- Small/mid SaaS: no detection, works fine
- Google/Microsoft: hostile to UI automation, aggressive bot detection
- AWS Console: CAPTCHA on login

**Legal**: Automating your own paid accounts is not a legal issue. Most ToS anti-bot clauses target scraping/abuse, not legitimate QA/monitoring.

## Recommended Next Steps

1. Add `totp` step type to auth-flow YAML — generate TOTP codes from stored secrets
2. Add `storageState` save/load to `--auth` — Playwright's native format includes cookies + localStorage
3. Add auth failure detection — if capture returns a login page, trigger re-auth
4. Document the bot account setup pattern for users
