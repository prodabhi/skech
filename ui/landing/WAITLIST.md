# Waitlist, into a Google Sheet

Three steps: make the sheet, deploy a script in front of it, point the site at
that script. No API key, no service account, nothing to rotate.

## 1. The sheet

New Google Sheet. Put these in row 1, in this order, because the script writes
by position:

```
email    source    at
```

## 2. The script

In the sheet: **Extensions -> Apps Script**. Replace everything with this, then
Save.

```js
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents)
    var email = String(body.email || '').trim().toLowerCase()
    if (!email) {
      return json({ ok: false, error: 'no email' })
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0]

    // Skip an address that is already on the list. Column A, from row 2 down.
    var last = sheet.getLastRow()
    if (last > 1) {
      var seen = sheet.getRange(2, 1, last - 1, 1).getValues()
      for (var i = 0; i < seen.length; i++) {
        if (String(seen[i][0]).trim().toLowerCase() === email) {
          return json({ ok: true, duplicate: true })
        }
      }
    }

    sheet.appendRow([email, body.source || '', body.at || new Date().toISOString()])
    return json({ ok: true })
  } catch (err) {
    return json({ ok: false, error: String(err) })
  }
}

// Every reply is HTTP 200: Apps Script cannot set a status code. That is why
// each one carries an explicit `ok`, and why /api/waitlist checks the body
// rather than the status.
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  )
}
```

## 3. Deploy it

**Deploy -> New deployment -> Web app**, then:

- **Execute as:** Me
- **Who has access:** Anyone

Authorise it when asked. Google will warn that the script is unverified; it is
your own script, so continue. Copy the `/exec` URL it gives you.

## 4. Point the site at it

Add to `ui/landing/.env.local`:

```
WAITLIST_SHEET_URL=https://script.google.com/macros/s/AKfy.../exec
```

Restart `bun run dev`.

**Not `NEXT_PUBLIC_`.** That URL is an open write endpoint: anything that has it
can append rows. Kept server-side, only `/api/waitlist` can reach it, which is
also where the address gets validated before anything is written.

Until the variable is set the form returns "Sign-ups aren't open yet", and the
dropped address is logged server-side so nothing is silently lost in testing.

## Checking it

```bash
curl -X POST http://localhost:3000/api/waitlist \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'
```

`{"ok":true}` and a new row. A bad address gives a 400 without touching the
sheet.

## Worth knowing

- **Re-deploying replaces the URL** unless you pick "Manage deployments" and
  edit the existing one. Editing keeps the URL; a new deployment does not.
- Apps Script web apps are slow, roughly half a second to two seconds. The route
  gives up at eight and tells the visitor to retry rather than hanging.
- Duplicates are dropped by the script, so the same person signing up twice
  still sees the confirmation and the sheet stays clean.
