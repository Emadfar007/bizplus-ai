# Cloud operation and recovery

Open [BizPlus AI](https://bizplus-ai-api.onrender.com). Its frontend, API,
Razorpay Test Mode integration and independent observer run online. The laptop
does not need Node or a local engine running to use the website.

The November 2026 migration copied 869 application records from four SQLite
databases into the private Supabase `bizplus` schema. Another 320 historical
observer records are retained in private archive tables. All 1,189 original rows
were checked against their cloud copies, and a second import inserted zero rows.
The original source databases were retained throughout verification.

The backend uses a dedicated database role with strict TLS. All eleven tables
enable RLS and deny access to the browser's `anon` and `authenticated` roles.
Database credentials remain in Render settings. Login stays human controlled;
payment keys and signatures are never sent to source control.

Demo history belongs to a session UUID. A private migration shortcut can use
`/incidents#resume-session=<UUID>` to retain that session on the hosted origin.
The browser stores the selected UUID and removes the fragment from its address.
This retains the existing demo isolation model; it is not production account
authentication. Session links must remain private, and no list of sessions is
published by the app.

The complete local project, including Git history, uncommitted source, documents,
screenshots, dependencies, database files and private configuration, is preserved
as an AES-256-GCM encrypted archive in the private
[BizPlus cloud backup repository](https://github.com/Emadfar007/bizplus-ai-cloud-backup).
Recovery instructions there identify the decryption secret in Supabase Vault.
The secret itself is never included in GitHub source or the archive metadata.

Render's filesystem remains temporary. PostgreSQL stores application history;
the full project archive preserves original files independently. Free services
can pause or take time to wake, so verify the current provider status before a
demonstration. Earlier presentation documents describe their original release.
