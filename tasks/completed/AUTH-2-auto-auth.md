# AUTH-2: --auto-auth google — automated Google OAuth login

## Context

Many SaaS apps use "Sign in with Google." When Chrome is logged into a Google account, the OAuth flow is just clicks — no password or 2FA. sitecap can automate this to capture authenticated pages without manual intervention.

## Goal

`--auto-auth google` detects the Google sign-in button, clicks it, selects the account matching the Chrome profile in the popup, and waits for the redirect back to the authenticated app.

## CLI

```bash
sitecap "https://app.example.com" --profile "Work" --auto-auth google -o ./output
```

Requires `--profile` (needs a real Chrome session with a Google account logged in).

## Flow

1. Navigate to the target URL
2. Detect Google sign-in — look for:
   - FedCM iframe from `accounts.google.com/gsi/`
   - Standard Google button: `[data-provider="google"]`, `a[href*="accounts.google.com"]`
   - Text-based: buttons/links containing "Sign in with Google"
3. Click the sign-in element
4. Wait for popup (new page event on the context)
5. In the popup (`accounts.google.com` URL):
   - Wait for account list to render
   - Find the account matching the Chrome profile's email
   - Click it
6. Popup closes, main page redirects to authenticated state
7. Wait for main page URL to change (no longer on login page)
8. Proceed with `waitForPageSettle()` then capture

## Files to Modify

- **lib/auth.js** (new) — `autoAuthGoogle(page, context)` function
- **bin/sitecap.js** — add `--auto-auth` flag, call auth function before capture

## Dependency Direction

`bin/sitecap.js` → `lib/auth.js`. auth.js is standalone, no deps on capture.js.

## Detection Strategy

Try selectors in order, first match wins:

```
1. iframe[src*="accounts.google.com/gsi"] → click [role=button] inside frame
2. [data-provider="google"]
3. button:has-text("Sign in with Google")
4. a[href*="accounts.google.com/o/oauth2"]
```

## Account Selection in Popup

The popup URL matches `accounts.google.com`. The account chooser shows email addresses. Match by:
1. Get the profile's Google email from Chrome's Local State JSON (`gaia_name` or `user_name` in profile info)
2. In the popup, find element containing that email
3. Click it

If no matching account found, fall back to first account (with a warning).

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No Google button found | Skip auth, proceed with capture (page may already be authenticated) |
| Already authenticated (no login page) | Detect by URL — if URL is already the dashboard/app, skip auth |
| Popup blocked | Error with message to allow popups |
| Account chooser has multiple accounts | Match by email from Chrome profile |
| 2FA required despite Google session | Fall back to --wait-for-auth behavior (print message, wait for stdin) |
| OAuth consent screen (first-time app) | Click "Allow" / "Continue" button |

## Future Extensions

Same pattern for other providers — each gets its own function in auth.js:
- `autoAuthGitHub(page, context)`
- `autoAuthMicrosoft(page, context)`
- `autoAuthApple(page, context)`

The `--auto-auth` flag takes a provider name. `lib/auth.js` exports a registry.

## Before Closing
- [ ] Run make check
- [ ] Verify --auto-auth without --profile gives clear error
- [ ] Verify no Google button found → graceful skip, not crash
- [ ] Verify popup detection works (context.waitForEvent('page'))
- [ ] Test with a real Google OAuth flow if possible
